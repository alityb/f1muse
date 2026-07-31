import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify
} from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync
} from 'node:fs';
import { z } from 'zod';
import {
  parseSemanticCatalogBindingArtifact,
  SemanticCatalogBindingArtifact,
  verifySemanticCatalogBindingArtifact
} from './audit-semantic-catalog-binding';
import {
  parseAnswerPrincipalAuditReport,
  verifyAnswerPrincipalAuditReport
} from './audit-answer-principal';
import {
  matchesSemanticShadowOracle,
  parseSemanticShadowJsonRejectDuplicateKeys,
  parseSemanticShadowRetainedEventsFromJsonl
} from '../src/f1ql/semantic-shadow-report';
import {
  ConfiguredSemanticCandidateModelIdentity,
  getConfiguredSemanticCandidateModelIdentity
} from '../src/f1ql/semantic-candidate-translator';
import {
  SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256
} from '../src/f1ql/semantic-shadow-resolver-reader';
import {
  loadSemanticShadowProductionCapturePublicKey,
  TrustedSemanticShadowProductionCaptureKey,
  verifySemanticShadowProductionCapture
} from '../src/f1ql/semantic-shadow-production-capture';
import { semanticShadowActiveVersions } from '../src/f1ql/semantic-shadow-planner';
import { SEMANTIC_CATALOG_HASH } from '../src/f1ql/semantic-catalog';
import { computeAnswerDatabaseConnectionIdentity } from '../src/db/answer-database';
import reviewedSnapshot from '../tests/fixtures/compositional-regression.snapshot.json';
import { reviewedSemanticShadowReportRequirements } from './report-semantic-shadow';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const MAXIMUM_INPUT_BYTES = 2_000_000;
const MAXIMUM_OUTPUT_BYTES = 100_000;
const MAXIMUM_EVIDENCE_AGE_MS = 15 * 60 * 1_000;
const PRODUCTION_CASE_ID = 'promoted-safe-dimension-join';
const CATALOG_BASE_READ_STATEMENTS = 4;

const evidenceSchema = z.object({
  version: z.literal(1),
  kind: z.literal('f1ql_semantic_shadow_production_metadata_evidence'),
  target: z.literal('production'),
  status: z.literal('passed'),
  observed_at: z.string().datetime(),
  catalog_observed_at: z.string().datetime(),
  principal_audited_at: z.string().datetime(),
  commit_sha: z.string().regex(COMMIT_SHA),
  deployment_id: z.string().regex(IDENTIFIER),
  release_id: z.string().regex(IDENTIFIER),
  case_id: z.literal(PRODUCTION_CASE_ID),
  question_sha256: z.string().regex(SHA256),
  semantic_catalog_sha256: z.string().regex(SHA256),
  semantic_catalog_database_binding_sha256: z.string().regex(SHA256),
  semantic_catalog_binding_artifact_sha256: z.string().regex(SHA256),
  principal_audit_artifact_sha256: z.string().regex(SHA256),
  current_user_sha256: z.string().regex(SHA256),
  current_database_sha256: z.string().regex(SHA256),
  answer_database_target_sha256: z.string().regex(SHA256),
  shadow_log_artifact_sha256: z.string().regex(SHA256),
  resolver_sql_fingerprint_set_sha256: z.string().regex(SHA256),
  provider_identity_sha256: z.string().regex(SHA256),
  active_versions_sha256: z.string().regex(SHA256),
  runtime_context_sha256: z.string().regex(SHA256),
  retained_observation_sha256: z.string().regex(SHA256),
  shadow: z.object({
    terminal: z.literal('semantic'),
    rollout_stage: z.literal(0),
    outcome: z.literal('answer'),
    reason: z.literal('plan_proven'),
    topology_code: z.literal('row_dimension_join'),
    source_set_code: z.literal('event_classification__event_metadata'),
    operator_set_code: z.literal('filter_join_project_sort_limit'),
    template_dual_status: z.literal('not_applicable')
  }).strict(),
  reads: z.object({
    fingerprint_transactions: z.literal(1),
    fingerprint_statements: z.number().int().min(CATALOG_BASE_READ_STATEMENTS).max(100),
    fingerprint_required_grain_checks: z.number().int().min(0).max(20),
    route_fingerprint_reads: z.literal(0),
    resolver_transactions: z.number().int().min(0).max(2),
    resolver_statements: z.number().int().min(0).max(2),
    resolver_returned_rows: z.number().int().min(0).max(10_502),
    result_query_calls: z.literal(0)
  }).strict(),
  production_evidence: z.object({
    key_id: z.string().regex(IDENTIFIER),
    algorithm: z.literal('Ed25519'),
    signature: z.string().regex(SIGNATURE)
  }).strict()
}).strict();

