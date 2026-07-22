import { describe, expect, it } from 'vitest';
import { createPaceV2IncompleteRebuildManifest, fingerprintDriverIds, parsePaceV2IncompleteRebuildArtifact, PACE_V2_INCOMPLETE_REBUILD_ROUNDS } from '../../src/etl/pace-v2-incomplete-rebuild';
import { fingerprintPaceV2FactRows } from '../../src/etl/pace-v2-identity-repair';
import { runPaceV2IncompleteRebuild } from '../../scripts/rebuild-pace-v2-incomplete-rounds';

const original = PACE_V2_INCOMPLETE_REBUILD_ROUNDS.map((round) => ({ season: 2026, round, track_id: `track_${round}`, driver_id: 'driver_a', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 90, is_valid_lap: true, is_pit_lap: true, is_out_lap: true, is_in_lap: true, clean_air_flag: false, compound: null, tyre_age_laps: null, methodology_version: 'clean_air_gap_2_0s_v1' }));
const driverIds = ['driver_a', 'alexander-albon', 'gabriel-bortoleto', 'lando-norris', 'oscar-piastri'];
const manifest = createPaceV2IncompleteRebuildManifest(PACE_V2_INCOMPLETE_REBUILD_ROUNDS.map((round) => ({ round, original_fact_row_count: 1, original_fact_fingerprint: fingerprintPaceV2FactRows(original.filter((row) => row.round === round)), canonical_driver_count: 5, canonical_driver_fingerprint: fingerprintDriverIds(driverIds) })));
const facts = PACE_V2_INCOMPLETE_REBUILD_ROUNDS.flatMap((round) => driverIds.map((driver_id, index) => ({ ...original.find((row) => row.round === round)!, driver_id, lap_number: index + 1, is_pit_lap: false, is_in_lap: false, is_out_lap: false })));
const artifactFor = (approvedManifest = manifest, approvedFacts = facts) => parsePaceV2IncompleteRebuildArtifact({ version: 1, rebuild_version: 'fastf1_complete_race_v1', manifest_fingerprint: approvedManifest.manifest_fingerprint, identity_map_fingerprint: 'a'.repeat(64), methodology_version: 'clean_air_gap_2_0s_v1', facts: approvedFacts }, approvedManifest);

describe('incomplete pace rebuild', () => {
  it('writes only immutable replacement facts and audits for full canonical FastF1 coverage', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push(sql); if (sql.includes('to_regclass')) return { rows: [{ relation: 'pace_v2_lap_rebuild' }, { relation: 'pace_v2_rebuild_audit' }] }; if (sql.includes('COUNT(*) = 3')) return { rows: [{ enabled: true }] }; if (sql.includes('FROM laps_normalized_v2')) return { rows: original.filter((row) => row.round === Number(params?.[0])) }; if (sql.includes('FROM race r JOIN race_data')) return { rows: driverIds.map((driver_id) => ({ driver_id })) }; if (sql.includes('SELECT 1 FROM pace_v2_rebuild_audit')) return { rows: [] }; return { rows: [] }; }, release() {} }; }, async end() {} };
    const artifact = artifactFor();
    await expect(runPaceV2IncompleteRebuild(pool, manifest, artifact)).resolves.toMatchObject({ rebuilt_rounds: 9, rebuild_fact_rows: 45 });
    expect(calls.some((sql) => sql.startsWith('INSERT INTO pace_v2_lap_rebuild'))).toBe(true);
    expect(calls.some((sql) => /(?:UPDATE|DELETE)\s+.*laps_normalized_v2/i.test(sql))).toBe(false);
  });

  it('rebuilds only the explicitly approved round 2 subset', async () => {
    const round2 = 2;
    const round2Original = original.filter((row) => row.round === round2);
    const round2Manifest = createPaceV2IncompleteRebuildManifest([{ round: round2, original_fact_row_count: 1, original_fact_fingerprint: fingerprintPaceV2FactRows(round2Original), canonical_driver_count: 5, canonical_driver_fingerprint: fingerprintDriverIds(driverIds) }]);
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push({ sql, params }); if (sql.includes('to_regclass')) return { rows: [{ relation: 'pace_v2_lap_rebuild' }, { relation: 'pace_v2_rebuild_audit' }] }; if (sql.includes('COUNT(*) = 3')) return { rows: [{ enabled: true }] }; if (sql.includes('FROM laps_normalized_v2')) return { rows: round2Original }; if (sql.includes('FROM race r JOIN race_data')) return { rows: driverIds.map((driver_id) => ({ driver_id })) }; if (sql.includes('SELECT 1 FROM pace_v2_rebuild_audit')) return { rows: [] }; return { rows: [] }; }, release() {} }; }, async end() {} };
    await expect(runPaceV2IncompleteRebuild(pool, round2Manifest, artifactFor(round2Manifest, facts.filter((row) => row.round === round2)))).resolves.toMatchObject({ rebuilt_rounds: 1, rebuild_fact_rows: 5 });
    expect(calls.filter((call) => call.sql.includes('FROM laps_normalized_v2')).map((call) => call.params?.[0])).toEqual([2]);
    expect(calls.some((call) => call.sql.includes('round=$1') && call.params?.[0] === 3)).toBe(false);
  });
});
