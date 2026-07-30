import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PlannedCoreAggregateNode,
  PlannedCoreComposeNode,
  PlannedCoreConceptRef,
  PlannedCoreFilterNode,
  PlannedCoreJoinNode,
  PlannedCoreLimitNode,
  PlannedCorePhysicalType,
  PlannedCorePredicate,
  PlannedCoreProgram,
  PlannedCoreProjectNode,
  PlannedCoreProjectOutput,
  PlannedCoreResultField,
  PlannedCoreRowBranch,
  PlannedCoreSemanticType,
  PlannedCoreSourceId,
  PlannedCoreSourceNode,
  PlannedCoreSortNode
} from './core';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH, SemanticCatalogSource } from './semantic-catalog';

export const PLANNED_F1QL_VERSION = 2 as const;
export const PLANNED_F1QL_DIALECT = 'planned_f1ql_v2' as const;
export const PLANNED_F1QL_COST_MODEL_VERSION = 'planned-cost-v1' as const;
export const PLANNED_F1QL_MAX_ROWS = 100;
export const PLANNED_F1QL_MAX_WORK_UNITS = 60;
export const PLANNED_SCALAR_INPUT_CARDINALITY = 'scalar_input_cardinality' as const;

const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const sourceIdSchema = z.enum(['driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification']);
const literalSchema = z.union([z.string().min(1).max(200), z.number().finite(), z.boolean()]);
const conceptRefSchema = z.object({ source_id: sourceIdSchema, concept_id: idSchema }).strict();
const predicateSchema = z.discriminatedUnion('operator', [
  z.object({ concept: conceptRefSchema, operator: z.literal('eq'), value: literalSchema }).strict(),
  z.object({ concept: conceptRefSchema, operator: z.literal('in'), values: z.array(literalSchema).min(1).max(20) }).strict(),
  z.object({ concept: conceptRefSchema, operator: z.literal('range'), min: literalSchema, max: literalSchema }).strict()
]);
const sourceSchema = z.object({ op: z.literal('source'), source_id: sourceIdSchema }).strict();
const filterSchema = z.object({
  op: z.literal('filter'),
  input: sourceSchema,
  predicates: z.array(predicateSchema).min(1).max(8)
}).strict();
const rowBranchSchema = z.union([sourceSchema, filterSchema]);
const joinSchema = z.object({
  op: z.literal('join'),
  relationship_id: idSchema,
  left: rowBranchSchema,
  right: rowBranchSchema
}).strict();
const aggregateMeasureSchema = z.object({
  concept: conceptRefSchema,
  function: z.enum(['count', 'max', 'min', 'sum']),
  as: idSchema
}).strict();
const aggregateSchema = z.object({
  op: z.literal('aggregate'),
  input: rowBranchSchema,
  group_by: z.array(conceptRefSchema).max(3),
  measures: z.array(aggregateMeasureSchema).min(1).max(4)
}).strict();
const composeSchema = z.object({
  op: z.literal('compose'),
  inputs: z.array(aggregateSchema).min(2).max(4)
}).strict();
const projectOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('concept'), concept: conceptRefSchema, as: idSchema }).strict(),
  z.object({ kind: z.literal('aggregate'), measure_as: idSchema, as: idSchema }).strict(),
  z.object({ kind: z.literal('composed_aggregate'), source_id: sourceIdSchema, measure_as: idSchema, as: idSchema }).strict()
]);
const projectSchema = z.object({
  op: z.literal('project'),
  input: z.union([rowBranchSchema, joinSchema, aggregateSchema, composeSchema]),
  outputs: z.array(projectOutputSchema).min(1).max(8)
}).strict();
const sortSchema = z.object({
  op: z.literal('sort'),
  input: projectSchema,
  keys: z.array(z.object({
    output_id: idSchema,
    direction: z.enum(['asc', 'desc']),
    nulls: z.enum(['first', 'last'])
  }).strict()).min(1).max(4)
}).strict();
const limitSchema = z.object({
  op: z.literal('limit'),
  input: sortSchema,
  count: z.number().int().min(1).max(PLANNED_F1QL_MAX_ROWS)
}).strict();
const plannedProgramSchema = z.object({
  kind: z.literal('internal_planned_f1ql'),
  version: z.literal(PLANNED_F1QL_VERSION),
  catalog_hash: z.string().regex(/^[a-f0-9]{64}$/),
  root: limitSchema
}).strict();

