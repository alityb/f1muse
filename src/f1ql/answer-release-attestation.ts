import { createHash, createPublicKey, KeyObject, verify as verifySignature } from 'node:crypto';
import { ANSWER_RUNTIME_MAXIMUMS, ANSWER_RUNTIME_MINIMUMS, AnswerRuntimeConfig } from './answer-runtime';
import { ANSWER_QUESTION_CONTRACT_VERSION } from './answer-question';
import { ANSWER_SEMANTIC_PROOF_VERSION } from './answer-semantic-proof';
import { ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from './answer-templates';
import {
  ANSWER_INTENT_CONTRACT_VERSION,
  ANSWER_TRANSLATOR_PROMPT_SHA256,
  ANSWER_TRANSLATOR_SCHEMA_NAME,
  ANSWER_TRANSLATOR_SCHEMA_SHA256,
  getConfiguredAnswerModelIdentity
} from './answer-translator';

export const ANSWER_RELEASE_ATTESTATION_VERSION = 3 as const;
export const ANSWER_AUTHORIZATION_CODE_VERSION = 'answer-authorization-v5' as const;
export const ANSWER_RELEASE_DEFAULT_MAX_VALIDITY_MS = 10 * 60 * 1000;
export const ANSWER_RELEASE_DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS = 60 * 60 * 1000;

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'disabled']);

const CODE_HASH_KEYS = [
  'prompt_version_sha256',
  'schema_version_sha256',
  'question_version_sha256',
  'intent_version_sha256',
  'template_version_sha256',
  'proof_version_sha256',
  'authorization_version_sha256'
] as const;

export const ANSWER_RELEASE_EVIDENCE_HASH_KEYS = [
  'manifest_sha256',
  'artifact_sha256',
  'report_sha256',
  'result_fixture_sha256',
  'principal_audit_sha256',
  'production_evidence_sha256'
] as const;

const HASH_KEYS = [...CODE_HASH_KEYS, ...ANSWER_RELEASE_EVIDENCE_HASH_KEYS] as const;
const RUNTIME_KEYS = [
  'max_concurrency', 'queue_timeout_ms', 'request_timeout_ms', 'rate_limit_max', 'rate_limit_window_ms',
  'statement_timeout_ms', 'max_work_units', 'max_rows', 'max_response_bytes'
] as const;
const STATUS_KEYS = ['semantic', 'safety', 'linker', 'latency', 'timeout'] as const;
const RUNTIME_CONFIG_KEYS: Readonly<Record<(typeof RUNTIME_KEYS)[number], keyof AnswerRuntimeConfig>> = {
  max_concurrency: 'maxConcurrency', queue_timeout_ms: 'queueTimeoutMs', request_timeout_ms: 'requestTimeoutMs',
  rate_limit_max: 'rateLimitMax', rate_limit_window_ms: 'rateLimitWindowMs', statement_timeout_ms: 'statementTimeoutMs',
  max_work_units: 'maxWorkUnits', max_rows: 'maxRows', max_response_bytes: 'maxResponseBytes'
};

export type AnswerReleaseHashKey = (typeof HASH_KEYS)[number];
export type AnswerReleaseEvidenceHashKey = (typeof ANSWER_RELEASE_EVIDENCE_HASH_KEYS)[number];
export type AnswerRuntimeCeilings = Readonly<Record<(typeof RUNTIME_KEYS)[number], number>>;
export type AnswerReleaseStatuses = Readonly<Record<(typeof STATUS_KEYS)[number], 'pass' | 'fail' | 'insufficient'>>;

export interface AnswerReleaseBindings extends Readonly<Record<AnswerReleaseHashKey, string>> {
  readonly release_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly commit_sha: string;
  readonly provider: string;
  readonly model_id: string;
  readonly endpoint_sha256: string;
  readonly reasoning_effort: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly statuses: AnswerReleaseStatuses;
  readonly runtime_ceilings: AnswerRuntimeCeilings;
  readonly runtime_evidence: AnswerRuntimeCeilings;
  readonly allowed_template_ids: readonly string[];
}

