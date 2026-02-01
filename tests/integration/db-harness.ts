/**
 * Integration Test Database Harness
 *
 * Provides infrastructure for seeded, deterministic integration tests.
 * Supports both:
 *   1. TEST_DATABASE_URL environment variable
 *   2. Docker Compose PostgreSQL (docker-compose.test.yml)
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES } from './fixtures';

const DEFAULT_TEST_DATABASE_URL = 'postgres://localhost:5432/f1muse_integration_test';

/**
 * Safe database URL validation - only allow localhost/127.0.0.1
 */
function assertLocalDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error(
      `Unsafe test database host "${hostname}". Integration tests must run against localhost only.`
    );
  }
}

/**
 * Get the integration test database URL
 */
export function getIntegrationDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  assertLocalDatabaseUrl(databaseUrl);
  return databaseUrl;
}

/**
 * Check if the test database is available
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  const pool = new Pool({
    connectionString: getIntegrationDatabaseUrl(),
    connectionTimeoutMillis: 3000
  });

  try {
    const result = await pool.query('SELECT 1');
    return result.rows.length === 1;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/**
 * Create a new pool for integration tests
 */
export function createIntegrationPool(): Pool {
  return new Pool({
    connectionString: getIntegrationDatabaseUrl(),
    max: 5
  });
}

/**
 * Run all database migrations
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = path.join(__dirname, '../../migrations');

  // Order matters - run in specific sequence
  const migrationOrder = [
    'create_laps_normalized.sql',
    'create_identity_maps.sql',
    'add_missing_2025_drivers.sql',
    'extend_ingestion_audit.sql',
    'create_api_query_cache.sql',
    'create_driver_matchup_matrix.sql'
  ];

  // First create F1DB reference tables (they're expected by migrations)
  await createF1dbReferenceTables(pool);

  for (const migration of migrationOrder) {
    const filePath = path.join(migrationsDir, migration);
    if (fs.existsSync(filePath)) {
      const sql = fs.readFileSync(filePath, 'utf-8');
      try {
        await pool.query(sql);
      } catch (err: any) {
        // Ignore "already exists" errors during migration
        if (!err.message?.includes('already exists')) {
          console.error(`Migration ${migration} failed:`, err.message);
        }
      }
    }
  }
}

/**
 * Create F1DB reference tables that migrations depend on
 */
