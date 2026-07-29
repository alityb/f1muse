import { createHash } from 'node:crypto';
import { AnswerCapability, authorizeAnswerProgram } from './answer-policy';
import { ANSWER_WORK_MODEL_VERSION } from './answer-bounds';
import {
  ANSWER_AUTHORIZATION_CODE_VERSION,
  ANSWER_RELEASE_ATTESTATION_VERSION,
  getAnswerReleaseAttestationHash,
  isVerifiedAnswerReleaseAttestation,
  VerifiedAnswerReleaseAttestation,
  verifyVerifiedAnswerReleaseAttestationValidity
} from './answer-release-attestation';
import { ANSWER_SEMANTIC_PROOF_VERSION, VerifiedAnswerSemanticProof, verifyAnswerSemanticProof } from './answer-semantic-proof';
import { ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION, materializeAnswerTemplate } from './answer-templates';
import { F1QLProgram } from './ast';
import { refreshF1QLDefinitionsVersion, validateF1QLProgram } from './validation';
import { F1QL_COMPILER_VERSION, F1QL_FACT_SPACE_VERSION, getF1QLProgramHash, normalizeF1QLProgram } from './verified-programs';

export const ANSWER_AUTHORIZATION_VERSION = 11 as const;
export const ANSWER_AUTHORIZATION_TTL_MS = 5_000;
export type AnswerPrincipalClass = 'internal' | 'internal_canary';
type AuthorizedAnswerCapability = Readonly<Omit<AnswerCapability, 'filters'>> & {
  readonly filters: ReadonlyArray<AnswerCapability['filters'][number]>;
};

export interface AnswerAuthorizationActiveVersions {
  readonly definitions: string;
  readonly compiler: string;
  readonly fact_space: string;
  readonly work_model: string;
  readonly semantic_proof: string;
  readonly template_registry: string;
  readonly release_attestation: number;
  readonly authorization: string;
}

export interface AnswerExecutionAuthorization {
  readonly version: typeof ANSWER_AUTHORIZATION_VERSION;
  readonly request_id: string;
  readonly principal_class: AnswerPrincipalClass;
  readonly audience: string;
  readonly deployment_id: string;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
  readonly question_hash: string;
  readonly intent_hash: string;
  readonly proof_hash: string;
  readonly template_id: string;
  readonly template_version: string;
  readonly template_registry_hash: string;
  readonly program_hash: string;
  readonly release_attestation_hash: string;
  readonly capability: AuthorizedAnswerCapability;
  readonly active_versions: AnswerAuthorizationActiveVersions;
  readonly authorization_hash: string;
}

declare const verifiedAnswerAuthorizationBrand: unique symbol;
export type VerifiedAnswerExecutionAuthorization = AnswerExecutionAuthorization & {
  readonly [verifiedAnswerAuthorizationBrand]: true;
};

export interface AnswerAuthorizationConsumptionContext {
  readonly request_id: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly release_attestation: VerifiedAnswerReleaseAttestation;
  readonly is_kill_switch_active: () => boolean;
}

const issuedAuthorizations = new WeakSet<object>();
const consumedAuthorizations = new WeakSet<object>();

export class AnswerAuthorizationError extends Error {
  constructor(readonly code: 'invalid_authorization' | 'authorization_expired' | 'authorization_replayed' | 'authorization_binding_mismatch' | 'release_expired' | 'kill_switch_active') {
    super(code);
    this.name = 'AnswerAuthorizationError';
  }
}

