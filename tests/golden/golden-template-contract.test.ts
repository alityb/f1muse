import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { TemplateLoader } from '../../src/execution/template-loader';
import { getTestDatabaseUrl } from '../../src/test/setup';
import { getGoldenAssertion, getGoldenCase } from './golden-registry';

const loader = new TemplateLoader();
let pool: Pool;
let client: PoolClient;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query('CREATE SCHEMA golden_contract');
  await client.query('SET LOCAL search_path TO golden_contract');
  await createGoldenSchema(client);
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

describe('golden template contract: standings authority', () => {
  it('uses official standings points instead of an incompatible race-result sum', async () => {
    const golden = getGoldenCase('hamilton-2018-official-points');
    const expectedPoints = getGoldenAssertion(
      golden,
      'lewis-hamilton',
      'championship_points'
    );
    const expectedWins = getGoldenAssertion(golden, 'lewis-hamilton', 'wins');
    const standingPoints = asNumber(expectedPoints, golden.id, 'championship_points');
    const wins = asNumber(expectedWins, golden.id, 'wins');

    for (let round = 1; round <= wins; round++) {
      await client.query('INSERT INTO race (id, year, round) VALUES ($1, $2, $3)', [round, 2018, round]);
      await client.query(
        `INSERT INTO race_data (race_id, type, driver_id, position_number, race_points)
         VALUES ($1, $2, $3, $4, $5)`,
        [round, 'RACE_RESULT', 'lewis_hamilton', 1, 0]
      );
    }
    await client.query(
      'INSERT INTO season_driver_standing (year, driver_id, points) VALUES ($1, $2, $3)',
      [2018, 'lewis-hamilton', standingPoints]
    );

    const sql = loader.load('driver_season_summary_v1');
    const result = await client.query(sql, ['lewis-hamilton', 2018]);

    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].points)).toBe(standingPoints);
    expect(Number(result.rows[0].wins)).toBe(wins);
  });

  it('uses the official 2025 standing instead of a sprint-incomplete result sum', async () => {
    const golden = getGoldenCase('russell-2025-sprint-inclusive-points');
    const expectedPoints = getGoldenAssertion(
      golden,
      'george-russell',
      'championship_points'
    );
    const standingPoints = asNumber(expectedPoints, golden.id, 'championship_points');

    await client.query('INSERT INTO race (id, year, round) VALUES ($1, $2, $3)', [2, 2025, 1]);
    await client.query(
      `INSERT INTO race_data (race_id, type, driver_id, position_number, race_points)
       VALUES ($1, $2, $3, $4, $5)`,
      [2, 'RACE_RESULT', 'george_russell', 1, 289]
    );
    await client.query(
      'INSERT INTO season_driver_standing (year, driver_id, points) VALUES ($1, $2, $3)',
      [2025, 'george-russell', standingPoints]
    );

    const sql = loader.load('driver_season_summary_v1');
    const result = await client.query(sql, ['george-russell', 2025]);

    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].points)).toBe(standingPoints);
  });

});

describe('golden template contract: participation gate', () => {
  it('returns no comprehensive comparison when either driver did not enter the season', async () => {
    const golden = getGoldenCase('russell-hamilton-2018-participation');
    const expectedParticipation = getGoldenAssertion(
      golden,
      'george-russell',
      'season_participation'
    );

    await client.query(`
      INSERT INTO season_driver_standing (year, driver_id, points)
      VALUES (2018, 'lewis-hamilton', 408);
    `);

    const sql = loader.load('driver_vs_driver_comprehensive_v1');
    const result = await client.query(sql, [2018, 'george-russell', 'lewis-hamilton']);

    expect(expectedParticipation).toBe(false);
    expect(result.rows).toHaveLength(0);
  });
});

async function createGoldenSchema(db: PoolClient): Promise<void> {
  await db.query(`
    CREATE TABLE race (
      id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL,
      round INTEGER NOT NULL
    );
    CREATE TABLE race_data (
      race_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      position_number INTEGER,
      position_text TEXT,
      race_reason_retired TEXT,
      race_points NUMERIC,
      race_fastest_lap BOOLEAN,
      PRIMARY KEY (race_id, type, driver_id)
    );
    CREATE TABLE season_driver_standing (
      year INTEGER NOT NULL,
      driver_id TEXT NOT NULL,
      points NUMERIC NOT NULL,
      PRIMARY KEY (year, driver_id)
    );
    CREATE TABLE qualifying_results (
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      driver_id TEXT NOT NULL,
      qualifying_position INTEGER,
      session_type TEXT,
      q1_time_ms INTEGER,
      q2_time_ms INTEGER,
      q3_time_ms INTEGER
    );
    CREATE TABLE laps_normalized (
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      track_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      lap_time_seconds NUMERIC,
      is_valid_lap BOOLEAN,
      is_pit_lap BOOLEAN,
      is_in_lap BOOLEAN,
      is_out_lap BOOLEAN
    );
  `);
}

function asNumber(value: number | string | boolean | null, caseId: string, metric: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Golden ${caseId}/${metric} must be numeric`);
  }
  return value;
}