const corePhysicalTypeSchema = z.enum(['boolean', 'date', 'integer', 'numeric', 'text']);
const coreSemanticTypeSchema = z.enum([
  'boolean', 'circuit_id', 'date', 'driver_id', 'duration_ms', 'event_id', 'number',
  'position', 'round', 'season', 'status', 'team_id', 'text'
]);
const coreConceptSchema = z.object({
  source_id: sourceIdSchema,
  concept_id: idSchema,
  physical_field: idSchema,
  physical_type: corePhysicalTypeSchema,
  semantic_type: coreSemanticTypeSchema,
  nullable: z.boolean()
}).strict();
const corePredicateSchema = z.discriminatedUnion('operator', [
  z.object({ concept: coreConceptSchema, operator: z.literal('eq'), value: literalSchema }).strict(),
  z.object({ concept: coreConceptSchema, operator: z.literal('in'), values: z.array(literalSchema).min(1).max(20) }).strict(),
  z.object({ concept: coreConceptSchema, operator: z.literal('range'), min: z.union([z.string(), z.number()]), max: z.union([z.string(), z.number()]) }).strict()
]);
const coreIntegritySchema = z.array(idSchema).min(1).max(20);
const coreSourceSchema = z.object({
  op: z.literal('source'), source_id: sourceIdSchema, view: z.string().min(1).max(200),
  grain: z.array(coreConceptSchema).min(1).max(5), integrity: coreIntegritySchema
}).strict();
const coreFilterSchema = z.object({
  op: z.literal('filter'), input: coreSourceSchema,
  predicates: z.array(corePredicateSchema).min(1).max(8), integrity: coreIntegritySchema
}).strict();
const coreJoinSchema = z.object({
  op: z.literal('join'), relationship_id: idSchema, left: coreFilterSchema, right: coreFilterSchema,
  type: z.enum(['inner', 'left']), cardinality: z.enum(['many_to_many', 'many_to_one', 'one_to_many', 'one_to_one']),
  left_keys: z.array(coreConceptSchema).min(1).max(5), right_keys: z.array(coreConceptSchema).min(1).max(5),
  output_grain: z.array(coreConceptSchema).min(1).max(5), integrity: coreIntegritySchema
}).strict();
const coreAggregateMeasureSchema = z.object({
  source_id: sourceIdSchema, concept_id: idSchema, physical_field: idSchema,
  physical_type: corePhysicalTypeSchema, semantic_type: coreSemanticTypeSchema,
  function: z.enum(['count', 'max', 'min', 'sum']), as: idSchema
}).strict();
const coreAggregateSchema = z.object({
  op: z.literal('aggregate'), input: coreFilterSchema,
  group_by: z.array(coreConceptSchema).max(3), measures: z.array(coreAggregateMeasureSchema).min(1).max(4),
  output_grain: z.array(coreConceptSchema).max(3), integrity: coreIntegritySchema
}).strict();
const coreComposeSchema = z.object({
  op: z.literal('compose'), inputs: z.array(coreAggregateSchema).min(2).max(4),
  output_grain: z.tuple([]), integrity: coreIntegritySchema
}).strict();
const coreProjectOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('concept'), as: idSchema, concept: coreConceptSchema }).strict(),
  z.object({
    kind: z.literal('aggregate'), as: idSchema, measure_as: idSchema,
    physical_type: corePhysicalTypeSchema, semantic_type: coreSemanticTypeSchema, nullable: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal('composed_aggregate'), source_id: sourceIdSchema, as: idSchema, measure_as: idSchema,
    physical_type: corePhysicalTypeSchema, semantic_type: coreSemanticTypeSchema, nullable: z.boolean()
  }).strict()
]);
const coreProjectSchema = z.object({
  op: z.literal('project'), input: z.union([coreFilterSchema, coreJoinSchema, coreAggregateSchema, coreComposeSchema]),
  outputs: z.array(coreProjectOutputSchema).min(1).max(8), output_grain: z.array(idSchema).max(5),
  integrity: coreIntegritySchema
}).strict();
const coreSortSchema = z.object({
  op: z.literal('sort'), input: coreProjectSchema,
  keys: z.array(z.object({
    output_id: idSchema, direction: z.enum(['asc', 'desc']), nulls: z.enum(['first', 'last']),
    physical_type: corePhysicalTypeSchema, semantic_type: coreSemanticTypeSchema
  }).strict()).min(1).max(4)
}).strict();
const coreProgramSchema = z.object({
  version: z.literal(PLANNED_F1QL_VERSION), dialect: z.literal(PLANNED_F1QL_DIALECT),
  catalog_hash: z.string().regex(/^[a-f0-9]{64}$/), parent_program_hash: z.string().regex(/^[a-f0-9]{64}$/),
  root: z.object({ op: z.literal('limit'), input: coreSortSchema, count: z.number().int().min(1).max(PLANNED_F1QL_MAX_ROWS) }).strict(),
  result_schema: z.array(z.object({
    id: idSchema, physical_type: corePhysicalTypeSchema, semantic_type: coreSemanticTypeSchema, nullable: z.boolean()
  }).strict()).min(1).max(8)
}).strict();

export type PlannedF1QLProgram = z.infer<typeof plannedProgramSchema>;
export type PlannedConceptRef = z.infer<typeof conceptRefSchema>;
export type PlannedPredicate = z.infer<typeof predicateSchema>;
export type PlannedRowBranch = z.infer<typeof rowBranchSchema>;
export type PlannedJoin = z.infer<typeof joinSchema>;
export type PlannedAggregate = z.infer<typeof aggregateSchema>;
export type PlannedCompose = z.infer<typeof composeSchema>;
export type PlannedProject = z.infer<typeof projectSchema>;

type CatalogDimension = SemanticCatalogSource['dimensions'][number];
type CatalogMeasure = SemanticCatalogSource['measures'][number];
type CatalogConcept =
  | { kind: 'dimension'; value: CatalogDimension }
  | { kind: 'measure'; value: CatalogMeasure };

export interface PlannedF1QLCost {
  readonly version: typeof PLANNED_F1QL_COST_MODEL_VERSION;
  readonly units: number;
  readonly sources: number;
  readonly joins: number;
  readonly depth: number;
  readonly requested_rows: number;
}

export type PlannedParticipationDecision =
  | { readonly type: 'not_required' }
  | { readonly type: 'required'; readonly requirements: ReadonlyArray<{ season: number; driver_ids: readonly string[] }> };

export function parsePlannedF1QLProgram(input: unknown): PlannedF1QLProgram {
  const program = plannedProgramSchema.parse(input);
  validatePlannedSemantics(program);
  return deepFreeze(program);
}

export function getPlannedF1QLProgramHash(input: unknown): string {
  const program = parsePlannedF1QLProgram(input);
  return sha256(stableSerialize(program));
}

export function estimatePlannedF1QLCost(input: unknown): PlannedF1QLCost {
  const program = parsePlannedF1QLProgram(input);
  const projectInput = program.root.input.input.input;
  const branches = inputBranches(projectInput);
  const units = branches.reduce((total, branch) => total + branchWork(branch), 0);
  let depth = 4;
  if (projectInput.op === 'compose') {depth = 6;}
  else if (projectInput.op === 'join' || projectInput.op === 'aggregate') {depth = 5;}
  const cost: PlannedF1QLCost = {
    version: PLANNED_F1QL_COST_MODEL_VERSION,
    units,
    sources: branches.length,
    joins: projectInput.op === 'join' ? 1 : 0,
    depth,
    requested_rows: program.root.count
  };
  if (cost.units < 1 || cost.units > PLANNED_F1QL_MAX_WORK_UNITS) {
    throw new Error(`planned F1QL work exceeds ${PLANNED_F1QL_MAX_WORK_UNITS} units`);
  }
  return deepFreeze(cost);
}

export function decidePlannedParticipation(input: unknown): PlannedParticipationDecision {
  const program = parsePlannedF1QLProgram(input);
  const projectInput = program.root.input.input.input;
  const branches = inputBranches(projectInput);
  const bySeason = new Map<number, Set<string>>();
  for (const branch of branches) {
    const season = scalarPredicate(branch, 'season');
    for (const driverId of predicateValues(branch, 'driver_id')) {
      const drivers = bySeason.get(season) ?? new Set<string>();
      drivers.add(String(driverId));
      bySeason.set(season, drivers);
    }
  }
  if (bySeason.size === 0) {return deepFreeze({ type: 'not_required' });}
  const requirements = [...bySeason.entries()].sort(([left], [right]) => left - right).map(([season, drivers]) => ({
    season,
    driver_ids: [...drivers].sort(compareText)
  }));
  return deepFreeze({ type: 'required', requirements });
}

