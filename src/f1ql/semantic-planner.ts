import { createHash } from 'node:crypto';
import { createAnswerQuestionContract } from './answer-question';
import {
  PLANNED_F1QL_MAX_ROWS,
  PLANNED_F1QL_VERSION,
  PlannedAggregate,
  PlannedConceptRef,
  PlannedF1QLProgram,
  PlannedPredicate
} from './planned-f1ql';
import { preparePlannedF1QLParent } from './planned-pipeline';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from './semantic-catalog';
import {
  AnswerFactSourceId,
  collectSemanticResolutionEvidence,
  LinkedSemanticEntity,
  SemanticDriverResolver,
  SemanticEventResolver,
  SemanticResolutionError,
  VerifiedSemanticResolutionEvidence,
  verifySemanticResolutionEvidence
} from './semantic-resolution-evidence';
import {
  SemanticQuery,
  VerifiedSemanticQueryAdmission,
  verifySemanticQueryAdmission
} from './semantic-query';

export const SEMANTIC_PLANNER_VERSION = 'semantic-planner-v2' as const;
export const SEMANTIC_LINKER_VERSION = 'semantic-resolution-v1' as const;
export const SEMANTIC_PLAN_WORK_MODEL_VERSION = 'semantic-plan-work-v1' as const;

export type {
  LinkedSemanticEntity,
  SemanticDriverMention,
  SemanticDriverResolver,
  SemanticEventResolver,
  VerifiedSemanticResolutionEvidence
} from './semantic-resolution-evidence';

export type AnswerPlannerReason =
  | 'admission_invalid'
  | 'aggregate_locality_unsupported'
  | 'aggregate_locality_violation'
  | 'entity_ambiguous'
  | 'entity_cardinality_mismatch'
  | 'entity_inventory_mismatch'
  | 'event_ambiguous'
  | 'grain_mismatch'
  | 'identity_unresolved'
  | 'join_path_ambiguous'
  | 'ordering_undefined'
  | 'output_alias_collision'
  | 'planned_program_invalid'
  | 'source_coverage_missing'
  | 'source_graph_disconnected'
  | 'unsafe_join_cardinality'
  | 'unsupported_source_combination';

export class AnswerPlannerError extends Error {
  constructor(readonly reason: AnswerPlannerReason) {
    super(reason);
    this.name = 'AnswerPlannerError';
  }
}

export interface AnswerPlanBranch {
  readonly source_id: AnswerFactSourceId;
  readonly predicates: readonly PlannedPredicate[];
  readonly source_grain: readonly string[];
  readonly fixed_grain: readonly string[];
  readonly residual_grain: readonly string[];
  readonly aggregate?: {
    readonly group_by: readonly string[];
    readonly measures: readonly string[];
  };
}

export interface AnswerPlan {
  readonly kind: 'answer_plan';
  readonly version: 2;
  readonly planner_version: typeof SEMANTIC_PLANNER_VERSION;
  readonly linker_version: typeof SEMANTIC_LINKER_VERSION;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly question_sha256: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly resolution_evidence_hash: string;
  readonly linker_hash: string;
  readonly topology: 'row_dimension_join' | 'scalar_aggregate_compose' | 'single_source_aggregate' | 'single_source_rows';
  readonly linked_entities: readonly LinkedSemanticEntity[];
  readonly source_graph: {
    readonly source_ids: readonly AnswerFactSourceId[];
    readonly resolution_relationship_ids: readonly string[];
    readonly row_relationship_ids: readonly string[];
  };
  readonly branches: readonly AnswerPlanBranch[];
  readonly output_grain: readonly string[];
  readonly integrity_checks: readonly string[];
  readonly work: {
    readonly model: typeof SEMANTIC_PLAN_WORK_MODEL_VERSION;
    readonly source_scan_units: number;
    readonly resolver_reads: number;
    readonly resolver_candidates: number;
    readonly sources: number;
    readonly row_joins: number;
    readonly compositions: number;
    readonly operator_depth: number;
    readonly requested_rows: number;
  };
  readonly planned_f1ql: PlannedF1QLProgram;
  readonly planned_f1ql_hash: string;
  readonly core_hash: string;
  readonly answer_plan_hash: string;
}

