import { z } from 'zod';

export const GoldenOutcomeSchema = z.enum(['answer', 'refusal']);
export const GoldenTargetSchema = z.enum(['api', 'sync', 'semantic']);
export const GoldenStatusSchema = z.enum(['provisional', 'verified']);

export const GoldenEvidenceSchema = z.object({
  source: z.enum(['f1db', 'fastf1', 'jolpica', 'production_observation']),
  reference: z.string().min(1),
  independently_verified: z.boolean(),
  snapshot: z.string().min(1).optional(),
});

export const GoldenAssertionSchema = z.object({
  subject: z.string().min(1),
  metric: z.string().min(1),
  equals: z.union([z.number(), z.string(), z.boolean(), z.null()]),
});

export const GoldenCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  incident: z.string().min(1),
  target: GoldenTargetSchema,
  status: GoldenStatusSchema,
  query: z.string().min(1).optional(),
  outcome: GoldenOutcomeSchema,
  authority: z.string().min(1),
  evidence: GoldenEvidenceSchema,
  assertions: z.array(GoldenAssertionSchema).min(1),
});

export const GoldenCaseRegistrySchema = z.object({
  version: z.literal(1),
  cases: z.array(GoldenCaseSchema).min(1),
});

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type GoldenCaseRegistry = z.infer<typeof GoldenCaseRegistrySchema>;