export type SemanticShadowProductionMetadataEvidence = z.infer<typeof evidenceSchema>;
type UnsignedEvidence = Omit<SemanticShadowProductionMetadataEvidence, 'production_evidence'> & {
  readonly production_evidence: { readonly key_id: string; readonly algorithm: 'Ed25519' };
};

export interface SemanticShadowProductionEvidenceContext {
  readonly commit_sha: string;
  readonly deployment_id: string;
  readonly release_id: string;
  readonly key_id: string;
  readonly private_key: KeyObject;
  readonly catalog_trusted_key: TrustedSemanticShadowProductionEvidenceKey;
  readonly capture_trusted_key: TrustedSemanticShadowProductionCaptureKey;
  readonly expected_provider_identity: ConfiguredSemanticCandidateModelIdentity;
  readonly capture_nonce: string;
  readonly answer_database_target_sha256: string;
  readonly answer_database_user_sha256: string;
  readonly answer_database_name_sha256: string;
}

export interface TrustedSemanticShadowProductionEvidenceKey {
  readonly key_id: string;
  readonly public_key: KeyObject;
}

export function computeSemanticShadowResolverFingerprintSetSha256(): string {
  return SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256;
}

export function parseSemanticShadowProductionMetadataEvidence(
  input: unknown
): SemanticShadowProductionMetadataEvidence {
  const evidence = evidenceSchema.parse(input);
  if (evidence.semantic_catalog_sha256 !== SEMANTIC_CATALOG_HASH ||
      evidence.resolver_sql_fingerprint_set_sha256 !== computeSemanticShadowResolverFingerprintSetSha256() ||
      evidence.active_versions_sha256 !== sha256(stableSerialize(semanticShadowActiveVersions())) ||
      evidence.reads.fingerprint_statements !==
        CATALOG_BASE_READ_STATEMENTS + evidence.reads.fingerprint_required_grain_checks) {
    throw new Error('semantic shadow production metadata evidence mismatch');
  }
  return deepFreeze(evidence);
}

export function getSemanticShadowProductionEvidenceSigningPayload(input: unknown): Buffer {
  const value = input as Record<string, unknown>;
  const rawEvidence = value?.production_evidence as Record<string, unknown> | undefined;
  const candidate = evidenceSchema.parse({
    ...value,
    production_evidence: {
      ...rawEvidence,
      signature: rawEvidence?.signature ?? `${'A'.repeat(86)}==`
    }
  });
  const productionEvidence = {
    key_id: candidate.production_evidence.key_id,
    algorithm: candidate.production_evidence.algorithm
  };
  return Buffer.from(stableSerialize({ ...candidate, production_evidence: productionEvidence }), 'utf8');
}

