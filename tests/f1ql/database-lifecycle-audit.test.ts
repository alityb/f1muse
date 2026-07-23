import { describe, expect, it } from 'vitest';
import { requireDatabaseLifecycleAuditConfiguration, runDatabaseLifecycleAudit } from '../../scripts/audit-database-lifecycle';

describe('database lifecycle audit', () => {
  it('requires explicit production configuration and rejects loopback', () => {
    expect(() => requireDatabaseLifecycleAuditConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('DATABASE_LIFECYCLE_AUDIT_ENABLED');
    expect(() => requireDatabaseLifecycleAuditConfiguration({ DATABASE_LIFECYCLE_AUDIT_ENABLED: 'true', DATABASE_LIFECYCLE_AUDIT_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('uses only read-only catalog observations and reports unavailable lifecycle state', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string) { calls.push(sql); return { rows: [] }; }, release() {} }; }, async end() {} };
    const report = await runDatabaseLifecycleAudit(pool, ['20260721_pace_correctness_v2.sql']);
    expect(report.status).toBe('attention');
    expect(report.migration_ledger.status).toBe('unavailable');
    expect(report.schema_reconciliation).toHaveLength(8);
    expect(report.active_serving_view.exists).toBe(false);
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls[1]).toContain('statement_timeout');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.some(sql => sql.includes('ORDER BY pg_total_relation_size(c.oid) DESC, relation'))).toBe(true);
    expect(calls.every(sql => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b/i.test(sql))).toBe(true);
  });
});
