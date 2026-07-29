import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { ANSWER_INTENT_SCHEMA_VERSION } from './answer-intent';
import { ANSWER_INTENT_DERIVATION_VERSION } from './answer-intent-derivation';
import { ANSWER_QUESTION_CONTRACT_VERSION } from './answer-question';
import { ANSWER_SEMANTIC_PROOF_VERSION } from './answer-semantic-proof';
import { ANSWER_TEMPLATE_IDS, ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from './answer-templates';

export const ANSWER_DERIVATION_EVIDENCE_VERSION = 1 as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keyIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const entitySchema = z.string().min(1).max(100).regex(/^(driver:[a-z0-9]+(?:-[a-z0-9]+)*|event:\d{4}:\d+)$/);
const reasonSchema = z.enum([
  'final_driver_standings', 'current_driver_standings', 'race_classification', 'race_classification_event_metadata', 'qualifying_classification', 'official_driver_results_comparison', 'race_date_metadata',
  'metric_ambiguous', 'session_ambiguous', 'season_missing', 'event_ambiguous', 'entity_ambiguous',
  'pace_source_disabled', 'interim_standings_unsupported', 'temporal_scope_unsupported',
  'team_filter_unsupported', 'session_scope_unsupported', 'entity_set_too_large',
  'classification_filter_combination_unsupported', 'sprint_source_unsupported', 'grid_source_unsupported',
  'constructor_source_unsupported', 'source_coverage_missing', 'capability_unsupported',
  'program_invalid', 'identity_unresolved', 'linking_unavailable', 'work_units', 'rows', 'response_bytes',
  'question_invalid', 'season_mismatch', 'event_mismatch', 'session_mismatch', 'metric_mismatch',
  'status_mismatch', 'entity_cardinality_mismatch', 'template_mismatch'
]);
const answerReasons = new Set(['final_driver_standings', 'current_driver_standings', 'race_classification', 'race_classification_event_metadata', 'qualifying_classification', 'official_driver_results_comparison', 'race_date_metadata']);
const clarificationReasons = new Set(['metric_ambiguous', 'session_ambiguous', 'season_missing', 'event_ambiguous', 'entity_ambiguous']);

const observationSchema = z.object({
  id: z.string().min(1).max(100),
  action: z.enum(['answer', 'clarify', 'abstain']),
  reason: reasonSchema,
  template_id: z.enum(ANSWER_TEMPLATE_IDS as [typeof ANSWER_TEMPLATE_IDS[number], ...typeof ANSWER_TEMPLATE_IDS[number][]]).optional(),
  proof_hash: hashSchema.optional(),
  program_hash: hashSchema.optional(),
  entity_candidates: z.array(entitySchema).max(20),
  linked_entities: z.array(entitySchema).max(20)
}).strict().superRefine((observation, context) => {
  for (const field of ['entity_candidates', 'linked_entities'] as const) {
    if (!isUniqueSorted(observation[field])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be unique and sorted` });
    }
  }
  if (observation.linked_entities.some(entity => !observation.entity_candidates.includes(entity))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Linked entities must be candidates' });
  }
  const complete = observation.template_id !== undefined && observation.proof_hash !== undefined && observation.program_hash !== undefined;
  if ((observation.action === 'answer') !== complete) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only answers have complete proof bindings' });
  }
  if (!isActionReasonConsistent(observation.action, observation.reason)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Action and reason are inconsistent' });
  }
});

function isUniqueSorted(values: readonly string[]): boolean {
  return new Set(values).size === values.length && JSON.stringify(values) === JSON.stringify([...values].sort());
}

function isActionReasonConsistent(action: 'answer' | 'clarify' | 'abstain', reason: string): boolean {
  if (action === 'answer') {
    return answerReasons.has(reason);
  }
  if (action === 'clarify') {
    return clarificationReasons.has(reason);
  }
  return !answerReasons.has(reason) && !clarificationReasons.has(reason);
}

const artifactSchema = z.object({
  version: z.literal(ANSWER_DERIVATION_EVIDENCE_VERSION),
  kind: z.literal('f1ql_answer_derivation_evidence'),
  collected_at: z.string().datetime(),
  manifest: z.object({ case_count: z.number().int().positive(), sha256: hashSchema }).strict(),
  contract: z.object({
    question_version: z.literal(ANSWER_QUESTION_CONTRACT_VERSION),
    derivation_version: z.literal(ANSWER_INTENT_DERIVATION_VERSION),
    intent_schema_version: z.literal(ANSWER_INTENT_SCHEMA_VERSION),
    template_version: z.literal(ANSWER_TEMPLATE_REGISTRY_VERSION),
    template_registry_hash: z.literal(ANSWER_TEMPLATE_REGISTRY_HASH),
    proof_version: z.literal(ANSWER_SEMANTIC_PROOF_VERSION)
  }).strict(),
  evaluation: z.object({
    key_id: keyIdSchema,
    algorithm: z.literal('Ed25519'),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
  }).strict(),
  observations: z.array(observationSchema).min(1).max(1_000)
}).strict();

export type AnswerDerivationEvidenceArtifact = z.infer<typeof artifactSchema>;
export type AnswerDerivationEvidenceObservation = AnswerDerivationEvidenceArtifact['observations'][number];
export type UnsignedAnswerDerivationEvidenceArtifact = Omit<AnswerDerivationEvidenceArtifact, 'evaluation'>;

export interface AnswerDerivationEvidenceSigner {
  readonly key_id: string;
  readonly private_key_base64: string;
}

export interface TrustedAnswerDerivationEvidenceKey {
  readonly key_id: string;
  readonly public_key_base64: string;
}

const verifiedArtifacts = new WeakSet<object>();
declare const verifiedDerivationEvidenceBrand: unique symbol;
export type VerifiedAnswerDerivationEvidenceArtifact = AnswerDerivationEvidenceArtifact & {
  readonly [verifiedDerivationEvidenceBrand]: true;
};

export function getAnswerDerivationManifestHash(cases: readonly object[]): string {
  return sha256(JSON.stringify(cases));
}

export function getAnswerDeterministicDerivationContractSha256(): string {
  return sha256(stableSerialize(currentContract()));
}

export function signAnswerDerivationEvidence(
  cases: readonly { readonly id: string }[],
  input: UnsignedAnswerDerivationEvidenceArtifact,
  signer: AnswerDerivationEvidenceSigner
): AnswerDerivationEvidenceArtifact {
  const keyId = keyIdSchema.parse(signer.key_id);
  const privateKey = createPrivateKey({ key: decodeCanonicalBase64(signer.private_key_base64, 'answer_derivation_private_key_invalid'), format: 'der', type: 'pkcs8' });
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('answer_derivation_private_key_invalid');
  }
  const unsigned = { ...input, evaluation: { key_id: keyId, algorithm: 'Ed25519' as const } };
  return validateAnswerDerivationEvidence(cases, {
    ...unsigned,
    evaluation: { ...unsigned.evaluation, signature: sign(null, Buffer.from(stableSerialize(unsigned)), privateKey).toString('base64') }
  });
}

export function parseAnswerDerivationEvidence(input: unknown): AnswerDerivationEvidenceArtifact {
  let artifact: AnswerDerivationEvidenceArtifact;
  try {
    artifact = artifactSchema.parse(input);
    if (decodeCanonicalBase64(artifact.evaluation.signature, 'answer_derivation_signature_invalid').byteLength !== 64) {
      throw new Error('answer_derivation_signature_invalid');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('answer_derivation_')) {
      throw error;
    }
    throw new Error('answer_derivation_artifact_invalid');
  }
  return artifact;
}

export function validateAnswerDerivationEvidence(
  cases: readonly { readonly id: string }[],
  input: unknown
): AnswerDerivationEvidenceArtifact {
  const artifact = parseAnswerDerivationEvidence(input);
  if (artifact.manifest.case_count !== cases.length || artifact.manifest.sha256 !== getAnswerDerivationManifestHash(cases)) {
    throw new Error('answer_derivation_manifest_mismatch');
  }
  const expectedIds = cases.map(item => item.id);
  const observedIds = artifact.observations.map(item => item.id);
  if (new Set(observedIds).size !== observedIds.length) {
    throw new Error('answer_derivation_observation_duplicate');
  }
  if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
    throw new Error('answer_derivation_observation_order_or_cardinality_invalid');
  }
  if (stableSerialize(artifact.contract) !== stableSerialize(currentContract())) {
    throw new Error('answer_derivation_contract_mismatch');
  }
  return artifact;
}

export function verifyAnswerDerivationEvidence(
  cases: readonly { readonly id: string }[],
  input: unknown,
  trustedKey: TrustedAnswerDerivationEvidenceKey
): VerifiedAnswerDerivationEvidenceArtifact {
  const artifact = validateAnswerDerivationEvidence(cases, input);
  if (artifact.evaluation.key_id !== keyIdSchema.parse(trustedKey.key_id)) {
    throw new Error('answer_derivation_evaluation_key_mismatch');
  }
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: decodeCanonicalBase64(trustedKey.public_key_base64, 'answer_derivation_public_key_invalid'), format: 'der', type: 'spki' });
    valid = publicKey.type === 'public' && publicKey.asymmetricKeyType === 'ed25519' && verify(
      null,
      Buffer.from(stableSerialize(unsignedArtifact(artifact))),
      publicKey,
      decodeCanonicalBase64(artifact.evaluation.signature, 'answer_derivation_signature_invalid')
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new Error('answer_derivation_signature_invalid');
  }
  verifiedArtifacts.add(artifact);
  return deepFreeze(artifact, 0) as VerifiedAnswerDerivationEvidenceArtifact;
}

export function isVerifiedAnswerDerivationEvidence(input: unknown): input is VerifiedAnswerDerivationEvidenceArtifact {
  return typeof input === 'object' && input !== null && verifiedArtifacts.has(input);
}

function currentContract(): AnswerDerivationEvidenceArtifact['contract'] {
  return {
    question_version: ANSWER_QUESTION_CONTRACT_VERSION,
    derivation_version: ANSWER_INTENT_DERIVATION_VERSION,
    intent_schema_version: ANSWER_INTENT_SCHEMA_VERSION,
    template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
    template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
    proof_version: ANSWER_SEMANTIC_PROOF_VERSION
  };
}

function unsignedArtifact(artifact: AnswerDerivationEvidenceArtifact): object {
  return { ...artifact, evaluation: { key_id: artifact.evaluation.key_id, algorithm: artifact.evaluation.algorithm } };
}

function decodeCanonicalBase64(value: string, code: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    throw new Error(code);
  }
  return decoded;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function deepFreeze<T>(value: T, depth: number): T {
  if (depth > 8) {
    throw new Error('answer_derivation_artifact_depth_invalid');
  }
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, depth + 1);
    }
    Object.freeze(value);
  }
  return value;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
