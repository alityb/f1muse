import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_PRINCIPAL_ALLOWED_ROUTINES,
  ANSWER_PRINCIPAL_REQUIRED_RELATIONS,
  parseAnswerPrincipalAuditReport,
  requireAnswerPrincipalAuditConfiguration,
  runAnswerPrincipalAudit,
  verifyAnswerPrincipalAuditReport
} from '../../scripts/audit-answer-principal';

const keys = generateKeyPairSync('ed25519');
const auditContext = {
  target: 'production' as const,
  commit_sha: 'a'.repeat(40),
  deployment_id: 'deployment-1',
  release_id: 'release-1',
  key_id: 'production-evidence-1',
  private_key: keys.privateKey,
  audited_at: '2026-07-24T00:00:00.000Z'
};
const trustedKey = { key_id: auditContext.key_id, public_key: keys.publicKey };

const safeRole = (overrides: Record<string, unknown> = {}) => ({
  role_name: 'raw-production-role', database_name: 'raw-production-database', transaction_read_only: 'on',
  rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
  database_create: false, database_temp: false, f1ql_usage: true, f1ql_create: false, public_create: false,
  ...overrides
});
const relation = (name: string, can_select = true) => ({
  relation: name, exists: true, can_select, can_insert: false, can_update: false, can_delete: false,
  can_truncate: false, can_references: false, can_trigger: false
});
const safeMembership = (overrides: Record<string, unknown> = {}) => ({
  role_name: 'f1ql_answer', depth: 1, admin_option: false, can_set_role: true, rolcanlogin: false, rolinherit: false,
  rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
  ...overrides
});
const routineObservation = (effective = 0, observed = 12) => ({
  routine_observation_count: observed, effective_routine_execute_count: effective
});
const poolWith = (
  role: Record<string, unknown>,
  relations = ANSWER_PRINCIPAL_REQUIRED_RELATIONS.map(name => relation(name)),
  memberships = [safeMembership()],
  routines = routineObservation()
) => ({
  async connect() { return { async query(sql: string) {
    if (sql.includes('FROM pg_roles')) return { rows: [role] };
    if (sql.includes('FROM pg_class')) return { rows: relations };
    if (sql.includes('WITH RECURSIVE memberships')) return { rows: memberships };
    if (sql.includes('FROM pg_proc')) return { rows: [routines] };
    return { rows: [] };
  }, release() {} }; }, async end() {}
});

