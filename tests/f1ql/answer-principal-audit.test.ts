import { describe, expect, it } from 'vitest';
import { requireAnswerPrincipalAuditConfiguration, runAnswerPrincipalAudit } from '../../scripts/audit-answer-principal';

describe('answer principal least-privilege audit', () => {
  it('requires dual production confirmation and a dedicated non-loopback credential', () => {
    expect(() => requireAnswerPrincipalAuditConfiguration({ F1QL_ANSWER_DATABASE_URL: 'postgres://db.example/f1' })).toThrow('AUDIT_ENABLED');
    expect(() => requireAnswerPrincipalAuditConfiguration({ F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED: 'true', F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET: 'production', F1QL_ANSWER_DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('detects an overprivileged principal using read-only catalog observations', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM pg_roles')) return { rows: [{ role_name: 'postgres', transaction_read_only: 'on', rolsuper: true, rolcreaterole: true, rolcreatedb: true, rolreplication: true, rolbypassrls: true, database_create: true, database_temp: true, f1ql_usage: true, f1ql_create: true, public_create: true }] };
      if (sql.includes('FROM pg_class')) return { rows: [] };
      return { rows: [] };
    }, release() {} }; }, async end() {} };
    const report = await runAnswerPrincipalAudit(pool);
    expect(report.status).toBe('attention');
    expect(report.findings).toContain('dangerous_role_attribute');
    expect(report.findings).toContain('unsafe_database_privilege');
    expect(report.findings).toContain('missing_relation:f1ql.answer_driver_identity');
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls[1]).toContain('statement_timeout');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.every(sql => !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql))).toBe(true);
  });

  it('passes only a read-only principal with the exact answer relation set', async () => {
    const required = ['f1ql.driver_standings', 'f1ql.event_classification', 'f1ql.qualifying_classification', 'f1ql.event_metadata', 'f1ql.answer_driver_identity', 'f1ql.answer_event_identity', 'f1ql.answer_season_participation'];
    const relation = (name: string, can_select: boolean) => ({ relation: name, exists: true, can_select, can_insert: false, can_update: false, can_delete: false, can_truncate: false, can_references: false, can_trigger: false });
    const pool = { async connect() { return { async query(sql: string) {
      if (sql.includes('FROM pg_roles')) return { rows: [{ role_name: 'f1ql_answer', transaction_read_only: 'on', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, database_create: false, database_temp: false, f1ql_usage: true, f1ql_create: false, public_create: false }] };
      if (sql.includes('FROM pg_class')) return { rows: required.map(name => relation(name, true)) };
      return { rows: [] };
    }, release() {} }; }, async end() {} };
    await expect(runAnswerPrincipalAudit(pool)).resolves.toMatchObject({ status: 'passed', findings: [] });
  });

  it('rejects effective SELECT on every relation outside the exact allowlist', async () => {
    const pool = { async connect() { return { async query(sql: string) {
      if (sql.includes('FROM pg_roles')) return { rows: [{ role_name: 'f1ql_answer', transaction_read_only: 'on', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, database_create: false, database_temp: false, f1ql_usage: true, f1ql_create: false, public_create: false }] };
      if (sql.includes('FROM pg_class')) return { rows: [{ relation: 'public.unrelated_table', exists: true, can_select: true, can_insert: false, can_update: false, can_delete: false, can_truncate: false, can_references: false, can_trigger: false }] };
      return { rows: [] };
    }, release() {} }; }, async end() {} };
    const report = await runAnswerPrincipalAudit(pool);
    expect(report.findings).toContain('unexpected_select:public.unrelated_table');
  });
});
