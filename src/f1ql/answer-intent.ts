import { z } from 'zod';
import { AnswerQuestionContract } from './answer-question';

const literalReferenceSchema = z.object({
  text: z.string().min(1).max(200),
  // Offsets are an inclusive/exclusive pair measured in Unicode code points.
  start: z.number().int().min(0),
  end: z.number().int().positive()
}).strict().refine(reference => reference.end > reference.start, 'Reference end must be after start');

const seasonFields = {
  season: z.number().int().min(1950).max(2100),
  season_reference: literalReferenceSchema
};
const eventFields = { event_reference: literalReferenceSchema };
const driverFields = { driver_reference: literalReferenceSchema };
const statusFields = { status_reference: literalReferenceSchema };
const raceStatus = z.enum(['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn']);
const qualifyingStatus = z.enum(['classified', 'dnf', 'dns']);

export const answerIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('final_standings_points'), ...seasonFields, driver_references: z.array(literalReferenceSchema).max(4) }).strict(),
  z.object({ type: z.literal('final_standings_leader'), ...seasonFields }).strict(),
  z.object({ type: z.literal('race_classification_all'), ...seasonFields, ...eventFields }).strict(),
  z.object({ type: z.literal('race_classification_driver'), ...seasonFields, ...eventFields, ...driverFields }).strict(),
  z.object({ type: z.literal('race_classification_status'), ...seasonFields, ...eventFields, status: raceStatus, ...statusFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_all'), ...seasonFields, ...eventFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_driver'), ...seasonFields, ...eventFields, ...driverFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_status'), ...seasonFields, ...eventFields, status: qualifyingStatus, ...statusFields }).strict(),
  z.object({ type: z.literal('race_date'), ...seasonFields, ...eventFields }).strict(),
  z.object({ type: z.literal('clarification'), reason: z.enum(['season_missing', 'event_ambiguous', 'entity_ambiguous', 'session_ambiguous', 'metric_ambiguous']) }).strict(),
  z.object({ type: z.literal('unsupported'), reason: z.enum(['sprint_source_unsupported', 'grid_source_unsupported', 'constructor_source_unsupported', 'pace_source_disabled', 'team_filter_unsupported', 'interim_standings_unsupported', 'temporal_scope_unsupported', 'capability_unsupported']) }).strict()
]);

export type LiteralMentionReference = z.infer<typeof literalReferenceSchema>;
export type AnswerIntent = z.infer<typeof answerIntentSchema>;

export function parseAnswerIntent(input: unknown, question: AnswerQuestionContract): AnswerIntent {
  const intent = answerIntentSchema.parse(input);
  const questionCodePoints = Array.from(question.normalized_question);
  for (const reference of collectReferences(intent)) {
    if (reference.end > questionCodePoints.length || questionCodePoints.slice(reference.start, reference.end).join('') !== reference.text) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message: 'Reference must be an exact span of the normalized question' }]);
    }
  }
  if ('season' in intent && Number(intent.season_reference.text) !== intent.season) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ['season_reference'], message: 'Season reference must literally identify season' }]);
  }
  return deepFreeze(intent);
}

function collectReferences(intent: AnswerIntent): LiteralMentionReference[] {
  if (!('season_reference' in intent)) {
    return [];
  }
  const references = [intent.season_reference];
  if ('event_reference' in intent) {
    references.push(intent.event_reference);
  }
  if ('driver_reference' in intent) {
    references.push(intent.driver_reference);
  }
  if ('driver_references' in intent && intent.driver_references) {
    references.push(...intent.driver_references);
  }
  if ('status_reference' in intent) {
    references.push(intent.status_reference);
  }
  return references;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
