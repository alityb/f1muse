import { createHash } from 'node:crypto';
import {
  OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
  OfficialTimingQuestionMatch
} from './official-timing-question';
import { OfficialTimingSemanticEvidence } from './official-timing-semantic-query';
import { OfficialTimingResolution, verifyOfficialTimingResolution } from './official-timing-resolution';
import { OfficialTimingPlan, verifyOfficialTimingPlan } from './official-timing-plan';
import {
  OfficialTimingPipelineResult,
  verifyOfficialTimingPipeline
} from './official-timing-compiler';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_PLAN_PROOF_VERSION = 'semantic-plan-proof-v2' as const;

const CERTIFIED_SCOPE = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;

export interface OfficialTimingPlanProof {
  readonly version: typeof OFFICIAL_TIMING_PLAN_PROOF_VERSION;
  readonly question_sha256: string;
  readonly catalog_sha256: string;
  readonly semantic_query_sha256: string;
  readonly plan_sha256: string;
  readonly planned_f1ql_sha256: string;
  readonly planned_core_sha256: string;
  readonly compiled_statement_sha256: string;
  readonly coverage_query_id: string;
  readonly coverage_query_sha256: string;
  readonly coverage_witness_sha256: string;
  readonly metric_contract_sha256: string;
  readonly output_schema_sha256: string;
  readonly branch_binding_sha256: string;
  readonly proof_hash: string;
}

export class OfficialTimingProofError extends Error {
  constructor(readonly reason: 'branch_reconstruction_mismatch' | 'binding_mismatch' | 'proof_provenance_invalid') {
    super(reason);
    this.name = 'OfficialTimingProofError';
  }
}

const activeProofs = new WeakSet<object>();

export function proveOfficialTimingPlan(input: {
  readonly question: OfficialTimingQuestionMatch;
  readonly evidence: OfficialTimingSemanticEvidence;
  readonly resolution: OfficialTimingResolution;
  readonly plan: OfficialTimingPlan;
  readonly pipeline: OfficialTimingPipelineResult;
}): OfficialTimingPlanProof {
  let plan: OfficialTimingPlan;
  let pipeline: OfficialTimingPipelineResult;
  let verifiedResolution: OfficialTimingResolution;
  try {
    plan = verifyOfficialTimingPlan(input.plan);
    pipeline = verifyOfficialTimingPipeline(input.pipeline);
    verifiedResolution = verifyOfficialTimingResolution(input.resolution, input.question, input.evidence);
  } catch {
    throw new OfficialTimingProofError('proof_provenance_invalid');
  }
  const resolution = verifiedResolution;
  if (resolution.type !== 'resolved') {
    throw new OfficialTimingProofError('binding_mismatch');
  }
  const query = input.evidence.candidates[0];
  const compiled = pipeline.compiled;
  const expectedWindow = expectedWindowFromQuery(query);
  assertCompiledParameters(resolution, expectedWindow, compiled.parameters);
  const compare = plan.planned_f1ql.root.input.input.input;
  const reconstructedBranches = reconstructBranches(resolution, expectedWindow);
  if (stableSerialize([compare.left, compare.right]) !== stableSerialize(reconstructedBranches)) {
    throw new OfficialTimingProofError('branch_reconstruction_mismatch');
  }
  const bindings = requireSealedBindings(resolution);
  assertCrossArtifactBindings(input, resolution, plan, compiled, bindings.metricContract);
  const unsigned = {
    version: OFFICIAL_TIMING_PLAN_PROOF_VERSION,
    question_sha256: input.question.question_sha256,
    catalog_sha256: input.evidence.catalog_hash,
    semantic_query_sha256: plan.semantic_query_hash,
    plan_sha256: plan.answer_plan_hash,
    planned_f1ql_sha256: plan.planned_f1ql_hash,
    planned_core_sha256: pipeline.planned_core_hash,
    compiled_statement_sha256: compiled.compiled_sha256,
    coverage_query_id: bindings.coverageQuery.id,
    coverage_query_sha256: bindings.coverageQuery.statement_sha256,
    coverage_witness_sha256: plan.coverage_witness_hash,
    metric_contract_sha256: compiled.metric_contract_sha256,
    output_schema_sha256: compiled.output_schema_sha256,
    branch_binding_sha256: hash(reconstructedBranches)
  };
  const proof: OfficialTimingPlanProof = deepFreeze({ ...unsigned, proof_hash: hash(unsigned) });
  activeProofs.add(proof);
  return proof;
}

function assertCompiledParameters(
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>,
  expectedWindow: { readonly min: number; readonly max: number } | null,
  parameters: readonly (string | number)[]
): void {
  const expected: (string | number)[] = [
    CERTIFIED_SCOPE.season,
    CERTIFIED_SCOPE.round,
    CERTIFIED_SCOPE.session_type,
    resolution.drivers[0].driver_id,
    resolution.drivers[1].driver_id,
    ...(expectedWindow === null ? [] : [expectedWindow.min, expectedWindow.max])
  ];
  if (stableSerialize(parameters) !== stableSerialize(expected)) {
    throw new OfficialTimingProofError('binding_mismatch');
  }
}

