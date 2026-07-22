import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeF1QL } from '../../src/f1ql/executor';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'team', 'team', 'driver-a')`);
  await pool.query(`INSERT INTO race (id, year, round) VALUES (1, 2025, 1)`);
  await pool.query(`INSERT INTO race_data
    (race_id, type, driver_id, position_number, position_text, race_reason_retired, race_points) VALUES
    (1, 'race_result', 'explicit_dsq', NULL, ' DSQ ', 'Engine', 0),
    (1, 'race_result', 'explicit_dns', NULL, 'DNS', 'DNF', 0),
    (1, 'race_result', 'formation_lap_dnf', NULL, 'DNF', NULL, 0)`);
  await pool.query(`INSERT INTO laps_normalized_v2
    (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, methodology_version) VALUES
    (2025, 1, 'track', 'driver-a', 'R', 1, 100, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
    (2025, 1, 'track', 'driver-a', 'R', 2, 101, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
    (2025, 1, 'track', 'driver-a', 'Q', 1, 80, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
    (2025, 1, 'track', 'driver-a', 'Q', 2, 81, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
    (2025, 1, 'track', 'driver-a', 'R', 3, 70, true, false, false, false, true, 'obsolete_methodology')`);
});

afterAll(async () => {
  await pool.end();
});

describe('pace and classification factual correctness', () => {
  it('uses explicit DSQ/DNS tokens before generic reasons and keeps formation-lap DNF', async () => {
    const rows = await pool.query(`SELECT driver_id, classification_status FROM f1ql.event_classification WHERE season = 2025 AND round = 1 ORDER BY driver_id`);
    expect(rows.rows).toEqual([
      { driver_id: 'explicit-dns', classification_status: 'dns' },
      { driver_id: 'explicit-dsq', classification_status: 'dsq' },
      { driver_id: 'formation-lap-dnf', classification_status: 'dnf' }
    ]);
  });

  it('keys sessions independently, excludes non-race and incompatible methodology laps, and exposes the method', async () => {
    const result = await executeF1QL(pool, {
      version: 1,
      root: { op: 'pace_summary', driver_id: 'driver-a', scope: { season: 2025 } }
    });
    expect(result.rows).toEqual([{
      driver_id: 'driver-a',
      methodology_version: 'clean_air_gap_2_0s_v1',
      events: 1,
      avg_lap_time_seconds: 100.5
    }]);
  });

  it('uses an approved replacement only for its audited poisoned round and retains healthy originals', async () => {
    await pool.query(`INSERT INTO laps_normalized_v2
      (season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, methodology_version) VALUES
      (2026, 2, 'poisoned', 'driver_a', 'R', 1, 1, 1, 100, true, true, true, true, false, 'clean_air_gap_2_0s_v1'),
      (2026, 2, 'poisoned', 'driver_a', 'R', 2, 1, 2, 101, true, true, true, true, false, 'clean_air_gap_2_0s_v1'),
      (2026, 11, 'healthy', 'driver_a', 'R', 1, 1, 1, 90, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
      (2026, 11, 'healthy', 'driver_a', 'R', 2, 1, 2, 91, true, false, false, false, true, 'clean_air_gap_2_0s_v1')`);
    await pool.query(`INSERT INTO pace_v2_lap_replacement
      (replacement_version, season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, methodology_version) VALUES
      ('nat_pit_flags_v1', 2026, 2, 'poisoned', 'driver_a', 'R', 1, 1, 1, 100, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
      ('nat_pit_flags_v1', 2026, 2, 'poisoned', 'driver_a', 'R', 2, 1, 2, 101, true, false, false, false, true, 'clean_air_gap_2_0s_v1')`);
    await pool.query(`INSERT INTO pace_v2_replacement_audit
      (replacement_version, season, round, session_type, replacement_manifest_fingerprint, original_fact_fingerprint, replacement_fact_fingerprint, fact_row_count, methodology_version)
      VALUES ('nat_pit_flags_v1', 2026, 2, 'R', 'manifest', 'original', 'replacement', 2, 'clean_air_gap_2_0s_v1')`);
    const rows = await pool.query(`SELECT round, is_pit_lap FROM f1ql.lap_pace WHERE season = 2026 AND driver_id = 'driver-a' ORDER BY round, lap_time_seconds`);
    expect(rows.rows).toEqual([
      { round: 2, is_pit_lap: false }, { round: 2, is_pit_lap: false },
      { round: 11, is_pit_lap: false }, { round: 11, is_pit_lap: false }
    ]);
  });
});