export function buildSemanticShadowProductionMetadataEvidence(
  principalAuditBytes: Buffer,
  catalogArtifactBytes: Buffer,
  shadowLogBytes: Buffer,
  context: SemanticShadowProductionEvidenceContext,
  nowMs = Date.now()
): SemanticShadowProductionMetadataEvidence {
  assertContext(context);
  const principalAuditInput = parseSingleJsonObject(decodeUtf8(principalAuditBytes));
  const principal = verifyAnswerPrincipalAuditReport(
    parseAnswerPrincipalAuditReport(principalAuditInput),
    context.catalog_trusted_key,
    context
  );
  if (principal.status !== 'passed' || principal.findings.length !== 0) {
    throw new Error('semantic shadow production evidence requires a passing principal audit');
  }
  const catalogArtifactInput = parseSingleJsonObject(decodeUtf8(catalogArtifactBytes));
  const catalogArtifact = verifySemanticCatalogBindingArtifact(
    catalogArtifactInput,
    context.catalog_trusted_key,
    context
  );
  if (!catalogArtifact.read_counters) {
    throw new Error('semantic shadow production evidence requires observed catalog read counters');
  }
  if (principal.database_target_sha256 !== context.answer_database_target_sha256 ||
      catalogArtifact.database_target_sha256 !== context.answer_database_target_sha256 ||
      catalogArtifact.binding.database_identity.current_user_sha256 !== principal.current_user_sha256 ||
      catalogArtifact.binding.database_identity.current_database_sha256 !== principal.current_database_sha256 ||
      context.answer_database_user_sha256 !== principal.current_user_sha256 ||
      context.answer_database_name_sha256 !== principal.current_database_sha256) {
    throw new Error('semantic shadow production evidence database binding mismatch');
  }
  const shadowLogContent = decodeUtf8(shadowLogBytes);
  const retainedEvents = parseSemanticShadowRetainedEventsFromJsonl(shadowLogContent);
  if (retainedEvents.length !== 1) {
    throw new Error('semantic shadow production evidence requires exactly one retained event');
  }
  const retained = verifySemanticShadowProductionCapture(retainedEvents[0], context.capture_trusted_key);
  if (retained.version !== 'semantic-shadow-retained-v2' || !('terminal' in retained) ||
      retained.terminal !== 'semantic' || retained.evidence_binding !== undefined) {
    throw new Error('semantic shadow production evidence requires one unbound semantic terminal event');
  }
  const expected = productionExpectedCase();
  const observation = retained.observation as unknown as Record<string, unknown>;
  const productionBinding = retained.production_evidence_binding;
  const expectedRuntimeContext = runtimeContext(context);
  if (retained.question_sha256 !== expected.question_sha256 ||
      !matchesSemanticShadowOracle(observation, expected) ||
      observation.hashes === undefined ||
      (observation.hashes as Record<string, unknown>).catalog_sha256 !== SEMANTIC_CATALOG_HASH ||
      stableSerialize(observation.versions) !== stableSerialize(semanticShadowActiveVersions()) ||
      stableSerialize(retained.provider_identity) !== stableSerialize(context.expected_provider_identity) ||
      stableSerialize(productionBinding) !== stableSerialize(expectedRuntimeContext)) {
    throw new Error('semantic shadow production evidence does not match the reviewed oracle');
  }
  assertRailwayEnvelope(shadowLogContent, retained.timestamp);
  const catalogObservedAt = Date.parse(catalogArtifact.observed_at);
  const principalAuditedAt = Date.parse(principal.audited_at);
  const observedAt = Date.parse(retained.timestamp);
  if (!Number.isFinite(nowMs) || !Number.isFinite(principalAuditedAt) ||
      !Number.isFinite(catalogObservedAt) || !Number.isFinite(observedAt) ||
      catalogObservedAt < principalAuditedAt || catalogObservedAt - principalAuditedAt > MAXIMUM_EVIDENCE_AGE_MS ||
      observedAt < catalogObservedAt || observedAt - catalogObservedAt > MAXIMUM_EVIDENCE_AGE_MS ||
      observedAt > nowMs || nowMs - observedAt > MAXIMUM_EVIDENCE_AGE_MS ||
      catalogObservedAt > nowMs || nowMs - catalogObservedAt > MAXIMUM_EVIDENCE_AGE_MS ||
      principalAuditedAt > nowMs || nowMs - principalAuditedAt > MAXIMUM_EVIDENCE_AGE_MS) {
    throw new Error('semantic shadow production evidence is stale or out of order');
  }
  const dual = observation.template_dual as Record<string, unknown>;
  const fingerprintChecks = catalogArtifact.read_counters.required_grain_check_count;
  const unsigned: UnsignedEvidence = {
    version: 1,
    kind: 'f1ql_semantic_shadow_production_metadata_evidence',
    target: 'production',
    status: 'passed',
    observed_at: retained.timestamp,
    catalog_observed_at: catalogArtifact.observed_at,
    principal_audited_at: principal.audited_at,
    commit_sha: context.commit_sha,
    deployment_id: context.deployment_id,
    release_id: context.release_id,
    case_id: PRODUCTION_CASE_ID,
    question_sha256: retained.question_sha256,
    semantic_catalog_sha256: catalogArtifact.catalog_hash,
    semantic_catalog_database_binding_sha256: catalogArtifact.database_binding_hash,
    semantic_catalog_binding_artifact_sha256: sha256(catalogArtifactBytes),
    principal_audit_artifact_sha256: sha256(principalAuditBytes),
    current_user_sha256: principal.current_user_sha256,
    current_database_sha256: principal.current_database_sha256,
    answer_database_target_sha256: context.answer_database_target_sha256,
    shadow_log_artifact_sha256: sha256(shadowLogBytes),
    resolver_sql_fingerprint_set_sha256: computeSemanticShadowResolverFingerprintSetSha256(),
    provider_identity_sha256: sha256(stableSerialize(retained.provider_identity)),
    active_versions_sha256: sha256(stableSerialize(semanticShadowActiveVersions())),
    runtime_context_sha256: sha256(stableSerialize(expectedRuntimeContext)),
    retained_observation_sha256: sha256(stableSerialize(retained)),
    shadow: {
      terminal: 'semantic',
      rollout_stage: 0,
      outcome: 'answer',
      reason: 'plan_proven',
      topology_code: 'row_dimension_join',
      source_set_code: 'event_classification__event_metadata',
      operator_set_code: 'filter_join_project_sort_limit',
      template_dual_status: dual.status as 'not_applicable'
    },
    reads: {
      fingerprint_transactions: 1,
      fingerprint_statements: catalogArtifact.read_counters.statement_count,
      fingerprint_required_grain_checks: fingerprintChecks,
      route_fingerprint_reads: observation.resolver_counts &&
        (observation.resolver_counts as Record<string, unknown>).fingerprint_reads as 0,
      resolver_transactions: retained.resolver_transaction_count,
      resolver_statements: retained.resolver_transaction_counters.statement_count,
      resolver_returned_rows: retained.resolver_transaction_counters.returned_row_count,
      result_query_calls: observation.result_query_calls as 0
    },
    production_evidence: { key_id: context.key_id, algorithm: 'Ed25519' }
  };
  return parseSemanticShadowProductionMetadataEvidence({
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getSemanticShadowProductionEvidenceSigningPayload(unsigned), context.private_key)
        .toString('base64')
    }
  });
}

