import { z } from 'zod';
import { AnswerQuestionContract } from './answer-question';

export const ANSWER_INTENT_SCHEMA_VERSION = 'answer-intent-schema-v3' as const;

const literalReferenceSchema = z.object({
  text: z.string().min(1).max(200),
  // Offsets are an inclusive/exclusive pair measured in Unicode code points.
  start: z.number().int().min(0),
  end: z.number().int().positive()
}).strict().refine(reference => reference.end > reference.start, 'Reference end must be after start');

const untrustedLiteralReferenceSchema = z.object({
  text: z.string().min(1).max(200)
}).strict();

const seasonFields = {
  season: z.number().int().min(1950).max(2100),
  season_reference: literalReferenceSchema
};
const eventFields = { event_reference: literalReferenceSchema };
const driverFields = { driver_reference: literalReferenceSchema };
const statusFields = { status_reference: literalReferenceSchema };
const raceStatus = z.enum(['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn']);
const qualifyingStatus = z.enum(['classified', 'dnf', 'dns']);

const untrustedSeasonFields = {
  season: z.number().int().min(1950).max(2100),
  season_reference: untrustedLiteralReferenceSchema
};
const untrustedEventFields = { event_reference: untrustedLiteralReferenceSchema };
const position = z.number().int().min(1).max(30);
const selectionFields = { selection_reference: literalReferenceSchema };
const untrustedSelectionFields = { selection_reference: untrustedLiteralReferenceSchema };

export const answerIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('final_standings_points'), ...seasonFields, driver_references: z.array(literalReferenceSchema).max(4) }).strict(),
  z.object({ type: z.literal('final_standings_leader'), ...seasonFields }).strict(),
  z.object({ type: z.literal('current_standings'), ...seasonFields }).strict(),
  z.object({ type: z.literal('race_classification_all'), ...seasonFields, ...eventFields }).strict(),
  z.object({ type: z.literal('race_classification_driver'), ...seasonFields, ...eventFields, ...driverFields }).strict(),
  z.object({ type: z.literal('race_classification_status'), ...seasonFields, ...eventFields, status: raceStatus, ...statusFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_all'), ...seasonFields, ...eventFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_driver'), ...seasonFields, ...eventFields, ...driverFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_status'), ...seasonFields, ...eventFields, status: qualifyingStatus, ...statusFields }).strict(),
  z.object({ type: z.literal('race_winner'), ...seasonFields, ...eventFields, ...selectionFields }).strict(),
  z.object({ type: z.literal('race_podium'), ...seasonFields, ...eventFields, ...selectionFields }).strict(),
  z.object({ type: z.literal('race_top_n'), ...seasonFields, ...eventFields, position, ...selectionFields }).strict(),
  z.object({ type: z.literal('race_exact_position'), ...seasonFields, ...eventFields, position, ...selectionFields }).strict(),
  z.object({ type: z.literal('qualifying_pole'), ...seasonFields, ...eventFields, ...selectionFields }).strict(),
  z.object({ type: z.literal('qualifying_top_n'), ...seasonFields, ...eventFields, position, ...selectionFields }).strict(),
  z.object({ type: z.literal('qualifying_exact_position'), ...seasonFields, ...eventFields, position, ...selectionFields }).strict(),
  z.object({ type: z.literal('race_date'), ...seasonFields, ...eventFields }).strict(),
  z.object({ type: z.literal('clarification'), reason: z.enum(['season_missing', 'event_ambiguous', 'entity_ambiguous', 'session_ambiguous', 'metric_ambiguous']) }).strict(),
  z.object({ type: z.literal('unsupported'), reason: z.enum(['sprint_source_unsupported', 'grid_source_unsupported', 'constructor_source_unsupported', 'pace_source_disabled', 'team_filter_unsupported', 'interim_standings_unsupported', 'temporal_scope_unsupported', 'capability_unsupported']) }).strict()
]);

export const untrustedAnswerIntentCandidateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('final_standings_points'), ...untrustedSeasonFields, driver_references: z.array(untrustedLiteralReferenceSchema).max(4) }).strict(),
  z.object({ type: z.literal('final_standings_leader'), ...untrustedSeasonFields }).strict(),
  z.object({ type: z.literal('current_standings'), ...untrustedSeasonFields }).strict(),
  z.object({ type: z.literal('race_classification_all'), ...untrustedSeasonFields, ...untrustedEventFields }).strict(),
  z.object({ type: z.literal('race_classification_driver'), ...untrustedSeasonFields, ...untrustedEventFields, driver_reference: untrustedLiteralReferenceSchema }).strict(),
  z.object({ type: z.literal('race_classification_status'), ...untrustedSeasonFields, ...untrustedEventFields, status: raceStatus, status_reference: untrustedLiteralReferenceSchema }).strict(),
  z.object({ type: z.literal('qualifying_classification_all'), ...untrustedSeasonFields, ...untrustedEventFields }).strict(),
  z.object({ type: z.literal('qualifying_classification_driver'), ...untrustedSeasonFields, ...untrustedEventFields, driver_reference: untrustedLiteralReferenceSchema }).strict(),
  z.object({ type: z.literal('qualifying_classification_status'), ...untrustedSeasonFields, ...untrustedEventFields, status: qualifyingStatus, status_reference: untrustedLiteralReferenceSchema }).strict(),
  z.object({ type: z.literal('race_winner'), ...untrustedSeasonFields, ...untrustedEventFields, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('race_podium'), ...untrustedSeasonFields, ...untrustedEventFields, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('race_top_n'), ...untrustedSeasonFields, ...untrustedEventFields, position, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('race_exact_position'), ...untrustedSeasonFields, ...untrustedEventFields, position, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('qualifying_pole'), ...untrustedSeasonFields, ...untrustedEventFields, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('qualifying_top_n'), ...untrustedSeasonFields, ...untrustedEventFields, position, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('qualifying_exact_position'), ...untrustedSeasonFields, ...untrustedEventFields, position, ...untrustedSelectionFields }).strict(),
  z.object({ type: z.literal('race_date'), ...untrustedSeasonFields, ...untrustedEventFields }).strict(),
  z.object({ type: z.literal('clarification'), reason: z.enum(['season_missing', 'event_ambiguous', 'entity_ambiguous', 'session_ambiguous', 'metric_ambiguous']) }).strict(),
  z.object({ type: z.literal('unsupported'), reason: z.enum(['sprint_source_unsupported', 'grid_source_unsupported', 'constructor_source_unsupported', 'pace_source_disabled', 'team_filter_unsupported', 'interim_standings_unsupported', 'temporal_scope_unsupported', 'capability_unsupported']) }).strict()
]);

export type LiteralMentionReference = z.infer<typeof literalReferenceSchema>;
export type AnswerIntent = z.infer<typeof answerIntentSchema>;
export type UntrustedAnswerIntentCandidate = z.infer<typeof untrustedAnswerIntentCandidateSchema>;

export function parseUntrustedAnswerIntentCandidate(input: unknown): UntrustedAnswerIntentCandidate {
  return untrustedAnswerIntentCandidateSchema.parse(input);
}

export function hydrateAndParseAnswerIntent(input: unknown, question: AnswerQuestionContract): AnswerIntent {
  const candidate = parseUntrustedAnswerIntentCandidate(input);
  const questionCodePoints = Array.from(question.normalized_question);
  return parseAnswerIntent(hydrateCandidate(normalizeTrustedStatus(candidate, question), question, questionCodePoints), question);
}

function normalizeTrustedStatus(candidate: UntrustedAnswerIntentCandidate, question: AnswerQuestionContract): UntrustedAnswerIntentCandidate {
  if (question.status_cues.length !== 1) {
    return candidate;
  }
  const raceCandidate = candidate.type === 'race_classification_all' || candidate.type === 'race_classification_status';
  const qualifyingCandidate = candidate.type === 'qualifying_classification_all' || candidate.type === 'qualifying_classification_status';
  if ((!raceCandidate && !qualifyingCandidate) || hasCrossSessionEvidence(question, raceCandidate ? 'race' : 'qualifying')) {
    return candidate;
  }
  const cue = question.status_cues[0];
  if ('status_reference' in candidate && !cue.text.includes(candidate.status_reference.text)) {
    throw referenceHydrationError('Status reference must be contained in the trusted status cue');
  }
  return {
    ...candidate,
    type: raceCandidate ? 'race_classification_status' : 'qualifying_classification_status',
    status: cue.value,
    status_reference: { text: cue.text }
  } as UntrustedAnswerIntentCandidate;
}

