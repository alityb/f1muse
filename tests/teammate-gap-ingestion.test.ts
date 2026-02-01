import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  setupTestDatabase,
  cleanupTestDatabase,
  getTestDatabaseUrl
} from '../src/test/setup';
import { runIngestion as runRaceIngestion } from '../src/etl/teammate-gap/race';
import { runIngestion as runQualifyingIngestion } from '../src/etl/teammate-gap/qualifying';
import { validateTableSchema } from '../src/etl/teammate-gap/utils';

let pool: Pool;

async function seedRaceData(): Promise<void> {
  await pool.query(`
    INSERT INTO race (id, year, round) VALUES
      (1004, 2025, 4),
      (9001, 2024, 1)
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number)
    VALUES
      (1001, 'RACE_RESULT', 'lando_norris', 'mclaren', 1),
      (1001, 'RACE_RESULT', 'oscar_piastri', 'mclaren', 2),
      (1001, 'RACE_RESULT', 'max_verstappen', 'red-bull', 3),
      (1001, 'RACE_RESULT', 'sergio_perez', 'red-bull', 4),
      (1002, 'RACE_RESULT', 'lando_norris', 'mclaren', 1),
      (1002, 'RACE_RESULT', 'oscar_piastri', 'mclaren', 2),
      (1003, 'RACE_RESULT', 'lando_norris', 'mclaren', 1),
      (1003, 'RACE_RESULT', 'oscar_piastri', 'mclaren', 2),
      (1004, 'RACE_RESULT', 'lando_norris', 'mclaren', 1),
      (1004, 'RACE_RESULT', 'oscar_piastri', 'mclaren', 2),
      (9001, 'RACE_RESULT', 'lando_norris', 'mclaren', 1),
      (9001, 'RACE_RESULT', 'oscar_piastri', 'mclaren', 2)
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO race_data (race_id, type, driver_id, constructor_id, qualifying_q1_millis, qualifying_q2_millis, qualifying_q3_millis)
    VALUES
      (1001, 'QUALIFYING_RESULT', 'lando_norris', 'mclaren', 80000, 79000, NULL),
      (1001, 'QUALIFYING_RESULT', 'oscar_piastri', 'mclaren', 80500, 79500, 81000),
      (1001, 'QUALIFYING_RESULT', 'max_verstappen', 'red-bull', 79000, 78000, 77000),
      (1001, 'QUALIFYING_RESULT', 'sergio_perez', 'red-bull', 79200, 78100, 77100)
    ON CONFLICT DO NOTHING;
  `);
}

