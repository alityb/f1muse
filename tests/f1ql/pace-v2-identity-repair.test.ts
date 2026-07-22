import { describe, expect, it } from 'vitest';
import { createPaceV2IdentityRepairManifest, fingerprintPaceV2FactRows, PaceV2FactRow, parsePaceV2IdentityRepairManifest } from '../../src/etl/pace-v2-identity-repair';
import { requirePaceV2IdentityRepairConfiguration, runPaceV2IdentityRepair } from '../../scripts/repair-pace-v2-identity';

const source: PaceV2FactRow[] = [{ season: 2026, round: 1, track_id: 'australian_grand_prix', driver_id: 'driver_one', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 91.234, is_valid_lap: true, is_pit_lap: false, is_out_lap: false, is_in_lap: false, clean_air_flag: true, compound: 'SOFT', tyre_age_laps: 1, methodology_version: 'clean_air_gap_2_0s_v1' }];
const target = source.map((row) => ({ ...row, track_id: 'melbourne' }));
const manifest = createPaceV2IdentityRepairManifest({ season: 2026, round: 1, session_type: 'R', methodology_version: 'clean_air_gap_2_0s_v1', from_track_id: 'australian_grand_prix', to_track_id: 'melbourne', fact_row_count: 1, source_fact_fingerprint: fingerprintPaceV2FactRows(source), target_fact_fingerprint: fingerprintPaceV2FactRows(target) });

function mockPool(rows = source) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let current = rows;
  return { calls, pool: { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); if (sql.includes('to_regclass')) return { rows: [{ relation: 'pace_v2_identity_repair_audit' }] }; if (sql.includes('SELECT 1 FROM pace_v2_identity_repair_audit')) return { rows: [] }; if (sql.startsWith('SELECT season, round, track_id')) return { rows: current }; if (sql.startsWith('UPDATE laps_normalized_v2')) { current = current.map((row) => ({ ...row, track_id: String(params?.[0]) })); return { rows: [], rowCount: current.length }; } return { rows: [] }; }, release() {} }; }, async end() {} } };
}

describe('pace v2 identity repair', () => {
  it('requires the explicit primary-only repair flags', () => {
    expect(() => requirePaceV2IdentityRepairConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('PACE_V2_IDENTITY_REPAIR_ENABLED');
    expect(() => requirePaceV2IdentityRepairConfiguration({ PACE_V2_IDENTITY_REPAIR_ENABLED: 'true', DATABASE_URL: 'postgres://db.example/f1' })).toThrow('TARGET=primary');
  });

  it('repairs only the approved round-one alias after source and target fingerprint checks', async () => {
    const { pool, calls } = mockPool();
    await expect(runPaceV2IdentityRepair(pool, parsePaceV2IdentityRepairManifest(manifest))).resolves.toMatchObject({ repaired_row_count: 1 });
    expect(calls[0].sql).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(calls.some((call) => call.sql.startsWith('UPDATE laps_normalized_v2'))).toBe(true);
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO pace_v2_identity_repair_audit'))).toBe(true);
    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });

  it('rejects modified manifests and any other identity or round', () => {
    expect(() => parsePaceV2IdentityRepairManifest({ ...manifest, season: 2025 })).toThrow('unsupported shape');
    expect(() => parsePaceV2IdentityRepairManifest({ ...manifest, round: 2 })).toThrow('unsupported shape');
    expect(() => parsePaceV2IdentityRepairManifest({ ...manifest, from_track_id: 'albert_park', manifest_fingerprint: manifest.manifest_fingerprint })).toThrow('exactly approved');
    expect(() => parsePaceV2IdentityRepairManifest({ ...manifest, fact_row_count: 2, manifest_fingerprint: manifest.manifest_fingerprint })).toThrow('fingerprint');
  });

  it('does not update facts when the persisted source fingerprint differs', async () => {
    const altered = source.map((row) => ({ ...row, lap_time_seconds: 92 }));
    const { pool, calls } = mockPool(altered);
    await expect(runPaceV2IdentityRepair(pool, manifest)).rejects.toThrow('source fingerprint');
    expect(calls.some((call) => call.sql.startsWith('UPDATE laps_normalized_v2'))).toBe(false);
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
  });
});
