import { CompiledF1QL } from './compiler';
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
import { validatePlannedCoreProgram } from './planned-f1ql';

export const PLANNED_INTEGRITY_FIELD = '__f1ql_integrity_ok';

interface SqlContext {
  params: unknown[];
}

interface SqlFragment {
  sql: string;
  integrity_field: string;
}

export function compilePlannedF1QL(input: PlannedCoreProgram): CompiledF1QL {
  const program = validatePlannedCoreProgram(input);
  const context: SqlContext = { params: [] };
  const project = compileProject(program.root.input.input, context);
  const order = program.root.input.keys.map(key => {
    const collation = key.physical_type === 'text' ? ' COLLATE "C"' : '';
    return `${quoteId(key.output_id)}${collation} ${key.direction.toUpperCase()} NULLS ${key.nulls.toUpperCase()}`;
  }).join(', ');
  context.params.push(program.root.count);
  return {
    sql: `SELECT * FROM (${project.sql}) AS planned_sorted ORDER BY ${order} LIMIT $${context.params.length}`,
    params: context.params
  };
}

function compileProject(project: PlannedCoreProjectNode, context: SqlContext): SqlFragment {
  let input: SqlFragment;
  if (project.input.op === 'join') {
    input = compileJoin(project.input, context);
  } else if (project.input.op === 'aggregate') {
    input = compileAggregate(project.input, context);
  } else {
    input = compileBranch(project.input, context);
  }
  const outputs = project.outputs.map(output => {
    if (output.kind === 'aggregate') {return `${quoteId(output.measure_as)} AS ${quoteId(output.as)}`;}
    return `${quoteId(coreColumn(output.concept))} AS ${quoteId(output.as)}`;
  });
  return {
    sql: `SELECT ${outputs.join(', ')}, ${quoteId(input.integrity_field)} AS ${quoteId(PLANNED_INTEGRITY_FIELD)} FROM (${input.sql}) AS planned_project_input`,
    integrity_field: PLANNED_INTEGRITY_FIELD
  };
}

function compileAggregate(aggregate: PlannedCoreAggregateNode, context: SqlContext): SqlFragment {
  const groups = aggregate.group_by.map(group => quoteId(coreColumn(group)));
  const measures = aggregate.measures.map(measure => {
    const field = quoteId(coreColumn(measure));
    if (measure.function === 'count') {return `COUNT(${field})::integer AS ${quoteId(measure.as)}`;}
    return `${measure.function.toUpperCase()}(${field}) AS ${quoteId(measure.as)}`;
  });
  if (groups.length === 0) {
    if (aggregate.input.op !== 'filter') {throw new Error('planned compiler requires an explicitly filtered source');}
    const parts = compileBranchParts(aggregate.input, context);
    return {
      sql: `${parts.with_sql} SELECT ${[...measures, `(${parts.integrity_sql}) AS ${quoteId(PLANNED_INTEGRITY_FIELD)}`].join(', ')} FROM planned_relevant`,
      integrity_field: PLANNED_INTEGRITY_FIELD
    };
  }
  const input = compileBranch(aggregate.input, context);
  const select = [...groups, ...measures, `COALESCE(bool_and(${quoteId(input.integrity_field)}), false) AS ${quoteId(PLANNED_INTEGRITY_FIELD)}`];
  return {
    sql: `SELECT ${select.join(', ')} FROM (${input.sql}) AS planned_aggregate_input GROUP BY ${groups.join(', ')}`,
    integrity_field: PLANNED_INTEGRITY_FIELD
  };
}

function compileJoin(join: Extract<PlannedCoreProjectNode['input'], { op: 'join' }>, context: SqlContext): SqlFragment {
  const left = compileBranch(join.left, context);
  const right = compileBranch(join.right, context);
  const on = join.left_keys.map((leftKey, index) =>
    `planned_left.${quoteId(coreColumn(leftKey))} = planned_right.${quoteId(coreColumn(join.right_keys[index]))}`).join(' AND ');
  const joinType = join.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
  return {
    sql: `SELECT planned_left.*, planned_right.*, (planned_left.${quoteId(left.integrity_field)} AND COALESCE(planned_right.${quoteId(right.integrity_field)}, false)) AS ${quoteId(PLANNED_INTEGRITY_FIELD)} FROM (${left.sql}) AS planned_left ${joinType} (${right.sql}) AS planned_right ON ${on}`,
    integrity_field: PLANNED_INTEGRITY_FIELD
  };
}

function compileBranch(branch: PlannedCoreRowBranch, context: SqlContext): SqlFragment {
  if (branch.op !== 'filter') {throw new Error('planned compiler requires an explicitly filtered source');}
  const parts = compileBranchParts(branch, context);
  return {
    sql: `${parts.with_sql} SELECT *, (${parts.integrity_sql}) AS ${quoteId(parts.integrity_field)} FROM planned_relevant`,
    integrity_field: parts.integrity_field
  };
}

