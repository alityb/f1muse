import { z } from 'zod';

export const SEMANTIC_SHADOW_OBSERVATION_VERSION = 'semantic-shadow-observation-v1' as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reasonSchema = z.enum([
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
  'shadow_internal_failure'
]);
const topologySchema = z.enum([
  'row_dimension_join', 'scalar_aggregate_compose', 'single_source_aggregate', 'single_source_rows'
]);
const sourceSetSchema = z.enum([
  'driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification',
  'event_classification__event_metadata', 'event_classification__qualifying_classification',
  'event_metadata__qualifying_classification'
]);
const operatorSetSchema = z.enum([
  'filter_project_sort_limit', 'filter_aggregate_project_sort_limit',
  'filter_join_project_sort_limit', 'filter_aggregate_compose_project_sort_limit'
]);
const stageLatencySchema = z.number().int().min(0).max(60_000);
const latenciesSchema = z.object({
  contract_ms: stageLatencySchema.optional(),
  inventory_ms: stageLatencySchema.optional(),
  enumeration_ms: stageLatencySchema.optional(),
  proposal_ms: stageLatencySchema.optional(),
  admission_ms: stageLatencySchema.optional(),
  resolution_ms: stageLatencySchema.optional(),
  planning_ms: stageLatencySchema.optional(),
  proof_ms: stageLatencySchema.optional(),
  template_dual_ms: stageLatencySchema.optional(),
  total_ms: z.number().int().min(0).max(600_000)
}).strict();
const hashesSchema = z.object({
  catalog_sha256: hashSchema.optional(),
  candidate_set_sha256: hashSchema.optional(),
  provider_candidate_set_sha256: hashSchema.optional(),
  semantic_evidence_sha256: hashSchema.optional(),
  semantic_query_sha256: hashSchema.optional(),
  answer_plan_sha256: hashSchema.optional(),
  topology_sha256: hashSchema.optional(),
  planned_f1ql_sha256: hashSchema.optional(),
  core_sha256: hashSchema.optional(),
  compiled_sha256: hashSchema.optional(),
  semantic_proof_sha256: hashSchema.optional()
}).strict();
const dualSchema = z.object({
  enabled: z.boolean(),
  status: z.enum([
    'not_requested', 'not_applicable', 'template_proof_failed', 'semantic_lane_incomplete',
    'matched', 'mismatched', 'not_comparable'
  ]),
  template_id: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  template_intent_sha256: hashSchema.optional(),
  template_program_sha256: hashSchema.optional(),
  template_proof_sha256: hashSchema.optional()
}).strict().superRefine((dual, context) => {
  const hasProof = dual.template_id !== undefined || dual.template_intent_sha256 !== undefined ||
    dual.template_program_sha256 !== undefined || dual.template_proof_sha256 !== undefined;
  const proofStatus = ['semantic_lane_incomplete', 'matched', 'mismatched', 'not_comparable'].includes(dual.status);
  if (dual.enabled === (dual.status === 'not_requested')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow dual request status is inconsistent' });
  }
  if (hasProof !== proofStatus ||
      (hasProof && (!dual.template_id || !dual.template_intent_sha256 || !dual.template_program_sha256 || !dual.template_proof_sha256))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow template proof hashes are incomplete' });
  }
});

