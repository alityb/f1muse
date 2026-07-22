import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPaceV2IncompleteRebuildManifest, fingerprintDriverIds, parsePaceV2IncompleteRebuildArtifact, PACE_V2_INCOMPLETE_REBUILD_ROUNDS } from '../../src/etl/pace-v2-incomplete-rebuild';
import { fingerprintPaceV2FactRows } from '../../src/etl/pace-v2-identity-repair';
import { runPaceV2IncompleteRebuild } from '../../scripts/rebuild-pace-v2-incomplete-rounds';
import { generatePaceV2IncompleteRebuildFacts, incompleteRebuildFactsRefusal, PaceV2IncompleteRebuildFactsError } from '../../scripts/generate-pace-v2-incomplete-rebuild-facts';
import { generatePaceV2IncompleteRebuildManifest, incompleteRebuildManifestRefusal, PaceV2IncompleteRebuildManifestError } from '../../scripts/generate-pace-v2-incomplete-rebuild-manifest';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const original = PACE_V2_INCOMPLETE_REBUILD_ROUNDS.map((round) => ({ season: 2026, round, track_id: `track_${round}`, driver_id: 'driver_a', session_type: 'R', lap_number: 1, stint_id: 1, stint_lap_index: 1, lap_time_seconds: 90, is_valid_lap: true, is_pit_lap: true, is_out_lap: true, is_in_lap: true, clean_air_flag: false, compound: null, tyre_age_laps: null, methodology_version: 'clean_air_gap_2_0s_v1' }));
const driverIds = ['driver_a', 'alexander-albon', 'gabriel-bortoleto', 'lando-norris', 'oscar-piastri'];
const manifest = createPaceV2IncompleteRebuildManifest(PACE_V2_INCOMPLETE_REBUILD_ROUNDS.map((round) => ({ round, original_fact_row_count: 1, original_fact_fingerprint: fingerprintPaceV2FactRows(original.filter((row) => row.round === round)), canonical_driver_count: 5, canonical_driver_fingerprint: fingerprintDriverIds(driverIds) })));
const facts = PACE_V2_INCOMPLETE_REBUILD_ROUNDS.flatMap((round) => driverIds.map((driver_id, index) => ({ ...original.find((row) => row.round === round)!, driver_id, lap_number: index + 1, is_pit_lap: false, is_in_lap: false, is_out_lap: false })));
const artifactFor = (approvedManifest = manifest, approvedFacts = facts) => parsePaceV2IncompleteRebuildArtifact({ version: 1, rebuild_version: 'fastf1_complete_race_v1', manifest_fingerprint: approvedManifest.manifest_fingerprint, identity_map_fingerprint: 'a'.repeat(64), methodology_version: 'clean_air_gap_2_0s_v1', facts: approvedFacts }, approvedManifest);
let database: Pool;

beforeAll(async () => {
  database = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(database, { seed: false });
});

afterAll(async () => { await database.end(); });

