import { createHash, createPrivateKey, createPublicKey, KeyObject, sign } from 'node:crypto';
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
  parseAnswerPrincipalAuditReport,
  verifyAnswerPrincipalAuditReport
} from './audit-answer-principal';
import {
  AnswerProductionEvidence,
  getAnswerProductionEvidenceSigningPayload,
  verifyAnswerProductionEvidence
} from './build-answer-release-attestation';

const MAXIMUM_INPUT_BYTES = 100_000;
const MAXIMUM_OUTPUT_BYTES = 100_000;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IDENTITY_VIEW_MIGRATION = join(__dirname, '../migrations/20260729_f1ql_answer_identity_views.sql');
const ROLE_GRANT_MIGRATION = join(__dirname, '../migrations/20260730_f1ql_answer_role_grants.sql');

export interface AnswerProductionEvidenceBuildPaths {
  principal_audit: string;
  output: string;
}

export interface AnswerProductionEvidenceBuildResult {
  readonly output: string;
  readonly status: 'pass';
  readonly sha256: string;
}

export function buildAnswerProductionEvidenceFile(
  paths: AnswerProductionEvidenceBuildPaths,
  env: NodeJS.ProcessEnv = process.env
): AnswerProductionEvidenceBuildResult {
  if (env.F1QL_ANSWER_PRODUCTION_EVIDENCE_BUILD_ENABLED !== 'true' ||
      env.F1QL_ANSWER_PRODUCTION_EVIDENCE_BUILD_TARGET !== 'production') {
    throw new Error('answer_production_evidence_build_not_enabled');
  }
  const commitSha = required(env, 'RAILWAY_GIT_COMMIT_SHA');
  const deploymentId = required(env, 'F1QL_ANSWER_DEPLOYMENT_ID');
  const releaseId = required(env, 'F1QL_ANSWER_RELEASE_ID');
  const keyId = required(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID');
  if (!COMMIT_SHA.test(commitSha) || !IDENTIFIER.test(deploymentId) ||
      !IDENTIFIER.test(releaseId) || !IDENTIFIER.test(keyId)) {
    throw new Error('answer_production_evidence_context_invalid');
  }

  const privateKey = loadPrivateKey(required(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64'));
  const publicKey = createPublicKey(privateKey);
  const principalFile = readBoundedRegularFile(paths.principal_audit);
  const principal = verifyAnswerPrincipalAuditReport(
    parseAnswerPrincipalAuditReport(JSON.parse(principalFile.content.toString('utf8'))),
    { key_id: keyId, public_key: publicKey },
    { commit_sha: commitSha, deployment_id: deploymentId, release_id: releaseId }
  );
  if (principal.status !== 'passed' || principal.findings.length !== 0) {
    throw new Error('answer_production_evidence_principal_audit_failed');
  }

  const unsigned = {
    version: 2 as const,
    kind: 'f1ql_answer_production_evidence' as const,
    target: 'production' as const,
    status: 'passed' as const,
    commit_sha: commitSha,
    deployment_id: deploymentId,
    release_id: releaseId,
    principal_audit_sha256: principalFile.sha256,
    current_user_sha256: principal.current_user_sha256,
    current_database_sha256: principal.current_database_sha256,
    identity_view_migration_sha256: readBoundedRegularFile(IDENTITY_VIEW_MIGRATION).sha256,
    role_grant_migration_sha256: readBoundedRegularFile(ROLE_GRANT_MIGRATION).sha256,
    production_evidence: { key_id: keyId, algorithm: 'Ed25519' as const }
  };
  const evidence: AnswerProductionEvidence = {
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getAnswerProductionEvidenceSigningPayload(unsigned), privateKey).toString('base64')
    }
  };
  verifyAnswerProductionEvidence(evidence, { key_id: keyId, public_key: publicKey }, {
    commit_sha: commitSha,
    deployment_id: deploymentId,
    release_id: releaseId,
    principal_audit_sha256: principalFile.sha256,
    current_user_sha256: principal.current_user_sha256,
    current_database_sha256: principal.current_database_sha256,
    identity_view_migration_sha256: unsigned.identity_view_migration_sha256,
    role_grant_migration_sha256: unsigned.role_grant_migration_sha256
  });
  const bytes = Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8');
  if (bytes.byteLength > MAXIMUM_OUTPUT_BYTES) throw new Error('answer_production_evidence_output_too_large');
  writeExclusive(paths.output, bytes);
  return {
    output: paths.output,
    status: 'pass',
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function readBoundedRegularFile(path: string): { content: Buffer; sha256: string } {
  requireSafePath(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAXIMUM_INPUT_BYTES) {
      throw new Error('answer_production_evidence_input_invalid');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
      if (count === 0) throw new Error('answer_production_evidence_input_incomplete');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, content.byteLength) !== 0) {
      throw new Error('answer_production_evidence_input_grew');
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('answer_production_evidence_input_changed');
    }
    return { content, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    closeSync(descriptor);
  }
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

function loadPrivateKey(value: string): KeyObject {
  if (value.length > 10_000 || !BASE64.test(value)) throw new Error('answer_production_evidence_signing_key_invalid');
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || decoded.byteLength < 32 || decoded.byteLength > 4_096) throw new Error('invalid');
    const key = createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
    return key;
  } catch {
    throw new Error('answer_production_evidence_signing_key_invalid');
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length > 10_000) throw new Error('answer_production_evidence_context_missing');
  return value;
}

function requireSafePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096 || path.includes('\0')) {
    throw new Error('answer_production_evidence_path_invalid');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('answer_production_evidence_arguments_invalid');
  const result = buildAnswerProductionEvidenceFile({ principal_audit: args[0], output: args[1] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  }
}
