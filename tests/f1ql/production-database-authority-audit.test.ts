import { describe, expect, it } from 'vitest';
import { requireDatabaseAuthorityAuditConfiguration, runDatabaseAuthorityAudit } from '../../scripts/audit-production-database-authority';

describe('production database authority audit', () => {
  it('requires explicit production configuration and rejects loopback', () => {
    expect(() => requireDatabaseAuthorityAuditConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('DATABASE_AUTHORITY_AUDIT_ENABLED');
    expect(() => requireDatabaseAuthorityAuditConfiguration({ DATABASE_AUTHORITY_AUDIT_ENABLED: 'true', DATABASE_AUTHORITY_AUDIT_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('uses bounded read-only observation and ledgers missing relations', async () => {
    const calls: string[] = [];
    const pool = {
      async connect() {
        return { async query(sql: string) {
          calls.push(sql);
          if (sql.includes('to_regclass')) return { rows: [] };
          return { rows: [] };
        }, release() {} };
      },
      async end() {}
    };
    const report = await runDatabaseAuthorityAudit(pool);
    expect(report.status).toBe('attention');
    expect(report.domains.filter(domain => domain.status === 'missing_relation')).toHaveLength(6);
    expect(report.factual_checks.filter(check => check.outcome === 'skipped_missing_relation')).toHaveLength(29);
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls[1]).toContain('statement_timeout');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.every(sql => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql))).toBe(true);
  });
});