export function verifySemanticShadowProductionMetadataEvidence(
  input: unknown,
  trustedKey: TrustedSemanticShadowProductionEvidenceKey,
  expected: Pick<SemanticShadowProductionMetadataEvidence,
    'commit_sha' | 'deployment_id' | 'release_id' | 'answer_database_target_sha256' |
    'current_user_sha256' | 'current_database_sha256'>,
  nowMs = Date.now()
): SemanticShadowProductionMetadataEvidence {
  const evidence = parseSemanticShadowProductionMetadataEvidence(input);
  const observedAt = Date.parse(evidence.observed_at);
  const catalogObservedAt = Date.parse(evidence.catalog_observed_at);
  const principalAuditedAt = Date.parse(evidence.principal_audited_at);
  if (trustedKey.key_id !== evidence.production_evidence.key_id ||
      trustedKey.public_key.type !== 'public' || trustedKey.public_key.asymmetricKeyType !== 'ed25519' ||
      evidence.commit_sha !== expected.commit_sha || evidence.deployment_id !== expected.deployment_id ||
      evidence.release_id !== expected.release_id ||
      evidence.answer_database_target_sha256 !== expected.answer_database_target_sha256 ||
      evidence.current_user_sha256 !== expected.current_user_sha256 ||
      evidence.current_database_sha256 !== expected.current_database_sha256 ||
      !Number.isFinite(nowMs) || observedAt > nowMs ||
      nowMs - observedAt > MAXIMUM_EVIDENCE_AGE_MS || catalogObservedAt > nowMs ||
      nowMs - catalogObservedAt > MAXIMUM_EVIDENCE_AGE_MS || catalogObservedAt > observedAt ||
      principalAuditedAt > nowMs || nowMs - principalAuditedAt > MAXIMUM_EVIDENCE_AGE_MS ||
      principalAuditedAt > catalogObservedAt ||
      !verify(null, getSemanticShadowProductionEvidenceSigningPayload(evidence), trustedKey.public_key,
        decodeCanonicalSignature(evidence.production_evidence.signature))) {
    throw new Error('semantic shadow production metadata evidence signature or context mismatch');
  }
  return evidence;
}

