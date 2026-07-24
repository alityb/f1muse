import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getAnswerPrincipalAuditSigningPayload,
  UnsignedAnswerPrincipalAuditReport
} from '../../scripts/audit-answer-principal';
import { buildAnswerProductionEvidenceFile } from '../../scripts/build-answer-production-evidence';
import { parseAnswerProductionEvidence } from '../../scripts/build-answer-release-attestation';

const COMMIT_SHA = 'e'.repeat(40);

describe('guarded answer production evidence builder', () => {
  it('writes mode-0600 evidence bound to the passing signed principal audit', () => {
    withFiles(({ paths, env }) => {
      const result = buildAnswerProductionEvidenceFile(paths, env);
      const evidence = parseAnswerProductionEvidence(JSON.parse(readFileSync(paths.output, 'utf8')));
      expect(result).toMatchObject({ output: paths.output, status: 'pass' });
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(statSync(paths.output).mode & 0o777).toBe(0o600);
      expect(evidence).toMatchObject({
        commit_sha: COMMIT_SHA,
        deployment_id: 'test-deployment',
        release_id: 'test-release',
        status: 'passed'
      });
    });
  });

  it('fails closed for disabled builds, tampered audits, and non-passing audits', () => {
    withFiles(({ paths, env }) => {
      expect(() => buildAnswerProductionEvidenceFile(paths, { ...env, F1QL_ANSWER_PRODUCTION_EVIDENCE_BUILD_ENABLED: 'false' }))
        .toThrow('answer_production_evidence_build_not_enabled');
      const audit = JSON.parse(readFileSync(paths.principal_audit, 'utf8'));
      writeFileSync(paths.principal_audit, `${JSON.stringify({ ...audit, current_user_sha256: '3'.repeat(64) })}\n`);
      expect(() => buildAnswerProductionEvidenceFile(paths, env)).toThrow('answer_principal_audit_signature_invalid');
    });
    withFiles(({ paths, env, privateKey }) => {
      writeFileSync(paths.principal_audit, `${JSON.stringify(signedAudit(privateKey, { status: 'attention', findings: ['unsafe_database_privilege'] }))}\n`);
      expect(() => buildAnswerProductionEvidenceFile(paths, env)).toThrow('answer_production_evidence_principal_audit_failed');
    });
  });

  it('refuses symlink inputs and existing outputs', () => {
    withFiles(({ directory, paths, env }) => {
      const linked = join(directory, 'linked.json');
      symlinkSync(paths.principal_audit, linked);
      expect(() => buildAnswerProductionEvidenceFile({ ...paths, principal_audit: linked }, env)).toThrow();
      writeFileSync(paths.output, 'occupied');
      expect(() => buildAnswerProductionEvidenceFile(paths, env)).toThrow();
    });
  });
});

function withFiles(
  run: (fixture: { directory: string; paths: { principal_audit: string; output: string }; env: NodeJS.ProcessEnv; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] }) => void
): void {
  const directory = mkdtempSync(join(tmpdir(), 'answer-production-evidence-'));
  try {
    const paths = { principal_audit: join(directory, 'principal.json'), output: join(directory, 'production.json') };
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(paths.principal_audit, `${JSON.stringify(signedAudit(keys.privateKey))}\n`);
    run({
      directory,
      paths,
      privateKey: keys.privateKey,
      env: {
        F1QL_ANSWER_PRODUCTION_EVIDENCE_BUILD_ENABLED: 'true',
        F1QL_ANSWER_PRODUCTION_EVIDENCE_BUILD_TARGET: 'production',
        F1QL_ANSWER_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID: 'production-evidence-key-1',
        F1QL_ANSWER_DEPLOYMENT_ID: 'test-deployment',
        F1QL_ANSWER_RELEASE_ID: 'test-release',
        RAILWAY_GIT_COMMIT_SHA: COMMIT_SHA
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function signedAudit(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  overrides: Partial<UnsignedAnswerPrincipalAuditReport> = {}
) {
  const unsigned: UnsignedAnswerPrincipalAuditReport = {
    version: 4,
    kind: 'f1ql_answer_principal_audit',
    target: 'production',
    audited_at: '2026-07-24T00:00:00.000Z',
    commit_sha: COMMIT_SHA,
    deployment_id: 'test-deployment',
    release_id: 'test-release',
    current_user_sha256: '1'.repeat(64),
    current_database_sha256: '2'.repeat(64),
    assertion_scope: 'answer_principal_least_privilege',
    statement_timeout_ms: 5_000,
    required_relations: [
      'f1ql.driver_standings',
      'f1ql.event_classification',
      'f1ql.qualifying_classification',
      'f1ql.event_metadata',
      'f1ql.answer_driver_identity',
      'f1ql.answer_event_identity',
      'f1ql.answer_season_participation'
    ],
    routine_observation_count: 12,
    effective_routine_execute_count: 0,
    status: 'passed',
    findings: [],
    production_evidence: { key_id: 'production-evidence-key-1', algorithm: 'Ed25519' },
    ...overrides
  };
  return {
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getAnswerPrincipalAuditSigningPayload(unsigned), privateKey).toString('base64')
    }
  };
}
