import { describe, expect, it } from 'vitest';
import {
  requireProductionGoldenConfiguration,
  runProductionGolden
} from '../../scripts/run-f1ql-production-golden';
import { productionCorpusAudit, productionCorpusManifest } from '../../scripts/f1ql-production-corpus-manifest';

function mockPool(rows: Array<Array<Record<string, unknown>>>, missingRelations = new Set<string>()) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let resultIndex = 0;
  return {
    calls,
    pool: {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            if (sql.includes('to_regclass')) {
              return { rows: [{ relation: missingRelations.has(String(params?.[0])) ? null : params?.[0] }] };
            }
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
    const rows = productionCorpusManifest.map((testCase) => testCase.expected_facts ?? [{ driver_id: 'max-verstappen', points: '25' }]);
    const { pool, calls } = mockPool(rows);
    const result = await runProductionGolden(pool);

    expect(result.status).toBe('passed');
    expect(result.cases).toHaveLength(5);
    expect(result.corpus_audit).toHaveLength(100);
    expect(calls[0]).toEqual({ sql: 'BEGIN READ ONLY', params: undefined });
    expect(calls[1]).toEqual({ sql: "SELECT set_config('statement_timeout', $1, true)", params: ['5000ms'] });
    expect(calls.at(-1)).toEqual({ sql: 'ROLLBACK', params: undefined });
    expect(calls.slice(2, -1).every(call => /^(SELECT|WITH)\b/i.test(call.sql.trim()))).toBe(true);
    expect(calls.slice(2, -1).every(call => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(call.sql))).toBe(true);
  });

  it('reports factual mismatches as JSON-safe failed results without writes', async () => {
    const rows = productionCorpusManifest.map((testCase) => testCase.expected_facts ?? [{ driver_id: 'max-verstappen', points: '25' }]);
    rows[3] = [{ driver_id: 'max-verstappen', finishing_position: 2 }];
    const { pool } = mockPool(rows);
    const result = await runProductionGolden(pool);
    expect(result.status).toBe('failed');
    expect(result.cases[3]).toMatchObject({ id: '2024-bahrain-race-winner', matched: false });
  });

  it('matches PostgreSQL numeric output against numeric authoritative facts', async () => {
    const rows = productionCorpusManifest.map((testCase) => testCase.expected_facts ?? [{ driver_id: 'max-verstappen', points: '25' }]);
    rows[3] = [{ ...rows[3][0], points: '26.00' }];
    const { pool } = mockPool(rows);
    const result = await runProductionGolden(pool);
    expect(result.status).toBe('passed');
  });

  it('explicitly skips cases whose required production view is unavailable', async () => {
    const rows = [
      [{ driver_id: 'max-verstappen', points: '25' }],
      [{ driver_id: 'max-verstappen', qualifying_position: 1 }],
      productionCorpusManifest[4].expected_facts ?? []
    ];
    const { pool, calls } = mockPool(rows, new Set(['f1ql.event_classification']));
    const result = await runProductionGolden(pool);

    expect(result.status).toBe('passed');
    expect(result.cases.filter(testCase => testCase.skip_reason === 'missing_production_view')).toEqual([
      expect.objectContaining({ id: '2025-race-classification-structural', outcome: 'skipped' }),
      expect.objectContaining({ id: '2024-bahrain-race-winner', outcome: 'skipped' })
    ]);
    expect(calls.filter(call => call.sql.includes('f1ql.event_classification') && !call.sql.includes('to_regclass'))).toHaveLength(0);
  });

  it('audits all 100 fixture cases and separates source-dependent pace coverage', () => {
    expect(productionCorpusAudit.filter(testCase => testCase.disposition === 'fixture_only')).toHaveLength(41);
    expect(productionCorpusAudit.filter(testCase => testCase.disposition === 'production_runnable_structural')).toHaveLength(59);
    expect(productionCorpusAudit.filter(testCase => testCase.runner_action === 'skipped_fixture_only')).toHaveLength(41);
    expect(productionCorpusAudit.some(testCase => testCase.reason.includes('Lap pace'))).toBe(true);
  });
});
