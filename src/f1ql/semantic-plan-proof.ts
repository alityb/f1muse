import { createHash } from 'node:crypto';
import { ANSWER_QUESTION_CONTRACT_VERSION, createAnswerQuestionContract } from './answer-question';
import { PLANNED_F1QL_COMPILER_VERSION } from './planned-compiler';
import {
  PLANNED_F1QL_COST_MODEL_VERSION,
  PLANNED_F1QL_DIALECT,
  PLANNED_F1QL_MAX_ROWS,
  PLANNED_F1QL_VERSION,
  PlannedAggregate,
  PlannedConceptRef,
  PlannedF1QLProgram,
  PlannedPredicate
} from './planned-f1ql';
import {
  PLANNED_F1QL_PIPELINE_VERSION,
  preparePlannedF1QLParent,
  VerifiedPlannedF1QLParent,
  verifyPlannedF1QLParent
} from './planned-pipeline';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from './semantic-catalog';
import {
  AnswerFactSourceId,
  LinkedSemanticEntity,
  SEMANTIC_RESOLUTION_EVIDENCE_VERSION,
  VerifiedSemanticResolutionEvidence,
  verifySemanticResolutionEvidence
} from './semantic-resolution-evidence';
import {
  computeSemanticEvidenceHash,
  computeSemanticQueryHash,
  SEMANTIC_EVIDENCE_VERSION,
  SEMANTIC_QUERY_VERSION,
  SemanticEvidence,
  SemanticQuery,
  VerifiedSemanticQueryAdmission,
  verifySemanticEvidence,
  verifySemanticQueryAdmission
} from './semantic-query';
import { F1QL_FACT_SPACE_VERSION } from './verified-programs';

export const SEMANTIC_PLAN_PROOF_VERSION = 'semantic-plan-proof-v1' as const;
export const VERIFIED_PLANNER_VERSION = 'semantic-planner-v2' as const;
export const VERIFIED_PLAN_WORK_MODEL_VERSION = 'semantic-plan-work-v1' as const;

export type SemanticPlanProofReason =
  | 'admission_invalid'
  | 'evidence_invalid'
  | 'plan_mismatch'
  | 'planned_program_invalid'
  | 'resolution_invalid'
  | 'semantic_query_not_unique'
  | 'unsupported_topology';

export class SemanticPlanProofError extends Error {
  constructor(readonly reason: SemanticPlanProofReason) {
    super(reason);
    this.name = 'SemanticPlanProofError';
  }
}

const verifiedSemanticPlanProofBrand: unique symbol = Symbol('verifiedSemanticPlanProof');

export interface VerifiedSemanticPlanProof {
  readonly [verifiedSemanticPlanProofBrand]: true;
  readonly version: typeof SEMANTIC_PLAN_PROOF_VERSION;
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly resolution_evidence_hash: string;
  readonly answer_plan_hash: string;
  readonly topology_hash: string;
  readonly work_hash: string;
  readonly planned_f1ql_hash: string;
  readonly participation_hash: string;
  readonly core_hash: string;
  readonly compiled_hash: string;
  readonly versions: {
    readonly question: typeof ANSWER_QUESTION_CONTRACT_VERSION;
    readonly semantic_query: typeof SEMANTIC_QUERY_VERSION;
    readonly semantic_evidence: typeof SEMANTIC_EVIDENCE_VERSION;
    readonly resolution: typeof SEMANTIC_RESOLUTION_EVIDENCE_VERSION;
    readonly planner: typeof VERIFIED_PLANNER_VERSION;
    readonly proof: typeof SEMANTIC_PLAN_PROOF_VERSION;
    readonly planned_f1ql: typeof PLANNED_F1QL_VERSION;
    readonly planned_dialect: typeof PLANNED_F1QL_DIALECT;
    readonly planned_cost: typeof PLANNED_F1QL_COST_MODEL_VERSION;
    readonly planned_pipeline: typeof PLANNED_F1QL_PIPELINE_VERSION;
    readonly planned_compiler: typeof PLANNED_F1QL_COMPILER_VERSION;
    readonly fact_space: typeof F1QL_FACT_SPACE_VERSION;
  };
  readonly proof_hash: string;
}

