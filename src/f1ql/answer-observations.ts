import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AnswerEvaluationCase, AnswerEvaluationObservation } from './answer-evaluation';
import { AnswerBoundError, AnswerWorkModelError, enforceAnswerWorkBudget } from './answer-bounds';
import { authorizeAnswerProgram } from './answer-policy';
import { F1QLProgram } from './ast';
import { F1QLLinkingError } from './translation-linking';
import { F1QLProgramCandidate } from './translation-schema';
import { F1QLTranslationResult } from './translator';
import { normalizeF1QLProgram } from './verified-programs';

const reasonSchema = z.enum([
  'final_driver_standings', 'race_classification', 'qualifying_classification', 'race_date_metadata',
  'metric_ambiguous', 'session_ambiguous', 'season_missing', 'event_ambiguous', 'entity_ambiguous',
  'pace_source_disabled', 'interim_standings_unsupported', 'temporal_scope_unsupported',
  'team_filter_unsupported', 'session_scope_unsupported', 'entity_set_too_large',
  'classification_filter_combination_unsupported', 'sprint_source_unsupported', 'grid_source_unsupported',
  'constructor_source_unsupported', 'source_coverage_missing', 'capability_unsupported',
  'program_invalid', 'provider_error', 'invalid_response', 'identity_unresolved', 'linking_unavailable',
  'work_units', 'rows', 'response_bytes'
]);

const programSchema = z.unknown().transform((value, context) => {
  try {
    return normalizeF1QLProgram(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid canonical F1QL program' });
    return z.NEVER;
  }
});

const entitySchema = z.string().min(1).max(100).regex(/^(driver:[a-z0-9]+(?:-[a-z0-9]+)*|event:\d{4}:\d+)$/);
const observationBaseSchema = z.object({
  id: z.string().min(1).max(100),
  entity_candidates: z.array(entitySchema).max(20),
  linked_entities: z.array(entitySchema).max(20)
});
const observationSchema = z.discriminatedUnion('action', [
  observationBaseSchema.extend({ action: z.literal('answer'), reason: z.enum(['final_driver_standings', 'race_classification', 'qualifying_classification', 'race_date_metadata']), program: programSchema }).strict(),
  observationBaseSchema.extend({ action: z.literal('clarify'), reason: z.enum(['metric_ambiguous', 'session_ambiguous', 'season_missing', 'event_ambiguous', 'entity_ambiguous']) }).strict(),
  observationBaseSchema.extend({ action: z.literal('abstain'), reason: reasonSchema.exclude(['final_driver_standings', 'race_classification', 'qualifying_classification', 'race_date_metadata', 'metric_ambiguous', 'session_ambiguous', 'season_missing', 'event_ambiguous', 'entity_ambiguous']) }).strict()
]).superRefine((observation, context) => {
  for (const field of ['entity_candidates', 'linked_entities'] as const) {
    if (new Set(observation[field]).size !== observation[field].length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must not contain duplicates` });
    }
    if (JSON.stringify(observation[field]) !== JSON.stringify([...observation[field]].sort())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be sorted` });
    }
  }
  if (observation.linked_entities.some(entity => !observation.entity_candidates.includes(entity))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'linked_entities must be resolver candidates' });
  }
  if (observation.action === 'answer' && JSON.stringify(observation.linked_entities) !== JSON.stringify(canonicalProgramEntities(observation.program))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Answer linked_entities must match the canonical program' });
  }
  if (observation.action === 'answer') {
    const decision = authorizeAnswerProgram(observation.program);
    if (decision.type !== 'approved' || decision.capability.source !== observation.reason) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Answer reason must match its authorized capability' });
    }
  }
});