export function lowerPlannedF1QL(input: unknown): PlannedCoreProgram {
  const program = parsePlannedF1QLProgram(input);
  const programHash = sha256(stableSerialize(program));
  const rankedSources = rankedSourcesForPlan(program.root.input.input, program.root.input.keys.map(key => key.output_id));
  const project = lowerProject(program.root.input.input, rankedSources);
  const outputById = new Map(project.outputs.map(output => [output.as, resultField(output)]));
  const sort: PlannedCoreSortNode = {
    op: 'sort',
    input: project,
    keys: program.root.input.keys.map(key => {
      const output = outputById.get(key.output_id)!;
      return { ...key, physical_type: output.physical_type, semantic_type: output.semantic_type };
    })
  };
  const root: PlannedCoreLimitNode = { op: 'limit', input: sort, count: program.root.count };
  const core: PlannedCoreProgram = {
    version: PLANNED_F1QL_VERSION,
    dialect: PLANNED_F1QL_DIALECT,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    parent_program_hash: programHash,
    root,
    result_schema: project.outputs.map(resultField)
  };
  validatePlannedCoreProgram(core);
  return deepFreeze(core);
}

export function getPlannedCoreProgramHash(input: PlannedCoreProgram): string {
  return sha256(stableSerialize(validatePlannedCoreProgram(input)));
}

export function validatePlannedCoreProgram(input: unknown): PlannedCoreProgram {
  const program = coreProgramSchema.parse(input) as PlannedCoreProgram;
  if (program.catalog_hash !== SEMANTIC_CATALOG_HASH) {throw new Error('invalid planned Core program envelope');}
  const project = program.root.input.input;
  const rankedSources = rankedSourcesForCore(project, program.root.input.keys.map(key => key.output_id));
  validateCoreInput(project.input, rankedSources);
  if (project.input.op === 'compose' && program.root.count !== 1) {
    throw new Error('planned Core scalar composition requires limit 1');
  }
  assertUnique(project.outputs.map(output => output.as), 'planned Core outputs');
  assertUnique(program.root.input.keys.map(key => key.output_id), 'planned Core sort keys');
  validateCoreProject(project);
  const outputById = new Map(project.outputs.map(output => [output.as, resultField(output)]));
  for (const key of program.root.input.keys) {
    const output = outputById.get(key.output_id);
    if (!output || output.physical_type !== key.physical_type || output.semantic_type !== key.semantic_type) {
      throw new Error(`planned Core sort key ${key.output_id} does not match its output`);
    }
  }
  if (stableSerialize(program.result_schema) !== stableSerialize(project.outputs.map(resultField))) {
    throw new Error('planned Core result schema does not match projection');
  }
  for (const grainId of project.output_grain) {
    if (!outputById.has(grainId) || !program.root.input.keys.some(key => key.output_id === grainId)) {
      throw new Error(`planned Core ordering does not total-order grain field ${grainId}`);
    }
  }
  return deepFreeze(program);
}

function validatePlannedSemantics(program: PlannedF1QLProgram): void {
  if (program.catalog_hash !== SEMANTIC_CATALOG_HASH) {
    throw new Error('planned F1QL catalog hash mismatch');
  }
  const project = program.root.input.input;
  const input = project.input;
  if (input.op === 'join') {validateJoin(input);}
  else if (input.op === 'compose') {validateCompose(input, program.root.count);}
  else if (input.op === 'aggregate') {validateAggregate(input);}
  else {validateBranch(input);}

  let availableConcepts: PlannedCoreSourceId[];
  if (input.op === 'join') {
    availableConcepts = [...branchSources(input.left), ...branchSources(input.right)];
  } else if (input.op === 'compose') {
    availableConcepts = input.inputs.flatMap(item => branchSources(item.input));
  } else if (input.op === 'aggregate') {
    availableConcepts = branchSources(input.input);
  } else {
    availableConcepts = branchSources(input);
  }
  const aggregateMeasures = input.op === 'aggregate' ? new Map(input.measures.map(measure => [measure.as, measure])) : new Map();
  const composedMeasures = input.op === 'compose'
    ? new Map(input.inputs.flatMap(item => item.measures.map(measure => [composedMeasureKey(branchSource(item.input), measure.as), measure] as const)))
    : new Map<string, PlannedAggregate['measures'][number]>();
  const aggregateGroups = input.op === 'aggregate' ? input.group_by.map(refKey) : [];
  assertUnique(project.outputs.map(output => output.as), 'planned output IDs');
  for (const output of project.outputs) {
    if (output.kind === 'concept') {
      const concept = conceptFor(output.concept);
      if (!availableConcepts.includes(output.concept.source_id) || concept.value.physical_field === null || output.as !== output.concept.concept_id) {
        throw new Error(`planned concept output ${output.as} is unavailable or noncanonical`);
      }
      if (input.op === 'aggregate' && !aggregateGroups.includes(refKey(output.concept))) {
        throw new Error(`planned aggregate output ${output.as} is not grouped`);
      }
    } else if (output.kind === 'aggregate') {
      if (input.op !== 'aggregate' || !aggregateMeasures.has(output.measure_as) || output.as !== output.measure_as) {
        throw new Error(`planned aggregate output ${output.as} is unavailable or noncanonical`);
      }
    } else {
      const key = composedMeasureKey(output.source_id, output.measure_as);
      if (input.op !== 'compose' || !composedMeasures.has(key) || output.as !== key) {
        throw new Error(`planned composed output ${output.as} is unavailable or noncanonical`);
      }
    }
  }
  if (input.op === 'compose') {
    if (project.outputs.some(output => output.kind !== 'composed_aggregate')) {
      throw new Error('planned composition may project only composed child measures');
    }
    const actual = project.outputs.filter((output): output is Extract<typeof output, { kind: 'composed_aggregate' }> => output.kind === 'composed_aggregate')
      .map(output => composedMeasureKey(output.source_id, output.measure_as));
    const expected = [...composedMeasures.keys()].sort(compareText);
    if (stableSerialize(actual) !== stableSerialize(expected)) {
      throw new Error('planned composition must project every child measure exactly once');
    }
  }
  const outputIds = project.outputs.map(output => output.as);
  assertUnique(program.root.input.keys.map(key => key.output_id), 'planned sort keys');
  for (const key of program.root.input.keys) {
    if (!outputIds.includes(key.output_id)) {throw new Error(`planned sort key ${key.output_id} is not projected`);}
  }
  const grain = inputGrain(input);
  for (const ref of grain) {
    const output = project.outputs.find(item => item.kind === 'concept' && refKey(item.concept) === refKey(ref));
    if (!output || !program.root.input.keys.some(key => key.output_id === output.as)) {
      throw new Error(`planned output must project and order by grain key ${ref.concept_id}`);
    }
  }
}

