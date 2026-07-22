import { describe, expect, it } from 'vitest';
import { PACE_V2_IDENTITY_REPAIR_METHOD, createPaceV2IdentityRepairManifest, fingerprintPaceV2FactRows } from '../../src/etl/pace-v2-identity-repair';
import { assessPaceV2AuditReadiness, requirePaceV2PreflightConfiguration, runPaceV2Preflight } from '../../scripts/preflight-pace-v2-production';

const fact = { season: 2025, round: 1, track_id: 'melbourne', driver_id: 'driver_one', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 91.234, is_valid_lap: true, is_pit_lap: false, is_out_lap: false, is_in_lap: false, clean_air_flag: true, compound: 'SOFT', tyre_age_laps: 1, methodology_version: 'clean_air_gap_2_0s_v1' };

function mockPool(options: { v2?: boolean; audit?: boolean; rows?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const facts = [fact];
  const fingerprint = fingerprintPaceV2FactRows(facts);
  return {
    calls,
    pool: {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            if (sql.includes('to_regclass')) {
              const relation = String(params?.[0]);
              if (relation === 'laps_normalized_v2') return { rows: [{ relation: options.v2 === false ? null : relation }] };
              if (relation === 'etl_runs_laps_normalized') return { rows: [{ relation: options.audit === false ? null : relation }] };
              return { rows: [{ relation }] };
            }
            if (sql.includes('FROM pg_trigger')) return { rows: [{ immutable: true }] };
            if (sql.includes('COUNT(*)::text AS row_count') && !sql.includes('GROUP BY')) return { rows: [{ row_count: String(options.rows ?? 4) }] };
            if (sql.includes('GROUP BY session_type, methodology_version')) return { rows: [{ session_type: 'R', methodology_version: 'clean_air_gap_2_0s_v1', row_count: String(options.rows ?? 4) }] };
            if (sql.includes('GROUP BY season, round')) return { rows: [{ season: 2025, round: 1, total_rows: options.rows ?? 4, eligible_laps: options.rows ?? 4 }] };
            if (sql.includes('GROUP BY season') && sql.includes('finished_at')) return { rows: [{ season: 2025, newest_finished_at: '2025-03-16 00:00:00+00', statuses: ['success'] }] };
            if (sql.includes('FROM pace_v2_round_audit')) return { rows: [{ season: 2025, round: 1, session_type: 'R', fact_fingerprint: fingerprint, fact_row_count: 1, methodology_version: 'clean_air_gap_2_0s_v1' }] };
            if (sql.includes('FROM pace_v2_identity_repair_audit')) return { rows: [] };
            if (sql.includes('FROM laps_normalized_v2 WHERE session_type')) return { rows: facts };
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

  it('accepts only an exact immutable identity-repair audit when a manifest audit is absent', () => {
    const repairedFact = { ...fact, season: 2026 };
    const sourceFingerprint = fingerprintPaceV2FactRows([{ ...repairedFact, track_id: 'australian_grand_prix' }]);
    const targetFingerprint = fingerprintPaceV2FactRows([repairedFact]);
    const manifest = createPaceV2IdentityRepairManifest({ season: 2026, round: 1, session_type: 'R', methodology_version: 'clean_air_gap_2_0s_v1', from_track_id: 'australian_grand_prix', to_track_id: 'melbourne', fact_row_count: 1, source_fact_fingerprint: sourceFingerprint, target_fact_fingerprint: targetFingerprint });
    const repair = { season: 2026, round: 1, session_type: 'R', repair_method: PACE_V2_IDENTITY_REPAIR_METHOD, manifest_fingerprint: manifest.manifest_fingerprint, source_fact_fingerprint: sourceFingerprint, target_fact_fingerprint: targetFingerprint, fact_row_count: 1, methodology_version: 'clean_air_gap_2_0s_v1' };
    expect(assessPaceV2AuditReadiness([repairedFact], [], [repair], true).rounds).toEqual([{ season: 2026, round: 1, status: 'identity_repair_bridge' }]);
    expect(assessPaceV2AuditReadiness([repairedFact], [], [{ ...repair, target_fact_fingerprint: 'c'.repeat(64) }], true).conditions).toContainEqual(expect.objectContaining({ code: 'invalid_identity_repair_audit' }));
    expect(assessPaceV2AuditReadiness([repairedFact], [{ season: 2026, round: 1, session_type: 'R', fact_fingerprint: 'c'.repeat(64), fact_row_count: 1, methodology_version: 'clean_air_gap_2_0s_v1' }], [repair], true).conditions).toContainEqual(expect.objectContaining({ code: 'invalid_manifest_audit' }));
    expect(assessPaceV2AuditReadiness([repairedFact], [], [repair], false).conditions).toContainEqual(expect.objectContaining({ code: 'invalid_identity_repair_audit' }));
  });
});