export function buildAnswerExecutionAuthorization(
  requestId: string,
  principalClass: AnswerPrincipalClass,
  proofInput: VerifiedAnswerSemanticProof,
  releaseAttestation: VerifiedAnswerReleaseAttestation,
  nowMs: number = Date.now()
): VerifiedAnswerExecutionAuthorization {
  validateRequestAndPrincipal(requestId, principalClass);
  if (!isVerifiedAnswerReleaseAttestation(releaseAttestation)) {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  let proof: VerifiedAnswerSemanticProof;
  let program: F1QLProgram;
  try {
    proof = verifyAnswerSemanticProof(proofInput);
    if (!releaseAttestation.allowed_template_ids.includes(proof.template_id)) {
      throw new Error('Template is not release-attested');
    }
    const materialized = materializeAnswerTemplate(proof.template_id, proof.template_variables);
    program = normalizeF1QLProgram(proof.program);
    if (getF1QLProgramHash(materialized) !== proof.program_hash || getF1QLProgramHash(program) !== proof.program_hash) {
      throw new Error('Program did not match the verified template');
    }
    validateF1QLProgram(program);
  } catch {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved') {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  const issuedAt = requireSafeTime(nowMs);
  const releaseExpiresAt = requireActiveRelease(releaseAttestation, issuedAt);
  const withoutHash = {
    version: ANSWER_AUTHORIZATION_VERSION,
    request_id: requestId,
    principal_class: principalClass,
    audience: releaseAttestation.audience,
    deployment_id: releaseAttestation.deployment_id,
    issued_at_ms: issuedAt,
    expires_at_ms: Math.min(issuedAt + ANSWER_AUTHORIZATION_TTL_MS, releaseExpiresAt),
    question_hash: proof.question_hash,
    intent_hash: proof.intent_hash,
    proof_hash: proof.proof_hash,
    template_id: proof.template_id,
    template_version: proof.template_version,
    template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
    program_hash: getF1QLProgramHash(program),
    release_attestation_hash: getAnswerReleaseAttestationHash(releaseAttestation),
    capability: deepFreeze({ ...decision.capability, filters: [...decision.capability.filters] }) as AuthorizedAnswerCapability,
    active_versions: activeVersions()
  };
  const authorization = deepFreeze({
    ...withoutHash,
    authorization_hash: sha256(stableSerialize(withoutHash))
  }) as unknown as VerifiedAnswerExecutionAuthorization;
  issuedAuthorizations.add(authorization);
  return authorization;
}

export function consumeAnswerExecutionAuthorization(
  input: unknown,
  context: AnswerAuthorizationConsumptionContext,
  nowMs: number = Date.now()
): VerifiedAnswerExecutionAuthorization {
  const authorization = validateAnswerExecutionAuthorization(input, context, nowMs, false);
  consumedAuthorizations.add(authorization);
  return authorization;
}

export function assertAnswerExecutionAuthorizationActive(
  input: unknown,
  context: AnswerAuthorizationConsumptionContext,
  nowMs: number = Date.now()
): VerifiedAnswerExecutionAuthorization {
  return validateAnswerExecutionAuthorization(input, context, nowMs, true);
}

function validateAnswerExecutionAuthorization(
  input: unknown,
  context: AnswerAuthorizationConsumptionContext,
  nowMs: number,
  requireConsumed: boolean
): VerifiedAnswerExecutionAuthorization {
  try {
    if (typeof context?.is_kill_switch_active !== 'function' || context.is_kill_switch_active()) {
      throw new AnswerAuthorizationError('kill_switch_active');
    }
  } catch (error) {
    if (error instanceof AnswerAuthorizationError) {
      throw error;
    }
    throw new AnswerAuthorizationError('kill_switch_active');
  }
  if (typeof input !== 'object' || input === null || !issuedAuthorizations.has(input) || !isDeepFrozen(input)) {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  const authorization = input as VerifiedAnswerExecutionAuthorization;
  if (!requireConsumed && consumedAuthorizations.has(authorization)) {
    throw new AnswerAuthorizationError('authorization_replayed');
  }
  if (requireConsumed && !consumedAuthorizations.has(authorization)) {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  if (!isVerifiedAnswerReleaseAttestation(context.release_attestation)) {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  const now = requireSafeTime(nowMs);
  const releaseExpiresAt = requireActiveRelease(context.release_attestation, now);
  if (!Number.isSafeInteger(authorization.issued_at_ms) ||
      authorization.expires_at_ms !== Math.min(authorization.issued_at_ms + ANSWER_AUTHORIZATION_TTL_MS, releaseExpiresAt) ||
      now < authorization.issued_at_ms || now >= authorization.expires_at_ms) {
    throw new AnswerAuthorizationError('authorization_expired');
  }
  const withoutHash = Object.fromEntries(Object.entries(authorization).filter(([key]) => key !== 'authorization_hash'));
  const expectedReleaseHash = getAnswerReleaseAttestationHash(context.release_attestation);
  if (authorization.version !== ANSWER_AUTHORIZATION_VERSION || authorization.request_id !== context.request_id ||
      authorization.audience !== context.audience || authorization.deployment_id !== context.deployment_id ||
      authorization.release_attestation_hash !== expectedReleaseHash ||
      authorization.authorization_hash !== sha256(stableSerialize(withoutHash)) ||
      !sameActiveVersions(authorization.active_versions, activeVersions())) {
    throw new AnswerAuthorizationError('authorization_binding_mismatch');
  }
  return authorization;
}

function requireActiveRelease(attestation: VerifiedAnswerReleaseAttestation, nowMs: number): number {
  try {
    verifyVerifiedAnswerReleaseAttestationValidity(attestation, nowMs);
    return Date.parse(attestation.expires_at);
  } catch {
    throw new AnswerAuthorizationError('release_expired');
  }
}

function requireSafeTime(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
  return value;
}

function activeVersions(): AnswerAuthorizationActiveVersions {
  return deepFreeze({
    definitions: refreshF1QLDefinitionsVersion(),
    compiler: F1QL_COMPILER_VERSION,
    fact_space: F1QL_FACT_SPACE_VERSION,
    work_model: ANSWER_WORK_MODEL_VERSION,
    semantic_proof: ANSWER_SEMANTIC_PROOF_VERSION,
    template_registry: ANSWER_TEMPLATE_REGISTRY_VERSION,
    release_attestation: ANSWER_RELEASE_ATTESTATION_VERSION,
    authorization: ANSWER_AUTHORIZATION_CODE_VERSION
  });
}

function validateRequestAndPrincipal(requestId: string, principalClass: AnswerPrincipalClass): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
      (principalClass !== 'internal' && principalClass !== 'internal_canary')) {
    throw new AnswerAuthorizationError('invalid_authorization');
  }
}

function sameActiveVersions(left: AnswerAuthorizationActiveVersions, right: AnswerAuthorizationActiveVersions): boolean {
  return left.definitions === right.definitions && left.compiler === right.compiler && left.fact_space === right.fact_space &&
    left.work_model === right.work_model && left.semantic_proof === right.semantic_proof &&
    left.template_registry === right.template_registry && left.release_attestation === right.release_attestation &&
    left.authorization === right.authorization;
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

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
    return false;
  }
  return Object.values(value).every(child => !child || typeof child !== 'object' || isDeepFrozen(child));
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