interface ExpectedBranch {
  readonly source_id: AnswerFactSourceId;
  readonly predicates: readonly PlannedPredicate[];
  readonly source_grain: readonly string[];
  readonly fixed_grain: readonly string[];
  readonly residual_grain: readonly string[];
  readonly aggregate?: { readonly group_by: readonly string[]; readonly measures: readonly string[] };
}

type ExpectedTopology =
  | 'row_dimension_join'
  | 'scalar_aggregate_compose'
  | 'single_source_aggregate'
  | 'single_source_rows';

interface MaterializedPlan {
  readonly program: PlannedF1QLProgram;
  readonly topology: ExpectedTopology;
  readonly branches: readonly ExpectedBranch[];
  readonly row_relationship_ids: readonly string[];
}

interface ProofBindings {
  readonly parent: VerifiedPlannedF1QLParent;
  readonly expected_plan: unknown;
}

const activeProofs = new WeakSet<object>();
const proofBindings = new WeakMap<object, ProofBindings>();

export function proveSemanticAnswerPlan(input: {
  readonly question: unknown;
  readonly entity_inventory?: readonly unknown[];
  readonly evidence: unknown;
  readonly admission: unknown;
  readonly resolution: unknown;
  readonly plan: unknown;
}): VerifiedSemanticPlanProof {
  let evidence: SemanticEvidence;
  let admission: VerifiedSemanticQueryAdmission;
  let resolution: VerifiedSemanticResolutionEvidence;
  try {
    evidence = verifySemanticEvidence(input.evidence, input.question, input.entity_inventory ?? []);
  } catch {
    throw new SemanticPlanProofError('evidence_invalid');
  }
  if (evidence.type !== 'candidate_set' || evidence.candidates.length !== 1 || evidence.ambiguity_reason) {
    throw new SemanticPlanProofError('semantic_query_not_unique');
  }
  try {
    admission = verifySemanticQueryAdmission(input.admission, input.question);
  } catch {
    throw new SemanticPlanProofError('admission_invalid');
  }
  if (admission.semantic_evidence_hash !== computeSemanticEvidenceHash(evidence) ||
      admission.query_hash !== computeSemanticQueryHash(evidence.candidates[0])) {
    throw new SemanticPlanProofError('admission_invalid');
  }
  try {
    resolution = verifySemanticResolutionEvidence(input.resolution, input.question, admission);
  } catch {
    throw new SemanticPlanProofError('resolution_invalid');
  }
  const question = createAnswerQuestionContract(input.question);
  const materialized = independentlyMaterialize(admission.query, resolution);
  let parent: VerifiedPlannedF1QLParent;
  try {
    parent = preparePlannedF1QLParent(materialized.program);
  } catch {
    throw new SemanticPlanProofError('planned_program_invalid');
  }
  const project = parent.core_program.root.input.input;
  const sourceGraph = {
    source_ids: resolution.source_ids,
    resolution_relationship_ids: sortedUnique(resolution.entities.flatMap(entity => [...entity.resolution_relationship_ids])),
    row_relationship_ids: materialized.row_relationship_ids
  };
  const work = {
    model: VERIFIED_PLAN_WORK_MODEL_VERSION,
    source_scan_units: parent.cost.units,
    resolver_reads: resolution.resolver_reads,
    resolver_candidates: resolution.resolver_candidates,
    sources: parent.cost.sources,
    row_joins: parent.cost.joins,
    compositions: materialized.topology === 'scalar_aggregate_compose' ? 1 : 0,
    operator_depth: parent.cost.depth,
    requested_rows: parent.cost.requested_rows
  };
  const expectedDraft = {
    kind: 'answer_plan' as const,
    version: 2 as const,
    planner_version: VERIFIED_PLANNER_VERSION,
    linker_version: SEMANTIC_RESOLUTION_EVIDENCE_VERSION,
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
    integrity_checks: [...project.integrity].sort(compareText),
    work,
    planned_f1ql: parent.program,
    planned_f1ql_hash: parent.program_hash,
    core_hash: parent.core_hash
  };
  const expectedPlan = deepFreeze({
    ...expectedDraft,
    answer_plan_hash: sha256(stableSerialize(expectedDraft))
  });
  if (stableSerialize(input.plan) !== stableSerialize(expectedPlan)) {
    throw new SemanticPlanProofError('plan_mismatch');
  }
  const topologyHash = sha256(stableSerialize({
    topology: materialized.topology,
    source_graph: sourceGraph,
    branches: materialized.branches,
    output_grain: project.output_grain,
    integrity_checks: expectedDraft.integrity_checks
  }));
  const proofDraft = {
    version: SEMANTIC_PLAN_PROOF_VERSION,
    question_sha256: question.sha256,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    semantic_evidence_hash: admission.semantic_evidence_hash,
    candidate_set_hash: admission.candidate_set_hash,
    semantic_query_hash: admission.query_hash,
    resolution_evidence_hash: resolution.resolution_hash,
    answer_plan_hash: expectedPlan.answer_plan_hash,
    topology_hash: topologyHash,
    work_hash: sha256(stableSerialize(work)),
    planned_f1ql_hash: parent.program_hash,
    participation_hash: sha256(stableSerialize(parent.participation)),
    core_hash: parent.core_hash,
    compiled_hash: sha256(stableSerialize(parent.compiled)),
    versions: {
      question: ANSWER_QUESTION_CONTRACT_VERSION,
      semantic_query: SEMANTIC_QUERY_VERSION,
      semantic_evidence: SEMANTIC_EVIDENCE_VERSION,
      resolution: SEMANTIC_RESOLUTION_EVIDENCE_VERSION,
      planner: VERIFIED_PLANNER_VERSION,
      proof: SEMANTIC_PLAN_PROOF_VERSION,
      planned_f1ql: PLANNED_F1QL_VERSION,
      planned_dialect: PLANNED_F1QL_DIALECT,
      planned_cost: PLANNED_F1QL_COST_MODEL_VERSION,
      planned_pipeline: PLANNED_F1QL_PIPELINE_VERSION,
      planned_compiler: PLANNED_F1QL_COMPILER_VERSION,
      fact_space: F1QL_FACT_SPACE_VERSION
    } as const
  };
  const proof: VerifiedSemanticPlanProof = deepFreeze({
    [verifiedSemanticPlanProofBrand]: true as const,
    ...proofDraft,
    proof_hash: sha256(stableSerialize(proofDraft))
  });
  activeProofs.add(proof);
  proofBindings.set(proof, { parent, expected_plan: expectedPlan });
  return proof;
}