const artifactSchema = z.object({
  version: z.literal(1),
  kind: z.literal('f1ql_answer_observations'),
  provider: z.object({
    type: z.enum(['anthropic', 'openai-compatible']),
    model: z.string().min(1).max(200),
    collected_at: z.string().datetime()
  }).strict(),
  manifest: z.object({ case_count: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  observations: z.array(observationSchema).min(1)
}).strict();

export type AnswerObservationArtifact = z.infer<typeof artifactSchema>;

export interface AnswerObservationCollectorDependencies {
  translate(question: string): Promise<F1QLTranslationResult>;
  link(candidate: F1QLProgramCandidate): Promise<{ program: F1QLProgram; entityCandidates: string[] }>;
}

export function parseAnswerObservationArtifact(input: unknown): AnswerObservationArtifact {
  const artifact = artifactSchema.parse(input);
  const ids = artifact.observations.map(observation => observation.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('duplicate_evaluation_observation_id');
  }
  return artifact;
}

export function validateAnswerObservationArtifact(cases: readonly AnswerEvaluationCase[], input: unknown): AnswerObservationArtifact {
  const artifact = parseAnswerObservationArtifact(input);
  const expectedIds = cases.map(item => item.id).sort();
  const observedIds = artifact.observations.map(observation => observation.id).sort();
  if (artifact.manifest.case_count !== cases.length || artifact.manifest.sha256 !== getAnswerEvaluationManifestHash(cases) || JSON.stringify(expectedIds) !== JSON.stringify(observedIds)) {
    throw new Error('answer_observation_manifest_mismatch');
  }
  return artifact;
}

export function getAnswerEvaluationManifestHash(cases: readonly AnswerEvaluationCase[]): string {
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}

export async function collectAnswerObservations(
  cases: readonly AnswerEvaluationCase[],
  provider: AnswerObservationArtifact['provider'],
  dependencies: AnswerObservationCollectorDependencies
): Promise<AnswerObservationArtifact> {
  const observations: AnswerEvaluationObservation[] = [];
  for (const item of cases) {
    const translation = await dependencies.translate(item.question);
    observations.push(await observeTranslation(item.id, translation, dependencies.link));
  }
  return validateAnswerObservationArtifact(cases, {
    version: 1,
    kind: 'f1ql_answer_observations',
    provider,
    manifest: { case_count: cases.length, sha256: getAnswerEvaluationManifestHash(cases) },
    observations
  });
}

async function observeTranslation(id: string, translation: F1QLTranslationResult, link: AnswerObservationCollectorDependencies['link']): Promise<AnswerEvaluationObservation> {
  if (translation.type === 'clarification_required') {
    return { id, action: 'clarify', reason: translation.reason, entity_candidates: [], linked_entities: [] };
  }
  if (translation.type === 'unsupported' || translation.type === 'provider_unavailable') {
    return { id, action: 'abstain', reason: translation.reason, entity_candidates: [], linked_entities: [] };
  }
  let linked: { program: F1QLProgram; entityCandidates: string[] };
  try {
    linked = await link(translation.program);
  } catch (error) {
    return linkingFailureObservation(id, error);
  }
  const { program, entityCandidates } = linked;
  const linkedEntities = canonicalProgramEntities(program);
  const decision = authorizeAnswerProgram(program);
  if (decision.type === 'rejected') {
    return { id, action: 'abstain', reason: decision.reason, entity_candidates: entityCandidates, linked_entities: linkedEntities };
  }
  try {
    enforceAnswerWorkBudget(program, decision.capability, 200, 100);
  } catch (error) {
    if (error instanceof AnswerBoundError) {
      return { id, action: 'abstain', reason: error.bound, entity_candidates: entityCandidates, linked_entities: linkedEntities };
    }
    if (error instanceof AnswerWorkModelError) {
      return { id, action: 'abstain', reason: 'program_invalid', entity_candidates: entityCandidates, linked_entities: linkedEntities };
    }
    throw error;
  }
  return { id, action: 'answer', reason: decision.capability.source, program, entity_candidates: entityCandidates, linked_entities: linkedEntities };
}

function linkingFailureObservation(id: string, error: unknown): AnswerEvaluationObservation {
  if (error instanceof F1QLLinkingError) {
    const entities = error.entityCandidates ?? linkingErrorEntities(error);
    const action = error.code === 'event_ambiguous' || error.code === 'entity_ambiguous' ? 'clarify' as const : 'abstain' as const;
    return { id, action, reason: error.code, entity_candidates: entities, linked_entities: [] };
  }
  if (error instanceof z.ZodError) {
    return { id, action: 'abstain', reason: 'program_invalid', entity_candidates: [], linked_entities: [] };
  }
  const reason = error instanceof Error && error.message.startsWith('identity_unresolved:') ? 'identity_unresolved' : 'linking_unavailable';
  return { id, action: 'abstain', reason, entity_candidates: [], linked_entities: [] };
}

function linkingErrorEntities(error: F1QLLinkingError): string[] {
  if (error.code === 'entity_ambiguous') {
    return (error.options ?? []).map(id => `driver:${id}`).sort();
  }
  if (error.code === 'event_ambiguous') {
    return (error.options ?? []).flatMap(option => {
      const match = /^(\d{4}) round (\d+)$/.exec(option);
      return match ? [`event:${match[1]}:${match[2]}`] : [];
    }).sort();
  }
  return [];
}

export function canonicalProgramEntities(program: F1QLProgram): string[] {
  const root = program.root;
  if (root.op === 'aggregate' || root.op === 'rank') {
    const aggregate = root.op === 'rank' ? root.input : root;
    const driverIds = aggregate.input.op === 'filter' ? aggregate.input.where.driver_id : undefined;
    const ids = Array.isArray(driverIds) ? driverIds : [];
    if (typeof driverIds === 'string') {
      ids.push(driverIds);
    }
    return ids.map(id => `driver:${id}`).sort();
  }
  const event = root.op === 'event_classification' || root.op === 'qualifying_classification' || root.op === 'event_metadata' ? [`event:${root.season}:${root.round}`] : [];
  let driver: string[] = [];
  if (root.op === 'pace_delta') {
    driver = [root.driver_a_id, root.driver_b_id];
  } else if (root.op === 'pace_summary') {
    driver = [root.driver_id];
  } else if ('filters' in root && root.filters?.driver_id) {
    driver = [root.filters.driver_id];
  }
  return [...event, ...driver.map(id => `driver:${id}`)].sort();
}