export function buildSemanticShadowProductionEvidenceFile(
  paths: {
    readonly principal_audit: string;
    readonly catalog_artifact: string;
    readonly shadow_log: string;
    readonly output: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): { readonly output: string; readonly status: 'pass'; readonly sha256: string } {
  if (env.F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_BUILD_ENABLED !== 'true' ||
      env.F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_TARGET !== 'production') {
    throw new Error('semantic shadow production evidence build is not enabled');
  }
  const principalBytes = readBoundedRegularFile(paths.principal_audit);
  const catalogBytes = readBoundedRegularFile(paths.catalog_artifact);
  const shadowBytes = readBoundedRegularFile(paths.shadow_log);
  parseSemanticCatalogBindingArtifact(parseSingleJsonObject(decodeUtf8(catalogBytes)));
  const context = {
    commit_sha: required(env, 'RAILWAY_GIT_COMMIT_SHA'),
    deployment_id: required(env, 'F1QL_ANSWER_DEPLOYMENT_ID'),
    release_id: required(env, 'F1QL_ANSWER_RELEASE_ID'),
    key_id: required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_KEY_ID'),
    private_key: loadPrivateKey(required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64')),
    catalog_trusted_key: {
      key_id: required(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID'),
      public_key: loadSemanticShadowProductionPublicKey(
        required(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64')
      )
    },
    capture_trusted_key: {
      key_id: required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_KEY_ID'),
      public_key: loadSemanticShadowProductionCapturePublicKey(
        required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_PUBLIC_KEY_BASE64')
      )
    },
    expected_provider_identity: getConfiguredSemanticCandidateModelIdentity(env),
    capture_nonce: required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_NONCE'),
    ...databaseIdentity(required(env, 'F1QL_ANSWER_DATABASE_URL'))
  };
  const artifact = buildSemanticShadowProductionMetadataEvidence(
    principalBytes, catalogBytes, shadowBytes, context, nowMs
  );
  const outputBytes = Buffer.from(`${JSON.stringify(artifact)}\n`, 'utf8');
  if (outputBytes.byteLength > MAXIMUM_OUTPUT_BYTES) {
    throw new Error('semantic shadow production evidence output is too large');
  }
  writeExclusive(paths.output, outputBytes);
  return { output: paths.output, status: 'pass', sha256: sha256(outputBytes) };
}

export function readSemanticShadowProductionEvidenceFile(path: string): Buffer {
  return readBoundedRegularFile(path);
}

export function parseSingleSemanticShadowProductionEvidenceFile(content: Buffer): unknown {
  return parseSingleJsonObject(decodeUtf8(content));
}

export function loadSemanticShadowProductionPublicKey(value: string): KeyObject {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || decoded.byteLength < 32 || decoded.byteLength > 4_096) {
      throw new Error('invalid');
    }
    const key = createPublicKey({ key: decoded, format: 'der', type: 'spki' });
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {throw new Error('invalid');}
    return key;
  } catch {
    throw new Error('semantic shadow production evidence public key is invalid');
  }
}

function productionExpectedCase() {
  const snapshot = reviewedSnapshot as { cases?: Array<{ id?: unknown }> };
  const index = snapshot.cases?.findIndex(item => item.id === PRODUCTION_CASE_ID) ?? -1;
  const expected = reviewedSemanticShadowReportRequirements(reviewedSnapshot).cases[index];
  if (index < 0 || !expected) {throw new Error('semantic shadow production evidence oracle is unavailable');}
  return expected;
}

function assertContext(context: SemanticShadowProductionEvidenceContext): void {
  if (!COMMIT_SHA.test(context.commit_sha) || !IDENTIFIER.test(context.deployment_id) ||
      !IDENTIFIER.test(context.release_id) || !IDENTIFIER.test(context.key_id) ||
      context.private_key.type !== 'private' || context.private_key.asymmetricKeyType !== 'ed25519' ||
      !IDENTIFIER.test(context.catalog_trusted_key.key_id) ||
      context.catalog_trusted_key.public_key.type !== 'public' ||
      context.catalog_trusted_key.public_key.asymmetricKeyType !== 'ed25519' ||
      !IDENTIFIER.test(context.capture_trusted_key.key_id) ||
      context.capture_trusted_key.public_key.type !== 'public' ||
      context.capture_trusted_key.public_key.asymmetricKeyType !== 'ed25519' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(context.capture_nonce) ||
      !SHA256.test(context.answer_database_target_sha256) || !SHA256.test(context.answer_database_user_sha256) ||
      !SHA256.test(context.answer_database_name_sha256) ||
      context.key_id === context.catalog_trusted_key.key_id ||
      context.key_id === context.capture_trusted_key.key_id ||
      context.catalog_trusted_key.key_id === context.capture_trusted_key.key_id ||
      createPublicKey(context.private_key).export({ format: 'der', type: 'spki' }).equals(
        context.catalog_trusted_key.public_key.export({ format: 'der', type: 'spki' })
      ) ||
      createPublicKey(context.private_key).export({ format: 'der', type: 'spki' }).equals(
        context.capture_trusted_key.public_key.export({ format: 'der', type: 'spki' })
      ) ||
      context.catalog_trusted_key.public_key.export({ format: 'der', type: 'spki' }).equals(
        context.capture_trusted_key.public_key.export({ format: 'der', type: 'spki' })
      )) {
    throw new Error('semantic shadow production evidence context is invalid');
  }
}

function runtimeContext(context: SemanticShadowProductionEvidenceContext) {
  return Object.freeze({
    commit_sha256: sha256(context.commit_sha),
    deployment_id_sha256: sha256(context.deployment_id),
    release_id_sha256: sha256(context.release_id),
    capture_nonce_sha256: sha256(context.capture_nonce),
    answer_database_target_sha256: context.answer_database_target_sha256,
    answer_database_user_sha256: context.answer_database_user_sha256,
    answer_database_name_sha256: context.answer_database_name_sha256,
    resolver_sql_fingerprint_set_sha256: SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256
  });
}

function databaseIdentity(connectionString: string) {
  const identity = computeAnswerDatabaseConnectionIdentity(connectionString);
  return {
    answer_database_target_sha256: identity.target_sha256,
    answer_database_user_sha256: identity.current_user_sha256,
    answer_database_name_sha256: identity.current_database_sha256
  };
}

function assertRailwayEnvelope(content: string, retainedTimestamp: string): void {
  const matchingEnvelopes = content.split(/\r?\n/u).filter(line => line.trim().length > 0).filter(line => {
    try {
      const outer = parseSemanticShadowJsonRejectDuplicateKeys(line) as Record<string, unknown>;
      if (typeof outer?.message !== 'string' || typeof outer.timestamp !== 'string') {return false;}
      const message = parseSemanticShadowJsonRejectDuplicateKeys(outer.message) as Record<string, unknown>;
      if (message?.version !== 'semantic-shadow-retained-v2') {return false;}
      const envelopeTimestamp = Date.parse(outer.timestamp);
      const eventTimestamp = Date.parse(retainedTimestamp);
      return Number.isFinite(envelopeTimestamp) && Math.abs(envelopeTimestamp - eventTimestamp) <= 60_000;
    } catch {
      return false;
    }
  });
  if (matchingEnvelopes.length !== 1) {
    throw new Error('semantic shadow production evidence requires one timestamp-bound Railway envelope');
  }
}

function parseSingleJsonObject(content: string): unknown {
  const lines = content.split(/\r?\n/u).filter(line => line.trim().length > 0);
  if (lines.length !== 1) {throw new Error('semantic shadow production evidence input is invalid');}
  return parseSemanticShadowJsonRejectDuplicateKeys(lines[0]);
}

function readBoundedRegularFile(path: string): Buffer {
  if (!path || path.length > 4_096 || path.includes('\0')) {
    throw new Error('semantic shadow production evidence path is invalid');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAXIMUM_INPUT_BYTES) {
      throw new Error('semantic shadow production evidence input is invalid');
    }
    const content = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const count = readSync(descriptor, content, offset, metadata.size - offset, offset);
      if (count === 0) {throw new Error('semantic shadow production evidence input is incomplete');}
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, metadata.size) !== 0) {
      throw new Error('semantic shadow production evidence input changed');
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error('semantic shadow production evidence input is not valid UTF-8');
  }
}