function compileBranchParts(branch: Extract<PlannedCoreRowBranch, { op: 'filter' }>, context: SqlContext): {
  with_sql: string;
  integrity_sql: string;
  integrity_field: string;
} {
  const source = SEMANTIC_CATALOG.sources.find(item => item.id === branch.input.source_id)!;
  const concepts = [...source.dimensions, ...source.measures].filter(concept => concept.physical_field !== null);
  const scopePredicates = branch.predicates.filter(predicate => ['season', 'round'].includes(predicate.concept.semantic_type));
  const rowPredicates = branch.predicates.filter(predicate => !['season', 'round'].includes(predicate.concept.semantic_type));
  const entityPredicates = rowPredicates.filter(isEntityPredicate);
  const integrityPredicates = rowPredicates.filter(predicate => !isEntityPredicate(predicate));
  const scopeSql = compilePredicates(scopePredicates, context, null);
  const entitySql = compilePredicates(entityPredicates, context, '');
  const integritySql = compilePredicates(integrityPredicates, context, '');
  const projected = concepts.map(concept => `${quoteId(concept.physical_field!)} AS ${quoteId(`${source.id}__${concept.id}`)}`);
  const integrity = compileSourceIntegrity(branch, source.id as PlannedCoreSourceId);
  return {
    with_sql: `WITH planned_scope AS (SELECT ${projected.join(', ')} FROM ${source.view}${scopeSql ? ` WHERE ${scopeSql}` : ''}), planned_entity_scope AS (SELECT * FROM planned_scope${entitySql ? ` WHERE ${entitySql}` : ''}), planned_integrity_relevant AS (SELECT * FROM planned_scope${integritySql ? ` WHERE ${integritySql}` : ''}), planned_relevant AS (SELECT * FROM planned_entity_scope${integritySql ? ` WHERE ${integritySql}` : ''})`,
    integrity_sql: integrity,
    integrity_field: sourceIntegrityField(source.id)
  };
}

function compileSourceIntegrity(branch: Extract<PlannedCoreRowBranch, { op: 'filter' }>, sourceId: PlannedCoreSourceId): string {
  const source = SEMANTIC_CATALOG.sources.find(item => item.id === sourceId)!;
  const checks: string[] = [];
  if (branch.integrity.includes('source_presence')) {
    checks.push('EXISTS (SELECT 1 FROM planned_scope)');
    for (const predicate of branch.predicates.filter(isEntityPredicate)) {
      const expected = expectedEntityCount(predicate);
      if (expected !== null) {
        checks.push(`(SELECT count(DISTINCT ${quoteId(coreColumn(predicate.concept))}) FROM planned_entity_scope) = ${expected}`);
      }
    }
  }
  if (branch.integrity.includes('unique_grain') || branch.integrity.includes('unique_event_key')) {
    checks.push(`NOT EXISTS (SELECT 1 FROM planned_scope GROUP BY ${source.grain.key.map(key => quoteId(`${source.id}__${key}`)).join(', ')} HAVING count(*) > 1)`);
  }
  const position = source.measures.find(item => item.semantic_type === 'position');
  const bounds = source.integrity.position_bounds.find(item => item.measure_id === position?.id);
  if (position && bounds && branch.integrity.includes('position_bounds')) {
    const column = quoteId(`${source.id}__${position.id}`);
    const maximum = bounds.max === null ? '' : ` AND ${column} <= ${bounds.max}`;
    checks.push(`NOT EXISTS (SELECT 1 FROM planned_scope WHERE ${column} IS NOT NULL AND NOT (${column} >= ${bounds.min}${maximum}))`);
  }
  if (position && branch.integrity.includes('non_null_position')) {
    checks.push(`NOT EXISTS (SELECT 1 FROM planned_integrity_relevant WHERE ${quoteId(`${source.id}__${position.id}`)} IS NULL)`);
  }
  if (position && branch.integrity.includes('unique_relevant_position')) {
    const partition = ['season', 'round', position.id].filter(id => source.dimensions.some(item => item.id === id) || source.measures.some(item => item.id === id));
    const positionColumn = quoteId(`${source.id}__${position.id}`);
    checks.push(`NOT EXISTS (SELECT 1 FROM planned_integrity_relevant WHERE ${positionColumn} IS NOT NULL GROUP BY ${partition.map(id => quoteId(`${source.id}__${id}`)).join(', ')} HAVING count(*) > 1)`);
  }
  return checks.length > 0 ? checks.map(check => `(${check})`).join(' AND ') : 'true';
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

function compilePredicates(predicates: PlannedCorePredicate[], context: SqlContext, qualifier: string | null): string {
  return predicates.map(predicate => {
    const columnName = coreColumn(predicate.concept);
    const column = qualifier === null
      ? quoteId(predicate.concept.physical_field)
      : `${qualifier ? `${qualifier}.` : ''}${quoteId(columnName)}`;
    if (predicate.operator === 'eq') {
      context.params.push(predicate.value);
      return `${column} = $${context.params.length}`;
    }
    if (predicate.operator === 'in') {
      const placeholders = predicate.values.map(value => {
        context.params.push(value);
        return `$${context.params.length}`;
      });
      return `${column} IN (${placeholders.join(', ')})`;
    }
    context.params.push(predicate.min, predicate.max);
    return `${column} BETWEEN $${context.params.length - 1} AND $${context.params.length}`;
  }).join(' AND ');
}

function isEntityPredicate(predicate: PlannedCorePredicate): boolean {
  return ['circuit_id', 'driver_id', 'event_id', 'team_id'].includes(predicate.concept.semantic_type);
}

function coreColumn(concept: Pick<PlannedCoreConceptRef, 'source_id' | 'concept_id'>): string {
  return `${concept.source_id}__${concept.concept_id}`;
}

function sourceIntegrityField(sourceId: string): string {
  return `__${sourceId}_integrity_ok`;
}

function quoteId(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {throw new Error(`unsafe planned SQL identifier ${value}`);}
  return `"${value}"`;
}
