import {
  PlannedCoreAggregateNode,
  PlannedCoreConceptRef,
  PlannedCorePredicate,
  PlannedCoreProgram,
  PlannedCoreProjectNode,
  PlannedCoreRowBranch,
  PlannedCoreSourceId
} from './core';
import { SEMANTIC_CATALOG } from './semantic-catalog';
import { PLANNED_INTEGRITY_FIELD } from './planned-compiler';
import { validatePlannedCoreProgram } from './planned-f1ql';

export type PlannedReferenceDatabase = Partial<Record<PlannedCoreSourceId, Array<Record<string, unknown>>>>;

interface EvaluatedRow {
  [key: string]: unknown;
}

interface EvaluatedBranch {
  rows: EvaluatedRow[];
  integrity: boolean;
}

export function interpretPlannedF1QL(input: PlannedCoreProgram, database: PlannedReferenceDatabase): Array<Record<string, unknown>> {
  const program = validatePlannedCoreProgram(input);
  const projected = evaluateProject(program.root.input.input, database);
  const sorted = [...projected].sort((left, right) => {
    for (const key of program.root.input.keys) {
      const comparison = compareSortValues(left[key.output_id], right[key.output_id], key.semantic_type, key.direction, key.nulls);
      if (comparison !== 0) {return comparison;}
    }
    return 0;
  });
  return sorted.slice(0, program.root.count);
}

function evaluateProject(project: PlannedCoreProjectNode, database: PlannedReferenceDatabase): EvaluatedRow[] {
  let input: EvaluatedRow[];
  if (project.input.op === 'join') {
    input = evaluateJoin(project.input, database);
  } else if (project.input.op === 'compose') {
    input = evaluateCompose(project.input, database);
  } else if (project.input.op === 'aggregate') {
    input = evaluateAggregate(project.input, database);
  } else {
    input = evaluateBranch(project.input, database);
  }
  return input.map(row => {
    const output: EvaluatedRow = {};
    for (const field of project.outputs) {
      if (field.kind === 'concept') {output[field.as] = row[coreColumn(field.concept)];}
      else if (field.kind === 'composed_aggregate') {output[field.as] = row[`${field.source_id}__${field.measure_as}`];}
      else {output[field.as] = row[field.measure_as];}
    }
    output[PLANNED_INTEGRITY_FIELD] = row[PLANNED_INTEGRITY_FIELD] === true && projectedRelationshipIntegrity(project, row);
    return output;
  });
}

function projectedRelationshipIntegrity(project: PlannedCoreProjectNode, row: EvaluatedRow): boolean {
  if (project.input.op !== 'join') {return true;}
  const join = project.input;
  if (!join.integrity.includes('non_null_requested_to_concepts')) {return true;}
  const relationship = SEMANTIC_CATALOG.relationships.find(item => item.id === join.relationship_id)!;
  return project.outputs.every(output => {
    if (output.kind !== 'concept' || output.concept.source_id !== relationship.to_source ||
        relationship.to_keys.includes(output.concept.concept_id)) {return true;}
    const value = row[coreColumn(output.concept)];
    return value !== null && value !== undefined && (output.concept.physical_type !== 'text' || String(value).trim().length > 0);
  });
}

function evaluateCompose(
  compose: Extract<PlannedCoreProjectNode['input'], { op: 'compose' }>,
  database: PlannedReferenceDatabase
): EvaluatedRow[] {
  const children = compose.inputs.map(input => {
    if (input.input.op !== 'filter') {throw new Error('planned interpreter requires filtered scalar inputs');}
    return {
      sourceId: input.input.input.source_id,
      rows: evaluateAggregate(input, database),
      measures: input.measures
    };
  });
  const output: EvaluatedRow = {};
  let integrity = children.every(child => child.rows.length === 1);
  for (const child of children) {
    const row = child.rows[0] ?? {};
    for (const measure of child.measures) {
      output[`${child.sourceId}__${measure.as}`] = row[measure.as];
    }
    integrity = integrity && row[PLANNED_INTEGRITY_FIELD] === true;
  }
  output[PLANNED_INTEGRITY_FIELD] = integrity;
  return [output];
}

function evaluateJoin(join: Extract<PlannedCoreProjectNode['input'], { op: 'join' }>, database: PlannedReferenceDatabase): EvaluatedRow[] {
  const left = evaluateBranch(join.left, database);
  const right = evaluateBranch(join.right, database);
  const output: EvaluatedRow[] = [];
  for (const leftRow of left) {
    const matches = right.filter(rightRow => join.left_keys.every((leftKey, index) =>
      leftRow[coreColumn(leftKey)] === rightRow[coreColumn(join.right_keys[index])]));
    if (matches.length === 0 && join.type === 'left') {
      output.push({ ...leftRow, [PLANNED_INTEGRITY_FIELD]: false });
    }
    for (const rightRow of matches) {
      output.push({
        ...leftRow,
        ...rightRow,
        [PLANNED_INTEGRITY_FIELD]: leftRow[PLANNED_INTEGRITY_FIELD] === true && rightRow[PLANNED_INTEGRITY_FIELD] === true
      });
    }
  }
  return output;
}