const activeAnswerPlans = new WeakSet<object>();

export async function planSemanticAnswer(input: {
  readonly question: unknown;
  readonly admission: unknown;
  readonly driver_resolver: SemanticDriverResolver;
  readonly event_resolver: SemanticEventResolver;
}): Promise<AnswerPlan> {
  let resolution: VerifiedSemanticResolutionEvidence;
  try {
    resolution = await collectSemanticResolutionEvidence(input);
  } catch (error) {
    if (error instanceof SemanticResolutionError) {throw new AnswerPlannerError(error.reason);}
    throw error;
  }
  return planSemanticAnswerFromResolution({ question: input.question, admission: input.admission, resolution });
}

export function planSemanticAnswerFromResolution(input: {
  readonly question: unknown;
  readonly admission: unknown;
  readonly resolution: unknown;
}): AnswerPlan {
  let admission: VerifiedSemanticQueryAdmission;
  let resolution: VerifiedSemanticResolutionEvidence;
  try {
    admission = verifySemanticQueryAdmission(input.admission, input.question);
    resolution = verifySemanticResolutionEvidence(input.resolution, input.question, admission);
  } catch {
    throw new AnswerPlannerError('admission_invalid');
  }
  const question = createAnswerQuestionContract(input.question);
  const query = admission.query;
  const sourceIds = [...resolution.source_ids];
  const materialized = materializePlannedProgram(query, sourceIds, resolution.entities, resolution.resolved_round);
  let parent;
  try {
    parent = preparePlannedF1QLParent(materialized.program);
  } catch {
    throw new AnswerPlannerError('planned_program_invalid');
  }
  const project = parent.core_program.root.input.input;
  const integrity = [...project.integrity].sort(compareText);
  const sourceGraph = {
    source_ids: sourceIds,
    resolution_relationship_ids: sortedUnique(resolution.entities.flatMap(entity => [...entity.resolution_relationship_ids])),
    row_relationship_ids: materialized.row_relationship_ids
  };
  const draft = {
    kind: 'answer_plan' as const,
    version: 2 as const,
    planner_version: SEMANTIC_PLANNER_VERSION,
    linker_version: SEMANTIC_LINKER_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    semantic_evidence_hash: admission.semantic_evidence_hash,
    question_sha256: question.sha256,
    candidate_set_hash: admission.candidate_set_hash,
    semantic_query_hash: admission.query_hash,
    resolution_evidence_hash: resolution.resolution_hash,
    linker_hash: resolution.resolution_hash,
    topology: materialized.topology,
    linked_entities: resolution.entities,
    source_graph: sourceGraph,
    branches: materialized.branches,
    output_grain: project.output_grain,
    integrity_checks: integrity,
    work: {
      model: SEMANTIC_PLAN_WORK_MODEL_VERSION,
      source_scan_units: parent.cost.units,
      resolver_reads: resolution.resolver_reads,
      resolver_candidates: resolution.resolver_candidates,
      sources: parent.cost.sources,
      row_joins: parent.cost.joins,
      compositions: materialized.topology === 'scalar_aggregate_compose' ? 1 : 0,
      operator_depth: parent.cost.depth,
      requested_rows: parent.cost.requested_rows
    },
    planned_f1ql: parent.program,
    planned_f1ql_hash: parent.program_hash,
    core_hash: parent.core_hash
  };
  const plan: AnswerPlan = deepFreeze({ ...draft, answer_plan_hash: sha256(stableSerialize(draft)) });
  activeAnswerPlans.add(plan);
  return plan;
}

export function verifyAnswerPlan(input: unknown): AnswerPlan {
  if (!input || typeof input !== 'object' || !activeAnswerPlans.has(input)) {
    throw new Error('answer plan provenance is invalid');
  }
  const plan = input as AnswerPlan;
  const { answer_plan_hash: answerPlanHash, ...draft } = plan;
  const parent = preparePlannedF1QLParent(plan.planned_f1ql);
  if (plan.catalog_hash !== SEMANTIC_CATALOG_HASH || plan.planned_f1ql_hash !== parent.program_hash ||
      plan.core_hash !== parent.core_hash || answerPlanHash !== sha256(stableSerialize(draft))) {
    throw new Error('answer plan binding is invalid');
  }
  return plan;
}

