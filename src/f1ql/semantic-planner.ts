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
  SemanticLiteralSpan,
  SemanticQuery,
  VerifiedSemanticQueryAdmission,
  verifySemanticQueryAdmission
} from './semantic-query';

export const SEMANTIC_PLANNER_VERSION = 'semantic-planner-v1' as const;
export const SEMANTIC_LINKER_VERSION = 'semantic-linker-v1' as const;
export const SEMANTIC_LINKER_MAX_CANDIDATES = 100;

type AnswerFactSourceId = 'driver_standings' | 'event_classification' | 'event_metadata' | 'qualifying_classification';

export interface SemanticDriverMention {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly candidates: readonly string[];
  readonly active_candidates: readonly string[];
}

export interface SemanticDriverResolver {
  inventoryMentions(question: string, season: number): Promise<readonly SemanticDriverMention[]>;
}

type EventResolution =
  | { readonly type: 'resolved'; readonly season: number; readonly round: number }
  | { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] }
  | { readonly type: 'missing' };

export interface SemanticEventResolver {
  resolve(season: number, name: string): Promise<EventResolution>;
  resolveRound(season: number, round: number): Promise<EventResolution>;
}

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

export interface LinkedSemanticEntity {
  readonly entity_index: number;
  readonly type: 'driver' | 'event';
  readonly span: SemanticLiteralSpan;
  readonly candidate_ids: readonly string[];
  readonly selected_id: string;
  readonly resolution_relationship_ids: readonly string[];
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
  readonly version: 1;
  readonly planner_version: typeof SEMANTIC_PLANNER_VERSION;
  readonly linker_version: typeof SEMANTIC_LINKER_VERSION;
  readonly catalog_hash: string;
  readonly question_sha256: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
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
    readonly model: 'semantic-plan-work-v1';
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
  let admission: VerifiedSemanticQueryAdmission;
  try {
    admission = verifySemanticQueryAdmission(input.admission, input.question);
  } catch {
    throw new AnswerPlannerError('admission_invalid');
  }
  const question = createAnswerQuestionContract(input.question);
  const query = admission.query;
  const season = requiredScopeValue(query, 'season');
  const sourceIds = semanticSourceIds(query);
  const linked = await linkEntities(question.normalized_question, query, season, sourceIds, input.driver_resolver, input.event_resolver);
  const materialized = materializePlannedProgram(query, sourceIds, linked.entities, linked.resolved_round);
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
    resolution_relationship_ids: sortedUnique(linked.entities.flatMap(entity => [...entity.resolution_relationship_ids])),
    row_relationship_ids: materialized.row_relationship_ids
  };
  const draft = {
    kind: 'answer_plan' as const,
    version: 1 as const,
    planner_version: SEMANTIC_PLANNER_VERSION,
    linker_version: SEMANTIC_LINKER_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    question_sha256: question.sha256,
    candidate_set_hash: admission.candidate_set_hash,
    semantic_query_hash: admission.query_hash,
    linker_hash: linked.linker_hash,
    topology: materialized.topology,
    linked_entities: linked.entities,
    source_graph: sourceGraph,
    branches: materialized.branches,
    output_grain: project.output_grain,
    integrity_checks: integrity,
    work: {
      model: 'semantic-plan-work-v1' as const,
      source_scan_units: parent.cost.units,
      resolver_reads: linked.resolver_reads,
      resolver_candidates: linked.resolver_candidates,
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

async function linkEntities(
  question: string,
  query: SemanticQuery,
  season: number,
  sourceIds: readonly AnswerFactSourceId[],
  driverResolver: SemanticDriverResolver,
  eventResolver: SemanticEventResolver
): Promise<{ readonly entities: readonly LinkedSemanticEntity[]; readonly resolved_round?: number; readonly resolver_reads: number; readonly resolver_candidates: number; readonly linker_hash: string }> {
  let resolverReads = 1;
  let resolverCandidates = 0;
  const rawMentions = await driverResolver.inventoryMentions(question, season);
  if (rawMentions.length > 8) {throw new AnswerPlannerError('entity_inventory_mismatch');}
  const mentions = [...rawMentions].sort(compareMentions);
  const expectedDrivers = query.entities.flatMap((entity, index) => entity.type === 'driver' ? [{ entity, index }] : []).sort((left, right) => compareSpans(left.entity.span, right.entity.span));
  if (mentions.length !== expectedDrivers.length || mentions.some((mention, index) => !sameMention(mention, expectedDrivers[index].entity.span))) {
    throw new AnswerPlannerError('entity_inventory_mismatch');
  }
  const linked: LinkedSemanticEntity[] = expectedDrivers.map(({ entity, index }, mentionIndex) => {
    const mention = mentions[mentionIndex];
    if (mention.candidates.length > SEMANTIC_LINKER_MAX_CANDIDATES ||
        mention.active_candidates.length > SEMANTIC_LINKER_MAX_CANDIDATES ||
        mention.candidates.some(candidate => !isBoundedCanonicalId(candidate)) ||
        mention.active_candidates.some(candidate => !isBoundedCanonicalId(candidate))) {
      throw new AnswerPlannerError('entity_inventory_mismatch');
    }
    resolverCandidates += mention.candidates.length;
    const candidates = sortedUnique([...mention.candidates]);
    const active = sortedUnique([...mention.active_candidates]);
    if (active.some(candidate => !candidates.includes(candidate))) {
      throw new AnswerPlannerError('entity_inventory_mismatch');
    }
    if (candidates.length === 0) {throw new AnswerPlannerError('identity_unresolved');}
    if (active.length === 0) {throw new AnswerPlannerError('source_coverage_missing');}
    if (active.length !== 1) {throw new AnswerPlannerError('entity_ambiguous');}
    return {
      entity_index: index,
      type: 'driver' as const,
      span: entity.span,
      candidate_ids: candidates,
      selected_id: active[0],
      resolution_relationship_ids: sortedUnique([
        'driver_participation_resolution',
        ...sourceIds.flatMap(driverResolutionRelationship)
      ])
    };
  });
  if (new Set(linked.map(entity => entity.selected_id)).size !== linked.length) {
    throw new AnswerPlannerError('entity_cardinality_mismatch');
  }

  const eventScope = query.scopes.find(scope => scope.kind === 'event');
  const roundScope = query.scopes.find(scope => scope.kind === 'round');
  let resolvedRound: number | undefined;
  if (eventScope || roundScope) {
    resolverReads += 1;
    const resolution = eventScope
      ? await eventResolver.resolve(season, query.entities[eventScope.entity_index].span.text)
      : await eventResolver.resolveRound(season, roundScope!.value);
    if (resolution.type === 'missing') {throw new AnswerPlannerError('source_coverage_missing');}
    if (resolution.type === 'ambiguous') {
      if (resolution.candidates.length > SEMANTIC_LINKER_MAX_CANDIDATES) {throw new AnswerPlannerError('entity_inventory_mismatch');}
      throw new AnswerPlannerError('event_ambiguous');
    }
    resolverCandidates += 1;
    if (resolution.season !== season || (roundScope && resolution.round !== roundScope.value)) {
      throw new AnswerPlannerError('source_coverage_missing');
    }
    resolvedRound = resolution.round;
    if (eventScope) {
      const entity = query.entities[eventScope.entity_index];
      linked.push({
        entity_index: eventScope.entity_index,
        type: 'event',
        span: entity.span,
        candidate_ids: [`event:${season}:${resolvedRound}`],
        selected_id: `event:${season}:${resolvedRound}`,
        resolution_relationship_ids: sortedUnique(sourceIds.flatMap(eventResolutionRelationship))
      });
    }
  }
  linked.sort((left, right) => left.entity_index - right.entity_index);
  const hashPayload = {
    version: SEMANTIC_LINKER_VERSION,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    entities: linked,
    resolved_round: resolvedRound ?? null,
    resolver_reads: resolverReads,
    resolver_candidates: resolverCandidates
  };
  return deepFreeze({
    entities: linked,
    resolver_reads: resolverReads,
    resolver_candidates: resolverCandidates,
    ...(resolvedRound === undefined ? {} : { resolved_round: resolvedRound }),
    linker_hash: sha256(stableSerialize(hashPayload))
  });
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
  } else if (sameStrings(sourceIds, ['event_classification', 'event_metadata']) && aggregateOutputs.length === 0) {
    topology = 'row_dimension_join';
    const relationships = SEMANTIC_CATALOG.relationships.filter(relationship => relationship.join_stage === 'row' &&
      relationship.from_source === sourceIds[0] && relationship.to_source === sourceIds[1] && relationship.governance !== 'experimental');
    if (relationships.length === 0) {throw new AnswerPlannerError('source_graph_disconnected');}
    if (relationships.length !== 1) {throw new AnswerPlannerError('join_path_ambiguous');}
    if (!['many_to_one', 'one_to_one'].includes(relationships[0].cardinality)) {throw new AnswerPlannerError('unsafe_join_cardinality');}
    projectInput = {
      op: 'join', relationship_id: relationships[0].id,
      left: rowBranch(sourceIds[0], branches[0].predicates),
      right: rowBranch(sourceIds[1], branches[1].predicates)
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

function semanticSourceIds(query: SemanticQuery): AnswerFactSourceId[] {
  const ids = sortedUnique([
    ...query.outputs.map(output => output.concept.source_id),
    ...query.group_by.map(group => group.concept.source_id),
    ...query.filters.map(filter => filter.concept.source_id)
  ]) as AnswerFactSourceId[];
  if (ids.length === 0) {throw new AnswerPlannerError('source_graph_disconnected');}
  return ids;
}

function outputId(query: SemanticQuery, index: number, topology: AnswerPlan['topology']): string {
  const output = query.outputs[index];
  if (!output) {throw new AnswerPlannerError('ordering_undefined');}
  if (output.kind === 'concept') {return output.concept.concept_id;}
  const aggregateId = `${output.function}_${output.concept.concept_id}`;
  return topology === 'scalar_aggregate_compose' ? `${output.concept.source_id}__${aggregateId}` : aggregateId;
}

function driverResolutionRelationship(sourceId: AnswerFactSourceId): string[] {
  if (sourceId === 'driver_standings') {return ['driver_identity_standings_resolution'];}
  if (sourceId === 'event_classification') {return ['driver_identity_race_resolution'];}
  if (sourceId === 'qualifying_classification') {return ['driver_identity_qualifying_resolution'];}
  return [];
}

function eventResolutionRelationship(sourceId: AnswerFactSourceId): string[] {
  if (sourceId === 'event_metadata') {return ['event_identity_metadata_resolution'];}
  if (sourceId === 'event_classification') {return ['event_identity_race_resolution'];}
  if (sourceId === 'qualifying_classification') {return ['event_identity_qualifying_resolution'];}
  return [];
}

function requiredScopeValue(query: SemanticQuery, kind: 'season'): number {
  const scope = query.scopes.find(item => item.kind === kind);
  if (!scope || scope.kind !== 'season') {throw new AnswerPlannerError('admission_invalid');}
  return scope.value;
}

function sameMention(mention: SemanticDriverMention, span: SemanticLiteralSpan): boolean {
  return mention.text === span.text && mention.start === span.start && mention.end === span.end;
}

function compareMentions(left: SemanticDriverMention, right: SemanticDriverMention): number {
  return left.start - right.start || left.end - right.end || compareText(left.text, right.text);
}

function compareSpans(left: SemanticLiteralSpan, right: SemanticLiteralSpan): number {
  return left.start - right.start || left.end - right.end || compareText(left.text, right.text);
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

function isBoundedCanonicalId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,199}$/.test(value);
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
