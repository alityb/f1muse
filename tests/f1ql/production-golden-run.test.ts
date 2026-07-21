import { describe, expect, it } from 'vitest';
import {
  requireProductionGoldenConfiguration,
  runProductionGolden
} from '../../scripts/run-f1ql-production-golden';
import { productionGoldenManifest } from '../../scripts/f1ql-production-golden-manifest';

function mockPool(rows: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let resultIndex = 0;
  return {
    calls,
    pool: {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            if (!sql.includes('set_config') && (sql.trim().startsWith('SELECT') || sql.trim().startsWith('WITH'))) {
              return { rows: rows[resultIndex++] ?? [] };
            }
            return { rows: [] };
          },
          release() {}
        };
      },
      async end() {}
    }
  };
}

describe('production F1QL golden run', () => {
  it('requires both explicit production flags and rejects localhost', () => {
    expect(() => requireProductionGoldenConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('F1QL_PRODUCTION_GOLDEN_ENABLED');
    expect(() => requireProductionGoldenConfiguration({
      F1QL_PRODUCTION_GOLDEN_ENABLED: 'true',
      F1QL_PRODUCTION_GOLDEN_TARGET: 'production',
      DATABASE_URL: 'postgres://localhost/f1'
    })).toThrow('refuses local');
    expect(requireProductionGoldenConfiguration({
      F1QL_PRODUCTION_GOLDEN_ENABLED: 'true',
      F1QL_PRODUCTION_GOLDEN_TARGET: 'production',
      DATABASE_URL: 'postgres://db.example/f1'
    })).toBe('postgres://db.example/f1');
  });

  it('uses one read-only transaction, a local timeout, and compares manifest facts', async () => {
    const { pool, calls } = mockPool(productionGoldenManifest.map(testCase => testCase.expected_facts));
    const result = await runProductionGolden(pool);

    expect(result.status).toBe('passed');
    expect(result.cases).toHaveLength(2);
    expect(calls[0]).toEqual({ sql: 'BEGIN READ ONLY', params: undefined });
    expect(calls[1]).toEqual({ sql: "SELECT set_config('statement_timeout', $1, true)", params: ['5000ms'] });
    expect(calls.at(-1)).toEqual({ sql: 'ROLLBACK', params: undefined });
    expect(calls.slice(2, -1).every(call => /^(SELECT|WITH)\b/i.test(call.sql.trim()))).toBe(true);
    expect(calls.slice(2, -1).every(call => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(call.sql))).toBe(true);
  });

  it('reports factual mismatches as JSON-safe failed results without writes', async () => {
    const { pool } = mockPool([[{ driver_id: 'max-verstappen', finishing_position: 2 }], productionGoldenManifest[1].expected_facts]);
    const result = await runProductionGolden(pool);
    expect(result.status).toBe('failed');
    expect(result.cases[0]).toMatchObject({ id: '2024-bahrain-race-winner', matched: false });
  });

  it('matches PostgreSQL numeric output against numeric authoritative facts', async () => {
    const expected = productionGoldenManifest.map(testCase => testCase.expected_facts);
    expected[0] = [{ ...expected[0][0], points: '26.00' }];
    const { pool } = mockPool(expected);
    const result = await runProductionGolden(pool);
    expect(result.status).toBe('passed');
  });
});