export interface AnswerReleaseAttestation extends AnswerReleaseBindings {
  readonly version: typeof ANSWER_RELEASE_ATTESTATION_VERSION;
  readonly kind: 'f1ql_answer_release_attestation';
  readonly key_id: string;
  readonly signature: string;
}

export type UnsignedAnswerReleaseAttestation = Omit<AnswerReleaseAttestation, 'signature'>;

export interface ActiveAnswerReleaseContext {
  readonly release_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly commit_sha: string;
  readonly provider: string;
  readonly model_id: string;
  readonly endpoint_sha256: string;
  readonly reasoning_effort: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly evidence_hashes: Readonly<Record<AnswerReleaseEvidenceHashKey, string>>;
  readonly statuses: AnswerReleaseStatuses;
  readonly runtime: AnswerRuntimeCeilings;
  readonly deployment_template_ids: readonly string[];
}

export interface TrustedAnswerReleaseKey {
  readonly key_id: string;
  readonly public_key: KeyObject | string | Buffer;
}

export interface AnswerReleaseVerificationInput {
  readonly raw_attestation: unknown;
  readonly trusted_key: TrustedAnswerReleaseKey;
  readonly active_context: ActiveAnswerReleaseContext;
  readonly temporal_policy: AnswerReleaseTemporalPolicy;
}

export interface AnswerReleaseTemporalPolicy {
  readonly now_ms: number;
  readonly max_validity_ms: number;
  readonly max_age_ms: number;
}

declare const verifiedAnswerReleaseBrand: unique symbol;
export type VerifiedAnswerReleaseAttestation = AnswerReleaseAttestation & {
  readonly [verifiedAnswerReleaseBrand]: true;
};

const verifiedAttestations = new WeakSet<object>();

export class AnswerReleaseAttestationError extends Error {
  constructor(readonly code: 'invalid_attestation' | 'binding_mismatch' | 'signature_invalid' | 'release_gate_failed' | 'runtime_mismatch' | 'release_not_configured') {
    super(code);
    this.name = 'AnswerReleaseAttestationError';
  }
}

export function buildActiveAnswerReleaseBindings(context: ActiveAnswerReleaseContext): AnswerReleaseBindings {
  const value: AnswerReleaseBindings = {
    commit_sha: context.commit_sha,
    release_id: context.release_id,
    issued_at: context.issued_at,
    expires_at: context.expires_at,
    provider: context.provider,
    model_id: context.model_id,
    endpoint_sha256: context.endpoint_sha256,
    reasoning_effort: context.reasoning_effort,
    audience: context.audience,
    deployment_id: context.deployment_id,
    prompt_version_sha256: ANSWER_TRANSLATOR_PROMPT_SHA256,
    schema_version_sha256: ANSWER_TRANSLATOR_SCHEMA_SHA256,
    question_version_sha256: sha256(ANSWER_QUESTION_CONTRACT_VERSION),
    intent_version_sha256: sha256(`${ANSWER_INTENT_CONTRACT_VERSION}:${ANSWER_TRANSLATOR_SCHEMA_NAME}:${ANSWER_TRANSLATOR_SCHEMA_SHA256}`),
    template_version_sha256: sha256(`${ANSWER_TEMPLATE_REGISTRY_VERSION}:${ANSWER_TEMPLATE_REGISTRY_HASH}`),
    proof_version_sha256: sha256(ANSWER_SEMANTIC_PROOF_VERSION),
    authorization_version_sha256: sha256(ANSWER_AUTHORIZATION_CODE_VERSION),
    ...context.evidence_hashes,
    statuses: context.statuses,
    runtime_ceilings: context.runtime,
    runtime_evidence: context.runtime,
    allowed_template_ids: context.deployment_template_ids
  };
  validateExpectedBindings(value);
  return deepFreeze(cloneBindings(value));
}

