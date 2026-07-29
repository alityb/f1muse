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
import { join } from 'node:path';
import {
  AnswerPrincipalAuditReport,
  TrustedProductionEvidenceKey,
  verifyAnswerPrincipalAuditReport
} from './audit-answer-principal';
import { buildAnswerDerivationReport } from '../src/f1ql/answer-derivation-report';
import { getAnswerDerivationManifestHash, verifyAnswerDerivationEvidence } from '../src/f1ql/answer-derivation-evidence';
import {
  ANSWER_RELEASE_ATTESTATION_VERSION,
  ANSWER_CANARY_POLICY_VERSION,
  ActiveAnswerReleaseContext,
  AnswerReleaseAttestation,
  AnswerReleaseStatuses,
  answerReleaseTemporalPolicy,
  answerRuntimeCeilingsFromConfig,
  ANSWER_PRINCIPAL_CLASSES,
  AnswerPrincipalClass,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationHash,
  getAnswerReleaseAttestationSigningPayload,
  getAnswerCanaryHmacKeySha256,
  verifyAnswerReleaseAttestation
} from '../src/f1ql/answer-release-attestation';
import { getAnswerRuntimeConfig } from '../src/f1ql/answer-runtime';
import { ANSWER_TEMPLATE_IDS, AnswerTemplateId } from '../src/f1ql/answer-templates';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

const MAXIMUM_INPUT_BYTES = 5_000_000;
const MAXIMUM_ATTESTATION_BYTES = 100_000;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMITTED_RESULT_FIXTURE = join(__dirname, '../tests/fixtures/f1ql-answer-evaluation-results.json');
const IDENTITY_VIEW_MIGRATION = join(__dirname, '../migrations/20260729_f1ql_answer_identity_views.sql');
const ROLE_GRANT_MIGRATION = join(__dirname, '../migrations/20260730_f1ql_answer_role_grants.sql');

export interface AnswerReleaseBuildPaths {
  artifact: string;
  report: string;
  result_fixture: string;
  principal_audit: string;
  production_evidence: string;
  output: string;
}

export interface AnswerReleaseBuildResult {
  readonly output: string;
  readonly status: 'pass';
  readonly sha256: string;
}