async function seedLapData(): Promise<void> {
  await pool.query(`DELETE FROM laps_normalized WHERE season = 2025`);

  const rows: Array<[number, number, string, string, number, number]> = [];
  const addLaps = (season: number, round: number, driver: string, times: number[]) => {
    times.forEach((time, index) => {
      rows.push([season, round, 'suzuka', driver, index + 1, time]);
    });
  };

  addLaps(2025, 1, 'lando_norris', [100.0, 101.0, 102.0]);
  addLaps(2025, 1, 'oscar_piastri', [98.0, 99.0, 100.0]);
  addLaps(2025, 1, 'max_verstappen', [95.0, 96.0, 97.0]);
  addLaps(2025, 1, 'sergio_perez', [97.0, 98.0, 99.0]);

  addLaps(2025, 2, 'lando_norris', [101.0, 102.0, 103.0]);
  addLaps(2025, 2, 'oscar_piastri', [100.0, 101.0, 102.0]);
  addLaps(2025, 3, 'lando_norris', [102.0, 103.0, 104.0]);
  addLaps(2025, 3, 'oscar_piastri', [101.0, 102.0, 103.0]);
  addLaps(2025, 4, 'lando_norris', [103.0, 104.0, 105.0]);
  addLaps(2025, 4, 'oscar_piastri', [102.0, 103.0, 104.0]);

  addLaps(2024, 1, 'lando_norris', [99.0, 100.0, 101.0]);
  addLaps(2024, 1, 'oscar_piastri', [98.0, 99.0, 100.0]);

  const values: string[] = [];
  const params: Array<string | number | boolean> = [];

  rows.forEach((row, index) => {
    const base = index * 6;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, true, false, true, false, false)`);
    params.push(...row);
  });

  await pool.query(
    `
    INSERT INTO laps_normalized (
      season,
      round,
      track_id,
      driver_id,
      lap_number,
      lap_time_seconds,
      is_valid_lap,
      is_pit_lap,
      clean_air_flag,
      is_out_lap,
      is_in_lap
    )
    VALUES ${values.join(', ')}
    ON CONFLICT DO NOTHING;
    `,
    params
  );
}

beforeAll(async () => {
  pool = new Pool({
    connectionString: getTestDatabaseUrl()
  });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool);
  await seedRaceData();
  await seedLapData();
  await runRaceIngestion(pool, { season: 2025 });
  await runQualifyingIngestion(pool, { season: 2025 });
});

afterAll(async () => {
  await cleanupTestDatabase(pool);
  await pool.end();
});

describe('Teammate gap ingestion pipelines', () => {
  it('does not create cross-team comparisons', async () => {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM teammate_gap_race_level_2025
      WHERE season = 2025
        AND driver_primary_id = $1
        AND driver_secondary_id = $2
      `,
      ['lando_norris', 'max_verstappen']
    );

    expect(result.rows[0].count).toBe(0);
  });

  it('does not create cross-season comparisons', async () => {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM teammate_gap_race_level_2025 WHERE season = 2024`
    );

    expect(result.rows[0].count).toBe(0);
  });

  it('selects the highest common qualifying session', async () => {
    const mclaren = await pool.query(
      `
      SELECT session_used
      FROM teammate_gap_qualifying_race_level_2025
      WHERE season = 2025
        AND round = 1
        AND driver_primary_id = $1
        AND driver_secondary_id = $2
      `,
      ['lando_norris', 'oscar_piastri']
    );

    expect(mclaren.rows[0]?.session_used).toBe('Q2');

    const redBull = await pool.query(
      `
      SELECT session_used
      FROM teammate_gap_qualifying_race_level_2025
      WHERE season = 2025
        AND round = 1
        AND driver_primary_id = $1
        AND driver_secondary_id = $2
      `,
      ['max_verstappen', 'sergio_perez']
    );

    expect(redBull.rows[0]?.session_used).toBe('Q3');
  });

  it('computes symmetric percent gap correctly', async () => {
    const result = await pool.query(
      `
      SELECT gap_percent
      FROM teammate_gap_race_level_2025
      WHERE season = 2025
        AND round = 1
        AND driver_primary_id = $1
        AND driver_secondary_id = $2
      `,
      ['lando_norris', 'oscar_piastri']
    );

    const gapPercent = parseFloat(result.rows[0].gap_percent);
    expect(gapPercent).toBeCloseTo(2.0, 3);
  });

  it('applies coverage thresholds based on shared races', async () => {
    const result = await pool.query(
      `
      SELECT shared_races, coverage_status
      FROM teammate_gap_season_summary_2025
      WHERE season = 2025
        AND driver_primary_id = $1
        AND driver_secondary_id = $2
      `,
      ['lando_norris', 'oscar_piastri']
    );

    expect(parseInt(result.rows[0].shared_races, 10)).toBe(4);
    expect(result.rows[0].coverage_status).toBe('low_coverage');
  });

  it('fails schema validation when required columns are missing', async () => {
    await pool.query(`DROP TABLE IF EXISTS schema_validation_tmp`);
    await pool.query(`CREATE TABLE schema_validation_tmp (id INTEGER)`);

    const result = await validateTableSchema(pool, 'schema_validation_tmp', [
      { name: 'missing_column', type: 'text' }
    ]);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing_column');

    await pool.query(`DROP TABLE schema_validation_tmp`);
  });
});