function hasCrossSessionEvidence(question: AnswerQuestionContract, expected: 'race' | 'qualifying'): boolean {
  const other = expected === 'race' ? 'qualifying' : 'race';
  return question.session_cues.some(cue => cue.value === other)
    || question.source_cues.some(cue => cue.value === `${other}_classification`);
}

function hydrateCandidate(value: unknown, question: AnswerQuestionContract, questionCodePoints: string[], key?: string, parent?: Record<string, unknown>): unknown {
  if (key === 'driver_references' && Array.isArray(value)) {
    return hydrateDriverReferences(value as { text: string }[], questionCodePoints);
  }
  if (key === 'status_reference' && isTextReference(value) && typeof parent?.status === 'string') {
    return hydrateStatusReference(value, parent.status as AnswerQuestionContract['status_cues'][number]['value'], question);
  }
  if (Array.isArray(value)) {
    return value.map(child => hydrateCandidate(child, question, questionCodePoints));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && isTextReference(object)) {
    return hydrateUniqueReference(object, questionCodePoints);
  }
  return Object.fromEntries(Object.entries(object).map(([childKey, child]) => [childKey, hydrateCandidate(child, question, questionCodePoints, childKey, object)]));
}

function hydrateUniqueReference(reference: { text: string }, questionCodePoints: string[]): LiteralMentionReference {
  const starts = literalStarts(reference.text, questionCodePoints);
  if (starts.length !== 1) {
    throw referenceHydrationError('Reference text must occur exactly once in the normalized question');
  }
  return { text: reference.text, start: starts[0], end: starts[0] + Array.from(reference.text).length };
}

function hydrateDriverReferences(references: readonly { text: string }[], questionCodePoints: string[]): LiteralMentionReference[] {
  const counts = new Map<string, number>();
  for (const reference of references) {
    counts.set(reference.text, (counts.get(reference.text) ?? 0) + 1);
  }
  const startsByText = new Map<string, number[]>();
  for (const [text, count] of counts) {
    const starts = literalStarts(text, questionCodePoints);
    if (starts.length !== count) {
      throw referenceHydrationError('Driver reference copies must exactly match literal occurrences in the normalized question');
    }
    startsByText.set(text, starts);
  }
  const consumed = new Map<string, number>();
  return references.map(reference => hydrateNextDriverReference(reference, startsByText, consumed));
}

function hydrateNextDriverReference(reference: { text: string }, startsByText: Map<string, number[]>, consumed: Map<string, number>): LiteralMentionReference {
  const index = consumed.get(reference.text) ?? 0;
  const start = startsByText.get(reference.text)?.[index];
  if (start === undefined) {
    throw referenceHydrationError('Driver reference occurrence could not be hydrated');
  }
  consumed.set(reference.text, index + 1);
  return { text: reference.text, start, end: start + Array.from(reference.text).length };
}

function hydrateStatusReference(reference: { text: string }, status: AnswerQuestionContract['status_cues'][number]['value'], question: AnswerQuestionContract): LiteralMentionReference {
  const matchingCues = question.status_cues.filter(cue => cue.value === status);
  if (matchingCues.length !== 1 || !matchingCues[0].text.includes(reference.text)) {
    throw referenceHydrationError('Status reference must be contained in exactly one matching status cue');
  }
  const cue = matchingCues[0];
  return { text: cue.text, start: cue.start, end: cue.end };
}

function literalStarts(text: string, questionCodePoints: string[]): number[] {
  const textCodePoints = Array.from(text);
  const starts: number[] = [];
  for (let start = 0; start <= questionCodePoints.length - textCodePoints.length; start += 1) {
    if (textCodePoints.every((codePoint, offset) => questionCodePoints[start + offset] === codePoint)) {
      starts.push(start);
    }
  }
  return starts;
}

function isTextReference(value: unknown): value is { text: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).text === 'string');
}

function referenceHydrationError(message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message }]);
}

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
  if ('selection_reference' in intent) {
    references.push(intent.selection_reference);
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