export function parseAnswerReleaseAttestation(input: unknown): AnswerReleaseAttestation {
  const value = strictRecord(input, [
    'version', 'kind', 'key_id', 'signature', 'release_id', 'issued_at', 'expires_at', 'commit_sha', 'provider', 'model_id', 'endpoint_sha256', 'reasoning_effort', 'audience', 'deployment_id',
    ...HASH_KEYS, 'statuses', 'runtime_ceilings', 'runtime_evidence', 'allowed_template_ids'
  ]);
  if (value.version !== ANSWER_RELEASE_ATTESTATION_VERSION || value.kind !== 'f1ql_answer_release_attestation' ||
      typeof value.key_id !== 'string' || !IDENTIFIER.test(value.key_id) ||
      typeof value.signature !== 'string' || !ED25519_SIGNATURE.test(value.signature) || !isCanonicalBase64Length(value.signature, 64)) {
    invalid();
  }
  const bindings = parseBindings(value);
  return { version: ANSWER_RELEASE_ATTESTATION_VERSION, kind: 'f1ql_answer_release_attestation', key_id: value.key_id as string, ...bindings, signature: value.signature as string };
}

export function getAnswerReleaseAttestationSigningPayload(input: unknown): Buffer {
  const unsigned = parseUnsignedAttestation(input);
  return Buffer.from(stableSerialize(unsigned), 'utf8');
}

export function verifyAnswerReleaseAttestation(
  input: unknown,
  trustedKey: TrustedAnswerReleaseKey,
  activeContext: ActiveAnswerReleaseContext,
  temporalPolicy: AnswerReleaseTemporalPolicy = defaultTemporalPolicy()
): VerifiedAnswerReleaseAttestation {
  const attestation = parseAnswerReleaseAttestation(input);
  validateTrustedKey(trustedKey);
  const expected = buildActiveAnswerReleaseBindings(activeContext);
  validateTemporalBindings(attestation, temporalPolicy);
  if (attestation.key_id !== trustedKey.key_id) {
    throw new AnswerReleaseAttestationError('signature_invalid');
  }
  let signatureValid = false;
  try {
    const publicKey = trustedKey.public_key instanceof KeyObject
      ? trustedKey.public_key
      : createPublicKey(trustedKey.public_key);
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Untrusted key type');
    }
    signatureValid = verifySignature(
      null,
      getAnswerReleaseAttestationSigningPayload(attestation),
      publicKey,
      decodeCanonicalBase64(attestation.signature)
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new AnswerReleaseAttestationError('signature_invalid');
  }
  if (!sameBindings(attestation, expected)) {
    throw new AnswerReleaseAttestationError('binding_mismatch');
  }
  if (STATUS_KEYS.some(key => attestation.statuses[key] !== 'pass')) {
    throw new AnswerReleaseAttestationError('release_gate_failed');
  }
  if (!sameRuntime(attestation.runtime_ceilings, attestation.runtime_evidence)) {
    throw new AnswerReleaseAttestationError('runtime_mismatch');
  }
  const verified = deepFreeze(attestation) as VerifiedAnswerReleaseAttestation;
  verifiedAttestations.add(verified);
  return verified;
}

export function isVerifiedAnswerReleaseAttestation(value: unknown): value is VerifiedAnswerReleaseAttestation {
  return typeof value === 'object' && value !== null && verifiedAttestations.has(value);
}

export function verifyVerifiedAnswerReleaseAttestationValidity(
  input: VerifiedAnswerReleaseAttestation,
  nowMs: number = Date.now()
): VerifiedAnswerReleaseAttestation {
  if (!isVerifiedAnswerReleaseAttestation(input)) {
    throw new AnswerReleaseAttestationError('invalid_attestation');
  }
  const now = requireFiniteTime(nowMs);
  const issued = Date.parse(input.issued_at);
  const expires = Date.parse(input.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= issued || now >= expires) {
    throw new AnswerReleaseAttestationError('binding_mismatch');
  }
  return input;
}

export function getAnswerReleaseAttestationHash(input: VerifiedAnswerReleaseAttestation): string {
  if (!isVerifiedAnswerReleaseAttestation(input)) {
    throw new AnswerReleaseAttestationError('invalid_attestation');
  }
  return sha256(stableSerialize(input));
}