describe('incomplete pace rebuild', () => {
  it('writes only immutable replacement facts and audits for full canonical FastF1 coverage', async () => {
    const calls: string[] = [];
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) { calls.push(sql); if (sql.includes('to_regclass')) return { rows: [{ relation: 'pace_v2_lap_rebuild' }, { relation: 'pace_v2_rebuild_audit' }] }; if (sql.includes('COUNT(*) = 3')) return { rows: [{ enabled: true }] }; if (sql.includes('FROM laps_normalized_v2')) return { rows: original.filter((row) => row.round === Number(params?.[0])) }; if (sql.includes('FROM race r JOIN race_data')) return { rows: driverIds.map((driver_id) => ({ driver_id })) }; if (sql.includes('SELECT 1 FROM pace_v2_rebuild_audit')) return { rows: [] }; return { rows: [] }; }, release() {} }; }, async end() {} };
    const artifact = artifactFor();
    await expect(runPaceV2IncompleteRebuild(pool, manifest, artifact)).resolves.toMatchObject({ rebuilt_rounds: 9, rebuild_fact_rows: 45 });
    expect(calls.some((sql) => sql.startsWith('INSERT INTO pace_v2_lap_rebuild'))).toBe(true);
    expect(calls.find((sql) => sql.includes('FROM race r JOIN race_data'))).toContain("UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('W', 'WD', 'WITHDRAWN', 'DNS', 'DID NOT START')");
    expect(calls.find((sql) => sql.includes('FROM race r JOIN race_data'))).not.toContain('rd.race_laps');
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

  it('reports missing canonical drivers without emitting a partial facts artifact', () => {
    const canonicalDriverIds = Array.from({ length: 11 }, (_, index) => `driver_${index}`);
    const round2Manifest = createPaceV2IncompleteRebuildManifest([{ round: 2, original_fact_row_count: 1, original_fact_fingerprint: fingerprintPaceV2FactRows(original.filter((row) => row.round === 2)), canonical_driver_count: canonicalDriverIds.length, canonical_driver_fingerprint: fingerprintDriverIds(canonicalDriverIds) }]);
    const map = { version: 2 as const, source: 'canonical_race_results_fastf1_identity_map' as const, season: 2026 as const, rounds: PACE_V2_INCOMPLETE_REBUILD_ROUNDS.map((round) => ({ round, track_id: `track_${round}`, driver_ids: Object.fromEntries(canonicalDriverIds.map((driverId, index) => [`D${String(index).padStart(2, '0')}`, driverId])) })) };
    const fetchSession = (_season: number, round: number) => ({ season: 2026, round, session_name: 'Race', event_name: `Round ${round}`, session_uid: `2026-${round}`, columns_present: { Driver: true, LapNumber: true, LapTime: true, IsAccurate: true, PitInTime: true, PitOutTime: true, Compound: true, TyreLife: true, Position: true, GapToLeader: true, Time: true }, laps: canonicalDriverIds.slice(1).map((driver_code, index) => ({ driver_code: `D${String(index + 1).padStart(2, '0')}`, lap_number: 1, lap_time_seconds: 90 + index, lap_end_time_seconds: 90 + index, is_accurate: true, pit_in: false, pit_out: false, compound: 'MEDIUM', tyre_life: 1, position: index + 1, gap_to_leader: index })) });
    try {
      generatePaceV2IncompleteRebuildFacts(round2Manifest, map, fetchSession);
      throw new Error('expected incomplete canonical driver coverage refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PaceV2IncompleteRebuildFactsError);
      expect(incompleteRebuildFactsRefusal(error)).toEqual({ status: 'refused', error: 'incomplete_canonical_driver_coverage', round: 2, expected_canonical_driver_count: 11, observed_fact_driver_count: 10, missing_canonical_driver_ids: ['driver_0'] });
    }
  });

  it('excludes explicit null-lap DNS and withdrawals while retaining all 18 round-2 starters including DNF', async () => {
    const starters = Array.from({ length: 17 }, (_, index) => `starter_${index + 1}`);
    const actualStarters = [...starters, 'formation_lap_dnf'];
    const nonStarters = ['DNS', 'Did not start', 'W', 'WD', 'Withdrawn'];
    const raceDataValues = [
      ...starters.map((driverId, index) => `(202602, 'race_result', '${driverId}', ${index + 1}, '${index + 1}', NULL, ${56 - index})`),
      "(202602, 'race_result', 'formation_lap_dnf', NULL, 'DNF', 'Collision', NULL)",
      ...nonStarters.flatMap((status) => [
        `(202602, 'race_result', 'position_${status.replaceAll(' ', '_').toLowerCase()}', NULL, '${status}', NULL, NULL)`,
        `(202602, 'race_result', 'reason_${status.replaceAll(' ', '_').toLowerCase()}', NULL, NULL, '${status}', NULL)`
      ])
    ];
    await database.query(`INSERT INTO race (id, year, round) VALUES (202602, 2026, 2);
      INSERT INTO race_data (race_id, type, driver_id, position_number, position_text, race_reason_retired, race_laps) VALUES ${raceDataValues.join(',')};
      INSERT INTO laps_normalized_v2
        (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, methodology_version)
      VALUES (2026, 2, 'shanghai', 'starter_1', 'R', 1, 90, true, false, false, false, true, 'clean_air_gap_2_0s_v1')`);

    const generated = await generatePaceV2IncompleteRebuildManifest(database, [2]);

    expect(generated.rounds).toEqual([expect.objectContaining({
      round: 2,
      canonical_driver_count: 18,
      canonical_driver_fingerprint: fingerprintDriverIds(actualStarters)
    })]);
  });

  it('reports the exact failed manifest candidate predicate', async () => {
    const pool = { async connect() { return { async query(sql: string) {
      if (sql.includes('FROM laps_normalized_v2')) return { rows: [original[0]] };
      if (sql.includes('FROM race r JOIN race_data')) return { rows: [{ round: 2, driver_id: 'driver_a' }] };
      return { rows: [] };
    }, release() {} }; }, async end() {} };
    try {
      await generatePaceV2IncompleteRebuildManifest(pool, [2]);
      throw new Error('expected incomplete candidate refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PaceV2IncompleteRebuildManifestError);
      expect(incompleteRebuildManifestRefusal(error)).toEqual({ status: 'refused', error: 'incomplete_rebuild_candidate_invalid', round: 2, predicates: {
        original_fact_rows_nonempty: true,
        canonical_driver_rows_nonempty: true,
        canonical_coverage_incomplete: false,
        persisted_drivers_are_canonical: true,
        methodology_version_active: true
      } });
    }
  });
});
