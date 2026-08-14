import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OfficialTimingQuestionMatch,
  OfficialTimingQuestionRefusalReason,
  parseOfficialTimingQuestion
} from './official-timing-question';
import {
  computeOfficialTimingQueryHash,
  enumerateOfficialTimingEvidence,
  OfficialTimingSemanticEvidence
} from './official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  OfficialTimingResolutionDependencies,
  OfficialTimingResolutionError
} from './official-timing-resolution';
import { readOfficialTimingCoverage } from './official-timing-coverage';
import {
  admitOfficialTimingProviderSelection,
  OFFICIAL_TIMING_PROVIDER_SELECTION_VERSION
} from './official-timing-provider-admission';
import { planOfficialTimingAnswer, OfficialTimingPlannerError } from './official-timing-plan';
import { OfficialTimingCompilerError, runOfficialTimingPlannedPipeline } from './official-timing-compiler';
import { OfficialTimingProofError, proveOfficialTimingPlan } from './official-timing-proof';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
} from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_VERSION = 'semantic-shadow-planner-v7' as const;
export const OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION = 'semantic-shadow-observation-v2' as const;
export const OFFICIAL_TIMING_SHADOW_RETAINED_VERSION = 'semantic-shadow-retained-v3' as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const SHADOW_REASONS = [
  'plan_proven',
  'attachment_ambiguous', 'entity_ambiguous', 'metric_ambiguous', 'output_shape_ambiguous',
  'scope_ambiguous', 'temporal_ambiguous', 'event_ambiguous',
  'candidate_overflow', 'provider_candidate_not_enumerated', 'unknown_language',
  'unsupported_comparison', 'unsupported_concept', 'unsupported_source_combination', 'unsupported_scope',
  'provider_malformed', 'provider_unavailable', 'question_invalid',
  'admission_invalid', 'aggregate_locality_unsupported', 'aggregate_locality_violation',
  'entity_cardinality_mismatch', 'entity_inventory_mismatch', 'grain_mismatch', 'identity_unresolved',
  'join_path_ambiguous', 'ordering_undefined', 'output_alias_collision', 'planned_program_invalid',
  'source_coverage_missing', 'source_graph_disconnected', 'unsafe_join_cardinality',
  'evidence_invalid', 'plan_mismatch', 'resolution_invalid', 'semantic_query_not_unique', 'unsupported_topology',
  'shadow_internal_failure', 'source_integrity_failed'
] as const;
type ShadowReason = (typeof SHADOW_REASONS)[number];

const REFUSAL_TO_SHADOW_REASON: Readonly<Record<OfficialTimingQuestionRefusalReason, ShadowReason>> = {
  ambiguous_or_missing_event: 'unsupported_scope',
  ambiguous_or_missing_season: 'unsupported_scope',
  clean_air: 'unsupported_concept',
  classification: 'unsupported_concept',
  causal_performance: 'unsupported_concept',
  constructor_or_team: 'unsupported_concept',
  contradictory_metric: 'metric_ambiguous',
  control_or_instruction_text: 'question_invalid',
  driver_cardinality_not_two: 'entity_cardinality_mismatch',
  explicit_exclusion_override: 'unsupported_concept',
  fastest_or_single_lap: 'unsupported_concept',
  fuel: 'unsupported_concept',
  generic_pace: 'unsupported_concept',
  grid: 'unsupported_concept',
  interim_or_latest: 'temporal_ambiguous',
  malformed_or_oversized_lap_range: 'question_invalid',
  multiple_sessions: 'unsupported_scope',
  multiseason: 'unsupported_scope',
  negation: 'unsupported_concept',
  practice: 'unsupported_scope',
  qualifying: 'unsupported_scope',
  safety_car: 'unsupported_concept',
  same_driver: 'identity_unresolved',
  sprint: 'unsupported_scope',
  strategy: 'unsupported_concept',
  traffic: 'unsupported_concept',
  tyre: 'unsupported_concept',
  unconsumed_filler: 'unknown_language',
  weather: 'unsupported_concept'
};