function loadPrivateKey(value: string): KeyObject {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || decoded.byteLength < 32 || decoded.byteLength > 4_096) {
      throw new Error('invalid');
    }
    const key = createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {throw new Error('invalid');}
    return key;
  } catch {
    throw new Error('semantic shadow production evidence signing key is invalid');
  }
}

function decodeCanonicalSignature(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 64 || decoded.toString('base64') !== value) {
    throw new Error('semantic shadow production metadata evidence signature is invalid');
  }
  return decoded;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length > 100_000) {throw new Error(`missing ${name}`);}
  return value;
}

function writeExclusive(path: string, content: Buffer): void {
  if (!path || path.length > 4_096 || path.includes('\0')) {
    throw new Error('semantic shadow production evidence output path is invalid');
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < content.byteLength) {
      offset += writeSync(descriptor, content, offset, content.byteLength - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}

function main(): void {
  const [principalAudit, catalogArtifact, shadowLog, output] = process.argv.slice(2);
  if (!principalAudit || !catalogArtifact || !shadowLog || !output || process.argv.slice(2).length !== 4) {
    throw new Error('semantic shadow production evidence arguments are invalid');
  }
  process.stdout.write(`${JSON.stringify(buildSemanticShadowProductionEvidenceFile({
    principal_audit: principalAudit,
    catalog_artifact: catalogArtifact,
    shadow_log: shadowLog,
    output
  }))}\n`);
}

if (require.main === module) {
  try {main();}
  catch {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  }
}