export function verifySemanticPlanProof(input: unknown): VerifiedSemanticPlanProof {
  if (!input || typeof input !== 'object' || !activeProofs.has(input)) {
    throw new Error('semantic plan proof provenance is invalid');
  }
  const proof = input as VerifiedSemanticPlanProof;
  const bindings = proofBindings.get(proof);
  if (!bindings) {throw new Error('semantic plan proof binding is missing');}
  const { proof_hash: proofHash, ...brandedDraft } = proof;
  const draft = brandedDraft;
  const parent = verifyPlannedF1QLParent(bindings.parent);
  if (proof[verifiedSemanticPlanProofBrand] !== true || proof.version !== SEMANTIC_PLAN_PROOF_VERSION ||
      proof.catalog_hash !== SEMANTIC_CATALOG_HASH || proof.planned_f1ql_hash !== parent.program_hash ||
      proof.core_hash !== parent.core_hash || proof.participation_hash !== sha256(stableSerialize(parent.participation)) ||
      proof.compiled_hash !== sha256(stableSerialize(parent.compiled)) ||
      proofHash !== sha256(stableSerialize(draft)) || !Object.isFrozen(bindings.expected_plan)) {
    throw new Error('semantic plan proof binding is invalid');
  }
  return proof;
}

export function getSemanticPlanProofParent(input: unknown): VerifiedPlannedF1QLParent {
  const proof = verifySemanticPlanProof(input);
  return proofBindings.get(proof)!.parent;
}

