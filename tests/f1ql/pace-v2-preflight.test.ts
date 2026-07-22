import { describe, expect, it } from 'vitest';
import { requirePaceV2PreflightConfiguration, runPaceV2Preflight } from '../../scripts/preflight-pace-v2-production';

function mockPool(options: { v2?: boolean; audit?: boolean; rows?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    pool: {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            if (sql.includes('to_regclass')) return { rows: [{ relation: params?.[0] === 'laps_normalized_v2' ? (options.v2 === false ? null : 'laps_normalized_v2') : (options.audit === false ? null : 'etl_runs_laps_normalized') }] };
            if (sql.includes('COUNT(*)::text AS row_count') && !sql.includes('GROUP BY')) return { rows: [{ row_count: String(options.rows ?? 4) }] };
            if (sql.includes('GROUP BY session_type, methodology_version')) return { rows: [{ session_type: 'R', methodology_version: 'clean_air_gap_2_0s_v1', row_count: String(options.rows ?? 4) }] };
            if (sql.includes('GROUP BY season, round')) return { rows: [{ season: 2025, round: 1, total_rows: options.rows ?? 4, eligible_laps: options.rows ?? 4 }] };
            if (sql.includes('GROUP BY season') && sql.includes('finished_at')) return { rows: [{ season: 2025, newest_finished_at: '2025-03-16 00:00:00+00', statuses: ['success'] }] };
            return { rows: [] };
          },
          release() {}
        };
      },
      async end() {}
    }
  };
}

describe('pace v2 production preflight', () => {
  it('requires dual production flags and refuses loopback targets', () => {
    expect(() => requirePaceV2PreflightConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('PACE_V2_PREFLIGHT_ENABLED');
    expect(() => requirePaceV2PreflightConfiguration({ PACE_V2_PREFLIGHT_ENABLED: 'true', PACE_V2_PREFLIGHT_TARGET: 'production', DATABASE_URL: 'postgres://[::1]/f1' })).toThrow('refuses local');
    expect(requirePaceV2PreflightConfiguration({ PACE_V2_PREFLIGHT_ENABLED: 'true', PACE_V2_PREFLIGHT_TARGET: 'production', DATABASE_URL: 'postgres://db.example/f1' })).toBe('postgres://db.example/f1');
  });

  it('uses one read-only transaction and reports coverage, eligibility, and audit freshness', async () => {
    const { pool, calls } = mockPool();
    const result = await runPaceV2Preflight(pool);
    expect(result).toMatchObject({ status: 'ready', v2_row_count: 4, season_round_coverage: [{ season: 2025, round_count: 1, rounds: [1] }], eligible_lap_counts: [{ season: 2025, round: 1, eligible_laps: 4 }], etl_audit: { available: true } });
    expect(calls[0]).toEqual({ sql: 'BEGIN READ ONLY', params: undefined });
    expect(calls[1]).toEqual({ sql: "SELECT set_config('statement_timeout', $1, true)", params: ['5000ms'] });
    expect(calls.at(-1)).toEqual({ sql: 'ROLLBACK', params: undefined });
    expect(calls.slice(2, -1).every((call) => /^(SELECT|WITH)\b/i.test(call.sql.trim()))).toBe(true);
    expect(calls.slice(2, -1).every((call) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY)\b/i.test(call.sql))).toBe(true);
  });

  it('reports missing v2 data and unavailable audit without attempting ingestion', async () => {
    const { pool, calls } = mockPool({ v2: false, audit: false });
    const result = await runPaceV2Preflight(pool);
    expect(result.status).toBe('missing');
    expect(result.conditions).toContainEqual(expect.objectContaining({ code: 'missing_v2_relation' }));
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toEqual({ sql: 'ROLLBACK', params: undefined });
  });
});