function expectedWindowFromQuery(
  query: OfficialTimingSemanticEvidence['candidates'][number]
): { readonly min: number; readonly max: number } | null {
  const window = query.filters.find(filter => filter.kind === 'literal_range');
  if (query.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID) {
    if (window !== undefined) {
      throw new OfficialTimingProofError('binding_mismatch');
    }
    return null;
  }
  if (window?.kind !== 'literal_range') {
    throw new OfficialTimingProofError('binding_mismatch');
  }
  return { min: window.min, max: window.max };
}

function requireSealedBindings(resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>) {
  const coverageQuery = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries
    .find(candidate => candidate.metric_id === resolution.coverage.metric);
  const metricContract = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics
    .find(metric => metric.metric_id === resolution.coverage.metric);
  if (!coverageQuery || !metricContract || coverageQuery.id !== resolution.coverage.coverage_query_id ||
      coverageQuery.statement_sha256 !== resolution.coverage.coverage_query_sha256) {
    throw new OfficialTimingProofError('binding_mismatch');
  }
  return { coverageQuery, metricContract };
}

function assertCrossArtifactBindings(
  input: { readonly question: OfficialTimingQuestionMatch; readonly evidence: OfficialTimingSemanticEvidence },
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>,
  plan: OfficialTimingPlan,
  compiled: OfficialTimingPipelineResult['compiled'],
  metricContract: unknown
): void {
  const query = input.evidence.candidates[0];
  const mismatches = [
    query.metric_id !== plan.metric_id,
    compiled.metric_id !== plan.metric_id,
    resolution.coverage.metric !== plan.metric_id,
    plan.question_sha256 !== input.question.question_sha256,
    plan.semantic_query_hash !== resolution.semantic_query_hash,
    plan.resolution_evidence_hash !== resolution.resolution_hash,
    plan.semantic_evidence_hash !== resolution.semantic_evidence_hash,
    plan.candidate_set_hash !== input.evidence.candidate_set_hash,
    resolution.candidate_set_hash !== input.evidence.candidate_set_hash,
    plan.coverage_witness_hash !== hash(resolution.coverage),
    plan.catalog_hash !== input.evidence.catalog_hash,
    compiled.answer_plan_hash !== plan.answer_plan_hash,
    compiled.planned_f1ql_hash !== plan.planned_f1ql_hash,
    compiled.metric_contract_sha256 !== hash(metricContract)
  ];
  if (mismatches.some(Boolean)) {
    throw new OfficialTimingProofError('binding_mismatch');
  }
}

export function verifyOfficialTimingProof(input: unknown, context: {
  readonly question: OfficialTimingQuestionMatch;
  readonly evidence: OfficialTimingSemanticEvidence;
  readonly resolution: OfficialTimingResolution;
  readonly plan: OfficialTimingPlan;
  readonly pipeline: OfficialTimingPipelineResult;
}): OfficialTimingPlanProof {
  if (!input || typeof input !== 'object' || !activeProofs.has(input)) {
    throw new OfficialTimingProofError('proof_provenance_invalid');
  }
  const reproduced = proveOfficialTimingPlan(context);
  if (stableSerialize(input) !== stableSerialize(reproduced)) {
    throw new OfficialTimingProofError('binding_mismatch');
  }
  return input as OfficialTimingPlanProof;
}

function reconstructBranches(
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>,
  window: { readonly min: number; readonly max: number } | null
) {
  const aggregation = resolution.coverage.metric === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? 'arithmetic_mean_integer_milliseconds' as const
    : 'median_integer_milliseconds' as const;
  return resolution.drivers.map(driver => ({
    op: 'aggregate' as const,
    branch: driver.branch,
    input: {
      op: 'filter' as const,
      input: { op: 'source' as const, source_id: 'official_race_lap_timing' as const, view: 'f1ql.official_race_lap_timing' as const },
      predicates: [
        { concept: 'season', operator: 'eq' as const, value: CERTIFIED_SCOPE.season },
        { concept: 'round', operator: 'eq' as const, value: CERTIFIED_SCOPE.round },
        { concept: 'session_type', operator: 'eq' as const, value: CERTIFIED_SCOPE.session_type },
        { concept: 'driver_id', operator: 'eq' as const, value: driver.driver_id },
        ...(window === null ? [] : [{ concept: 'lap_number', operator: 'range' as const, min: window.min, max: window.max }])
      ]
    },
    group_by: [] as const,
    measures: [{
      concept: 'lap_time_seconds' as const,
      function: aggregation,
      as: `${driver.branch}_metric` as 'driver_a_metric' | 'driver_b_metric',
      exclude_predicates: [
        { concept: 'official_deleted_lap' as const, operator: 'eq' as const, value: false as const },
        { concept: 'official_pit_marker' as const, operator: 'eq' as const, value: false as const }
      ]
    }]
  }));
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing proof value is not canonically serializable');
  }
  return serialized;
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
