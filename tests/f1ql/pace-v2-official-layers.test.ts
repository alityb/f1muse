import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { exclusionReasons, requireOfficialLayersConfiguration, validateOfficialPaceLayers } from '../../scripts/validate-pace-v2-official-layers';

const stream = '\uFEFF00:00:01.000{"Lines":{"1":{"NumberOfLaps":1,"LastLapTime":{"Value":"1:30.000"}},"2":{"NumberOfLaps":1,"LastLapTime":{"Value":"1:31.000"}}}}\n';

describe('official pace validation layers', () => {
  it('requires explicit production-only configuration and documents v2 exclusions', () => {
    expect(() => requireOfficialLayersConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('PACE_V2_OFFICIAL_LAYERS_ENABLED');
    expect(() => requireOfficialLayersConfiguration({ PACE_V2_OFFICIAL_LAYERS_ENABLED: 'true', PACE_V2_OFFICIAL_LAYERS_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
    expect(exclusionReasons({ driver_id: 'a', lap_number: 1, lap_time_seconds: null, is_valid_lap: false, is_pit_lap: true, is_in_lap: true, is_out_lap: true, clean_air_flag: false })).toEqual(['v2_lap_time_missing', 'v2_lap_marked_invalid', 'v2_lap_marked_pit', 'v2_lap_marked_in_lap', 'v2_lap_marked_out_lap']);
  });

  it('uses read-only v2 observations but does not infer an identity or eligibility mapping', async () => {
    const artifact = Buffer.from(stream);
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string) { calls.push(sql); if (sql.includes('FROM laps_normalized_v2')) return { rows: [{ driver_id: 'driver-a', lap_number: 1, lap_time_seconds: '90', is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true }, { driver_id: 'driver-a', lap_number: 2, lap_time_seconds: '91', is_valid_lap: true, is_pit_lap: true, is_in_lap: false, is_out_lap: false, clean_air_flag: false }] }; return { rows: [] }; }, release() {} }; }, async end() {} };
    const result = await validateOfficialPaceLayers(pool, 2, artifact, { url: 'https://official.example/timing', sha256: createHash('sha256').update(artifact).digest('hex') });
    expect(result.layer_1_driver_coverage).toMatchObject({ status: 'unverified', official_racing_number_count: 2, v2_driver_count: 1 });
    expect(result.layer_3_eligibility_evidence.evidence[1]).toMatchObject({ v2_eligibility: 'excluded', exclusion_reasons: ['v2_lap_marked_pit'], official_clean_air_pit_metadata: 'unavailable_not_inferred' });
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls.at(-1)).toBe('ROLLBACK');
  });
});
