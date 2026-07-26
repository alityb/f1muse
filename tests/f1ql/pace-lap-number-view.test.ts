import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const migration = readFileSync('migrations/20260731_f1ql_lap_pace_lap_number.sql', 'utf8');
const previousMigration = readFileSync('migrations/20260726_pace_v2_incomplete_rebuild.sql', 'utf8');
const deployedView = previousMigration.slice(previousMigration.indexOf('CREATE OR REPLACE VIEW f1ql.lap_pace AS'));
let database: Pool;

beforeAll(async () => {
  database = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(database, { seed: false });
});

afterAll(async () => {
  await database.query(`
    DELETE FROM pace_v2_rebuild_audit WHERE season = 2026 AND round = 10;
    DELETE FROM pace_v2_lap_rebuild WHERE season = 2026 AND round = 10 AND driver_id = 'driver_one';
    DELETE FROM pace_v2_replacement_audit WHERE season = 2026 AND round IN (9, 10);
    DELETE FROM pace_v2_lap_replacement WHERE season = 2026 AND round IN (9, 10) AND driver_id = 'driver_one';
    DELETE FROM laps_normalized_v2 WHERE season = 2026 AND round IN (8, 9, 10) AND driver_id = 'driver_one';
  `);
  await database.end();
});

describe('lap pace lap identity view', () => {
  it('idempotently appends lap_number without changing selected fact precedence', async () => {
    await database.query('DROP VIEW f1ql.lap_pace');
    await database.query(deployedView);
    const deployedColumns = await database.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'f1ql' AND table_name = 'lap_pace'
      ORDER BY ordinal_position
    `);
    expect(deployedColumns.rows).toHaveLength(14);
    expect(deployedColumns.rows.some(column => column.column_name === 'lap_number')).toBe(false);

    await database.query(migration);
    await database.query(migration);
    await database.query(`
      INSERT INTO laps_normalized_v2
        (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds,
         is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, methodology_version)
      VALUES
        (2026, 8, 'event_8', 'driver_one', 'R', 7, 91.007, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
        (2026, 9, 'event_9', 'driver_one', 'R', 1, 92.001, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
        (2026, 10, 'event_10', 'driver_one', 'R', 1, 93.001, true, false, false, false, true, 'clean_air_gap_2_0s_v1');

      INSERT INTO pace_v2_lap_replacement
        (replacement_version, season, round, track_id, driver_id, session_type, lap_number,
         stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap,
         is_out_lap, clean_air_flag, methodology_version)
      VALUES
        ('nat_pit_flags_v1', 2026, 9, 'event_9', 'driver_one', 'R', 8, 1, 1, 92.008, true, false, false, false, true, 'clean_air_gap_2_0s_v1'),
        ('nat_pit_flags_v1', 2026, 10, 'event_10', 'driver_one', 'R', 2, 1, 1, 93.002, true, false, false, false, true, 'clean_air_gap_2_0s_v1');

      INSERT INTO pace_v2_replacement_audit
        (replacement_version, season, round, session_type, replacement_manifest_fingerprint,
         original_fact_fingerprint, replacement_fact_fingerprint, fact_row_count, methodology_version)
      VALUES
        ('nat_pit_flags_v1', 2026, 9, 'R', 'manifest-9', 'original-9', 'replacement-9', 1, 'clean_air_gap_2_0s_v1'),
        ('nat_pit_flags_v1', 2026, 10, 'R', 'manifest-10', 'original-10', 'replacement-10', 1, 'clean_air_gap_2_0s_v1');

      INSERT INTO pace_v2_lap_rebuild
        (rebuild_version, season, round, track_id, driver_id, session_type, lap_number,
         stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap,
         is_out_lap, clean_air_flag, methodology_version)
      VALUES
        ('fastf1_complete_race_v1', 2026, 10, 'event_10', 'driver_one', 'R', 9, 1, 1, 93.009, true, false, false, false, true, 'clean_air_gap_2_0s_v1');

      INSERT INTO pace_v2_rebuild_audit
        (rebuild_version, season, round, session_type, rebuild_manifest_fingerprint,
         identity_map_fingerprint, original_fact_fingerprint, replacement_fact_fingerprint,
         original_fact_row_count, replacement_fact_row_count, canonical_driver_fingerprint,
         canonical_driver_count, methodology_version)
      VALUES
        ('fastf1_complete_race_v1', 2026, 10, 'R', 'rebuild-10', 'identity-10', 'original-10',
         'replacement-10', 1, 1, 'drivers-10', 1, 'clean_air_gap_2_0s_v1');
    `);

    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'f1ql' AND table_name = 'lap_pace'
      ORDER BY ordinal_position
    `);
    expect(columns.rows.at(-1)?.column_name).toBe('lap_number');

    const selected = await database.query(`
      SELECT round, lap_number, lap_time_seconds::text
      FROM f1ql.lap_pace
      WHERE season = 2026 AND driver_id = 'driver-one'
      ORDER BY round
    `);
    expect(selected.rows).toEqual([
      { round: 8, lap_number: 7, lap_time_seconds: '91.007' },
      { round: 9, lap_number: 8, lap_time_seconds: '92.008' },
      { round: 10, lap_number: 9, lap_time_seconds: '93.009' }
    ]);
  });
});