function materializePlannedProgram(
  query: SemanticQuery,
  sourceIds: readonly AnswerFactSourceId[],
  linkedEntities: readonly LinkedSemanticEntity[],
  resolvedRound?: number
): {
  readonly program: PlannedF1QLProgram;
  readonly topology: AnswerPlan['topology'];
  readonly branches: readonly AnswerPlanBranch[];
  readonly row_relationship_ids: readonly string[];
} {
  const branches = sourceIds.map(sourceId => buildBranch(query, sourceId, linkedEntities, resolvedRound));
  const aggregateOutputs = query.outputs.filter(output => output.kind === 'aggregate');
  let topology: AnswerPlan['topology'];
  let projectInput: PlannedF1QLProgram['root']['input']['input']['input'];
  let projectOutputs: PlannedF1QLProgram['root']['input']['input']['outputs'];
  let rowRelationships: string[] = [];
  let rowFromSourceId: AnswerFactSourceId | undefined;

  if (sourceIds.length === 1) {
    const branch = branches[0];
    if (aggregateOutputs.length > 0) {
      topology = 'single_source_aggregate';
      const aggregate = aggregateForSource(query, sourceIds[0], branch.predicates);
      projectInput = aggregate;
      projectOutputs = query.outputs.map(output => output.kind === 'aggregate'
        ? { kind: 'aggregate' as const, measure_as: `${output.function}_${output.concept.concept_id}`, as: `${output.function}_${output.concept.concept_id}` }
        : { kind: 'concept' as const, concept: output.concept, as: output.concept.concept_id });
    } else {
      topology = 'single_source_rows';
      projectInput = rowBranch(sourceIds[0], branch.predicates);
      projectOutputs = query.outputs.map(output => ({ kind: 'concept' as const, concept: output.concept, as: output.concept.concept_id }));
    }
  } else if (sourceIds.length === 2 && aggregateOutputs.length === 0) {
    topology = 'row_dimension_join';
    const relationships = SEMANTIC_CATALOG.relationships.filter(relationship => relationship.join_stage === 'row' &&
      ['qualifying_event_metadata', 'race_event_metadata'].includes(relationship.id) &&
      relationship.governance !== 'experimental' && sourceIds.includes(relationship.from_source as AnswerFactSourceId) &&
      sourceIds.includes(relationship.to_source as AnswerFactSourceId));
    if (relationships.length === 0) {throw new AnswerPlannerError('source_graph_disconnected');}
    if (relationships.length !== 1) {throw new AnswerPlannerError('join_path_ambiguous');}
    if (!['many_to_one', 'one_to_one'].includes(relationships[0].cardinality)) {throw new AnswerPlannerError('unsafe_join_cardinality');}
    const fromIndex = sourceIds.indexOf(relationships[0].from_source as AnswerFactSourceId);
    const toIndex = sourceIds.indexOf(relationships[0].to_source as AnswerFactSourceId);
    rowFromSourceId = sourceIds[fromIndex];
    projectInput = {
      op: 'join', relationship_id: relationships[0].id,
      left: rowBranch(sourceIds[fromIndex], branches[fromIndex].predicates),
      right: rowBranch(sourceIds[toIndex], branches[toIndex].predicates)
    };
    projectOutputs = query.outputs.map(output => ({ kind: 'concept' as const, concept: output.concept, as: output.concept.concept_id }));
    rowRelationships = [relationships[0].id];
  } else if (sameStrings(sourceIds, ['event_classification', 'qualifying_classification']) &&
      aggregateOutputs.length === query.outputs.length && query.group_by.length === 0) {
    topology = 'scalar_aggregate_compose';
    projectInput = {
      op: 'compose',
      inputs: sourceIds.map((sourceId, index) => aggregateForSource(query, sourceId, branches[index].predicates))
    };
    projectOutputs = sourceIds.flatMap(sourceId => query.outputs.flatMap(output => output.kind === 'aggregate' && output.concept.source_id === sourceId
      ? [{
          kind: 'composed_aggregate' as const,
          source_id: sourceId,
          measure_as: `${output.function}_${output.concept.concept_id}`,
          as: `${sourceId}__${output.function}_${output.concept.concept_id}`
        }]
      : []));
  } else if (aggregateOutputs.length > 0) {
    throw new AnswerPlannerError(query.outputs.some(output => output.kind === 'concept')
      ? 'aggregate_locality_violation' : 'aggregate_locality_unsupported');
  } else {
    throw new AnswerPlannerError('unsupported_source_combination');
  }

  const outputIds = projectOutputs.map(output => output.as);
  if (new Set(outputIds).size !== outputIds.length) {throw new AnswerPlannerError('output_alias_collision');}
  let residualGrain: readonly string[];
  if (topology === 'scalar_aggregate_compose') {
    residualGrain = [];
  } else if (topology === 'single_source_aggregate') {
    residualGrain = query.group_by.map(group => group.concept.concept_id);
  } else if (topology === 'row_dimension_join' && rowFromSourceId) {
    residualGrain = branches.find(branch => branch.source_id === rowFromSourceId)!.residual_grain;
  } else {
    residualGrain = branches[0].residual_grain;
  }
  for (const grainId of residualGrain) {
    if (!outputIds.includes(grainId)) {throw new AnswerPlannerError('grain_mismatch');}
  }
  const sortKeys = query.order_by.map(order => ({
    output_id: outputId(query, order.output_index, topology),
    direction: order.direction,
    nulls: 'last' as const
  }));
  for (const grainId of residualGrain) {
    if (!sortKeys.some(key => key.output_id === grainId)) {
      sortKeys.push({ output_id: grainId, direction: 'asc', nulls: 'last' });
    }
  }
  if (sortKeys.length === 0 && residualGrain.length === 0) {
    sortKeys.push({ output_id: outputIds[0], direction: 'asc', nulls: 'last' });
  }
  if (sortKeys.length === 0 || sortKeys.length > 4) {throw new AnswerPlannerError('ordering_undefined');}
  const count = residualGrain.length === 0 ? 1 : query.limit?.value ?? PLANNED_F1QL_MAX_ROWS;
  const raw = {
    kind: 'internal_planned_f1ql' as const,
    version: PLANNED_F1QL_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit' as const,
      count,
      input: {
        op: 'sort' as const,
        keys: sortKeys,
        input: { op: 'project' as const, input: projectInput, outputs: projectOutputs }
      }
    }
  };
  return {
    program: raw as PlannedF1QLProgram,
    topology,
    branches,
    row_relationship_ids: rowRelationships
  };
}