const observationSchema = z.object({
  version: z.literal(OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION),
  outcome: z.enum(['answer', 'clarify', 'abstain', 'unavailable']),
  reason: z.enum(SHADOW_REASONS),
  topology_code: z.literal('same_source_scalar_comparison').optional(),
  source_set_code: z.literal('official_race_lap_timing').optional(),
  operator_set_code: z.literal('filter_aggregate_compare_project_sort_limit').optional(),
  candidate_counts: z.object({
    enumerated: z.number().int().min(0).max(2),
    proposed: z.number().int().min(0).max(2),
    matched: z.number().int().min(0).max(2),
    omitted: z.number().int().min(0).max(2),
    extraneous: z.number().int().min(0).max(2),
    comparison: z.enum(['exact', 'omission', 'extraneous', 'mixed', 'not_comparable'])
  }).strict(),
  resolver_counts: z.object({
    driver_inventory_reads: z.number().int().min(0).max(2),
    event_reads: z.number().int().min(0).max(1),
    fingerprint_reads: z.literal(0),
    official_coverage_reads: z.number().int().min(0).max(1)
  }).strict(),
  execution_counters: z.object({
    translated_execution_calls: z.literal(0),
    planned_result_execution_calls: z.literal(0),
    answer_result_executor_calls: z.literal(0),
    result_query_calls: z.literal(0)
  }).strict(),
  plan_work: z.object({
    model: z.literal('semantic-plan-work-v2'),
    sources: z.literal(1),
    source_scans: z.literal(2),
    joins: z.literal(0),
    comparisons: z.literal(1),
    compositions: z.literal(0),
    requested_rows: z.literal(1)
  }).strict().optional(),
  hashes: z.object({
    activation_bundle_sha256: sha256Schema,
    catalog_sha256: sha256Schema.optional(),
    candidate_set_sha256: sha256Schema.optional(),
    provider_candidate_set_sha256: sha256Schema.optional(),
    semantic_evidence_sha256: sha256Schema.optional(),
    semantic_query_sha256: sha256Schema.optional(),
    coverage_query_id: z.enum(['official_event_coverage_v1', 'official_window_coverage_v1']).optional(),
    coverage_query_sha256: sha256Schema.optional(),
    coverage_witness_sha256: sha256Schema.optional(),
    answer_plan_sha256: sha256Schema.optional(),
    topology_sha256: sha256Schema.optional(),
    planned_f1ql_sha256: sha256Schema.optional(),
    planned_core_sha256: sha256Schema.optional(),
    compiled_sha256: sha256Schema.optional(),
    semantic_proof_sha256: sha256Schema.optional()
  }).strict(),
  template_dual: z.object({ enabled: z.literal(false), status: z.literal('not_applicable') }).strict(),
  latencies: z.object({ total_ms: z.number().int().min(0).max(600_000) }).strict(),
  versions: z.object({
    orchestrator: z.literal(OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_VERSION),
    observation: z.literal(OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION),
    question_parser: z.literal('official-timing-question-parser-v1'),
    semantic_query: z.literal(3),
    resolution: z.literal('semantic-resolution-v2'),
    planner: z.literal('semantic-planner-v3'),
    planned_f1ql: z.literal(3),
    planned_compiler: z.literal('planned-compiler-v3'),
    proof: z.literal('semantic-plan-proof-v2'),
    coverage_reader: z.literal('official-timing-coverage-v1')
  }).strict()
}).strict().superRefine((observation, context) => {
  const planFields = [observation.topology_code, observation.source_set_code, observation.operator_set_code, observation.plan_work];
  const planHashes = [
    observation.hashes.answer_plan_sha256, observation.hashes.planned_f1ql_sha256,
    observation.hashes.planned_core_sha256, observation.hashes.compiled_sha256,
    observation.hashes.semantic_proof_sha256, observation.hashes.topology_sha256
  ];
  const complete = planFields.every(value => value !== undefined) && planHashes.every(value => value !== undefined);
  const absent = planFields.every(value => value === undefined) && planHashes.every(value => value === undefined);
  if (!complete && !absent) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official timing shadow plan fields are incomplete' });
  }
  if ((observation.outcome === 'answer') !== complete) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official timing shadow plan fields require the answer outcome' });
  }
  if ((observation.outcome === 'answer') !== (observation.reason === 'plan_proven')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official timing shadow answer reason is invalid' });
  }
  if ((observation.outcome === 'unavailable') !==
      (observation.reason === 'provider_malformed' || observation.reason === 'provider_unavailable')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official timing shadow provider outcome is inconsistent' });
  }
});

export type OfficialTimingShadowObservation = z.infer<typeof observationSchema>;