function validateBranch(branch: PlannedRowBranch): void {
  const source = sourceFor(branch.op === 'filter' ? branch.input.source_id : branch.source_id);
  if (source.usage !== 'answer_fact') {throw new Error(`planned source ${source.id} is not answer-fact eligible`);}
  if (branch.op !== 'filter') {throw new Error(`planned source ${source.id} requires explicit scope predicates`);}
  assertUnique(branch.predicates.map(predicate => predicate.concept.concept_id), `predicates for ${source.id}`);
  assertCanonicalOrder(branch.predicates.map(predicate => refKey(predicate.concept)), `predicates for ${source.id}`);
  for (const predicate of branch.predicates) {
    if (predicate.concept.source_id !== source.id) {throw new Error('planned predicate source mismatch');}
    const concept = conceptFor(predicate.concept).value;
    if (!concept.filter_operators.includes(predicate.operator)) {throw new Error(`operator ${predicate.operator} is not allowed for ${source.id}.${concept.id}`);}
    const values = plannedPredicateLiterals(predicate);
    if (predicate.operator === 'in' && !isCanonicalLiterals(predicate.values)) {throw new Error(`values for ${source.id}.${concept.id} must be unique and sorted`);}
    for (const value of values) {validateLiteral(concept, value);}
    if (predicate.operator === 'range' && compareLiteral(predicate.min, predicate.max) > 0) {throw new Error(`range for ${source.id}.${concept.id} is inverted`);}
  }
  const season = scalarPredicate(branch, 'season');
  if (!Number.isSafeInteger(season) || (source.scope.season_min !== null && season < source.scope.season_min) ||
      (source.scope.season_max !== null && season > source.scope.season_max)) {
    throw new Error(`planned source ${source.id} requires one in-scope season`);
  }
}

function validateJoin(join: PlannedJoin): void {
  validateBranch(join.left);
  validateBranch(join.right);
  const relationship = SEMANTIC_CATALOG.relationships.find(item => item.id === join.relationship_id);
  if (!relationship || relationship.id !== 'race_event_metadata' || relationship.join_stage !== 'row' ||
      relationship.from_source !== branchSource(join.left) || relationship.to_source !== branchSource(join.right)) {
    throw new Error(`planned relationship ${join.relationship_id} is not a promoted row join`);
  }
  const leftSeason = scalarEqualityPredicate(join.left, 'season');
  const rightSeason = scalarEqualityPredicate(join.right, 'season');
  const leftRound = scalarEqualityPredicate(join.left, 'round');
  const rightRound = scalarEqualityPredicate(join.right, 'round');
  if (leftSeason !== rightSeason || leftRound !== rightRound) {throw new Error('planned join branches must have the same exact event scope');}
}

function validateAggregate(aggregate: PlannedAggregate): void {
  validateBranch(aggregate.input);
  const sourceId = branchSource(aggregate.input);
  assertUnique(aggregate.group_by.map(refKey), 'planned aggregate group keys');
  assertUnique(aggregate.measures.map(measure => measure.as), 'planned aggregate measure IDs');
  assertCanonicalOrder(aggregate.group_by.map(refKey), 'planned aggregate group keys');
  assertCanonicalOrder(aggregate.measures.map(measure => measure.as), 'planned aggregate measure IDs');
  for (const group of aggregate.group_by) {
    const concept = conceptFor(group);
    if (group.source_id !== sourceId || concept.kind !== 'dimension' || !concept.value.groupable) {
      throw new Error(`planned aggregate group ${refKey(group)} is not groupable`);
    }
  }
  for (const measure of aggregate.measures) {
    const concept = conceptFor(measure.concept);
    if (measure.concept.source_id !== sourceId || concept.kind !== 'measure' ||
        !concept.value.allowed_aggregations.includes(measure.function) ||
        measure.as !== `${measure.function}_${measure.concept.concept_id}`) {
      throw new Error(`planned aggregate measure ${measure.as} is not catalog-authorized`);
    }
  }
}

function validateCompose(compose: PlannedCompose, limit: number): void {
  if (limit !== 1) {throw new Error('planned scalar composition requires limit 1');}
  const sourceIds = compose.inputs.map(item => branchSource(item.input));
  assertUnique(sourceIds, 'planned composition sources');
  assertCanonicalOrder(sourceIds, 'planned composition sources');
  const seasons = compose.inputs.map(item => {
    validateAggregate(item);
    if (item.group_by.length !== 0) {throw new Error('planned composition inputs must be ungrouped aggregates');}
    return scalarEqualityPredicate(item.input, 'season');
  });
  if (!seasons.every(season => season === seasons[0])) {
    throw new Error('planned composition inputs must have the same scalar season');
  }
  const eventInputs = compose.inputs.filter(item => sourceFor(branchSource(item.input)).dimensions.some(concept => concept.id === 'round'));
  const rounds = eventInputs.map(item => optionalScalarEqualityPredicate(item.input, 'round'));
  const allOmitted = rounds.every(round => round === undefined);
  const allEqual = rounds.length > 0 && rounds.every(round => round !== undefined && round === rounds[0]);
  if (!allOmitted && !allEqual) {
    throw new Error('planned composition event inputs must omit round or share the same scalar round');
  }
}

function lowerProject(project: PlannedProject, rankedSources: ReadonlySet<string>): PlannedCoreProjectNode {
  let input: PlannedCoreProjectNode['input'];
  if (project.input.op === 'join') {
    input = lowerJoin(project.input, rankedSources);
  } else if (project.input.op === 'compose') {
    input = lowerCompose(project.input, rankedSources);
  } else if (project.input.op === 'aggregate') {
    input = lowerAggregate(project.input, rankedSources.has(branchSource(project.input.input)));
  } else {
    input = lowerBranch(project.input, rankedSources.has(branchSource(project.input)));
  }
  const outputs: PlannedCoreProjectOutput[] = project.outputs.map(output => {
    if (output.kind === 'concept') {return { kind: 'concept', as: output.as, concept: lowerConcept(output.concept) };}
    const aggregate = output.kind === 'aggregate'
      ? input as PlannedCoreAggregateNode
      : (input as PlannedCoreComposeNode).inputs.find(item => coreAggregateSourceId(item) === output.source_id)!;
    const measure = aggregate.measures.find(item => item.as === output.measure_as)!;
    const type = aggregateOutputType(measure);
    return output.kind === 'composed_aggregate'
      ? { kind: 'composed_aggregate', source_id: output.source_id, as: output.as, measure_as: output.measure_as, ...type }
      : { kind: 'aggregate', as: output.as, measure_as: output.measure_as, ...type };
  });
  const grainRefs = input.op === 'aggregate' || input.op === 'join' || input.op === 'compose'
    ? input.output_grain
    : residualCoreBranchGrain(input);
  const outputGrain = grainRefs.map(ref => outputs.find(output => output.kind === 'concept' &&
    output.concept.source_id === ref.source_id && output.concept.concept_id === ref.concept_id)?.as).filter((id): id is string => !!id);
  return { op: 'project', input, outputs, output_grain: outputGrain, integrity: input.integrity };
}