function independentlyMaterialize(query: SemanticQuery, resolution: VerifiedSemanticResolutionEvidence): MaterializedPlan {
  const sourceIds = [...resolution.source_ids];
  const branches = sourceIds.map(sourceId => independentlyBuildBranch(query, sourceId, resolution.entities, resolution.resolved_round));
  const aggregateOutputs = query.outputs.filter(output => output.kind === 'aggregate');
  let topology: ExpectedTopology;
  let projectInput: PlannedF1QLProgram['root']['input']['input']['input'];
  let projectOutputs: PlannedF1QLProgram['root']['input']['input']['outputs'];
  let rowRelationships: string[] = [];
  if (sourceIds.length === 1) {
    if (aggregateOutputs.length > 0) {
      topology = 'single_source_aggregate';
      projectInput = independentlyAggregate(query, sourceIds[0], branches[0].predicates);
      projectOutputs = query.outputs.map(output => output.kind === 'aggregate'
        ? { kind: 'aggregate' as const, measure_as: `${output.function}_${output.concept.concept_id}`, as: `${output.function}_${output.concept.concept_id}` }
        : { kind: 'concept' as const, concept: output.concept, as: output.concept.concept_id });
    } else {
      topology = 'single_source_rows';
      projectInput = rowBranch(sourceIds[0], branches[0].predicates);
      projectOutputs = query.outputs.map(output => ({ kind: 'concept' as const, concept: output.concept, as: output.concept.concept_id }));
    }
  } else if (sameStrings(sourceIds, ['event_classification', 'event_metadata']) && aggregateOutputs.length === 0) {
    const relationships = SEMANTIC_CATALOG.relationships.filter(relationship => relationship.join_stage === 'row' &&
      relationship.governance !== 'experimental' && relationship.from_source === sourceIds[0] &&
      relationship.to_source === sourceIds[1] && ['many_to_one', 'one_to_one'].includes(relationship.cardinality));
    if (relationships.length !== 1) {throw new SemanticPlanProofError('unsupported_topology');}
    topology = 'row_dimension_join';
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
      inputs: sourceIds.map((sourceId, index) => independentlyAggregate(query, sourceId, branches[index].predicates))
    };
    projectOutputs = sourceIds.flatMap(sourceId => query.outputs.flatMap(output =>
      output.kind === 'aggregate' && output.concept.source_id === sourceId ? [{
        kind: 'composed_aggregate' as const,
        source_id: sourceId,
        measure_as: `${output.function}_${output.concept.concept_id}`,
        as: `${sourceId}__${output.function}_${output.concept.concept_id}`
      }] : []));
  } else {
    throw new SemanticPlanProofError('unsupported_topology');
  }
  const outputIds = projectOutputs.map(output => output.as);
  let residualGrain = branches[0].residual_grain;
  if (topology === 'scalar_aggregate_compose') {
    residualGrain = [];
  } else if (topology === 'single_source_aggregate') {
    residualGrain = query.group_by.map(group => group.concept.concept_id);
  }
  if (new Set(outputIds).size !== outputIds.length || residualGrain.some(grain => !outputIds.includes(grain))) {
    throw new SemanticPlanProofError('unsupported_topology');
  }
  const sortKeys = query.order_by.map(order => ({
    output_id: expectedOutputId(query, order.output_index, topology), direction: order.direction, nulls: 'last' as const
  }));
  for (const grain of residualGrain) {
    if (!sortKeys.some(key => key.output_id === grain)) {
      sortKeys.push({ output_id: grain, direction: 'asc', nulls: 'last' });
    }
  }
  if (sortKeys.length === 0 && residualGrain.length === 0) {
    sortKeys.push({ output_id: outputIds[0], direction: 'asc', nulls: 'last' });
  }
  if (sortKeys.length === 0 || sortKeys.length > 4) {throw new SemanticPlanProofError('unsupported_topology');}
  const count = residualGrain.length === 0 ? 1 : query.limit?.value ?? PLANNED_F1QL_MAX_ROWS;
  return {
    program: {
      kind: 'internal_planned_f1ql', version: PLANNED_F1QL_VERSION, catalog_hash: SEMANTIC_CATALOG_HASH,
      root: { op: 'limit', count, input: { op: 'sort', keys: sortKeys, input: { op: 'project', input: projectInput, outputs: projectOutputs } } }
    },
    topology,
    branches,
    row_relationship_ids: rowRelationships
  };
}