export interface OfficialTimingShadowProposer {
  propose(request: {
    readonly version: typeof OFFICIAL_TIMING_PROVIDER_SELECTION_VERSION;
    readonly question: string;
    readonly semantic_query_version: 3;
    readonly candidate_set_hash: string;
    readonly catalog_hash: string;
    readonly candidates: readonly [{
      readonly candidate_id: string;
      readonly semantic_query: OfficialTimingSemanticEvidence['candidates'][0];
    }];
  }): Promise<unknown>;
}

export interface OfficialTimingShadowDependencies {
  readonly proposer: OfficialTimingShadowProposer;
  readonly resolution: Omit<OfficialTimingResolutionDependencies, 'catalog'> & {
    readonly catalog: OfficialTimingResolutionDependencies['catalog'];
  };
  readonly now?: () => number;
}

interface Counters {
  driverInventoryReads: number;
  eventReads: number;
  coverageReads: number;
}

export async function orchestrateOfficialTimingShadow(
  questionInput: unknown,
  dependencies: OfficialTimingShadowDependencies
): Promise<OfficialTimingShadowObservation> {
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  const counters: Counters = { driverInventoryReads: 0, eventReads: 0, coverageReads: 0 };
  const finish = (input: Omit<OfficialTimingShadowObservation, 'version' | 'resolver_counts' | 'execution_counters' | 'latencies' | 'versions' | 'template_dual'>) =>
    sanitizeOfficialTimingShadowObservation({
      ...input,
      resolver_counts: {
        driver_inventory_reads: counters.driverInventoryReads,
        event_reads: counters.eventReads,
        fingerprint_reads: 0,
        official_coverage_reads: counters.coverageReads
      },
      latencies: { total_ms: boundedLatency(startedAt, now()) },
      versions: shadowVersions()
    });

  let question: OfficialTimingQuestionMatch;
  try {
    const parsed = parseOfficialTimingQuestion(questionInput);
    if (parsed.type !== 'matched') {
      return finish(baseOutcome(outcomeForReason(REFUSAL_TO_SHADOW_REASON[parsed.reason]), REFUSAL_TO_SHADOW_REASON[parsed.reason], {}));
    }
    question = parsed;
  } catch {
    return finish(baseOutcome('abstain', 'question_invalid', {}));
  }

  let evidence: OfficialTimingSemanticEvidence;
  try {
    evidence = enumerateOfficialTimingEvidence(question, dependencies.resolution.catalog);
  } catch {
    return finish(baseOutcome('abstain', 'evidence_invalid', {}));
  }
  let hashes: OfficialTimingShadowObservation['hashes'] = {
    activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
    catalog_sha256: evidence.catalog_hash,
    candidate_set_sha256: evidence.candidate_set_hash,
    semantic_evidence_sha256: hashValue(evidence),
    semantic_query_sha256: computeQueryHashForObservation(evidence)
  };

  const proposal = await proposalStage(dependencies.proposer, question, evidence, hashes, finish);
  if (proposal.type === 'observation') {
    return proposal.observation;
  }
  hashes = proposal.hashes;

  const resolved = await resolutionStage(dependencies.resolution, question, evidence, hashes, counters, finish);
  if (resolved.type === 'observation') {
    return resolved.observation;
  }
  return planningStage(question, evidence, resolved.resolution, resolved.hashes, finish);
}

type ResolutionStageResult =
  | { readonly type: 'observation'; readonly observation: OfficialTimingShadowObservation }
  | {
      readonly type: 'resolved';
      readonly resolution: Extract<Awaited<ReturnType<typeof collectOfficialTimingResolution>>, { type: 'resolved' }>;
      readonly hashes: ObservationHashes;
    };

async function resolutionStage(
  dependencies: OfficialTimingResolutionDependencies,
  question: OfficialTimingQuestionMatch,
  evidence: OfficialTimingSemanticEvidence,
  hashes: ObservationHashes,
  counters: Counters,
  finish: Finish
): Promise<ResolutionStageResult> {
  let resolution;
  try {
    resolution = await collectOfficialTimingResolution(question, evidence, countingResolutionDependencies(dependencies, counters));
  } catch (error) {
    const reason = error instanceof OfficialTimingResolutionError ? resolutionReason(error.code) : 'resolution_invalid';
    return { type: 'observation', observation: finish(baseOutcome(outcomeForReason(reason), reason, hashes)) };
  }
  const coverageQueryId = resolution.type === 'resolved'
    ? resolution.coverage.coverage_query_id
    : coverageQueryIdFor(question.metric_id);
  const coverageQuerySha256 = resolution.type === 'resolved'
    ? resolution.coverage.coverage_query_sha256
    : coverageQuerySha256For(question.metric_id);
  const withCoverage = {
    ...hashes,
    coverage_query_id: coverageQueryId,
    coverage_query_sha256: coverageQuerySha256,
    coverage_witness_sha256: hashValue(resolution.coverage)
  };
  if (resolution.type === 'abstained') {
    return { type: 'observation', observation: finish(baseOutcome('abstain', resolution.coverage.reason, withCoverage)) };
  }
  return { type: 'resolved', resolution, hashes: withCoverage };
}