function evaluateAggregate(aggregate: PlannedCoreAggregateNode, database: PlannedReferenceDatabase): EvaluatedRow[] {
  const branch = evaluateBranchResult(aggregate.input, database);
  const rows = branch.rows;
  const groups = new Map<string, EvaluatedRow[]>();
  for (const row of rows) {
    const key = JSON.stringify(aggregate.group_by.map(group => row[coreColumn(group)]));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (aggregate.group_by.length === 0 && groups.size === 0) {groups.set('[]', []);}
  return [...groups.values()].map(groupRows => {
    const result: EvaluatedRow = {};
    for (const group of aggregate.group_by) {result[coreColumn(group)] = groupRows[0]?.[coreColumn(group)];}
    for (const measure of aggregate.measures) {
      const values = groupRows.map(row => row[coreColumn(measure)]).filter(value => value !== null && value !== undefined);
      if (measure.function === 'count') {result[measure.as] = values.length;}
      else if (values.length === 0) {result[measure.as] = null;}
      else {result[measure.as] = values.reduce((selected, value) => {
        const comparison = compareValues(value, selected, measure.semantic_type, 'last');
        if (measure.function === 'min') {
          return comparison < 0 ? value : selected;
        }
        return comparison > 0 ? value : selected;
      });}
    }
    result[PLANNED_INTEGRITY_FIELD] = groupRows.length === 0
      ? branch.integrity
      : groupRows.every(row => row[PLANNED_INTEGRITY_FIELD] === true);
    return result;
  });
}

function evaluateBranch(branch: PlannedCoreRowBranch, database: PlannedReferenceDatabase): EvaluatedRow[] {
  return evaluateBranchResult(branch, database).rows;
}

function evaluateBranchResult(branch: PlannedCoreRowBranch, database: PlannedReferenceDatabase): EvaluatedBranch {
  if (branch.op !== 'filter') {throw new Error('planned interpreter requires an explicitly filtered source');}
  const source = SEMANTIC_CATALOG.sources.find(item => item.id === branch.input.source_id)!;
  const sourceRows = database[branch.input.source_id] ?? [];
  const scopePredicates = branch.predicates.filter(predicate => ['season', 'round'].includes(predicate.concept.semantic_type));
  const rowPredicates = branch.predicates.filter(predicate => !['season', 'round'].includes(predicate.concept.semantic_type));
  const entityPredicates = rowPredicates.filter(isEntityPredicate);
  const integrityPredicates = rowPredicates.filter(predicate => !isEntityPredicate(predicate));
  const scoped = sourceRows.filter(row => scopePredicates.every(predicate => matchesPredicate(row[predicate.concept.concept_id], predicate)));
  const entityScoped = scoped.filter(row => entityPredicates.every(predicate => matchesPredicate(row[predicate.concept.concept_id], predicate)));
  const integrityRelevant = scoped.filter(row => integrityPredicates.every(predicate => matchesPredicate(row[predicate.concept.concept_id], predicate)));
  const relevant = entityScoped.filter(row => integrityPredicates.every(predicate => matchesPredicate(row[predicate.concept.concept_id], predicate)));
  const grainCounts = countsBy(scoped, source.grain.key);
  const position = source.measures.find(item => item.semantic_type === 'position');
  const bounds = source.integrity.position_bounds.find(item => item.measure_id === position?.id);
  const entityPresence = entityPredicates.every(predicate => {
    const expected = expectedEntityCount(predicate);
    if (expected === null) {return true;}
    return new Set(entityScoped.map(row => row[predicate.concept.concept_id])).size === expected;
  });
  const sourcePresent = !branch.integrity.includes('source_presence') || (scoped.length > 0 && entityPresence);
  const uniqueGrain = !branch.integrity.some(check => check === 'unique_grain' || check === 'unique_event_key') || [...grainCounts.values()].every(count => count === 1);
  const validGrain = !branch.integrity.some(check => check === 'unique_grain' || check === 'unique_event_key') ||
    scoped.every(row => source.grain.key.every(key => {
      const concept = [...source.dimensions, ...source.measures].find(item => item.id === key)!;
      return validSourceGrainValue(row[key], concept.semantic_type, source.scope);
    }));
  const positionsBounded = !position || !bounds || !branch.integrity.includes('position_bounds') || scoped.every(row => {
    const value = row[position.id];
    return value === null || value === undefined || (typeof value === 'number' && value >= bounds.min && (bounds.max === null || value <= bounds.max));
  });
  const positionKeys = position ? ['season', 'round', position.id].filter(key => source.grain.key.includes(key) || key === position.id) : [];
  const positionCounts = position ? countsBy(integrityRelevant.filter(row => row[position.id] !== null && row[position.id] !== undefined), positionKeys) : new Map<string, number>();
  const nonNullPosition = !position || !branch.integrity.includes('non_null_position') ||
    integrityRelevant.every(row => row[position.id] !== null && row[position.id] !== undefined);
  const uniquePosition = !position || !branch.integrity.includes('unique_relevant_position') ||
    [...positionCounts.values()].every(count => count === 1);
  const integrity = sourcePresent && uniqueGrain && validGrain && positionsBounded && nonNullPosition && uniquePosition;
  const rows = relevant.map(row => {
    const output: EvaluatedRow = {};
    for (const concept of [...source.dimensions, ...source.measures]) {
      if (concept.physical_field !== null) {output[`${source.id}__${concept.id}`] = normalizePhysicalValue(row[concept.id], concept.physical_type);}
    }
    output[PLANNED_INTEGRITY_FIELD] = integrity;
    return output;
  });
  return { rows, integrity };
}

function validSourceGrainValue(
  value: unknown,
  semanticType: string,
  scope: { readonly season_min: number | null; readonly season_max: number | null }
): boolean {
  if (value === null || value === undefined) {return false;}
  if (semanticType === 'round') {return validRound(value);}
  if (semanticType === 'season') {return validSeason(value, scope);}
  if (['circuit_id', 'driver_id', 'event_id', 'team_id'].includes(semanticType)) {
    return validCanonicalIdentifier(value);
  }
  return true;
}

function validRound(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 30;
}

function validSeason(
  value: unknown,
  scope: { readonly season_min: number | null; readonly season_max: number | null }
): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    (scope.season_min === null || value >= scope.season_min) &&
    (scope.season_max === null || value <= scope.season_max);
}