function lowerCompose(compose: PlannedCompose, rankedSources: ReadonlySet<string>): PlannedCoreComposeNode {
  const inputs = compose.inputs.map(item => lowerAggregate(item, rankedSources.has(branchSource(item.input))));
  return {
    op: 'compose', inputs, output_grain: [],
    integrity: sortedUnique([...inputs.flatMap(item => item.integrity), PLANNED_SCALAR_INPUT_CARDINALITY])
  };
}

function lowerBranch(branch: PlannedRowBranch, ranking: boolean): PlannedCoreFilterNode {
  if (branch.op !== 'filter') {throw new Error('planned source requires explicit filters before lowering');}
  const source = sourceFor(branch.input.source_id);
  const positionFiltered = branch.predicates.some(predicate => conceptFor(predicate.concept).value.semantic_type === 'position');
  const integrity = sourceIntegrity(source, positionFiltered, ranking);
  return {
    op: 'filter',
    input: lowerSource(source, integrity),
    predicates: branch.predicates.map(lowerPredicate),
    integrity
  };
}

function lowerSource(source: SemanticCatalogSource, integrity: string[]): PlannedCoreSourceNode {
  return {
    op: 'source', source_id: source.id as PlannedCoreSourceId, view: source.view,
    grain: source.grain.key.map(conceptId => lowerConcept({ source_id: source.id as PlannedCoreSourceId, concept_id: conceptId })),
    integrity
  };
}

function lowerJoin(join: PlannedJoin, rankedSources: ReadonlySet<string>): PlannedCoreJoinNode {
  const relationship = SEMANTIC_CATALOG.relationships.find(item => item.id === join.relationship_id)!;
  const left = lowerBranch(join.left, rankedSources.has(branchSource(join.left)));
  const right = lowerBranch(join.right, rankedSources.has(branchSource(join.right)));
  const integrity = sortedUnique([...left.integrity, ...right.integrity, ...relationship.required_checks]);
  return {
    op: 'join', relationship_id: relationship.id, left, right, type: relationship.optionality,
    cardinality: relationship.cardinality,
    left_keys: relationship.from_keys.map(conceptId => lowerConcept({ source_id: relationship.from_source as PlannedCoreSourceId, concept_id: conceptId })),
    right_keys: relationship.to_keys.map(conceptId => lowerConcept({ source_id: relationship.to_source as PlannedCoreSourceId, concept_id: conceptId })),
    output_grain: residualCoreBranchGrain(left),
    integrity
  };
}

function lowerAggregate(aggregate: PlannedAggregate, ranking: boolean): PlannedCoreAggregateNode {
  const input = lowerBranch(aggregate.input, ranking);
  const groupBy = aggregate.group_by.map(lowerConcept);
  return {
    op: 'aggregate', input, group_by: groupBy,
    measures: aggregate.measures.map(measure => {
      const concept = lowerConcept(measure.concept);
      return {
        source_id: concept.source_id, concept_id: concept.concept_id, physical_field: concept.physical_field,
        physical_type: concept.physical_type, semantic_type: concept.semantic_type,
        function: measure.function, as: measure.as
      };
    }),
    output_grain: groupBy,
    integrity: input.integrity
  };
}

function lowerPredicate(predicate: PlannedPredicate): PlannedCorePredicate {
  const concept = lowerConcept(predicate.concept);
  if (predicate.operator === 'eq') {return { concept, operator: 'eq', value: predicate.value };}
  if (predicate.operator === 'in') {return { concept, operator: 'in', values: [...predicate.values] };}
  return { concept, operator: 'range', min: predicate.min as string | number, max: predicate.max as string | number };
}

function plannedPredicateLiterals(predicate: PlannedPredicate): Array<string | number | boolean> {
  if (predicate.operator === 'eq') {
    return [predicate.value];
  }
  if (predicate.operator === 'in') {
    return predicate.values;
  }
  return [predicate.min, predicate.max];
}

function lowerConcept(ref: PlannedConceptRef): PlannedCoreConceptRef {
  const concept = conceptFor(ref).value;
  if (concept.physical_field === null) {throw new Error(`planned concept ${refKey(ref)} has no physical field`);}
  return {
    source_id: ref.source_id,
    concept_id: ref.concept_id,
    physical_field: concept.physical_field,
    physical_type: concept.physical_type as PlannedCorePhysicalType,
    semantic_type: concept.semantic_type as PlannedCoreSemanticType,
    nullable: concept.nullable
  };
}

function validateCoreInput(input: PlannedCoreProjectNode['input'], rankedSources: ReadonlySet<string>): void {
  if (input.op === 'join') {
    const left = requireCoreFilter(input.left);
    const right = requireCoreFilter(input.right);
    validateCoreBranch(left, rankedSources.has(left.input.source_id));
    validateCoreBranch(right, rankedSources.has(right.input.source_id));
    const relationship = SEMANTIC_CATALOG.relationships.find(item => item.id === input.relationship_id);
    if (!relationship || relationship.id !== 'race_event_metadata' || input.type !== relationship.optionality ||
        input.cardinality !== relationship.cardinality ||
        left.input.source_id !== relationship.from_source || right.input.source_id !== relationship.to_source ||
        stableSerialize(input.left_keys) !== stableSerialize(relationship.from_keys.map(conceptId => lowerConcept({ source_id: relationship.from_source as PlannedCoreSourceId, concept_id: conceptId }))) ||
        stableSerialize(input.right_keys) !== stableSerialize(relationship.to_keys.map(conceptId => lowerConcept({ source_id: relationship.to_source as PlannedCoreSourceId, concept_id: conceptId }))) ||
        stableSerialize(input.output_grain) !== stableSerialize(residualCoreBranchGrain(left)) ||
        stableSerialize(input.integrity) !== stableSerialize(sortedUnique([...left.integrity, ...right.integrity, ...relationship.required_checks]))) {
      throw new Error('planned Core join does not match the active catalog relationship');
    }
    validateJoin({
      op: 'join', relationship_id: input.relationship_id,
      left: plannedBranchFromCore(left), right: plannedBranchFromCore(right)
    });
  } else if (input.op === 'compose') {
    validateCoreCompose(input, rankedSources);
  } else if (input.op === 'aggregate') {
    validateCoreAggregate(input, rankedSources.has(coreAggregateSourceId(input)));
  } else {
    const filter = requireCoreFilter(input);
    validateCoreBranch(filter, rankedSources.has(filter.input.source_id));
  }
}

