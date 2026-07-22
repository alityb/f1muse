import { describe, expect, it } from 'vitest';
import { buildPaceV2NatIdentityMap, generatePaceV2NatIdentityMap, requirePaceV2NatIdentityMapConfiguration } from '../../scripts/generate-pace-v2-nat-identity-map';
import { PACE_V2_NAT_REPLACEMENT_ROUNDS } from '../../src/etl/pace-v2-nat-replacement';

const rows = PACE_V2_NAT_REPLACEMENT_ROUNDS.flatMap((round) => [
  { round, race_track_id: `track_${round}`, driver_id: `driver_${round}_a`, driver_code: 'AAA', is_official_non_starter: false },
  { round, race_track_id: `track_${round}`, driver_id: `driver_${round}_b`, driver_code: 'BBB', is_official_non_starter: false }
]);

function session(season: number, round: number) {
  return { season, round, session_name: 'Race', event_name: `Round ${round}`, session_uid: `${round}`, columns_present: {}, laps: [
    { driver_code: 'AAA', lap_number: 1, lap_time_seconds: 90, lap_end_time_seconds: 90, is_accurate: true, pit_in: false, pit_out: false, compound: null, tyre_life: null, position: 1, gap_to_leader: 0 },
    { driver_code: 'BBB', lap_number: 1, lap_time_seconds: 91, lap_end_time_seconds: 91, is_accurate: true, pit_in: false, pit_out: false, compound: null, tyre_life: null, position: 2, gap_to_leader: 1 }
  ] };
}

describe('NaT FastF1 identity-map generator', () => {
  it('requires explicit production flags and refuses loopback', () => {
    expect(() => requirePaceV2NatIdentityMapConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('IDENTITY_MAP_ENABLED');
    expect(() => requirePaceV2NatIdentityMapConfiguration({ PACE_V2_NAT_IDENTITY_MAP_ENABLED: 'true', DATABASE_URL: 'postgres://db.example/f1' })).toThrow('TARGET=production');
    expect(() => requirePaceV2NatIdentityMapConfiguration({ PACE_V2_NAT_IDENTITY_MAP_ENABLED: 'true', PACE_V2_NAT_IDENTITY_MAP_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
  });

  it('maps exact FastF1 codes only after read-only canonical race-result reconciliation', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); return /^SELECT/.test(sql.trim()) ? { rows } : { rows: [] }; }, release() {} }; }, async end() {} };
    const artifact = await generatePaceV2NatIdentityMap(pool, session);
    expect(artifact).toMatchObject({ version: 2, source: 'canonical_race_results_fastf1_identity_map', season: 2026 });
    expect(artifact.rounds).toHaveLength(9);
    expect(artifact.rounds[0]).toEqual({ round: 2, track_id: 'track_2', driver_ids: { AAA: 'driver_2_a', BBB: 'driver_2_b' }, official_non_starter_codes: [] });
    expect(calls[0].sql).toBe('BEGIN READ ONLY');
    expect(calls[1].params).toEqual(['5000ms']);
    expect(calls[2].sql).toMatch(/^\s*SELECT\b/i);
    expect(calls[2].sql).not.toContain('rd.race_laps');
    expect(calls[2].sql).not.toContain('laps_normalized_v2');
    expect(calls[2].sql).toContain('is_official_non_starter');
    expect(calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('fails closed for FastF1 count and canonical ambiguity', () => {
    expect(() => buildPaceV2NatIdentityMap(rows, (season, round) => ({ ...session(season, round), laps: session(season, round).laps.slice(0, 1) }))).toThrow('extra_database_identities=[{"code":"BBB","driver_id":"driver_2_b"}]');
    expect(() => buildPaceV2NatIdentityMap(rows, (season, round) => ({ ...session(season, round), laps: [...session(season, round).laps, { ...session(season, round).laps[0], driver_code: 'CCC' }] }))).toThrow('missing_database_codes=["CCC"]');
    expect(() => buildPaceV2NatIdentityMap([...rows, { ...rows[0] }], session)).toThrow('ambiguous');
  });

  it('derives round-2 starters from canonical results and excludes official DNS/W FastF1 codes', () => {
    const starters = Array.from({ length: 18 }, (_, index) => ({ round: 2, race_track_id: 'track_2', driver_id: `starter_${index}`, driver_code: `S${String(index).padStart(2, '0')}`, is_official_non_starter: false }));
    const nonStarters = ['DNS', 'WTH', 'WD1', 'WD2'].map((driver_code, index) => ({ round: 2, race_track_id: 'track_2', driver_id: `non_starter_${index}`, driver_code, is_official_non_starter: true }));
    const full = PACE_V2_NAT_REPLACEMENT_ROUNDS.flatMap((round) => round === 2 ? [...starters, ...nonStarters] : rows.filter((row) => row.round === round));
    const artifact = buildPaceV2NatIdentityMap(full, (season, round) => ({ ...session(season, round), laps: (round === 2 ? [...starters, ...nonStarters] : rows.filter((row) => row.round === round)).map((row, index) => ({ ...session(season, round).laps[0], driver_code: row.driver_code, position: index + 1 })) }));
    expect(Object.keys(artifact.rounds[0].driver_ids)).toHaveLength(18);
    expect(artifact.rounds[0].driver_ids).not.toHaveProperty('DNS');
    expect(artifact.rounds[0].driver_ids).not.toHaveProperty('WTH');
    expect(artifact.rounds[0].official_non_starter_codes).toEqual(['DNS', 'WD1', 'WD2', 'WTH']);
  });

  it('fails closed when a FastF1 code is not a canonical starter or official DNS/W exclusion', () => {
    const starters = Array.from({ length: 18 }, (_, index) => ({ round: 2, race_track_id: 'track_2', driver_id: `starter_${index}`, driver_code: `S${String(index).padStart(2, '0')}`, is_official_non_starter: false }));
    const nonStarter = { round: 2, race_track_id: 'track_2', driver_id: 'dns_driver', driver_code: 'DNS', is_official_non_starter: true };
    const full = PACE_V2_NAT_REPLACEMENT_ROUNDS.flatMap((round) => round === 2 ? [...starters, nonStarter] : rows.filter((row) => row.round === round));
    expect(() => buildPaceV2NatIdentityMap(full, (season, round) => ({ ...session(season, round), laps: (round === 2 ? [...starters, nonStarter, { ...nonStarter, driver_code: 'BAD' }] : rows.filter((row) => row.round === round)).map((row, index) => ({ ...session(season, round).laps[0], driver_code: row.driver_code, position: index + 1 })) }))).toThrow('missing_database_codes=["BAD"]');
  });
});
