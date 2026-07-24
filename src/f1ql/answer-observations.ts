import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { AnswerEvaluationCase } from './answer-evaluation';
import { AnswerBoundError, enforceAnswerWorkBudget } from './answer-bounds';
import { authorizeAnswerProgram } from './answer-policy';
import { F1QLProgram } from './ast';
import { AnswerIntent } from './answer-intent';
import { ANSWER_QUESTION_CONTRACT_VERSION, AnswerQuestionContract, createAnswerQuestionContract } from './answer-question';
import { ANSWER_SEMANTIC_PROOF_VERSION, AnswerSemanticProofError, VerifiedAnswerSemanticProof } from './answer-semantic-proof';
import { ANSWER_TEMPLATE_IDS, ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from './answer-templates';
import {
  ANSWER_INTENT_CONTRACT_VERSION,
  ANSWER_PROVIDER_DIAGNOSTIC_CODES,
  ANSWER_TRANSLATOR_PROMPT_SHA256,
  ANSWER_TRANSLATOR_SCHEMA_SHA256,
  AnswerTranslationResult
} from './answer-translator';
import { F1QLLinkingError } from './translation-linking';
import { PROVIDER_DIAGNOSTIC_CODES } from './translator';
import { normalizeF1QLProgram } from './verified-programs';

export const ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS = 15_000;

const reasonSchema = z.enum([
  'final_driver_standings', 'race_classification', 'qualifying_classification', 'race_date_metadata',
  'metric_ambiguous', 'session_ambiguous', 'season_missing', 'event_ambiguous', 'entity_ambiguous',
  'pace_source_disabled', 'interim_standings_unsupported', 'temporal_scope_unsupported',
  'team_filter_unsupported', 'session_scope_unsupported', 'entity_set_too_large',
  'classification_filter_combination_unsupported', 'sprint_source_unsupported', 'grid_source_unsupported',
  'constructor_source_unsupported', 'source_coverage_missing', 'capability_unsupported',
  'program_invalid', 'provider_error', 'invalid_response', 'identity_unresolved', 'linking_unavailable',
  'work_units', 'rows', 'response_bytes', 'incomplete_response', 'unsupported_provider', 'question_invalid',
  'season_mismatch', 'event_mismatch', 'session_mismatch', 'metric_mismatch', 'status_mismatch',
  'entity_cardinality_mismatch', 'template_mismatch'
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
  translation_latency_ms: z.number().int().min(0).max(60_000).optional(),
  translation_timed_out: z.boolean().optional(),
  provider_diagnostic_code: z.enum(PROVIDER_DIAGNOSTIC_CODES).optional(),
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
  if (observation.translation_timed_out) {
    if (observation.action !== 'abstain' || observation.reason !== 'provider_error') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Timed-out translation must be a provider-error abstention' });
    }
    if (observation.translation_latency_ms === undefined || observation.translation_latency_ms < ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Timed-out translation must include deadline latency' });
    }
    if (observation.entity_candidates.length > 0 || observation.linked_entities.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Timed-out translation must not include linker entities' });
    }
    if (observation.provider_diagnostic_code !== undefined && observation.provider_diagnostic_code !== 'request_timeout') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Timed-out translation diagnostic must be request_timeout' });
    }
  }
  if (observation.provider_diagnostic_code !== undefined && (observation.action !== 'abstain' || !['provider_error', 'invalid_response'].includes(observation.reason))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider diagnostics require a provider-unavailable abstention' });
  }
});