function validateCoreAggregate(input: PlannedCoreAggregateNode, ranking: boolean): void {
  const filter = requireCoreFilter(input.input);
  validateCoreBranch(filter, ranking);
  assertUnique(input.group_by.map(refKey), 'planned Core aggregate group keys');
  assertUnique(input.measures.map(measure => measure.as), 'planned Core aggregate measure IDs');
  assertCanonicalOrder(input.group_by.map(refKey), 'planned Core aggregate group keys');
  assertCanonicalOrder(input.measures.map(measure => measure.as), 'planned Core aggregate measure IDs');
  for (const group of input.group_by) {
    assertCoreConcept(group);
    const concept = conceptFor(group);
    if (group.source_id !== filter.input.source_id || concept.kind !== 'dimension' || !concept.value.groupable) {
      throw new Error('planned Core aggregate group is not catalog-authorized');
    }
  }
  for (const measure of input.measures) {
    const catalogMeasure = conceptFor({ source_id: measure.source_id, concept_id: measure.concept_id });
    if (catalogMeasure.kind !== 'measure' || !catalogMeasure.value.allowed_aggregations.includes(measure.function) ||
        measure.source_id !== filter.input.source_id || measure.as !== `${measure.function}_${measure.concept_id}` ||
        measure.physical_field !== catalogMeasure.value.physical_field || measure.physical_type !== catalogMeasure.value.physical_type ||
        measure.semantic_type !== catalogMeasure.value.semantic_type) {
      throw new Error('planned Core aggregate is not catalog-authorized');
    }
  }
  if (stableSerialize(input.output_grain) !== stableSerialize(input.group_by) ||
      stableSerialize(input.integrity) !== stableSerialize(input.input.integrity)) {
    throw new Error('planned Core aggregate grain or integrity is invalid');
  }
  validateAggregate({
    op: 'aggregate', input: plannedBranchFromCore(filter),
    group_by: input.group_by.map(group => ({ source_id: group.source_id, concept_id: group.concept_id })),
    measures: input.measures.map(measure => ({
      concept: { source_id: measure.source_id, concept_id: measure.concept_id }, function: measure.function, as: measure.as
    }))
  });
}

function validateCoreCompose(compose: PlannedCoreComposeNode, rankedSources: ReadonlySet<string>): void {
  const sourceIds = compose.inputs.map(coreAggregateSourceId);
  assertUnique(sourceIds, 'planned Core composition sources');
  assertCanonicalOrder(sourceIds, 'planned Core composition sources');
  for (const item of compose.inputs) {
    validateCoreAggregate(item, rankedSources.has(coreAggregateSourceId(item)));
    if (item.group_by.length !== 0) {throw new Error('planned Core composition inputs must be ungrouped aggregates');}
  }
  const expectedIntegrity = sortedUnique([...compose.inputs.flatMap(item => item.integrity), PLANNED_SCALAR_INPUT_CARDINALITY]);
  if (compose.output_grain.length !== 0 || stableSerialize(compose.integrity) !== stableSerialize(expectedIntegrity)) {
    throw new Error('planned Core composition grain or integrity is invalid');
  }
  validateCompose({
    op: 'compose',
    inputs: compose.inputs.map(item => ({
      op: 'aggregate', input: plannedBranchFromCore(requireCoreFilter(item.input)), group_by: [],
      measures: item.measures.map(measure => ({
        concept: { source_id: measure.source_id, concept_id: measure.concept_id }, function: measure.function, as: measure.as
      }))
    }))
  }, 1);
}

function validateCoreBranch(branch: PlannedCoreRowBranch, ranking: boolean): void {
  if (branch.op !== 'filter') {throw new Error('planned Core sources require explicit filters');}
  const filter = branch;
  const sourceNode = branch.input;
  const source = sourceFor(sourceNode.source_id);
  const expectedIntegrity = sourceIntegrity(
    source,
    filter.predicates.some(predicate => conceptFor(predicate.concept).value.semantic_type === 'position'),
    ranking
  );
  if (source.usage !== 'answer_fact' || sourceNode.view !== source.view ||
      stableSerialize(sourceNode.grain) !== stableSerialize(source.grain.key.map(conceptId => lowerConcept({ source_id: source.id as PlannedCoreSourceId, concept_id: conceptId }))) ||
      stableSerialize(sourceNode.integrity) !== stableSerialize(expectedIntegrity) ||
      stableSerialize(filter.integrity) !== stableSerialize(expectedIntegrity)) {
    throw new Error(`planned Core source ${sourceNode.source_id} does not match the active catalog`);
  }
  for (const predicate of filter.predicates) {
    const expected = lowerConcept({ source_id: predicate.concept.source_id, concept_id: predicate.concept.concept_id });
    if (stableSerialize(predicate.concept) !== stableSerialize(expected) || predicate.concept.source_id !== source.id) {
      throw new Error('planned Core predicate does not match the active catalog');
    }
  }
  validateBranch(plannedBranchFromCore(filter));
}

function validateCoreProject(project: PlannedCoreProjectNode): void {
  let sourceIds: PlannedCoreSourceId[];
  if (project.input.op === 'join') {
    sourceIds = [requireCoreFilter(project.input.left).input.source_id, requireCoreFilter(project.input.right).input.source_id];
  } else if (project.input.op === 'compose') {
    sourceIds = project.input.inputs.map(coreAggregateSourceId);
  } else {
    sourceIds = [requireCoreFilter(project.input.op === 'aggregate' ? project.input.input : project.input).input.source_id];
  }
  const grouped = project.input.op === 'aggregate' ? project.input.group_by.map(refKey) : [];
  const measures = project.input.op === 'aggregate' ? new Map(project.input.measures.map(measure => [measure.as, measure])) : new Map();
  const composedMeasures = project.input.op === 'compose'
    ? new Map(project.input.inputs.flatMap(item => item.measures.map(measure => [composedMeasureKey(coreAggregateSourceId(item), measure.as), measure] as const)))
    : new Map<string, PlannedCoreAggregateNode['measures'][number]>();
  for (const output of project.outputs) {
    if (output.kind === 'concept') {
      assertCoreConcept(output.concept);
      if (output.as !== output.concept.concept_id || !sourceIds.includes(output.concept.source_id) ||
          (project.input.op === 'aggregate' && !grouped.includes(refKey(output.concept)))) {
        throw new Error(`planned Core concept output ${output.as} is unavailable or noncanonical`);
      }
    } else if (output.kind === 'aggregate') {
      const measure = measures.get(output.measure_as);
      const expected = measure && {
        physical_type: measure.function === 'count' ? 'integer' : measure.physical_type,
        semantic_type: measure.function === 'count' ? 'number' : measure.semantic_type,
        nullable: measure.function !== 'count'
      };
      if (!measure || !expected || output.as !== output.measure_as || output.physical_type !== expected.physical_type ||
          output.semantic_type !== expected.semantic_type || output.nullable !== expected.nullable) {
        throw new Error(`planned Core aggregate output ${output.as} is unavailable or noncanonical`);
      }
    } else {
      const measure = composedMeasures.get(composedMeasureKey(output.source_id, output.measure_as));
      const expected = measure && aggregateOutputType(measure);
      if (!measure || !expected || output.as !== composedMeasureKey(output.source_id, output.measure_as) ||
          output.physical_type !== expected.physical_type || output.semantic_type !== expected.semantic_type ||
          output.nullable !== expected.nullable) {
        throw new Error(`planned Core composed output ${output.as} is unavailable or noncanonical`);
      }
    }
  }
  if (project.input.op === 'compose') {
    if (project.outputs.some(output => output.kind !== 'composed_aggregate')) {
      throw new Error('planned Core composition may project only composed child measures');
    }
    const actual = project.outputs.filter(output => output.kind === 'composed_aggregate')
      .map(output => composedMeasureKey(output.source_id, output.measure_as));
    if (stableSerialize(actual) !== stableSerialize([...composedMeasures.keys()].sort(compareText))) {
      throw new Error('planned Core composition must project every child measure exactly once');
    }
  }
  const grain = project.input.op === 'aggregate' || project.input.op === 'join' || project.input.op === 'compose'
    ? project.input.output_grain
    : residualCoreBranchGrain(requireCoreFilter(project.input));
  const expectedOutputGrain = grain.map(ref => {
    const output = project.outputs.find(item => item.kind === 'concept' &&
      item.concept.source_id === ref.source_id && item.concept.concept_id === ref.concept_id);
    if (!output) {throw new Error(`planned Core projection must include grain key ${ref.concept_id}`);}
    return output.as;
  });
  if (stableSerialize(project.output_grain) !== stableSerialize(expectedOutputGrain) ||
      stableSerialize(project.integrity) !== stableSerialize(project.input.integrity)) {
    throw new Error('planned Core projection grain or integrity is invalid');
  }
}