function independentlyBuildBranch(
  query: SemanticQuery,
  sourceId: AnswerFactSourceId,
  entities: readonly LinkedSemanticEntity[],
  resolvedRound?: number
): ExpectedBranch {
  const source = SEMANTIC_CATALOG.sources.find(item => item.id === sourceId)!;
  const season = query.scopes.find(scope => scope.kind === 'season');
  if (!season || season.kind !== 'season') {throw new SemanticPlanProofError('admission_invalid');}
  const predicates: PlannedPredicate[] = [{ concept: ref(sourceId, 'season'), operator: 'eq', value: season.value }];
  if (source.dimensions.some(dimension => dimension.id === 'round') && resolvedRound !== undefined) {
    predicates.push({ concept: ref(sourceId, 'round'), operator: 'eq', value: resolvedRound });
  }
  for (const filter of query.filters.filter(item => item.concept.source_id === sourceId)) {
    if (filter.kind === 'entity') {
      const values = filter.entity_indices.map(index => {
        const linked = entities.find(entity => entity.entity_index === index && entity.type === 'driver');
        if (!linked) {throw new SemanticPlanProofError('resolution_invalid');}
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
      predicates.push({ concept: filter.concept, operator: 'range', min: filter.min as string | number, max: filter.max as string | number });
    }
  }
  predicates.sort((left, right) => compareText(refKey(left.concept), refKey(right.concept)));
  if (new Set(predicates.map(predicate => predicate.concept.concept_id)).size !== predicates.length) {
    throw new SemanticPlanProofError('unsupported_topology');
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

function independentlyAggregate(
  query: SemanticQuery,
  sourceId: AnswerFactSourceId,
  predicates: readonly PlannedPredicate[]
): PlannedAggregate {
  const groups = query.group_by.filter(group => group.concept.source_id === sourceId).map(group => group.concept);
  const measures = query.outputs.flatMap(output => output.kind === 'aggregate' && output.concept.source_id === sourceId
    ? [{ concept: output.concept, function: output.function, as: `${output.function}_${output.concept.concept_id}` }] : []);
  if (measures.length === 0 || query.outputs.some(output => output.kind === 'concept' && output.concept.source_id === sourceId &&
      !groups.some(group => refKey(group) === refKey(output.concept)))) {
    throw new SemanticPlanProofError('unsupported_topology');
  }
  return { op: 'aggregate', input: rowBranch(sourceId, predicates), group_by: groups, measures };
}

function rowBranch(sourceId: AnswerFactSourceId, predicates: readonly PlannedPredicate[]) {
  return { op: 'filter' as const, input: { op: 'source' as const, source_id: sourceId }, predicates: [...predicates] };
}

function expectedOutputId(query: SemanticQuery, index: number, topology: ExpectedTopology): string {
  const output = query.outputs[index];
  if (!output) {throw new SemanticPlanProofError('unsupported_topology');}
  if (output.kind === 'concept') {return output.concept.concept_id;}
  const aggregate = `${output.function}_${output.concept.concept_id}`;
  return topology === 'scalar_aggregate_compose' ? `${output.concept.source_id}__${aggregate}` : aggregate;
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