export function loadAnswerReleaseVerificationInput(
  runtimeConfig: AnswerRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): AnswerReleaseVerificationInput {
  const raw = env.F1QL_ANSWER_RELEASE_ATTESTATION;
  const publicKeyBase64 = env.F1QL_ANSWER_RELEASE_PUBLIC_KEY_BASE64;
  const keyId = env.F1QL_ANSWER_RELEASE_KEY_ID;
  const commitSha = env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA;
  const audience = env.F1QL_ANSWER_AUTHORIZATION_AUDIENCE;
  const deploymentId = env.F1QL_ANSWER_DEPLOYMENT_ID;
  const releaseId = env.F1QL_ANSWER_RELEASE_ID;
  const templateIds = parseEnvironmentTemplateIds(env.F1QL_ANSWER_DEPLOYMENT_TEMPLATE_IDS);
  if (!raw || Buffer.byteLength(raw, 'utf8') > 100_000 || !publicKeyBase64 || !keyId || !commitSha || !audience || !deploymentId || !releaseId) {
    throw new AnswerReleaseAttestationError('release_not_configured');
  }
  let rawAttestation: AnswerReleaseAttestation;
  let publicKey: KeyObject;
  try {
    rawAttestation = parseAnswerReleaseAttestation(JSON.parse(raw));
    const der = decodeCanonicalBase64(publicKeyBase64);
    if (der.byteLength < 32 || der.byteLength > 4096) {
      throw new Error('Invalid key length');
    }
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Invalid release public key type');
    }
  } catch {
    throw new AnswerReleaseAttestationError('release_not_configured');
  }
  const model = getConfiguredAnswerModelIdentity(env);
  const evidenceHashes = Object.fromEntries(ANSWER_RELEASE_EVIDENCE_HASH_KEYS.map(key => {
    const envKey = `F1QL_ANSWER_RELEASE_${key.toUpperCase()}`;
    const value = env[envKey];
    if (!value || !SHA256.test(value)) {
      throw new AnswerReleaseAttestationError('release_not_configured');
    }
    return [key, value];
  })) as Record<AnswerReleaseEvidenceHashKey, string>;
  return deepFreeze({
    raw_attestation: rawAttestation,
    trusted_key: { key_id: keyId, public_key: publicKey },
    active_context: {
      release_id: releaseId,
      issued_at: rawAttestation.issued_at,
      expires_at: rawAttestation.expires_at,
      commit_sha: commitSha,
      provider: model.provider,
      model_id: model.model_id,
      endpoint_sha256: model.endpoint_sha256,
      reasoning_effort: model.reasoning_effort,
      audience,
      deployment_id: deploymentId,
      evidence_hashes: evidenceHashes,
      statuses: { semantic: 'pass', safety: 'pass', linker: 'pass', latency: 'pass', timeout: 'pass' },
      runtime: answerRuntimeCeilingsFromConfig(runtimeConfig),
      deployment_template_ids: templateIds
    },
    temporal_policy: answerReleaseTemporalPolicy(env, nowMs)
  });
}

function parseUnsignedAttestation(input: unknown): UnsignedAnswerReleaseAttestation {
  const candidate = typeof input === 'object' && input !== null && Object.prototype.hasOwnProperty.call(input, 'signature')
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => key !== 'signature'))
    : input;
  const value = strictRecord(candidate, [
    'version', 'kind', 'key_id', 'release_id', 'issued_at', 'expires_at', 'commit_sha', 'provider', 'model_id', 'endpoint_sha256', 'reasoning_effort', 'audience', 'deployment_id',
    ...HASH_KEYS, 'statuses', 'runtime_ceilings', 'runtime_evidence', 'allowed_template_ids'
  ]);
  if (value.version !== ANSWER_RELEASE_ATTESTATION_VERSION || value.kind !== 'f1ql_answer_release_attestation' ||
      typeof value.key_id !== 'string' || !IDENTIFIER.test(value.key_id)) {
    invalid();
  }
  return { version: ANSWER_RELEASE_ATTESTATION_VERSION, kind: 'f1ql_answer_release_attestation', key_id: value.key_id as string, ...parseBindings(value) };
}