function requireCoreFilter(branch: PlannedCoreRowBranch): PlannedCoreFilterNode {
  if (branch.op !== 'filter') {throw new Error('planned Core sources require explicit filters');}
  return branch;
}

function coreAggregateSourceId(aggregate: PlannedCoreAggregateNode): PlannedCoreSourceId {
  return requireCoreFilter(aggregate.input).input.source_id;
}

function plannedBranchFromCore(branch: PlannedCoreFilterNode): PlannedRowBranch {
  return {
    op: 'filter', input: { op: 'source', source_id: branch.input.source_id },
    predicates: branch.predicates.map(predicate => {
      const concept = { source_id: predicate.concept.source_id, concept_id: predicate.concept.concept_id };
      if (predicate.operator === 'eq') {return { concept, operator: 'eq' as const, value: predicate.value };}
      if (predicate.operator === 'in') {return { concept, operator: 'in' as const, values: [...predicate.values] };}
      return { concept, operator: 'range' as const, min: predicate.min, max: predicate.max };
    })
  };
}

function resultField(output: PlannedCoreProjectOutput): PlannedCoreResultField {
  return output.kind === 'concept'
    ? { id: output.as, physical_type: output.concept.physical_type, semantic_type: output.concept.semantic_type, nullable: output.concept.nullable }
    : { id: output.as, physical_type: output.physical_type, semantic_type: output.semantic_type, nullable: output.nullable };
}

function aggregateOutputType(measure: PlannedCoreAggregateNode['measures'][number]): Pick<PlannedCoreResultField, 'physical_type' | 'semantic_type' | 'nullable'> {
  return {
    physical_type: measure.function === 'count' ? 'integer' : measure.physical_type,
    semantic_type: measure.function === 'count' ? 'number' : measure.semantic_type,
    nullable: measure.function !== 'count'
  };
}

function sourceIntegrity(source: SemanticCatalogSource, positionFiltered: boolean, ranking: boolean): string[] {
  const checks = [...source.integrity.required_checks];
  if (positionFiltered) {checks.push(...(source.integrity.operation_checks.find(item => item.operation_class === 'position_filter')?.required_checks ?? []));}
  if (ranking) {checks.push(...(source.integrity.operation_checks.find(item => item.operation_class === 'ranking')?.required_checks ?? []));}
  return sortedUnique(checks);
}

function sourceFor(sourceId: string): SemanticCatalogSource {
  const source = SEMANTIC_CATALOG.sources.find(item => item.id === sourceId);
  if (!source) {throw new Error(`unknown planned source ${sourceId}`);}
  return source;
}

function conceptFor(ref: PlannedConceptRef): CatalogConcept {
  const source = sourceFor(ref.source_id);
  const dimension = source.dimensions.find(item => item.id === ref.concept_id);
  if (dimension) {return { kind: 'dimension', value: dimension };}
  const measure = source.measures.find(item => item.id === ref.concept_id);
  if (measure) {return { kind: 'measure', value: measure };}
  throw new Error(`unknown planned concept ${refKey(ref)}`);
}

function inputGrain(input: PlannedProject['input']): PlannedConceptRef[] {
  if (input.op === 'aggregate') {return input.group_by;}
  if (input.op === 'compose') {return [];}
  if (input.op === 'join') {
    return residualPlannedBranchGrain(input.left);
  }
  return residualPlannedBranchGrain(input);
}

function inputBranches(input: PlannedProject['input']): PlannedRowBranch[] {
  if (input.op === 'join') {return [input.left, input.right];}
  if (input.op === 'compose') {return input.inputs.map(item => item.input);}
  if (input.op === 'aggregate') {return [input.input];}
  return [input];
}

function branchWork(branch: PlannedRowBranch): number {
  const sourceId = branchSource(branch);
  if (sourceId === 'driver_standings') {return 1;}
  return predicateValues(branch, 'round').length === 1 ? 1 : 30;
}

function branchSource(branch: PlannedRowBranch): PlannedCoreSourceId {
  return branch.op === 'filter' ? branch.input.source_id : branch.source_id;
}

function branchSources(branch: PlannedRowBranch): PlannedCoreSourceId[] {
  return [branchSource(branch)];
}

function predicateValues(branch: PlannedRowBranch, conceptId: string): Array<string | number | boolean> {
  if (branch.op !== 'filter') {return [];}
  const predicate = branch.predicates.find(item => item.concept.concept_id === conceptId);
  if (!predicate) {return [];}
  if (predicate.operator === 'eq') {return [predicate.value];}
  if (predicate.operator === 'in') {return predicate.values;}
  return [];
}

function scalarPredicate(branch: PlannedRowBranch, conceptId: string): number {
  const values = predicateValues(branch, conceptId);
  if (values.length !== 1 || !Number.isSafeInteger(values[0])) {throw new Error(`planned branch requires one scalar ${conceptId}`);}
  return values[0] as number;
}