export function buildAnswerReleaseAttestationFile(
  paths: AnswerReleaseBuildPaths,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): AnswerReleaseBuildResult {
  requireBuildGuard(env);
  const artifactFile = readBoundedRegularFile(paths.artifact);
  const reportFile = readBoundedRegularFile(paths.report);
  const resultFile = readBoundedRegularFile(paths.result_fixture);
  const principalFile = readBoundedRegularFile(paths.principal_audit);
  const productionFile = readBoundedRegularFile(paths.production_evidence);

  const artifact = verifyAnswerDerivationEvidence(answerEvaluationManifest, parseJson(artifactFile.content), {
    key_id: requiredEnvironment(env, 'F1QL_ANSWER_EVALUATION_KEY_ID'),
    public_key_base64: requiredEnvironment(env, 'F1QL_ANSWER_EVALUATION_PUBLIC_KEY_BASE64')
  });
  requireFreshEvidence(artifact.collected_at, requiredAgeLimit(env, 'F1QL_ANSWER_DERIVATION_EVIDENCE_MAX_AGE_MS'), nowMs, 'answer_release_derivation_evidence_stale');

  const expectedReport = buildAnswerDerivationReport(
    answerEvaluationManifest,
    answerMetamorphicGroups,
    artifact,
    artifactFile.sha256
  );
  const suppliedReport = parseJson(reportFile.content);
  if (stableSerialize(suppliedReport) !== stableSerialize(expectedReport)) {
    throw new Error('answer_release_report_mismatch');
  }
  requirePassingReport(expectedReport);
  validateResultFixture(resultFile.content);

  const allowedTemplateIds = parseTemplateAllowlist(env.F1QL_ANSWER_DEPLOYMENT_TEMPLATE_IDS);
  const allowedPrincipalClasses = parsePrincipalAllowlist(env.F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES);
  const observedTemplates = new Set(artifact.observations.flatMap(observation => observation.template_id ? [observation.template_id] : []));
  requireEvidenceBackedTemplates(allowedTemplateIds, observedTemplates);

  const requestedCommitSha = env.F1QL_ANSWER_RELEASE_COMMIT_SHA;
  const currentCommitSha = env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA;
  if (!requestedCommitSha || !currentCommitSha || requestedCommitSha !== currentCommitSha) {
    throw new Error('answer_release_commit_mismatch');
  }
  const commitSha = requestedCommitSha;
  const audience = env.F1QL_ANSWER_AUTHORIZATION_AUDIENCE;
  const deploymentId = env.F1QL_ANSWER_DEPLOYMENT_ID;
  const releaseId = env.F1QL_ANSWER_RELEASE_ID;
  const keyId = env.F1QL_ANSWER_RELEASE_KEY_ID;
  if (!commitSha || !COMMIT_SHA.test(commitSha) || !audience || !IDENTIFIER.test(audience) ||
      !deploymentId || !IDENTIFIER.test(deploymentId) || !releaseId || !IDENTIFIER.test(releaseId) || !keyId || !IDENTIFIER.test(keyId)) {
    throw new Error('answer_release_context_invalid');
  }
  const productionEvidenceKey = loadProductionEvidenceKey(env);
  const principalAudit = verifyAnswerPrincipalAuditReport(parseJson(principalFile.content), productionEvidenceKey, {
    commit_sha: commitSha,
    deployment_id: deploymentId,
    release_id: releaseId
  });
  requirePassingPrincipalAudit(principalAudit);
  requireFreshEvidence(principalAudit.audited_at, requiredAgeLimit(env, 'F1QL_ANSWER_PRINCIPAL_AUDIT_MAX_AGE_MS'), nowMs, 'answer_release_principal_audit_stale');
  const identityMigration = readBoundedRegularFile(IDENTITY_VIEW_MIGRATION);
  const roleGrantMigration = readBoundedRegularFile(ROLE_GRANT_MIGRATION);
  verifyAnswerProductionEvidence(parseJson(productionFile.content), productionEvidenceKey, {
    commit_sha: commitSha,
    deployment_id: deploymentId,
    release_id: releaseId,
    principal_audit_sha256: principalFile.sha256,
    current_user_sha256: principalAudit.current_user_sha256,
    current_database_sha256: principalAudit.current_database_sha256,
    identity_view_migration_sha256: identityMigration.sha256,
    role_grant_migration_sha256: roleGrantMigration.sha256
  });

  const statuses: AnswerReleaseStatuses = { semantic: 'pass', safety: 'pass', linker: 'pass' };
  const activeContext: ActiveAnswerReleaseContext = {
    release_id: releaseId,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + answerReleaseTemporalPolicy(env, nowMs).max_validity_ms).toISOString(),
    commit_sha: commitSha,
    audience,
    deployment_id: deploymentId,
    canary_policy_version: ANSWER_CANARY_POLICY_VERSION,
    maximum_canary_stage: parseCanaryMaximumStage(env.F1QL_ANSWER_CANARY_MAXIMUM_STAGE),
    canary_hmac_key_sha256: getAnswerCanaryHmacKeySha256(env.F1QL_ANSWER_CANARY_HMAC_KEY_BASE64),
    evidence_hashes: {
      manifest_sha256: getAnswerDerivationManifestHash(answerEvaluationManifest),
      artifact_sha256: artifactFile.sha256,
      report_sha256: reportFile.sha256,
      result_fixture_sha256: resultFile.sha256,
      principal_audit_sha256: principalFile.sha256,
      production_evidence_sha256: productionFile.sha256
    },
    statuses,
    runtime: answerRuntimeCeilingsFromConfig(getAnswerRuntimeConfig(env)),
    deployment_template_ids: allowedTemplateIds,
    deployment_principal_classes: allowedPrincipalClasses
  };
  const privateKey = loadSigningKey(env.F1QL_ANSWER_RELEASE_PRIVATE_KEY_BASE64);
  const unsigned = {
    version: ANSWER_RELEASE_ATTESTATION_VERSION,
    kind: 'f1ql_answer_release_attestation' as const,
    key_id: keyId,
    ...buildActiveAnswerReleaseBindings(activeContext)
  };
  const attestation: AnswerReleaseAttestation = {
    ...unsigned,
    signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), privateKey).toString('base64')
  };
  const verified = verifyAnswerReleaseAttestation(
    attestation,
    { key_id: keyId, public_key: createPublicKey(privateKey) },
    activeContext,
    answerReleaseTemporalPolicy(env, nowMs)
  );
  const bytes = Buffer.from(`${JSON.stringify(attestation)}\n`, 'utf8');
  if (bytes.byteLength > MAXIMUM_ATTESTATION_BYTES) {
    throw new Error('answer_release_attestation_too_large');
  }
  writeExclusive(paths.output, bytes);
  return { output: paths.output, status: 'pass', sha256: getAnswerReleaseAttestationHash(verified) };
}

export function requireEvidenceBackedTemplates(allowedTemplateIds: readonly AnswerTemplateId[], observedTemplates: ReadonlySet<string>): void {
  if (allowedTemplateIds.some(templateId => !observedTemplates.has(templateId))) {
    throw new Error('answer_release_template_not_deployed');
  }
}

function requireBuildGuard(env: NodeJS.ProcessEnv): void {
  if (env.F1QL_ANSWER_RELEASE_BUILD_ENABLED !== 'true' || env.F1QL_ANSWER_RELEASE_BUILD_TARGET !== 'release') {
    throw new Error('answer_release_build_not_enabled');
  }
}

