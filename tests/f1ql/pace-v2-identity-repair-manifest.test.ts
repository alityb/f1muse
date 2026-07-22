import { describe, expect, it } from 'vitest';
import { fingerprintPaceV2FactRows } from '../../src/etl/pace-v2-identity-repair';
import { generatePaceV2IdentityRepairManifest, requirePaceV2IdentityRepairManifestConfiguration } from '../../scripts/generate-pace-v2-identity-repair-manifest';

const source = [{ season: 2026, round: 1, track_id: 'australian_grand_prix', driver_id: 'driver_one', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 91.234, is_valid_lap: true, is_pit_lap: false, is_out_lap: false, is_in_lap: false, clean_air_flag: true, compound: 'SOFT', tyre_age_laps: 1, methodology_version: 'clean_air_gap_2_0s_v1' }];

function mockPool(rows = source) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return { calls, pool: { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); return sql.startsWith('SELECT season') ? { rows } : { rows: [] }; }, release() {} }; }, async end() {} } };
}

describe('pace v2 identity repair manifest generator', () => {
  it('requires explicit production flags and refuses local targets', () => {
    expect(() => requirePaceV2IdentityRepairManifestConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('MANIFEST_ENABLED');
    expect(() => requirePaceV2IdentityRepairManifestConfiguration({ PACE_V2_IDENTITY_REPAIR_MANIFEST_ENABLED: 'true', DATABASE_URL: 'postgres://db.example/f1' })).toThrow('TARGET=production');
    expect(() => requirePaceV2IdentityRepairManifestConfiguration({ PACE_V2_IDENTITY_REPAIR_MANIFEST_ENABLED: 'true', PACE_V2_IDENTITY_REPAIR_MANIFEST_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('emits the exact approved manifest from a rolled-back read-only source observation', async () => {
    const { pool, calls } = mockPool();
    const manifest = await generatePaceV2IdentityRepairManifest(pool);
    expect(manifest).toMatchObject({ season: 2026, round: 1, session_type: 'R', from_track_id: 'australian_grand_prix', to_track_id: 'melbourne', fact_row_count: 1 });
    expect(manifest.source_fact_fingerprint).toBe(fingerprintPaceV2FactRows(source));
    expect(manifest.target_fact_fingerprint).toBe(fingerprintPaceV2FactRows(source.map((row) => ({ ...row, track_id: 'melbourne' }))));
    expect(calls[0].sql).toBe('BEGIN READ ONLY');
    expect(calls[1].params).toEqual(['5000ms']);
    expect(calls[2].sql).toMatch(/^SELECT\b/i);
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('fails closed and rolls back when rows are mixed or do not use the active methodology', async () => {
    const { pool, calls } = mockPool([{ ...source[0], track_id: 'melbourne' }]);
    await expect(generatePaceV2IdentityRepairManifest(pool)).rejects.toThrow('exact approved source contract');
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
  });
});