function parseBindings(value: Record<string, unknown>): AnswerReleaseBindings {
  if (typeof value.release_id !== 'string' || !IDENTIFIER.test(value.release_id) ||
      typeof value.issued_at !== 'string' || !isIsoDate(value.issued_at) || typeof value.expires_at !== 'string' || !isIsoDate(value.expires_at) ||
      typeof value.commit_sha !== 'string' || !COMMIT_SHA.test(value.commit_sha) ||
      typeof value.provider !== 'string' || !IDENTIFIER.test(value.provider) ||
      typeof value.model_id !== 'string' || !IDENTIFIER.test(value.model_id) ||
      typeof value.endpoint_sha256 !== 'string' || !SHA256.test(value.endpoint_sha256) ||
      typeof value.reasoning_effort !== 'string' || !REASONING_EFFORTS.has(value.reasoning_effort) ||
      typeof value.audience !== 'string' || !IDENTIFIER.test(value.audience) ||
      typeof value.deployment_id !== 'string' || !IDENTIFIER.test(value.deployment_id)) {
    invalid();
  }
  for (const key of HASH_KEYS) {
    if (typeof value[key] !== 'string' || !SHA256.test(value[key])) {
      invalid();
    }
  }
  return {
    release_id: value.release_id, issued_at: value.issued_at, expires_at: value.expires_at,
    commit_sha: value.commit_sha, provider: value.provider, model_id: value.model_id,
    endpoint_sha256: value.endpoint_sha256, reasoning_effort: value.reasoning_effort,
    audience: value.audience, deployment_id: value.deployment_id,
    ...Object.fromEntries(HASH_KEYS.map(key => [key, value[key]])) as Record<AnswerReleaseHashKey, string>,
    statuses: parseStatuses(value.statuses),
    runtime_ceilings: parseRuntime(value.runtime_ceilings),
    runtime_evidence: parseRuntime(value.runtime_evidence),
    allowed_template_ids: parseTemplateIds(value.allowed_template_ids)
  };
}

function validateExpectedBindings(expected: AnswerReleaseBindings): void {
  parseBindings(expected as unknown as Record<string, unknown>);
  if (!sameRuntime(expected.runtime_ceilings, expected.runtime_evidence)) {
    throw new AnswerReleaseAttestationError('runtime_mismatch');
  }
}

function validateTrustedKey(key: TrustedAnswerReleaseKey): void {
  if (!key || typeof key !== 'object' || typeof key.key_id !== 'string' || !IDENTIFIER.test(key.key_id) || key.public_key === undefined) {
    invalid();
  }
}

function parseRuntime(input: unknown): AnswerRuntimeCeilings {
  const value = strictRecord(input, RUNTIME_KEYS);
  for (const key of RUNTIME_KEYS) {
    const configKey = RUNTIME_CONFIG_KEYS[key];
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < ANSWER_RUNTIME_MINIMUMS[configKey] ||
        (value[key] as number) > ANSWER_RUNTIME_MAXIMUMS[configKey]) {
      invalid();
    }
  }
  if ((value.statement_timeout_ms as number) > (value.request_timeout_ms as number)) {
    invalid();
  }
  return Object.fromEntries(RUNTIME_KEYS.map(key => [key, value[key]])) as unknown as AnswerRuntimeCeilings;
}

export function answerRuntimeCeilingsFromConfig(config: AnswerRuntimeConfig): AnswerRuntimeCeilings {
  return parseRuntime(Object.fromEntries(RUNTIME_KEYS.map(key => [key, config[RUNTIME_CONFIG_KEYS[key]]])));
}

function parseStatuses(input: unknown): AnswerReleaseStatuses {
  const value = strictRecord(input, STATUS_KEYS);
  for (const key of STATUS_KEYS) {
    if (value[key] !== 'pass' && value[key] !== 'fail' && value[key] !== 'insufficient') {
      invalid();
    }
  }
  return Object.fromEntries(STATUS_KEYS.map(key => [key, value[key]])) as Record<(typeof STATUS_KEYS)[number], 'pass' | 'fail' | 'insufficient'>;
}

function parseTemplateIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.some(item => typeof item !== 'string' || !TEMPLATE_ID.test(item))) {
    invalid();
  }
  const values = [...input] as string[];
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1] >= value)) {
    invalid();
  }
  return values;
}