type Finish = (input: Omit<OfficialTimingShadowObservation, 'version' | 'resolver_counts' | 'execution_counters' | 'latencies' | 'versions' | 'template_dual'>) => OfficialTimingShadowObservation;

type ProposalStageResult =
  | { readonly type: 'observation'; readonly observation: OfficialTimingShadowObservation }
  | { readonly type: 'admitted'; readonly hashes: ObservationHashes };

async function proposalStage(
  proposer: OfficialTimingShadowProposer,
  question: OfficialTimingQuestionMatch,
  evidence: OfficialTimingSemanticEvidence,
  hashes: ObservationHashes,
  finish: Finish
): Promise<ProposalStageResult> {
  let providerInput: unknown;
  try {
    providerInput = await proposer.propose(deepFreeze({
      version: OFFICIAL_TIMING_PROVIDER_SELECTION_VERSION,
      question: question.normalized_question,
      semantic_query_version: 3,
      candidate_set_hash: evidence.candidate_set_hash,
      catalog_hash: evidence.catalog_hash,
      candidates: [{
        candidate_id: computeOfficialTimingQueryHash(evidence.candidates[0]),
        semantic_query: evidence.candidates[0]
      }]
    }));
  } catch {
    return {
      type: 'observation',
      observation: finish({ ...baseOutcome('unavailable', 'provider_unavailable', hashes), candidate_counts: { enumerated: 1, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable' } })
    };
  }
  const admission = admitProviderSelection(providerInput, evidence);
  if (admission.type !== 'admitted') {
    return {
      type: 'observation',
      observation: finish({
        ...baseOutcome(admission.outcome, admission.reason, {
          ...hashes,
          ...(admission.provider_hash === undefined ? {} : { provider_candidate_set_sha256: admission.provider_hash })
        }),
        candidate_counts: admission.candidate_counts
      })
    };
  }
  return { type: 'admitted', hashes: { ...hashes, provider_candidate_set_sha256: admission.provider_hash } };
}

function planningStage(
  question: OfficialTimingQuestionMatch,
  evidence: OfficialTimingSemanticEvidence,
  resolution: Extract<Awaited<ReturnType<typeof collectOfficialTimingResolution>>, { type: 'resolved' }>,
  hashes: ObservationHashes,
  finish: Finish
): OfficialTimingShadowObservation {
  try {
    const plan = planOfficialTimingAnswer({ question, evidence, resolution });
    const pipeline = runOfficialTimingPlannedPipeline(plan);
    const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
    return finish({
      outcome: 'answer',
      reason: 'plan_proven',
      candidate_counts: { enumerated: 1, proposed: 1, matched: 1, omitted: 0, extraneous: 0, comparison: 'exact' },
      topology_code: 'same_source_scalar_comparison',
      source_set_code: 'official_race_lap_timing',
      operator_set_code: 'filter_aggregate_compare_project_sort_limit',
      plan_work: {
        model: 'semantic-plan-work-v2',
        sources: 1, source_scans: 2, joins: 0, comparisons: 1, compositions: 0, requested_rows: 1
      },
      hashes: {
        ...hashes,
        answer_plan_sha256: plan.answer_plan_hash,
        topology_sha256: hashValue(plan.topology),
        planned_f1ql_sha256: plan.planned_f1ql_hash,
        planned_core_sha256: pipeline.planned_core_hash,
        compiled_sha256: pipeline.compiled.compiled_sha256,
        semantic_proof_sha256: proof.proof_hash
      }
    });
  } catch (error) {
    const reason = planningFailureReason(error);
    return finish(baseOutcome('abstain', reason, hashes));
  }
}

function planningFailureReason(error: unknown): ShadowReason {
  if (error instanceof OfficialTimingPlannerError) {
    return 'planned_program_invalid';
  }
  if (error instanceof OfficialTimingProofError) {
    return 'plan_mismatch';
  }
  if (error instanceof OfficialTimingCompilerError) {
    return 'planned_program_invalid';
  }
  return 'shadow_internal_failure';
}

export function sanitizeOfficialTimingShadowObservation(input: unknown): OfficialTimingShadowObservation {
  return deepFreeze(observationSchema.parse({
    version: OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION,
    template_dual: { enabled: false, status: 'not_applicable' },
    execution_counters: {
      translated_execution_calls: 0,
      planned_result_execution_calls: 0,
      answer_result_executor_calls: 0,
      result_query_calls: 0
    },
    ...input as Record<string, unknown>
  }));
}

type CandidateCounts = OfficialTimingShadowObservation['candidate_counts'];
type ProviderAdmission =
  | { readonly type: 'admitted'; readonly provider_hash: string }
  | {
      readonly type: 'rejected';
      readonly outcome: 'unavailable' | 'abstain';
      readonly reason: ShadowReason;
      readonly provider_hash?: string;
      readonly candidate_counts: CandidateCounts;
    };

function admitProviderSelection(
  input: unknown,
  evidence: OfficialTimingSemanticEvidence
): ProviderAdmission {
  const admission = admitOfficialTimingProviderSelection(input, evidence);
  if (admission.type === 'admitted') {
    return { type: 'admitted', provider_hash: admission.provider_candidate_set_sha256 };
  }
  if (admission.type === 'malformed') {
    return {
      type: 'rejected',
      outcome: 'unavailable',
      reason: 'provider_malformed',
      candidate_counts: { enumerated: 1, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable' }
    };
  }
  return {
    type: 'rejected',
    outcome: 'abstain',
    reason: 'provider_candidate_not_enumerated',
    provider_hash: admission.provider_candidate_set_sha256,
    candidate_counts: { enumerated: 1, proposed: 1, matched: 0, omitted: 0, extraneous: 1, comparison: 'extraneous' }
  };
}

function countingResolutionDependencies(
  dependencies: OfficialTimingShadowDependencies['resolution'],
  counters: Counters
): OfficialTimingResolutionDependencies {
  return {
    ...dependencies,
    driver_resolver: {
      resolveUnambiguous: async (alias, season) => {
        counters.driverInventoryReads += 1;
        return dependencies.driver_resolver.resolveUnambiguous(alias, season);
      }
    },
    event_resolver: {
      resolveRound: async (season, round) => {
        counters.eventReads += 1;
        return dependencies.event_resolver.resolveRound(season, round);
      }
    },
    coverage_reader: async (database, request) => {
      counters.coverageReads += 1;
      return (dependencies.coverage_reader ?? readOfficialTimingCoverage)(database, request);
    }
  };
}

function resolutionReason(code: OfficialTimingResolutionError['code']): ShadowReason {
  const mapped: Record<OfficialTimingResolutionError['code'], ShadowReason> = {
    catalog_unsupported: 'evidence_invalid',
    driver_not_certified: 'identity_unresolved',
    entity_ambiguous: 'entity_ambiguous',
    event_mismatch: 'event_ambiguous',
    evidence_invalid: 'evidence_invalid',
    identity_unresolved: 'identity_unresolved'
  };
  return mapped[code];
}

function outcomeForReason(reason: ShadowReason): 'answer' | 'clarify' | 'abstain' | 'unavailable' {
  if (reason === 'provider_malformed' || reason === 'provider_unavailable') {
    return 'unavailable';
  }
  const clarify: readonly ShadowReason[] = [
    'attachment_ambiguous', 'entity_ambiguous', 'metric_ambiguous', 'output_shape_ambiguous',
    'scope_ambiguous', 'temporal_ambiguous', 'event_ambiguous', 'join_path_ambiguous'
  ];
  return clarify.includes(reason) ? 'clarify' : 'abstain';
}

type ObservationHashes = OfficialTimingShadowObservation['hashes'];

function baseOutcome(
  outcome: 'answer' | 'clarify' | 'abstain' | 'unavailable',
  reason: ShadowReason,
  hashes: Omit<ObservationHashes, 'activation_bundle_sha256'> & { activation_bundle_sha256?: string }
) {
  return {
    outcome,
    reason,
    candidate_counts: { enumerated: 0, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable' as const },
    hashes: {
      activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
      ...hashes
    }
  };
}

function coverageQueryFor(metric: string) {
  const query = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries
    .find(candidate => candidate.metric_id === metric);
  if (!query) {
    throw new Error('FAIL_CLOSED: official timing coverage query contract is missing');
  }
  return query;
}

function coverageQueryIdFor(metric: string): 'official_event_coverage_v1' | 'official_window_coverage_v1' {
  const id = coverageQueryFor(metric).id;
  if (id !== 'official_event_coverage_v1' && id !== 'official_window_coverage_v1') {
    throw new Error('FAIL_CLOSED: official timing coverage query id is outside the sealed set');
  }
  return id;
}

function coverageQuerySha256For(metric: string): string {
  return coverageQueryFor(metric).statement_sha256;
}

function computeQueryHashForObservation(evidence: OfficialTimingSemanticEvidence): string {
  return hashValue(evidence.candidates[0]);
}

function shadowVersions(): OfficialTimingShadowObservation['versions'] {
  return {
    orchestrator: OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_VERSION,
    observation: OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION,
    question_parser: 'official-timing-question-parser-v1',
    semantic_query: 3,
    resolution: 'semantic-resolution-v2',
    planner: 'semantic-planner-v3',
    planned_f1ql: 3,
    planned_compiler: 'planned-compiler-v3',
    proof: 'semantic-plan-proof-v2',
    coverage_reader: 'official-timing-coverage-v1'
  };
}

function boundedLatency(startedAt: number, now: number): number {
  const elapsed = Math.floor(now - startedAt);
  return Math.max(0, Math.min(600_000, Number.isFinite(elapsed) ? elapsed : 0));
}

function hashValue(value: unknown): string {
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
    throw new Error('FAIL_CLOSED: official timing shadow value is not canonically serializable');
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

// Retained observation v3: exactly one sanitized terminal record per admitted request.
const retainedSchema = z.object({
  version: z.literal(OFFICIAL_TIMING_SHADOW_RETAINED_VERSION),
  timestamp: z.string().datetime({ offset: true }),
  mode: z.literal('semantic_shadow'),
  rollout_stage: z.literal(0),
  terminal: z.enum(['semantic', 'operational_failure']),
  observation: observationSchema.optional(),
  failure: z.object({
    reason: z.enum([
      'semantic_shadow_busy', 'answer_queue_timeout', 'request_timeout', 'request_cancelled',
      'metadata_statement_timeout', 'answer_database_unavailable',
      'semantic_shadow_metadata_unavailable', 'semantic_shadow_planning_unavailable'
    ]),
    stage: z.enum(['admission', 'inventory', 'proposal', 'resolution', 'planning', 'coverage', 'integrity']),
    total_ms: z.number().int().min(0).max(600_000)
  }).strict().optional(),
  provider_identity: z.object({
    provider: z.enum(['openai-compatible', 'anthropic']),
    endpoint_sha256: sha256Schema,
    model_sha256: sha256Schema,
    catalog_projection_sha256: sha256Schema,
    prompt_sha256: sha256Schema,
    schema_sha256: sha256Schema,
    request_config_sha256: sha256Schema
  }).strict(),
  resolver_transaction_counters: z.object({
    statement_count: z.number().int().min(0).max(3),
    returned_row_count: z.number().int().min(0).max(10_502),
    driver_inventory_reads: z.number().int().min(0).max(2),
    event_reads: z.number().int().min(0).max(1),
    official_coverage_reads: z.number().int().min(0).max(1)
  }).strict(),
  execution_counters: z.object({
    translated_execution_calls: z.literal(0),
    planned_result_execution_calls: z.literal(0),
    answer_result_executor_calls: z.literal(0),
    result_query_calls: z.literal(0)
  }).strict(),
  target_hashes: z.object({
    activation_bundle_sha256: sha256Schema,
    shadow_target_sha256: sha256Schema
  }).strict()
}).strict().superRefine((retained, context) => {
  if ((retained.terminal === 'semantic') !== (retained.observation !== undefined) ||
      (retained.terminal === 'operational_failure') !== (retained.failure !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official timing retained terminal payload is inconsistent' });
  }
});

export type OfficialTimingShadowRetainedObservation = z.infer<typeof retainedSchema>;

export function sanitizeOfficialTimingShadowRetainedObservation(input: unknown): OfficialTimingShadowRetainedObservation {
  return deepFreeze(retainedSchema.parse(input));
}