const artifactBaseSchema = z.object({
  kind: z.literal('f1ql_answer_observations'),
  manifest: z.object({ case_count: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  observations: z.array(observationSchema).min(1)
});
const modelIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keyIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const signatureSchema = z.string().min(1).max(200).refine(value => {
  try {
    const decoded = decodeCanonicalBase64(value, 'answer_observation_signature_invalid');
    return decoded.length === 64 && decoded.toString('base64') === value;
  } catch {
    return false;
  }
}, 'Invalid Ed25519 signature');
const artifactSchema = z.discriminatedUnion('version', [
  artifactBaseSchema.extend({
    version: z.literal(1),
    provider: z.object({ type: z.enum(['anthropic', 'openai-compatible']), model: z.string().min(1).max(200), collected_at: z.string().datetime() }).strict()
  }).strict(),
  artifactBaseSchema.extend({
    version: z.literal(2),
    provider: z.object({ type: z.enum(['anthropic', 'openai-compatible']), model: modelIdSchema, collected_at: z.string().datetime() }).strict()
  }).strict(),
  z.object({
    version: z.literal(3),
    kind: z.literal('f1ql_answer_observations'),
    provider: z.object({ type: z.enum(['groq', 'openai-compatible']), model: modelIdSchema, collected_at: z.string().datetime() }).strict(),
    manifest: z.object({ case_count: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    contract: z.object({
      question_version: z.string().min(1).max(100),
      intent_version: z.string().min(1).max(100),
      translator_prompt_hash: hashSchema,
      translator_schema_hash: hashSchema,
      template_version: z.string().min(1).max(100),
      template_registry_hash: hashSchema,
      proof_version: z.string().min(1).max(100)
    }).strict(),
    evaluation: z.object({ key_id: keyIdSchema, algorithm: z.literal('Ed25519'), signature: signatureSchema }).strict(),
    observations: z.array(z.object({
      id: z.string().min(1).max(100),
      action: z.enum(['answer', 'clarify', 'abstain']),
      reason: reasonSchema,
      translation_attempted: z.boolean(),
      translation_latency_ms: z.number().int().min(0).max(60_000).optional(),
      translation_timed_out: z.boolean(),
      provider_diagnostic_code: z.enum(ANSWER_PROVIDER_DIAGNOSTIC_CODES).optional(),
      template_id: z.enum(ANSWER_TEMPLATE_IDS as [typeof ANSWER_TEMPLATE_IDS[number], ...typeof ANSWER_TEMPLATE_IDS[number][]]).optional(),
      proof_status: z.enum(['passed', 'failed', 'not_applicable']),
      proof_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      program_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      entity_candidates: z.array(entitySchema).max(20),
      linked_entities: z.array(entitySchema).max(20)
    }).strict().superRefine((observation, context) => {
      for (const field of ['entity_candidates', 'linked_entities'] as const) {
        if (new Set(observation[field]).size !== observation[field].length || JSON.stringify(observation[field]) !== JSON.stringify([...observation[field]].sort())) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be unique and sorted` });
        }
      }
      if (observation.linked_entities.some(entity => !observation.entity_candidates.includes(entity))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'linked_entities must be resolver candidates' });
      }
      const passed = observation.proof_status === 'passed';
      if (passed !== (observation.proof_hash !== undefined && observation.program_hash !== undefined && observation.template_id !== undefined) || passed !== (observation.action === 'answer')) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Passed proof bindings are required only for answers' });
      }
      if (observation.translation_timed_out && (observation.provider_diagnostic_code !== 'request_timeout' ||
          (observation.translation_latency_ms ?? -1) < ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS || observation.action !== 'abstain' ||
          observation.reason !== 'provider_error' || observation.entity_candidates.length !== 0 || observation.linked_entities.length !== 0 ||
          observation.proof_status === 'passed' || observation.proof_hash !== undefined || observation.program_hash !== undefined || observation.template_id !== undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Timeout evidence must be causal' });
      }
      if (observation.provider_diagnostic_code !== undefined && observation.action !== 'abstain') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider diagnostics require abstention' });
      }
      if (observation.translation_attempted !== (observation.translation_latency_ms !== undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only attempted translations may record latency' });
      }
      if (!observation.translation_attempted && (observation.translation_timed_out || observation.provider_diagnostic_code !== undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Deterministic outcomes cannot record provider evidence' });
      }
    })).min(1)
  }).strict()
]).superRefine((artifact, context) => {
  if (artifact.version === 1) {
    artifact.observations.forEach((observation, index) => {
      if (observation.provider_diagnostic_code !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'provider_diagnostic_code'], message: 'Version 1 artifacts do not support provider diagnostics' });
      }
    });
  } else if (artifact.version === 2) {
    artifact.observations.forEach((observation, index) => {
      if (observation.action === 'abstain' && ['provider_error', 'invalid_response'].includes(observation.reason) && observation.provider_diagnostic_code === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'provider_diagnostic_code'], message: 'Version 2 provider failures require a diagnostic code' });
      }
    });
  }
});

export type AnswerObservationArtifact = z.infer<typeof artifactSchema>;
export type HardenedAnswerObservationArtifact = Extract<AnswerObservationArtifact, { version: 3 }>;
export type HistoricalAnswerObservationArtifact = Exclude<AnswerObservationArtifact, { version: 3 }>;
export type AnswerObservationProvider = { type: 'groq' | 'openai-compatible'; model: string; collected_at: string };

const verifiedArtifactBrand: unique symbol = Symbol('VerifiedAnswerObservationArtifact');
const signingHelperBrand: unique symbol = Symbol('AnswerObservationSigningHelper');
let untrustedUnitSigner: AnswerObservationSigningHelper | undefined;
export type VerifiedAnswerObservationArtifact = HardenedAnswerObservationArtifact & { readonly [verifiedArtifactBrand]: true };
export interface AnswerObservationSigningHelper {
  readonly key_id: string;
  readonly [signingHelperBrand]: true;
  readonly sign_canonical: (content: string) => string;
}

export interface TrustedAnswerObservationKey {
  readonly key_id: string;
  readonly public_key_base64: string;
}

export interface AnswerObservationCollectorDependencies {
  translate(contract: AnswerQuestionContract): Promise<{ result: AnswerTranslationResult; timedOut: boolean }>;
  prove(contract: AnswerQuestionContract, intent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>): Promise<VerifiedAnswerSemanticProof>;
  beforeTranslate?(): Promise<void>;
  now?: () => number;
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

export function createAnswerObservationSigningHelper(keyId: string, privateKeyBase64: string): AnswerObservationSigningHelper {
  const parsedKeyId = keyIdSchema.parse(keyId);
  const privateKey = createPrivateKey({ key: decodeCanonicalBase64(privateKeyBase64, 'answer_observation_private_key_invalid'), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('answer_observation_private_key_not_ed25519');
  }
  return Object.freeze({
    key_id: parsedKeyId,
    sign_canonical: (content: string) => sign(null, Buffer.from(content, 'utf8'), privateKey).toString('base64'),
    [signingHelperBrand]: true as const
  });
}

export function signAnswerObservationArtifact(
  cases: readonly AnswerEvaluationCase[],
  unsignedInput: Omit<HardenedAnswerObservationArtifact, 'evaluation'>,
  signer: AnswerObservationSigningHelper
): HardenedAnswerObservationArtifact {
  if (signer[signingHelperBrand] !== true) {
    throw new Error('answer_observation_signer_required');
  }
  const unsigned = { ...unsignedInput, evaluation: { key_id: signer.key_id, algorithm: 'Ed25519' as const } };
  const signature = signer.sign_canonical(stableSerialize(unsigned));
  return validateAnswerObservationArtifact(cases, {
    ...unsigned,
    evaluation: { ...unsigned.evaluation, signature }
  }) as HardenedAnswerObservationArtifact;
}

export function verifyAnswerObservationArtifact(
  cases: readonly AnswerEvaluationCase[],
  input: unknown,
  trustedKey: TrustedAnswerObservationKey
): VerifiedAnswerObservationArtifact {
  const artifact = validateAnswerObservationArtifact(cases, input);
  if (artifact.version !== 3) {
    throw new Error('answer_observation_artifact_not_hardened');
  }
  if (artifact.evaluation.key_id !== keyIdSchema.parse(trustedKey.key_id)) {
    throw new Error('answer_observation_evaluation_key_mismatch');
  }
  assertCurrentContract(artifact);
  const publicKey = createPublicKey({ key: decodeCanonicalBase64(trustedKey.public_key_base64, 'answer_observation_public_key_invalid'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('answer_observation_public_key_not_ed25519');
  }
  const valid = verify(null, canonicalUnsignedArtifact(artifact), publicKey, decodeCanonicalBase64(artifact.evaluation.signature, 'answer_observation_signature_invalid'));
  if (!valid) {
    throw new Error('answer_observation_signature_invalid');
  }
  Object.defineProperty(artifact, verifiedArtifactBrand, { value: true, enumerable: false, configurable: false, writable: false });
  return deepFreeze(artifact) as VerifiedAnswerObservationArtifact;
}

export function isVerifiedAnswerObservationArtifact(artifact: AnswerObservationArtifact): artifact is VerifiedAnswerObservationArtifact {
  return artifact.version === 3 && (artifact as Partial<VerifiedAnswerObservationArtifact>)[verifiedArtifactBrand] === true;
}

export function getAnswerEvaluationManifestHash(cases: readonly AnswerEvaluationCase[]): string {
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}

export async function collectAnswerObservations(
  cases: readonly AnswerEvaluationCase[],
  provider: AnswerObservationProvider,
  dependencies: AnswerObservationCollectorDependencies,
  signer?: AnswerObservationSigningHelper
): Promise<HardenedAnswerObservationArtifact> {
  const observations: Array<HardenedAnswerObservationArtifact['observations'][number]> = [];
  const now = dependencies.now ?? (() => performance.now());
  for (const item of cases) {
    let contract: AnswerQuestionContract;
    try {
      contract = createAnswerQuestionContract(item.question);
    } catch {
      observations.push(hardenedObservation(item.id, 'abstain', 'question_invalid'));
      continue;
    }
    if (contract.outcome.type === 'rejected') {
      observations.push(hardenedObservation(item.id, 'abstain', contract.outcome.reason));
      continue;
    }
    if (contract.outcome.type === 'clarification_required') {
      observations.push(hardenedObservation(item.id, 'clarify', contract.outcome.reason));
      continue;
    }
    await dependencies.beforeTranslate?.();
    const startedAt = now();
    const translation = await dependencies.translate(contract);
    const translationLatencyMs = boundedTranslationLatency(startedAt, now());
    observations.push(await observeHardenedTranslation(item.id, contract, translation.result, translation.timedOut, translationLatencyMs, dependencies.prove));
  }
  signer ??= getUntrustedUnitSigner();
  return signAnswerObservationArtifact(cases, {
    version: 3,
    kind: 'f1ql_answer_observations',
    provider,
    manifest: { case_count: cases.length, sha256: getAnswerEvaluationManifestHash(cases) },
    contract: {
      question_version: ANSWER_QUESTION_CONTRACT_VERSION,
      intent_version: ANSWER_INTENT_CONTRACT_VERSION,
      translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256,
      translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256,
      template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
      template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
      proof_version: ANSWER_SEMANTIC_PROOF_VERSION
    },
    observations
  }, signer);
}

function boundedTranslationLatency(startedAt: number, finishedAt: number): number {
  const elapsed = finishedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 60_000) {
    throw new Error('answer_observation_translation_latency_invalid');
  }
  return Math.ceil(elapsed);
}

function hardenedObservation(
  id: string,
  action: 'clarify' | 'abstain',
  reason: z.infer<typeof reasonSchema>,
  additions: Partial<HardenedAnswerObservationArtifact['observations'][number]> = {}
): HardenedAnswerObservationArtifact['observations'][number] {
  return {
    id,
    action,
    reason,
    translation_attempted: additions.translation_attempted ?? false,
    ...(additions.translation_latency_ms === undefined ? {} : { translation_latency_ms: additions.translation_latency_ms }),
    translation_timed_out: additions.translation_timed_out ?? false,
    proof_status: additions.proof_status ?? 'not_applicable',
    entity_candidates: additions.entity_candidates ?? [],
    linked_entities: additions.linked_entities ?? [],
    ...(additions.provider_diagnostic_code ? { provider_diagnostic_code: additions.provider_diagnostic_code } : {})
  };
}

async function observeHardenedTranslation(
  id: string,
  contract: AnswerQuestionContract,
  translation: AnswerTranslationResult,
  timedOut: boolean,
  latency: number,
  prove: AnswerObservationCollectorDependencies['prove']
): Promise<HardenedAnswerObservationArtifact['observations'][number]> {
  if (translation.type === 'clarification_required') {
    return hardenedObservation(id, 'clarify', translation.reason, { translation_attempted: true, translation_latency_ms: latency });
  }
  if (translation.type === 'unsupported') {
    return hardenedObservation(id, 'abstain', translation.reason, { translation_attempted: true, translation_latency_ms: latency });
  }
  if (translation.type === 'provider_unavailable') {
    if (timedOut) {
      return hardenedObservation(id, 'abstain', 'provider_error', {
        translation_latency_ms: latency,
        translation_attempted: true,
        translation_timed_out: true,
        provider_diagnostic_code: 'request_timeout'
      });
    }
    return hardenedObservation(id, 'abstain', translation.reason, {
      translation_latency_ms: latency,
      translation_attempted: true,
      translation_timed_out: timedOut,
      provider_diagnostic_code: translation.diagnostic_code ?? 'transport'
    });
  }
  let proof: VerifiedAnswerSemanticProof;
  try {
    proof = await prove(contract, translation.intent);
  } catch (error) {
    if (error instanceof F1QLLinkingError) {
      const candidates = (error.entityCandidates ?? linkingErrorEntities(error)).sort();
      const action = error.code === 'event_ambiguous' || error.code === 'entity_ambiguous' ? 'clarify' : 'abstain';
      return hardenedObservation(id, action, error.code, { translation_attempted: true, translation_latency_ms: latency, proof_status: 'failed', entity_candidates: candidates });
    }
    if (error instanceof AnswerSemanticProofError || error instanceof z.ZodError) {
      const reason = error instanceof AnswerSemanticProofError ? error.reason : 'program_invalid';
      return hardenedObservation(id, 'abstain', reason, { translation_attempted: true, translation_latency_ms: latency, proof_status: 'failed' });
    }
    return hardenedObservation(id, 'abstain', 'linking_unavailable', { translation_attempted: true, translation_latency_ms: latency, proof_status: 'failed' });
  }
  const candidates = proof.mentions.flatMap(mention => mention.candidates.map(candidate => mention.kind === 'driver' ? `driver:${candidate}` : candidate)).sort();
  const linked = proof.mentions.map(mention => mention.kind === 'driver' ? `driver:${mention.selected_id}` : mention.selected_id).sort();
  const decision = authorizeAnswerProgram(proof.program);
  if (decision.type === 'rejected') {
    return hardenedObservation(id, 'abstain', decision.reason, { translation_attempted: true, translation_latency_ms: latency, proof_status: 'failed', entity_candidates: candidates, linked_entities: linked });
  }
  try {
    enforceAnswerWorkBudget(proof.program, decision.capability, 200, 100);
  } catch (error) {
    const reason = error instanceof AnswerBoundError ? error.bound : 'program_invalid';
    return hardenedObservation(id, 'abstain', reason, { translation_attempted: true, translation_latency_ms: latency, proof_status: 'failed', entity_candidates: candidates, linked_entities: linked });
  }
  return {
    id,
    action: 'answer',
    reason: decision.capability.source,
    translation_attempted: true,
    translation_latency_ms: latency,
    translation_timed_out: false,
    template_id: proof.template_id,
    proof_status: 'passed',
    proof_hash: proof.proof_hash,
    program_hash: proof.program_hash,
    entity_candidates: candidates,
    linked_entities: linked
  };
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

function assertCurrentContract(artifact: HardenedAnswerObservationArtifact): void {
  const expected = {
    question_version: ANSWER_QUESTION_CONTRACT_VERSION,
    intent_version: ANSWER_INTENT_CONTRACT_VERSION,
    translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256,
    translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256,
    template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
    template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
    proof_version: ANSWER_SEMANTIC_PROOF_VERSION
  };
  if (stableSerialize(artifact.contract) !== stableSerialize(expected)) {
    throw new Error('answer_observation_contract_mismatch');
  }
}

function getUntrustedUnitSigner(): AnswerObservationSigningHelper {
  if (!untrustedUnitSigner) {
    const keys = generateKeyPairSync('ed25519');
    untrustedUnitSigner = Object.freeze({
      key_id: 'untrusted-unit-ephemeral',
      sign_canonical: (content: string) => sign(null, Buffer.from(content, 'utf8'), keys.privateKey).toString('base64'),
      [signingHelperBrand]: true as const
    });
  }
  return untrustedUnitSigner;
}

function canonicalUnsignedArtifact(artifact: HardenedAnswerObservationArtifact): Buffer {
  const evaluation = { key_id: artifact.evaluation.key_id, algorithm: artifact.evaluation.algorithm };
  return Buffer.from(stableSerialize({ ...artifact, evaluation }), 'utf8');
}

function decodeCanonicalBase64(value: string, errorCode: string): Buffer {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== value) {
      throw new Error(errorCode);
    }
    return decoded;
  } catch {
    throw new Error(errorCode);
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
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