function validCanonicalIdentifier(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function matchesPredicate(value: unknown, predicate: PlannedCorePredicate): boolean {
  if (value === null || value === undefined) {return false;}
  if (predicate.operator === 'eq') {return value === predicate.value;}
  if (predicate.operator === 'in') {return predicate.values.includes(value as never);}
  return compareValues(value, predicate.min, predicate.concept.semantic_type, 'last') >= 0 &&
    compareValues(value, predicate.max, predicate.concept.semantic_type, 'last') <= 0;
}

function countsBy(rows: Array<Record<string, unknown>>, keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = rowKey(row, keys);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function rowKey(row: Record<string, unknown>, keys: string[]): string {
  return JSON.stringify(keys.map(key => row[key]));
}

function compareValues(left: unknown, right: unknown, semanticType: string, nulls: 'first' | 'last'): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) {return 0;}
    return leftNull === (nulls === 'first') ? -1 : 1;
  }
  if (['circuit_id', 'date', 'driver_id', 'event_id', 'status', 'team_id', 'text'].includes(semanticType)) {
    return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
  }
  if (semanticType === 'number') {return compareExactDecimals(left, right);}
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (leftNumber < rightNumber) {return -1;}
  return leftNumber > rightNumber ? 1 : 0;
}

function isEntityPredicate(predicate: PlannedCorePredicate): boolean {
  return ['circuit_id', 'driver_id', 'event_id', 'team_id'].includes(predicate.concept.semantic_type);
}

function normalizePhysicalValue(value: unknown, physicalType: string): unknown {
  if (value === null || value === undefined) {return value;}
  return physicalType === 'numeric' ? String(value) : value;
}

function compareExactDecimals(left: unknown, right: unknown): number {
  const leftParts = decimalParts(String(left));
  const rightParts = decimalParts(String(right));
  if (!leftParts || !rightParts) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (leftNumber < rightNumber) {
      return -1;
    }
    return leftNumber > rightNumber ? 1 : 0;
  }
  if (leftParts.negative !== rightParts.negative) {return leftParts.negative ? -1 : 1;}
  const direction = leftParts.negative ? -1 : 1;
  if (leftParts.integer.length !== rightParts.integer.length) {
    return leftParts.integer.length < rightParts.integer.length ? -direction : direction;
  }
  if (leftParts.integer !== rightParts.integer) {return leftParts.integer < rightParts.integer ? -direction : direction;}
  const width = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(width, '0');
  const rightFraction = rightParts.fraction.padEnd(width, '0');
  if (leftFraction === rightFraction) {return 0;}
  return leftFraction < rightFraction ? -direction : direction;
}

function expectedEntityCount(predicate: PlannedCorePredicate): number | null {
  if (predicate.operator === 'eq') {
    return 1;
  }
  if (predicate.operator === 'in') {
    return predicate.values.length;
  }
  return null;
}

function decimalParts(value: string): { negative: boolean; integer: string; fraction: string } | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {return null;}
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const zero = integer === '0' && fraction.length === 0;
  return { negative: match[1] === '-' && !zero, integer, fraction };
}

function compareSortValues(
  left: unknown,
  right: unknown,
  semanticType: string,
  direction: 'asc' | 'desc',
  nulls: 'first' | 'last'
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) {return 0;}
    return leftNull === (nulls === 'first') ? -1 : 1;
  }
  const comparison = compareValues(left, right, semanticType, nulls);
  return direction === 'asc' ? comparison : -comparison;
}

function coreColumn(concept: Pick<PlannedCoreConceptRef, 'source_id' | 'concept_id'>): string {
  return `${concept.source_id}__${concept.concept_id}`;
}