const observationSchema = z.object({
  version: z.literal(SEMANTIC_SHADOW_OBSERVATION_VERSION),
  outcome: z.enum(['answer', 'clarify', 'abstain', 'unavailable']),
  reason: reasonSchema,
  candidate_counts: z.object({
    enumerated: z.number().int().min(0).max(5),
    enumerated_lower_bound: z.number().int().min(1).max(10_000).optional(),
    proposed: z.number().int().min(0).max(5),
    matched: z.number().int().min(0).max(5),
    omitted: z.number().int().min(0).max(5),
    extraneous: z.number().int().min(0).max(5),
    comparison: z.enum(['exact', 'omission', 'extraneous', 'mixed', 'not_comparable'])
  }).strict().superRefine((counts, context) => {
    if (counts.comparison !== 'not_comparable' &&
        (counts.matched + counts.omitted !== counts.enumerated ||
        counts.matched + counts.extraneous !== counts.proposed)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow candidate counts are inconsistent' });
    }
    if (!candidateComparisonMatches(counts)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow candidate comparison is inconsistent' });
    }
  }),
  resolver_counts: z.object({
    inventory_reads: z.number().int().min(0).max(1),
    event_reads: z.number().int().min(0).max(1),
    fingerprint_reads: z.literal(0),
    inventory_entities: z.number().int().min(0).max(8),
    verified_candidates: z.number().int().min(0).max(201)
  }).strict(),
  topology_code: topologySchema.optional(),
  source_set_code: sourceSetSchema.optional(),
  operator_set_code: operatorSetSchema.optional(),
  plan_work: z.object({
    model: z.string().min(1).max(100),
    source_scan_units: z.number().int().min(0).max(10_000),
    resolver_reads: z.number().int().min(0).max(2),
    resolver_candidates: z.number().int().min(0).max(201),
    sources: z.number().int().min(1).max(4),
    row_joins: z.number().int().min(0).max(3),
    compositions: z.number().int().min(0).max(3),
    operator_depth: z.number().int().min(1).max(20),
    requested_rows: z.number().int().min(1).max(100)
  }).strict().optional(),
  hashes: hashesSchema,
  template_dual: dualSchema,
  latencies: latenciesSchema,
  result_query_calls: z.literal(0),
  versions: z.object({
    orchestrator: z.string().min(1).max(100),
    observation: z.literal(SEMANTIC_SHADOW_OBSERVATION_VERSION),
    question_contract: z.string().min(1).max(100),
    semantic_query: z.number().int().positive(),
    semantic_evidence: z.number().int().positive(),
    resolution: z.string().min(1).max(100),
    planner: z.string().min(1).max(100),
    semantic_proof: z.string().min(1).max(100),
    planned_f1ql: z.number().int().positive(),
    planned_compiler: z.string().min(1).max(100),
    fact_space: z.string().min(1).max(100),
    template_intent: z.string().min(1).max(100),
    template_registry: z.string().min(1).max(100),
    template_proof: z.string().min(1).max(100)
  }).strict()
}).strict().superRefine((observation, context) => {
  const planFields = [observation.topology_code, observation.source_set_code,
    observation.operator_set_code, observation.plan_work];
  const anyPlanField = planFields.some(value => value !== undefined);
  const completePlanFields = planFields.every(value => value !== undefined);
  const completePlanHashes = Boolean(observation.hashes.catalog_sha256 && observation.hashes.candidate_set_sha256 &&
    observation.hashes.provider_candidate_set_sha256 && observation.hashes.semantic_evidence_sha256 &&
    observation.hashes.semantic_query_sha256 && observation.hashes.answer_plan_sha256 && observation.hashes.topology_sha256 &&
        observation.hashes.planned_f1ql_sha256 && observation.hashes.core_sha256 &&
        observation.hashes.compiled_sha256 && observation.hashes.semantic_proof_sha256);
  const anyPlanHash = [observation.hashes.answer_plan_sha256, observation.hashes.topology_sha256,
    observation.hashes.planned_f1ql_sha256, observation.hashes.core_sha256,
    observation.hashes.compiled_sha256, observation.hashes.semantic_proof_sha256]
    .some(value => value !== undefined);
  if (anyPlanField !== completePlanFields || completePlanFields !== (observation.outcome === 'answer') ||
      completePlanFields !== completePlanHashes || anyPlanHash !== completePlanHashes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow plan fields are incomplete' });
  }
  if (observation.plan_work && (observation.plan_work.resolver_reads !==
      observation.resolver_counts.inventory_reads + observation.resolver_counts.event_reads ||
      observation.plan_work.resolver_candidates !== observation.resolver_counts.verified_candidates)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow plan work is inconsistent' });
  }
  if (observation.outcome === 'answer' && observation.reason !== 'plan_proven') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow answer reason is invalid' });
  }
  if (observation.outcome !== 'answer' && observation.reason === 'plan_proven') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow non-answer reason is invalid' });
  }
  if ((observation.outcome === 'unavailable') !==
      (observation.reason === 'provider_malformed' || observation.reason === 'provider_unavailable')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow provider availability outcome is inconsistent' });
  }
  if ((observation.outcome === 'answer' && observation.template_dual.status === 'semantic_lane_incomplete') ||
      (observation.outcome !== 'answer' && ['matched', 'mismatched', 'not_comparable'].includes(observation.template_dual.status))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow dual lane completion status is inconsistent' });
  }
});

export type SemanticShadowObservation = z.infer<typeof observationSchema>;
export type SemanticShadowReason = SemanticShadowObservation['reason'];

export function sanitizeSemanticShadowObservation(input: unknown): SemanticShadowObservation {
  return deepFreeze(observationSchema.parse(input));
}

function candidateComparisonMatches(counts: {
  readonly enumerated: number;
  readonly proposed: number;
  readonly omitted: number;
  readonly extraneous: number;
  readonly comparison: string;
}): boolean {
  if (counts.comparison === 'not_comparable') {
    return counts.proposed === 0 && counts.omitted === 0 && counts.extraneous === 0;
  }
  if (counts.comparison === 'exact') {return counts.omitted === 0 && counts.extraneous === 0;}
  if (counts.comparison === 'omission') {return counts.omitted > 0 && counts.extraneous === 0;}
  if (counts.comparison === 'extraneous') {return counts.omitted === 0 && counts.extraneous > 0;}
  return counts.comparison === 'mixed' && counts.omitted > 0 && counts.extraneous > 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