function buildBranch(
  query: SemanticQuery,
  sourceId: AnswerFactSourceId,
  linkedEntities: readonly LinkedSemanticEntity[],
  resolvedRound?: number
): AnswerPlanBranch {
  const source = SEMANTIC_CATALOG.sources.find(item => item.id === sourceId)!;
  const season = requiredScopeValue(query, 'season');
  const predicates: PlannedPredicate[] = [{ concept: ref(sourceId, 'season'), operator: 'eq', value: season }];
  if (source.dimensions.some(dimension => dimension.id === 'round') && resolvedRound !== undefined) {
    predicates.push({ concept: ref(sourceId, 'round'), operator: 'eq', value: resolvedRound });
  }
  for (const filter of query.filters.filter(item => item.concept.source_id === sourceId)) {
    if (filter.kind === 'entity') {
      const values = filter.entity_indices.map(index => {
        const linked = linkedEntities.find(entity => entity.entity_index === index);
        if (!linked || linked.type !== 'driver') {throw new AnswerPlannerError('identity_unresolved');}
        return linked.selected_id;
      }).sort(compareText);
      predicates.push(filter.operator === 'eq'
        ? { concept: filter.concept, operator: 'eq', value: values[0] }
        : { concept: filter.concept, operator: 'in', values });
    } else if (filter.kind === 'literal') {
      predicates.push({ concept: filter.concept, operator: 'eq', value: filter.value });
    } else if (filter.kind === 'literal_set') {
      predicates.push({ concept: filter.concept, operator: 'in', values: [...filter.values].sort(compareLiteral) });
    } else {
      predicates.push({ concept: filter.concept, operator: 'range', min: filter.min as number | string, max: filter.max as number | string });
    }
  }
  predicates.sort((left, right) => compareText(refKey(left.concept), refKey(right.concept)));
  if (new Set(predicates.map(predicate => predicate.concept.concept_id)).size !== predicates.length) {
    throw new AnswerPlannerError('grain_mismatch');
  }
  const fixed = new Set(predicates.filter(predicate => predicate.operator === 'eq').map(predicate => predicate.concept.concept_id));
  const sourceGrain = [...source.grain.key];
  const aggregate = query.outputs.some(output => output.kind === 'aggregate' && output.concept.source_id === sourceId)
    ? {
        group_by: query.group_by.filter(group => group.concept.source_id === sourceId).map(group => group.concept.concept_id),
        measures: query.outputs.flatMap(output => output.kind === 'aggregate' && output.concept.source_id === sourceId
          ? [`${output.function}_${output.concept.concept_id}`] : [])
      }
    : undefined;
  return deepFreeze({
    source_id: sourceId,
    predicates,
    source_grain: sourceGrain,
    fixed_grain: sourceGrain.filter(key => fixed.has(key)),
    residual_grain: aggregate ? aggregate.group_by : sourceGrain.filter(key => !fixed.has(key)),
    ...(aggregate ? { aggregate } : {})
  });
}