function parseEnvironmentTemplateIds(value: string | undefined): string[] {
  if (!value) {
    throw new AnswerReleaseAttestationError('release_not_configured');
  }
  try {
    return parseTemplateIds(value.split(',').map(item => item.trim()));
  } catch {
    throw new AnswerReleaseAttestationError('release_not_configured');
  }
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    invalid();
  }
  const value = input as Record<string, unknown>;
  if (!sameStrings(Object.keys(value).sort(), [...keys].sort())) {
    invalid();
  }
  return value;
}

function cloneBindings(value: AnswerReleaseBindings): AnswerReleaseBindings {
  return {
    ...value,
    statuses: { ...value.statuses },
    runtime_ceilings: { ...value.runtime_ceilings },
    runtime_evidence: { ...value.runtime_evidence },
    allowed_template_ids: [...value.allowed_template_ids]
  };
}

function sameBindings(left: AnswerReleaseBindings, right: AnswerReleaseBindings): boolean {
  return left.release_id === right.release_id && left.issued_at === right.issued_at && left.expires_at === right.expires_at &&
    left.commit_sha === right.commit_sha && left.provider === right.provider && left.model_id === right.model_id &&
    left.endpoint_sha256 === right.endpoint_sha256 && left.reasoning_effort === right.reasoning_effort &&
    left.audience === right.audience && left.deployment_id === right.deployment_id &&
    HASH_KEYS.every(key => left[key] === right[key]) && sameStatuses(left.statuses, right.statuses) &&
    sameRuntime(left.runtime_ceilings, right.runtime_ceilings) && sameRuntime(left.runtime_evidence, right.runtime_evidence) &&
    sameStrings(left.allowed_template_ids, right.allowed_template_ids);
}

function sameRuntime(left: AnswerRuntimeCeilings, right: AnswerRuntimeCeilings): boolean {
  return RUNTIME_KEYS.every(key => left[key] === right[key]);
}

function sameStatuses(left: AnswerReleaseStatuses, right: AnswerReleaseStatuses): boolean {
  return STATUS_KEYS.every(key => left[key] === right[key]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
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

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Invalid Base64');
  }
  return decoded;
}

function isCanonicalBase64Length(value: string, length: number): boolean {
  try {
    return decodeCanonicalBase64(value).byteLength === length;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function answerReleaseTemporalPolicy(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): AnswerReleaseTemporalPolicy {
  return {
    now_ms: requireFiniteTime(nowMs),
    max_validity_ms: parseTimeLimit(env.F1QL_ANSWER_RELEASE_MAX_VALIDITY_MS, ANSWER_RELEASE_DEFAULT_MAX_VALIDITY_MS),
    max_age_ms: parseTimeLimit(env.F1QL_ANSWER_RELEASE_MAX_AGE_MS, ANSWER_RELEASE_DEFAULT_MAX_AGE_MS)
  };
}

function defaultTemporalPolicy(): AnswerReleaseTemporalPolicy {
  return answerReleaseTemporalPolicy(process.env, Date.now());
}

function validateTemporalBindings(attestation: AnswerReleaseAttestation, policy: AnswerReleaseTemporalPolicy): void {
  const now = requireFiniteTime(policy.now_ms);
  const maxValidity = parseTimeLimit(String(policy.max_validity_ms), ANSWER_RELEASE_DEFAULT_MAX_VALIDITY_MS);
  const maxAge = parseTimeLimit(String(policy.max_age_ms), ANSWER_RELEASE_DEFAULT_MAX_AGE_MS);
  const issued = Date.parse(attestation.issued_at);
  const expires = Date.parse(attestation.expires_at);
  if (issued > now || now - issued > maxAge || expires <= now || expires <= issued || expires - issued > maxValidity) {
    throw new AnswerReleaseAttestationError('binding_mismatch');
  }
}

function parseTimeLimit(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS) {
    throw new AnswerReleaseAttestationError('release_not_configured');
  }
  return value;
}

function requireFiniteTime(value: number): number {
  if (!Number.isFinite(value)) {
    throw new AnswerReleaseAttestationError('release_not_configured');
  }
  return value;
}

function isIsoDate(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function invalid(): never {
  throw new AnswerReleaseAttestationError('invalid_attestation');
}