function scalarEqualityPredicate(branch: PlannedRowBranch, conceptId: string): number {
  const value = optionalScalarEqualityPredicate(branch, conceptId);
  if (value === undefined) {throw new Error(`planned branch requires one scalar equality ${conceptId}`);}
  return value;
}

function optionalScalarEqualityPredicate(branch: PlannedRowBranch, conceptId: string): number | undefined {
  if (branch.op !== 'filter') {return undefined;}
  const predicate = branch.predicates.find(item => item.concept.concept_id === conceptId);
  if (!predicate) {return undefined;}
  if (predicate.operator !== 'eq' || !Number.isSafeInteger(predicate.value)) {
    throw new Error(`planned branch ${conceptId} predicate must be scalar equality when present`);
  }
  return predicate.value as number;
}

function validateLiteral(concept: CatalogDimension | CatalogMeasure, value: string | number | boolean): void {
  const numeric = ['duration_ms', 'number', 'position', 'round', 'season'].includes(concept.semantic_type);
  if ((numeric && typeof value !== 'number') || (concept.semantic_type === 'boolean' && typeof value !== 'boolean') ||
      (!numeric && concept.semantic_type !== 'boolean' && typeof value !== 'string')) {
    throw new Error(`literal type does not match ${concept.id}`);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) ||
      (['duration_ms', 'position', 'round', 'season'].includes(concept.semantic_type) && !Number.isSafeInteger(value)))) {
    throw new Error(`numeric literal is invalid for ${concept.id}`);
  }
  if (typeof value === 'number' && concept.semantic_type === 'round' && (value < 1 || value > 30)) {
    throw new Error(`round literal is outside supported bounds for ${concept.id}`);
  }
  if (typeof value === 'number' && concept.semantic_type === 'duration_ms' && value < 0) {
    throw new Error(`duration literal is outside supported bounds for ${concept.id}`);
  }
  if (typeof value === 'number' && concept.semantic_type === 'position') {
    const source = SEMANTIC_CATALOG.sources.find(item =>
      [...item.dimensions, ...item.measures].some(candidate => candidate.id === concept.id && candidate.physical_field === concept.physical_field));
    const bounds = source?.integrity.position_bounds.find(item => item.measure_id === concept.id);
    if (!bounds || value < bounds.min || (bounds.max !== null && value > bounds.max)) {
      throw new Error(`position literal is outside supported bounds for ${concept.id}`);
    }
  }
  if (typeof value === 'string' && concept.semantic_type === 'date' && !isIsoDate(value)) {
    throw new Error(`date literal is invalid for ${concept.id}`);
  }
  if ('allowed_values' in concept && concept.allowed_values.length > 0 && !concept.allowed_values.includes(String(value))) {
    throw new Error(`literal is not allowed for ${concept.id}`);
  }
}

function rankedSourcesForPlan(project: PlannedProject, sortOutputIds: string[]): Set<string> {
  const ranked = new Set<string>();
  for (const output of project.outputs) {
    if (!sortOutputIds.includes(output.as)) {continue;}
    if (output.kind === 'concept') {
      if (conceptFor(output.concept).value.semantic_type === 'position') {ranked.add(output.concept.source_id);}
      continue;
    }
    if (output.kind === 'composed_aggregate' && project.input.op === 'compose') {
      const aggregate = project.input.inputs.find(item => branchSource(item.input) === output.source_id);
      const measure = aggregate?.measures.find(item => item.as === output.measure_as);
      if (measure && conceptFor(measure.concept).value.semantic_type === 'position' && measure.function !== 'count') {
        ranked.add(measure.concept.source_id);
      }
      continue;
    }
    if (output.kind !== 'aggregate' || project.input.op !== 'aggregate') {continue;}
    const measure = project.input.measures.find(item => item.as === output.measure_as);
    if (measure && conceptFor(measure.concept).value.semantic_type === 'position' && measure.function !== 'count') {
      ranked.add(measure.concept.source_id);
    }
  }
  return ranked;
}

function rankedSourcesForCore(project: PlannedCoreProjectNode, sortOutputIds: string[]): Set<string> {
  const ranked = new Set<string>();
  for (const output of project.outputs) {
    if (!sortOutputIds.includes(output.as)) {continue;}
    if (output.kind === 'concept' && output.concept.semantic_type === 'position') {ranked.add(output.concept.source_id);}
    if (output.kind === 'composed_aggregate' && output.semantic_type === 'position' && project.input.op === 'compose') {
      ranked.add(output.source_id);
    }
    if (output.kind === 'aggregate' && output.semantic_type === 'position' && project.input.op === 'aggregate') {
      const measure = project.input.measures.find(item => item.as === output.measure_as);
      if (measure) {ranked.add(measure.source_id);}
    }
  }
  return ranked;
}

function residualPlannedBranchGrain(branch: PlannedRowBranch): PlannedConceptRef[] {
  const source = sourceFor(branchSource(branch));
  const fixed = branch.op === 'filter'
    ? new Set(branch.predicates.filter(predicate => predicate.operator === 'eq').map(predicate => predicate.concept.concept_id))
    : new Set<string>();
  return source.grain.key.filter(conceptId => !fixed.has(conceptId))
    .map(conceptId => ({ source_id: source.id as PlannedCoreSourceId, concept_id: conceptId }));
}

function residualCoreBranchGrain(branch: PlannedCoreFilterNode): PlannedCoreConceptRef[] {
  const fixed = new Set(branch.predicates.filter(predicate => predicate.operator === 'eq').map(predicate => predicate.concept.concept_id));
  return branch.input.grain.filter(concept => !fixed.has(concept.concept_id));
}

function composedMeasureKey(sourceId: string, measureAs: string): string {
  return `${sourceId}__${measureAs}`;
}

function assertCoreConcept(concept: PlannedCoreConceptRef): void {
  if (stableSerialize(concept) !== stableSerialize(lowerConcept({ source_id: concept.source_id, concept_id: concept.concept_id }))) {
    throw new Error('planned Core concept does not match the active catalog');
  }
}

function isCanonicalLiterals(values: Array<string | number | boolean>): boolean {
  const sorted = [...values].sort(compareLiteral);
  return values.length === new Set(values.map(value => stableSerialize(value))).size && values.every((value, index) => value === sorted[index]);
}

function compareLiteral(left: string | number | boolean, right: string | number | boolean): number {
  if (typeof left !== typeof right) {return typeof left < typeof right ? -1 : 1;}
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function refKey(ref: PlannedConceptRef): string {
  return `${ref.source_id}.${ref.concept_id}`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {throw new Error(`${label} must be unique`);}
}

function assertCanonicalOrder(values: string[], label: string): void {
  const sorted = [...values].sort(compareText);
  if (!values.every((value, index) => value === sorted[index])) {throw new Error(`${label} must be sorted`);}
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {return false;}
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