async function createF1dbReferenceTables(pool: Pool): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver (
      id TEXT PRIMARY KEY,
      name TEXT,
      full_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      abbreviation TEXT NOT NULL,
      gender TEXT,
      date_of_birth DATE,
      place_of_birth TEXT,
      country_of_birth_country_id TEXT,
      nationality_country_id TEXT,
      total_championship_wins INTEGER DEFAULT 0,
      total_race_entries INTEGER DEFAULT 0,
      total_race_starts INTEGER DEFAULT 0,
      total_race_wins INTEGER DEFAULT 0,
      total_race_laps INTEGER DEFAULT 0,
      total_podiums INTEGER DEFAULT 0,
      total_points NUMERIC DEFAULT 0,
      total_championship_points NUMERIC DEFAULT 0,
      total_pole_positions INTEGER DEFAULT 0,
      total_fastest_laps INTEGER DEFAULT 0,
      total_sprint_race_starts INTEGER DEFAULT 0,
      total_sprint_race_wins INTEGER DEFAULT 0,
      total_driver_of_the_day INTEGER DEFAULT 0,
      total_grand_slams INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuit (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      previous_names TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grand_prix (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      abbreviation TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS season (
      year INTEGER PRIMARY KEY
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS race (
      id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL,
      round INTEGER NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS race_data (
      race_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      constructor_id TEXT,
      position_number INTEGER,
      race_reason_retired TEXT,
      qualifying_q1_millis INTEGER,
      qualifying_q2_millis INTEGER,
      qualifying_q3_millis INTEGER,
      PRIMARY KEY (race_id, type, driver_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS season_entrant_driver (
      year INTEGER,
      entrant_id TEXT,
      constructor_id TEXT,
      driver_id TEXT,
      test_driver BOOLEAN DEFAULT false,
      PRIMARY KEY (year, entrant_id, constructor_id, driver_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pace_metric_summary_driver_season (
      driver_id TEXT,
      season INTEGER,
      metric_name VARCHAR(50),
      metric_value NUMERIC,
      normalization VARCHAR(50),
      laps_considered INTEGER,
      clean_air_only BOOLEAN,
      compound_context VARCHAR(20),
      session_scope VARCHAR(20)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pace_metric_summary_driver_track (
      driver_id TEXT,
      season INTEGER,
      track_id VARCHAR(50),
      metric_name VARCHAR(50),
      metric_value NUMERIC,
      normalization VARCHAR(50),
      laps_considered INTEGER,
      clean_air_only BOOLEAN,
      compound_context VARCHAR(20),
      session_scope VARCHAR(20)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_season_summary_2025 (
      season INTEGER,
      team_id TEXT,
      driver_primary_id TEXT,
      driver_secondary_id TEXT,
      driver_pair_gap_percent NUMERIC,
      driver_pair_gap_seconds NUMERIC,
      gap_percent NUMERIC,
      shared_races INTEGER,
      faster_driver_primary_count INTEGER,
      coverage_status TEXT,
      failure_reason TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_season_entries (
      driver_id TEXT,
      year INTEGER,
      PRIMARY KEY (driver_id, year)
    );
  `);
}

/**
 * Seed the database with deterministic fixture data
 */
export async function seedFixtureData(pool: Pool): Promise<void> {
  // Seasons
  await pool.query(`
    INSERT INTO season (year)
    VALUES ${FIXTURES.seasons.map(s => `(${s})`).join(', ')}
    ON CONFLICT DO NOTHING;
  `);

  // Drivers
  for (const driver of FIXTURES.drivers) {
    await pool.query(`
      INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING;
    `, [driver.id, driver.last_name, driver.full_name, driver.first_name, driver.last_name, driver.abbreviation]);
  }

  // Circuits
  for (const circuit of FIXTURES.circuits) {
    await pool.query(`
      INSERT INTO circuit (id, name, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING;
    `, [circuit.id, circuit.name, circuit.full_name]);
  }

  // Grand Prix
  for (const gp of FIXTURES.grandPrix) {
    await pool.query(`
      INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING;
    `, [gp.id, gp.name, gp.full_name, gp.short_name, gp.abbreviation]);
  }

  // Races
  for (const race of FIXTURES.races) {
    await pool.query(`
      INSERT INTO race (id, year, round)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING;
    `, [race.id, race.year, race.round]);
  }

  // Race data
  for (const rd of FIXTURES.raceData) {
    await pool.query(`
      INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number, race_reason_retired)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING;
    `, [rd.race_id, rd.type, rd.driver_id, rd.constructor_id, rd.position_number, rd.race_reason_retired]);
  }

  // Season entrant drivers (team assignments)
  for (const sed of FIXTURES.seasonEntrantDrivers) {
    await pool.query(`
      INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING;
    `, [sed.year, sed.entrant_id, sed.constructor_id, sed.driver_id, sed.test_driver]);
  }

  // Pace metrics (season-level)
  for (const pm of FIXTURES.paceMetricsSeason) {
    await pool.query(`
      INSERT INTO pace_metric_summary_driver_season
        (driver_id, season, metric_name, metric_value, normalization, laps_considered, clean_air_only, compound_context, session_scope)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING;
    `, [pm.driver_id, pm.season, pm.metric_name, pm.metric_value, pm.normalization, pm.laps_considered, pm.clean_air_only, pm.compound_context, pm.session_scope]);
  }

  // Pace metrics (track-level)
  for (const pm of FIXTURES.paceMetricsTrack) {
    await pool.query(`
      INSERT INTO pace_metric_summary_driver_track
        (driver_id, season, track_id, metric_name, metric_value, normalization, laps_considered, clean_air_only, compound_context, session_scope)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT DO NOTHING;
    `, [pm.driver_id, pm.season, pm.track_id, pm.metric_name, pm.metric_value, pm.normalization, pm.laps_considered, pm.clean_air_only, pm.compound_context, pm.session_scope]);
  }

  // Teammate gap summaries
  for (const tg of FIXTURES.teammateGapSummaries) {
    await pool.query(`
      INSERT INTO teammate_gap_season_summary_2025
        (season, team_id, driver_primary_id, driver_secondary_id, driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races, faster_driver_primary_count, coverage_status, failure_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING;
    `, [tg.season, tg.team_id, tg.driver_primary_id, tg.driver_secondary_id, tg.driver_pair_gap_percent, tg.driver_pair_gap_seconds, tg.gap_percent, tg.shared_races, tg.faster_driver_primary_count, tg.coverage_status, tg.failure_reason]);
  }

  // Laps normalized
  for (const lap of FIXTURES.lapsNormalized) {
    await pool.query(`
      INSERT INTO laps_normalized
        (season, round, track_id, driver_id, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, clean_air_flag, is_out_lap, is_in_lap)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING;
    `, [lap.season, lap.round, lap.track_id, lap.driver_id, lap.lap_number, lap.lap_time_seconds, lap.is_valid_lap, lap.is_pit_lap, lap.clean_air_flag, lap.is_out_lap || false, lap.is_in_lap || false]);
  }

  // Matchup matrix
  for (const mm of FIXTURES.matchupMatrix) {
    await pool.query(`
      INSERT INTO driver_matchup_matrix_2025
        (driver_a_id, driver_b_id, metric, season, driver_a_wins, driver_b_wins, ties, shared_events, coverage_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING;
    `, [mm.driver_a_id, mm.driver_b_id, mm.metric, mm.season, mm.driver_a_wins, mm.driver_b_wins, mm.ties, mm.shared_events, mm.coverage_status]);
  }
}

/**
 * Reset the database by truncating all tables
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      driver_matchup_matrix_2025,
      api_query_cache,
      teammate_gap_season_summary_2025,
      pace_metric_summary_driver_track,
      pace_metric_summary_driver_season,
      laps_normalized,
      race_data,
      race,
      season_entrant_driver,
      driver_season_entries,
      grand_prix,
      circuit,
      season,
      driver
    CASCADE;
  `);
}

/**
 * Full database setup - migrations + seed
 */
export async function ensureDatabase(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await seedFixtureData(pool);
}

/**
 * Complete teardown
 */
export async function teardownDatabase(pool: Pool): Promise<void> {
  await pool.end();
}

/**
 * Utility: Wrap integration test that requires database
 */
export function withDatabase<T>(
  testFn: (pool: Pool) => Promise<T>
): () => Promise<T> {
  return async () => {
    const pool = createIntegrationPool();
    try {
      return await testFn(pool);
    } finally {
      await pool.end();
    }
  };
}