function readBoundedRegularFile(path: string): { content: Buffer; sha256: string } {
  requireSafePath(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAXIMUM_INPUT_BYTES) {
      throw new Error('answer_release_input_invalid');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
      if (count === 0) throw new Error('answer_release_input_incomplete');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, content.byteLength) !== 0) {
      throw new Error('answer_release_input_grew');
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('answer_release_input_changed');
    }
    return { content, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    closeSync(descriptor);
  }
}

function parseJson(content: Buffer): unknown {
  return JSON.parse(content.toString('utf8')) as unknown;
}

function requirePassingReport(report: ReturnType<typeof buildAnswerDerivationReport>): void {
  const gates = report.release_gates;
  const booleanGates = Object.entries(gates).filter(([key]) => key !== 'status');
  if (gates.status !== 'pass' || booleanGates.some(([, value]) => value !== true)) {
    throw new Error('answer_release_report_failed');
  }
}

function validateResultFixture(content: Buffer): void {
  const committed = readBoundedRegularFile(COMMITTED_RESULT_FIXTURE).content;
  if (!content.equals(committed) || stableSerialize(parseJson(content)) !== stableSerialize(parseJson(committed))) {
    throw new Error('answer_release_result_fixture_mismatch');
  }
}

function requirePassingPrincipalAudit(audit: AnswerPrincipalAuditReport): void {
  if (audit.status !== 'passed' || audit.findings.length !== 0) {
    throw new Error('answer_release_principal_audit_invalid');
  }
}

function requiredAgeLimit(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('answer_release_evidence_max_age_invalid');
  }
  return value;
}

function requireFreshEvidence(timestamp: string, maximumAgeMs: number, nowMs: number, error: string): void {
  const observed = Date.parse(timestamp);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observed) || observed > nowMs || nowMs - observed > maximumAgeMs) {
    throw new Error(error);
  }
}

export interface AnswerProductionEvidenceBindings {
  commit_sha: string;
  deployment_id: string;
  release_id: string;
  principal_audit_sha256: string;
  current_user_sha256: string;
  current_database_sha256: string;
  identity_view_migration_sha256: string;
  role_grant_migration_sha256: string;
}

export interface AnswerProductionEvidence extends AnswerProductionEvidenceBindings {
  version: 2;
  kind: 'f1ql_answer_production_evidence';
  target: 'production';
  status: 'passed';
  production_evidence: {
    key_id: string;
    algorithm: 'Ed25519';
    signature: string;
  };
}

export function parseAnswerProductionEvidence(input: unknown): AnswerProductionEvidence {
  const evidence = strictRecord(input, [
    'version', 'kind', 'target', 'status', 'commit_sha', 'deployment_id', 'release_id', 'principal_audit_sha256',
    'current_user_sha256', 'current_database_sha256',
    'identity_view_migration_sha256', 'role_grant_migration_sha256', 'production_evidence'
  ]);
  const signature = strictRecord(evidence.production_evidence, ['key_id', 'algorithm', 'signature']);
  if (evidence.version !== 2 || evidence.kind !== 'f1ql_answer_production_evidence' || evidence.target !== 'production' || evidence.status !== 'passed' ||
      !COMMIT_SHA.test(String(evidence.commit_sha)) || !IDENTIFIER.test(String(evidence.deployment_id)) ||
      !IDENTIFIER.test(String(evidence.release_id)) ||
      !SHA256.test(String(evidence.principal_audit_sha256)) || !SHA256.test(String(evidence.current_user_sha256)) ||
      !SHA256.test(String(evidence.current_database_sha256)) || !SHA256.test(String(evidence.identity_view_migration_sha256)) ||
      !SHA256.test(String(evidence.role_grant_migration_sha256)) || !IDENTIFIER.test(String(signature.key_id)) ||
      signature.algorithm !== 'Ed25519' || typeof signature.signature !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature) || !isCanonicalBase64Length(signature.signature, 64)) {
    throw new Error('answer_release_production_evidence_invalid');
  }
  return evidence as unknown as AnswerProductionEvidence;
}

export function getAnswerProductionEvidenceSigningPayload(input: unknown): Buffer {
  const evidence = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const rawSignature = evidence.production_evidence;
  const signature = strictRecord(rawSignature, rawSignature && typeof rawSignature === 'object' && 'signature' in rawSignature ? ['key_id', 'algorithm', 'signature'] : ['key_id', 'algorithm']);
  const unsigned = { ...evidence, production_evidence: { key_id: signature.key_id, algorithm: signature.algorithm } };
  parseAnswerProductionEvidence({ ...unsigned, production_evidence: { ...unsigned.production_evidence, signature: 'A'.repeat(86) + '==' } });
  return Buffer.from(stableSerialize(unsigned), 'utf8');
}

