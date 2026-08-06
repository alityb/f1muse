import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sanitizeSemanticShadowObservation } from './semantic-shadow-observations';

export const SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION = 'semantic-shadow-retained-v2' as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const statementCountsSchema = z.object({
  driver_inventory_unscoped: z.number().int().min(0).max(1),
  driver_inventory_scoped: z.number().int().min(0).max(1),
  event_name: z.number().int().min(0).max(1),
  event_round: z.number().int().min(0).max(1)
}).strict();

const commonSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  mode: z.literal('semantic_shadow'),
  rollout_stage: z.literal(0),
  provider_identity: z.object({
    provider: z.enum(['openai-compatible', 'anthropic']),
    endpoint_sha256: hashSchema,
    model_sha256: hashSchema,
    catalog_projection_sha256: hashSchema,
    prompt_sha256: hashSchema,
    schema_sha256: hashSchema,
    request_config_sha256: hashSchema
  }).strict(),
  resolver_transaction_count: z.number().int().min(0).max(2),
  resolver_transaction_counters: z.object({
    statement_count: z.number().int().min(0).max(2),
    returned_row_count: z.number().int().min(0).max(10_502),
    statements: statementCountsSchema
  }).strict()
});

const legacySchema = commonSchema.extend({
  version: z.literal('semantic-shadow-retained-v1'),
  observation: z.unknown().transform((value, context) => {
    try {return sanitizeSemanticShadowObservation(value);}
    catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow observation is invalid' });
      return z.NEVER;
    }
  })
}).strict().superRefine((retained, context) => {
  const statements = retained.resolver_transaction_counters.statements;
  const inventoryReads = statements.driver_inventory_unscoped + statements.driver_inventory_scoped;
  const eventReads = statements.event_name + statements.event_round;
  if (retained.resolver_transaction_counters.statement_count !== inventoryReads + eventReads ||
      retained.resolver_transaction_count !== retained.resolver_transaction_counters.statement_count ||
      retained.resolver_transaction_counters.returned_row_count > maximumReturnedRows(statements) ||
      retained.observation.resolver_counts.inventory_reads !== inventoryReads ||
      retained.observation.resolver_counts.event_reads !== eventReads ||
      retained.observation.resolver_counts.fingerprint_reads !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow resolver counters are inconsistent' });
  }
});

const v2BaseSchema = commonSchema.extend({
  version: z.literal(SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION),
  question_sha256: hashSchema,
  evidence_binding: z.object({
    corpus_sha256: hashSchema,
    run_sha256: hashSchema,
    case_index: z.number().int().min(0).max(48),
    repetition_index: z.number().int().min(0).max(2),
    attempt_sha256: hashSchema,
    provider_raw_candidate_set_sha256: hashSchema.optional()
  }).strict().optional(),
  production_evidence_binding: z.object({
    commit_sha256: hashSchema,
    deployment_id_sha256: hashSchema,
    release_id_sha256: hashSchema,
    capture_nonce_sha256: hashSchema,
    answer_database_target_sha256: hashSchema,
    answer_database_user_sha256: hashSchema,
    answer_database_name_sha256: hashSchema,
    resolver_sql_fingerprint_set_sha256: hashSchema
  }).strict().optional(),
  production_capture: z.object({
    key_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u),
    algorithm: z.literal('Ed25519'),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u)
  }).strict().optional()
});

const retainedSchema = z.discriminatedUnion('terminal', [
  v2BaseSchema.extend({
    terminal: z.literal('semantic'),
    observation: z.unknown().transform((value, context) => {
      try {return sanitizeSemanticShadowObservation(value);}
      catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow observation is invalid' });
        return z.NEVER;
      }
    })
  }).strict(),
  v2BaseSchema.extend({
    terminal: z.literal('operational_failure'),
    failure: z.object({
      reason: z.enum([
        'semantic_shadow_busy', 'answer_queue_timeout', 'request_timeout', 'request_cancelled',
        'metadata_statement_timeout', 'answer_database_unavailable',
        'semantic_shadow_metadata_unavailable', 'semantic_shadow_planning_unavailable'
      ]),
      stage: z.enum(['admission', 'inventory', 'proposal', 'resolution', 'planning']),
      total_ms: z.number().int().min(0).max(600_000)
    }).strict(),
    result_query_calls: z.literal(0)
  }).strict()
]).superRefine((retained, context) => {
  const statements = retained.resolver_transaction_counters.statements;
  const inventoryReads = statements.driver_inventory_unscoped + statements.driver_inventory_scoped;
  const eventReads = statements.event_name + statements.event_round;
  const counters = retained.resolver_transaction_counters;
  if (counters.statement_count !== inventoryReads + eventReads ||
      counters.statement_count > retained.resolver_transaction_count ||
      counters.returned_row_count > maximumReturnedRows(statements) ||
      (retained.terminal === 'semantic' &&
        (retained.resolver_transaction_count !== counters.statement_count ||
         retained.observation.resolver_counts.inventory_reads !== inventoryReads ||
         retained.observation.resolver_counts.event_reads !== eventReads ||
         retained.observation.resolver_counts.fingerprint_reads !== 0))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow resolver counters are inconsistent' });
  }
  if (retained.evidence_binding && retained.evidence_binding.attempt_sha256 !== computeSemanticShadowAttemptSha256({
    ...retained.evidence_binding,
    question_sha256: retained.question_sha256
  })) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow evidence binding is inconsistent' });
  }
});

const acceptedSchema = z.union([retainedSchema, legacySchema]);

export type SemanticShadowRetainedObservation = z.infer<typeof acceptedSchema>;

export function sanitizeSemanticShadowRetainedObservation(input: unknown): SemanticShadowRetainedObservation {
  return deepFreeze(acceptedSchema.parse(input));
}

export function computeSemanticShadowAttemptSha256(input: {
  readonly corpus_sha256: string;
  readonly run_sha256: string;
  readonly question_sha256: string;
  readonly case_index: number;
  readonly repetition_index: number;
  readonly provider_raw_candidate_set_sha256?: string;
}): string {
  return createHash('sha256').update([
    'semantic-shadow-attempt-v1', input.corpus_sha256, input.run_sha256, input.question_sha256,
    String(input.case_index), String(input.repetition_index), input.provider_raw_candidate_set_sha256 ?? ''
  ].join('\n'), 'utf8').digest('hex');
}

function maximumReturnedRows(statements: z.infer<typeof statementCountsSchema>): number {
  return statements.driver_inventory_unscoped * 10_001 +
    statements.driver_inventory_scoped * 10_001 +
    statements.event_name * 501 + statements.event_round * 2;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
