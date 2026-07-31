import { z } from 'zod';
import { sanitizeSemanticShadowObservation } from './semantic-shadow-observations';

export const SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION = 'semantic-shadow-retained-v1' as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const statementCountsSchema = z.object({
  driver_inventory_unscoped: z.number().int().min(0).max(1),
  driver_inventory_scoped: z.number().int().min(0).max(1),
  event_name: z.number().int().min(0).max(1),
  event_round: z.number().int().min(0).max(1)
}).strict();

const retainedSchema = z.object({
  version: z.literal(SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION),
  timestamp: z.string().datetime({ offset: true }),
  mode: z.literal('semantic_shadow'),
  rollout_stage: z.literal(0),
  provider_identity: z.object({
    provider: z.literal('openai-compatible'),
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
  }).strict(),
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
      retained.observation.resolver_counts.inventory_reads !== inventoryReads ||
      retained.observation.resolver_counts.event_reads !== eventReads ||
      retained.observation.resolver_counts.fingerprint_reads !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'semantic shadow resolver counters are inconsistent' });
  }
});

export type SemanticShadowRetainedObservation = z.infer<typeof retainedSchema>;

export function sanitizeSemanticShadowRetainedObservation(input: unknown): SemanticShadowRetainedObservation {
  return deepFreeze(retainedSchema.parse(input));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