export function verifyAnswerProductionEvidence(input: unknown, trustedKey: TrustedProductionEvidenceKey, expected: AnswerProductionEvidenceBindings): AnswerProductionEvidence {
  const evidence = parseAnswerProductionEvidence(input);
  if (evidence.production_evidence.key_id !== trustedKey.key_id || Object.entries(expected).some(([key, value]) => evidence[key as keyof AnswerProductionEvidenceBindings] !== value)) {
    throw new Error('answer_release_production_evidence_invalid');
  }
  let publicKey: KeyObject;
  try {
    publicKey = trustedKey.public_key instanceof KeyObject ? trustedKey.public_key : createPublicKey(trustedKey.public_key);
  } catch {
    throw new Error('answer_release_production_evidence_invalid');
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' ||
      !verify(null, getAnswerProductionEvidenceSigningPayload(evidence), publicKey, decodeCanonicalBase64(evidence.production_evidence.signature))) {
    throw new Error('answer_release_production_evidence_invalid');
  }
  return evidence;
}

function parseTemplateAllowlist(raw: string | undefined): AnswerTemplateId[] {
  if (!raw) throw new Error('answer_release_template_allowlist_invalid');
  const values = raw.split(',').map(value => value.trim());
  const known = new Set<string>(ANSWER_TEMPLATE_IDS);
  if (values.length === 0 || new Set(values).size !== values.length || values.some(value => !known.has(value)) ||
      values.some((value, index) => index > 0 && values[index - 1] >= value)) {
    throw new Error('answer_release_template_allowlist_invalid');
  }
  return values as AnswerTemplateId[];
}

function parsePrincipalAllowlist(raw: string | undefined): AnswerPrincipalClass[] {
  if (!raw) throw new Error('answer_release_principal_allowlist_invalid');
  const values = raw.split(',').map(value => value.trim());
  const known = new Set<string>(ANSWER_PRINCIPAL_CLASSES);
  if (values.length === 0 || new Set(values).size !== values.length || values.some(value => !known.has(value)) ||
      values.some((value, index) => index > 0 && values[index - 1] >= value)) {
    throw new Error('answer_release_principal_allowlist_invalid');
  }
  return values as AnswerPrincipalClass[];
}

function parseCanaryMaximumStage(raw: string | undefined): number {
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error('answer_release_canary_maximum_invalid');
  const stage = Number(raw);
  if (![0, 1, 5, 25, 50, 100].includes(stage)) throw new Error('answer_release_canary_maximum_invalid');
  return stage;
}

function loadSigningKey(raw: string | undefined): KeyObject {
  if (!raw || raw.length > 10_000 || !BASE64.test(raw)) throw new Error('answer_release_signing_key_invalid');
  let der: Buffer;
  try {
    der = decodeCanonicalBase64(raw);
  } catch {
    throw new Error('answer_release_signing_key_invalid');
  }
  if (der.byteLength < 32 || der.byteLength > 4_096) {
    throw new Error('answer_release_signing_key_invalid');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('answer_release_signing_key_invalid');
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('answer_release_signing_key_invalid');
  }
  return key;
}

function writeExclusive(path: string, content: Buffer): void {
  requireSafePath(path);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < content.byteLength) offset += writeSync(descriptor, content, offset, content.byteLength - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requireSafePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096 || path.includes('\0')) {
    throw new Error('answer_release_path_invalid');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(input) || !sameStrings(Object.keys(input).sort(), [...keys].sort())) {
    throw new Error('answer_release_evidence_invalid');
  }
  return input;
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length > 10_000) throw new Error('answer_release_environment_invalid');
  return value;
}

function loadProductionEvidenceKey(env: NodeJS.ProcessEnv): TrustedProductionEvidenceKey {
  const keyId = requiredEnvironment(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID');
  if (!IDENTIFIER.test(keyId)) throw new Error('answer_release_environment_invalid');
  try {
    const raw = requiredEnvironment(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64');
    const der = decodeCanonicalBase64(raw);
    if (der.byteLength < 32 || der.byteLength > 4_096) throw new Error('invalid');
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
    return { key_id: keyId, public_key: publicKey };
  } catch {
    throw new Error('answer_release_environment_invalid');
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('invalid');
  return decoded;
}

function isCanonicalBase64Length(value: string, length: number): boolean {
  try {
    return decodeCanonicalBase64(value).byteLength === length;
  } catch {
    return false;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 6) throw new Error('answer_release_build_arguments_invalid');
  const result = buildAnswerReleaseAttestationFile({
    artifact: args[0], report: args[1], result_fixture: args[2], principal_audit: args[3],
    production_evidence: args[4], output: args[5]
  });
  process.stdout.write(`${JSON.stringify({ output: result.output, sha256: result.sha256, status: result.status })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  }
}
