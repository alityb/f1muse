import { z } from 'zod';
import { F1QLProgram } from './ast';

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const season = z.number().int().min(1950).max(2100);
const stringOrArray = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const seasonOrArray = z.union([season, z.array(season).min(1)]);

export const standingsFilterSchema = z.object({
  season: seasonOrArray.optional(),
  driver_id: stringOrArray.optional()
}).strict();

export const sourceNodeSchema = z.object({
  op: z.literal('source'),
  source: z.literal('standings')
}).strict();

export const filterNodeSchema = z.object({
  op: z.literal('filter'),
  input: sourceNodeSchema,
  where: standingsFilterSchema
}).strict();

const aggregateMeasureSchema = z.object({
  as: identifier,
  function: z.enum(['sum', 'count', 'min', 'max']),
  field: z.enum(['points', 'championship_position']).optional()
}).strict().superRefine((measure, context) => {
  if (measure.function === 'count' && measure.field !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'count does not accept a field' });
  }
  if (measure.function !== 'count' && measure.field === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${measure.function} requires a field` });
  }
});

export const aggregateNodeSchema = z.object({
  op: z.literal('aggregate'),
  input: z.union([sourceNodeSchema, filterNodeSchema]),
  group_by: z.array(z.literal('driver_id')).min(1).max(1),
  measures: z.array(aggregateMeasureSchema).min(1).max(4)
}).strict().superRefine((node, context) => {
  const aliases = node.measures.map((measure) => measure.as);
  if (new Set(aliases).size !== aliases.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'aggregate aliases must be unique' });
  }
});

export const rankNodeSchema = z.object({
  op: z.literal('rank'),
  input: aggregateNodeSchema,
  by: identifier,
  direction: z.enum(['asc', 'desc']),
  limit: z.number().int().min(1).max(50)
}).strict().superRefine((node, context) => {
  if (!node.input.measures.some((measure) => measure.as === node.by)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'rank field must be an aggregate alias' });
  }
});

export const paceDeltaNodeSchema = z.object({
  op: z.literal('pace_delta'),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1),
  scope: z.object({
    season,
    rounds: z.array(z.number().int().min(1).max(30)).min(1).optional()
  }).strict(),
  filters: z.object({
    clean_air_only: z.boolean().optional(),
    compound: z.string().min(1).optional()
  }).strict().optional()
}).strict().superRefine((node, context) => {
  if (node.driver_a_id === node.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pace_delta requires two different drivers' });
  }
});

export const paceSummaryNodeSchema = z.object({
  op: z.literal('pace_summary'),
  driver_id: z.string().min(1),
  scope: z.object({
    season,
    rounds: z.array(z.number().int().min(1).max(30)).min(1).optional()
  }).strict(),
  filters: z.object({
    clean_air_only: z.boolean().optional(),
    compound: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export const eventClassificationNodeSchema = z.object({
  op: z.literal('event_classification'),
  season,
  round: z.number().int().min(1).max(30),
  limit: z.number().int().min(1).max(30),
  filters: z.object({
    classification_status: z.array(z.enum(['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn'])).min(1).optional(),
    driver_id: z.string().min(1).optional(),
    team_id: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export const qualifyingClassificationNodeSchema = z.object({
  op: z.literal('qualifying_classification'),
  season,
  round: z.number().int().min(1).max(30),
  limit: z.number().int().min(1).max(30),
  filters: z.object({
    classification_status: z.array(z.enum(['classified', 'dnf', 'dns'])).min(1).optional(),
    driver_id: z.string().min(1).optional(),
    team_id: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export const eventMetadataNodeSchema = z.object({
  op: z.literal('event_metadata'),
  season,
  round: z.number().int().min(1).max(30),
  session_scope: z.enum(['race', 'qualifying']).optional()
}).strict();

export const f1qlProgramSchema = z.object({
  version: z.literal(1),
  root: z.union([aggregateNodeSchema, rankNodeSchema, paceDeltaNodeSchema, paceSummaryNodeSchema, eventClassificationNodeSchema, qualifyingClassificationNodeSchema, eventMetadataNodeSchema])
}).strict();

export function parseF1QLProgram(input: unknown): F1QLProgram {
  return f1qlProgramSchema.parse(input) as F1QLProgram;
}