describe('answer principal least-privilege audit', () => {
  it('requires production, deployment, release, commit, credential, and signing context', () => {
    expect(() => requireAnswerPrincipalAuditConfiguration({ F1QL_ANSWER_DATABASE_URL: 'postgres://db.example/f1' })).toThrow('not_enabled');
    expect(() => requireAnswerPrincipalAuditConfiguration({
      F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED: 'true', F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET: 'production',
      F1QL_ANSWER_DATABASE_URL: 'postgres://localhost/f1'
    })).toThrow('refuses_local');
    expect(() => requireAnswerPrincipalAuditConfiguration({
      F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED: 'true', F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET: 'production',
      F1QL_ANSWER_DATABASE_URL: 'postgres://db.example/f1'
    })).toThrow('context_missing');
  });

  it.each([
    'localhost',
    'LOCALHOST.',
    'audit.localhost',
    '127.0.0.2',
    '127.1',
    '2130706433',
    '0x7f000001',
    '017700000001',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]'
  ])('refuses loopback production target %s', hostname => {
    expect(() => requireAnswerPrincipalAuditConfiguration({
      F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED: 'true',
      F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET: 'production',
      F1QL_ANSWER_DATABASE_URL: `postgres://${hostname}/f1`
    })).toThrow('refuses_local');
  });

  it('builds verified TLS without allowing URL SSL options to override the trusted CA', () => {
    const certificate = '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n';
    const configuration = requireAnswerPrincipalAuditConfiguration({
      F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED: 'true', F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET: 'production',
      F1QL_ANSWER_DATABASE_URL: 'postgres://db.example/f1?sslmode=disable&sslrootcert=other',
      F1QL_ANSWER_DATABASE_CA_CERT_BASE64: Buffer.from(certificate).toString('base64'),
      RAILWAY_GIT_COMMIT_SHA: auditContext.commit_sha, F1QL_ANSWER_DEPLOYMENT_ID: auditContext.deployment_id,
      F1QL_ANSWER_RELEASE_ID: auditContext.release_id, F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID: auditContext.key_id,
      F1QL_ANSWER_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    });
    expect(configuration.pool_config.ssl).toEqual({ ca: certificate, rejectUnauthorized: true });
    expect(configuration.pool_config.connectionString).not.toMatch(/sslmode|sslrootcert/);
    expect(configuration.pool_config.connectionTimeoutMillis).toBe(5_000);
  });

  it('detects an overprivileged principal using read-only catalog observations', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM pg_roles')) return { rows: [safeRole({ rolsuper: true, rolcreaterole: true, database_create: true, database_temp: true, f1ql_create: true, public_create: true })] };
      if (sql.includes('FROM pg_class')) return { rows: [] };
      if (sql.includes('WITH RECURSIVE memberships')) return { rows: [] };
      if (sql.includes('FROM pg_proc')) return { rows: [routineObservation(2)] };
      return { rows: [] };
    }, release() {} }; }, async end() {} };
    const report = await runAnswerPrincipalAudit(pool, auditContext);
    expect(report.status).toBe('attention');
    expect(report.findings).toContain('dangerous_role_attribute');
    expect(report.findings).toContain('unsafe_database_privilege');
    expect(report.findings).toContain('missing_relation:f1ql.answer_driver_identity');
    expect(report.findings).toContain('unexpected_routine_execute:2');
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls[1]).toContain('statement_timeout');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.every(sql => !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql))).toBe(true);
    expect(calls.join('\n')).toContain('pg_auth_members');
    expect(calls.join('\n')).toContain("has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege");
    expect(calls.join('\n')).toContain("has_function_privilege(current_user, p.oid, 'EXECUTE')");
    expect(calls.join('\n')).toContain("has_schema_privilege(current_user, n.oid, 'USAGE')");
    expect(calls.join('\n')).toContain('FROM pg_proc p JOIN pg_namespace n');
    expect(calls.join('\n')).not.toMatch(/pg_has_role\s*\([^)]*['"]SET['"]/i);
    expect(ANSWER_PRINCIPAL_ALLOWED_ROUTINES).toEqual([]);
  });

  it('emits and verifies a signed sanitized v4 report bound to exact production context', async () => {
    const report = await runAnswerPrincipalAudit(poolWith(safeRole()), auditContext);
    expect(report).toMatchObject({
      version: 4, target: 'production', audited_at: auditContext.audited_at, commit_sha: auditContext.commit_sha,
      deployment_id: auditContext.deployment_id, release_id: auditContext.release_id, status: 'passed', findings: [],
      statement_timeout_ms: 5_000, required_relations: ANSWER_PRINCIPAL_REQUIRED_RELATIONS,
      routine_observation_count: 12, effective_routine_execute_count: 0,
      production_evidence: { key_id: auditContext.key_id, algorithm: 'Ed25519' }
    });
    expect(report.current_user_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.current_database_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain('raw-production-role');
    expect(JSON.stringify(report)).not.toContain('raw-production-database');
    expect(verifyAnswerPrincipalAuditReport(report, trustedKey, auditContext)).toEqual(report);
    const publicKeyBase64 = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(verifyAnswerPrincipalAuditReport(report, { ...trustedKey, public_key: publicKeyBase64 }, auditContext)).toEqual(report);
    expect(() => verifyAnswerPrincipalAuditReport(report, { ...trustedKey, public_key: `${publicKeyBase64}\n` }, auditContext)).toThrow('trusted_key_invalid');
    expect(() => verifyAnswerPrincipalAuditReport(report, trustedKey, { ...auditContext, commit_sha: 'b'.repeat(40) })).toThrow('context_mismatch');
    expect(() => verifyAnswerPrincipalAuditReport({ ...report, current_user_sha256: '0'.repeat(64) }, trustedKey, auditContext)).toThrow('signature_invalid');
    expect(() => parseAnswerPrincipalAuditReport({ ...report, raw_role: 'forbidden' })).toThrow('invalid');
    expect(() => parseAnswerPrincipalAuditReport({ ...report, target: 'local' })).toThrow('invalid');
    expect(() => parseAnswerPrincipalAuditReport({ ...report, production_evidence: { key_id: auditContext.key_id, algorithm: 'Ed25519' } })).toThrow('invalid');
    expect(() => parseAnswerPrincipalAuditReport({ ...report, production_evidence: { ...report.production_evidence, signature: `${report.production_evidence.signature}\n` } })).toThrow('invalid');
    expect(() => parseAnswerPrincipalAuditReport({ ...report, production_evidence: { ...report.production_evidence, signature: nonCanonicalAlias(report.production_evidence.signature) } })).toThrow('invalid');
  });

  it('rejects wrong principal/database fingerprints and wrong evidence keys', async () => {
    const report = await runAnswerPrincipalAudit(poolWith(safeRole()), auditContext);
    const wrongKeys = generateKeyPairSync('ed25519');
    expect(() => verifyAnswerPrincipalAuditReport(report, { ...trustedKey, public_key: wrongKeys.publicKey }, auditContext)).toThrow('signature_invalid');
    for (const field of ['current_user_sha256', 'current_database_sha256'] as const) {
      expect(() => verifyAnswerPrincipalAuditReport({ ...report, [field]: 'f'.repeat(64) }, trustedKey, auditContext)).toThrow('signature_invalid');
    }
  });

  it('rejects effective SELECT on every relation outside the exact allowlist', async () => {
    const report = await runAnswerPrincipalAudit(poolWith(safeRole(), [...ANSWER_PRINCIPAL_REQUIRED_RELATIONS.map(name => relation(name)), relation('public.unrelated_table')]), auditContext);
    expect(report.findings).toContain('unexpected_select:public.unrelated_table');
  });

  it('rejects write-like privileges on any observed relation', async () => {
    const unrelated = { ...relation('public.unrelated_table', false), can_trigger: true };
    const report = await runAnswerPrincipalAudit(poolWith(safeRole(), [...ANSWER_PRINCIPAL_REQUIRED_RELATIONS.map(name => relation(name)), unrelated]), auditContext);
    expect(report.findings).toContain('write_privilege:public.unrelated_table');
  });

  it('rejects every effective routine EXECUTE privilege without signing routine inventory', async () => {
    const report = await runAnswerPrincipalAudit(
      poolWith(safeRole(), undefined, undefined, routineObservation(3, 19)),
      auditContext
    );
    expect(report.status).toBe('attention');
    expect(report.routine_observation_count).toBe(19);
    expect(report.effective_routine_execute_count).toBe(3);
    expect(report.findings).toContain('unexpected_routine_execute:3');
    expect(JSON.stringify(report)).not.toMatch(/routine_[a-z]+\s*\(/i);
  });

  it('requires only the safe dedicated group and rejects recursive SET ROLE escalation', async () => {
    const extra = safeMembership({ role_name: 'database_owner', depth: 2, rolsuper: true });
    const escalated = await runAnswerPrincipalAudit(poolWith(safeRole(), undefined, [safeMembership(), extra]), auditContext);
    expect(escalated.findings).toContain('unsafe_role_membership');

    const unsafeGroup = await runAnswerPrincipalAudit(poolWith(safeRole(), undefined, [safeMembership({ rolcanlogin: true })]), auditContext);
    expect(unsafeGroup.findings).toContain('unsafe_answer_group_role');
  });

  it('retains the reviewed unapplied NOLOGIN exact-view grant migration', () => {
    const sql = readFileSync('migrations/20260730_f1ql_answer_role_grants.sql', 'utf8');
    expect(sql).toContain('CREATE ROLE f1ql_answer');
    expect(sql).toContain('NOLOGIN');
    expect(sql).toContain('NOBYPASSRLS');
    expect(sql).toContain('existing f1ql_answer role attributes do not match the reviewed contract');
    expect(sql).not.toContain('ALTER ROLE f1ql_answer');
    expect(sql).not.toMatch(/PASSWORD|LOGIN\s*;/);
    for (const relationName of ANSWER_PRINCIPAL_REQUIRED_RELATIONS) expect(sql).toContain(relationName);
    expect((sql.match(/GRANT SELECT ON/g) ?? [])).toHaveLength(1);
    expect(sql).not.toMatch(/REVOKE\s+TEMPORARY\s+ON\s+DATABASE\s+%I\s+FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA f1ql FROM f1ql_answer;/);
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA f1ql FROM f1ql_answer;/);
    expect(sql).not.toMatch(/ALL (?:FUNCTIONS|PROCEDURES) IN SCHEMA [^;]+ FROM PUBLIC/i);
    expect(sql).toContain('External DBA prerequisite');
  });
});

function nonCanonicalAlias(value: string): string {
  const index = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value.at(-3)!);
  return `${value.slice(0, -3)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[index + 1]}==`;
}