function aggregateForSource(query: SemanticQuery, sourceId: AnswerFactSourceId, predicates: readonly PlannedPredicate[]): PlannedAggregate {
  const groups = query.group_by.filter(group => group.concept.source_id === sourceId).map(group => group.concept);
  const measures = query.outputs.flatMap(output => output.kind === 'aggregate' && output.concept.source_id === sourceId
    ? [{ concept: output.concept, function: output.function, as: `${output.function}_${output.concept.concept_id}` }]
    : []);
  if (measures.length === 0 || query.outputs.some(output => output.kind === 'concept' && output.concept.source_id === sourceId &&
      !groups.some(group => refKey(group) === refKey(output.concept)))) {
    throw new AnswerPlannerError('aggregate_locality_violation');
  }
  return { op: 'aggregate', input: rowBranch(sourceId, predicates), group_by: groups, measures };
}

function rowBranch(sourceId: AnswerFactSourceId, predicates: readonly PlannedPredicate[]) {
  return { op: 'filter' as const, input: { op: 'source' as const, source_id: sourceId }, predicates: [...predicates] };
}

function outputId(query: SemanticQuery, index: number, topology: AnswerPlan['topology']): string {
  const output = query.outputs[index];
  if (!output) {throw new AnswerPlannerError('ordering_undefined');}
  if (output.kind === 'concept') {return output.concept.concept_id;}
  const aggregateId = `${output.function}_${output.concept.concept_id}`;
  return topology === 'scalar_aggregate_compose' ? `${output.concept.source_id}__${aggregateId}` : aggregateId;
}

function requiredScopeValue(query: SemanticQuery, kind: 'season'): number {
  const scope = query.scopes.find(item => item.kind === kind);
  if (!scope || scope.kind !== 'season') {throw new AnswerPlannerError('admission_invalid');}
  return scope.value;
}

function ref(source_id: AnswerFactSourceId, concept_id: string): PlannedConceptRef {
  return { source_id, concept_id };
}

function refKey(reference: { readonly source_id: string; readonly concept_id: string }): string {
  return `${reference.source_id}.${reference.concept_id}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareLiteral(left: string | number | boolean, right: string | number | boolean): number {
  return compareText(stableSerialize(left), stableSerialize(right));
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  if (left > right) {return 1;}
  return 0;
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
