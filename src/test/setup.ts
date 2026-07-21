import { Pool } from 'pg';

const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/f1muse_test';

function assertLocalDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error(
      `Unsafe test database host "${hostname}". Tests must run against localhost only.`
    );
  }
}

/**
 * Resolve a safe local database URL for tests.
 */
export function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL_TEST ||
    process.env.TEST_DATABASE_URL ||
    DEFAULT_TEST_DATABASE_URL;

  assertLocalDatabaseUrl(databaseUrl);
  return databaseUrl;
}

/**
 * Test database setup and mock data
 */
export interface TestDatabaseOptions {
  seed?: boolean;
}

export async function setupTestDatabase(
  pool: Pool,
  options: TestDatabaseOptions = {}
): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS driver_season_entries, 
    race_data,
    race,
    qualifying_results,
    season_driver_standing,
    season_constructor_standing,
    driver_matchup_matrix_2025,
    api_query_cache,
    laps_normalized_v2,
    laps_normalized, 
    pace_metric_summary_driver_track, 
    pace_metric_summary_driver_season, 
    teammate_gap_season_summary_2025,
    teammate_gap_race_level_2025,
    teammate_gap_qualifying_race_level_2025,
    teammate_gap_qualifying_season_summary_2025,
    ingestion_runs_teammate_gap,
    season_entrant_driver, 
    season, 
    grand_prix, 
    circuit, 
    constructor,
    driver CASCADE;
  `);

  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS f1ql;`);

  console.log('Creating table: driver');
  // F1DB reference tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      abbreviation TEXT NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS first_name TEXT;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS last_name TEXT;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_championship_wins INTEGER;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_podiums INTEGER;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_race_wins INTEGER;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_race_starts INTEGER;`);
  await pool.query(`ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_pole_positions INTEGER;`);

  console.log('Creating table: circuit');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuit (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      previous_names TEXT,
      type TEXT
    );
  `);

  console.log('Creating table: constructor');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS constructor (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  console.log('Creating table: grand_prix');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grand_prix (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      abbreviation TEXT NOT NULL
    );
  `);

  console.log('Creating table: season');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS season (
      year INTEGER PRIMARY KEY
    );
  `);

  console.log('Creating table: race');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS race (
      id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL,
      round INTEGER NOT NULL,
      circuit_id TEXT,
      grand_prix_id TEXT,
      official_name TEXT,
      date DATE
    );
  `);

  console.log('Creating table: race_data');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS race_data (
      race_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      constructor_id TEXT,
      position_display_order INTEGER,
      position_number INTEGER,
      position_text TEXT,
      driver_number TEXT,
      engine_manufacturer_id TEXT,
      tyre_manufacturer_id TEXT,
      race_reason_retired TEXT,
      race_points NUMERIC,
      race_fastest_lap BOOLEAN,
      race_time TEXT,
      race_time_millis INTEGER,
      race_gap TEXT,
      race_gap_millis INTEGER,
      race_laps INTEGER,
      fastest_lap_time TEXT,
      race_grid_position_number INTEGER,
      qualifying_q1 INTEGER,
      qualifying_q2 INTEGER,
      qualifying_q3 INTEGER,
      qualifying_q1_millis INTEGER,
      qualifying_q2_millis INTEGER,
      qualifying_q3_millis INTEGER,
      PRIMARY KEY (race_id, type, driver_id),
      UNIQUE (race_id, type, position_display_order)
    );
  `);

  console.log('Creating table: qualifying_results');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qualifying_results (
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      driver_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      track_id TEXT,
      qualifying_position INTEGER,
      grid_position INTEGER,
      session_type TEXT,
      q1_time_ms INTEGER,
      q2_time_ms INTEGER,
      q3_time_ms INTEGER,
      best_time_ms INTEGER,
      best_session TEXT,
      eliminated_in_round TEXT,
      is_dnf BOOLEAN DEFAULT false,
      is_dns BOOLEAN DEFAULT false,
      PRIMARY KEY (season, round, driver_id)
    );
  `);

  console.log('Creating table: season_driver_standing');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS season_driver_standing (
      year INTEGER NOT NULL,
      position_display_order INTEGER NOT NULL,
      position_number INTEGER,
      position_text TEXT,
      driver_id TEXT NOT NULL,
      points NUMERIC NOT NULL,
      championship_won BOOLEAN DEFAULT false,
      PRIMARY KEY (year, position_display_order)
    );
  `);

  console.log('Creating table: season_constructor_standing');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS season_constructor_standing (
      year INTEGER NOT NULL,
      position_display_order INTEGER NOT NULL,
      position_number INTEGER,
      position_text TEXT,
      constructor_id TEXT NOT NULL,
      engine_manufacturer_id TEXT,
      points NUMERIC NOT NULL,
      championship_won BOOLEAN DEFAULT false,
      PRIMARY KEY (year, position_display_order)
    );
  `);

  console.log('Creating table: driver_matchup_matrix');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_matchup_matrix (
      driver_a_id TEXT NOT NULL,
      driver_b_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      season INTEGER NOT NULL,
      driver_a_wins INTEGER NOT NULL DEFAULT 0,
      driver_b_wins INTEGER NOT NULL DEFAULT 0,
      ties INTEGER NOT NULL DEFAULT 0,
      shared_events INTEGER NOT NULL DEFAULT 0,
      coverage_status TEXT NOT NULL DEFAULT 'insufficient',
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (driver_a_id, driver_b_id, metric, season)
    );
  `);

  console.log('Creating table: driver_matchup_matrix_2025');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_matchup_matrix_2025 (
      driver_a_id TEXT NOT NULL,
      driver_b_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      season INTEGER NOT NULL,
      driver_a_wins INTEGER NOT NULL DEFAULT 0,
      driver_b_wins INTEGER NOT NULL DEFAULT 0,
      ties INTEGER NOT NULL DEFAULT 0,
      shared_events INTEGER NOT NULL DEFAULT 0,
      coverage_status TEXT NOT NULL DEFAULT 'insufficient',
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (driver_a_id, driver_b_id, metric, season)
    );
  `);

  console.log('Creating table: api_query_cache');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_query_cache (
      cache_key TEXT PRIMARY KEY,
      query_kind TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      parameters JSONB NOT NULL,
      response JSONB NOT NULL,
      confidence_level TEXT NOT NULL,
      coverage_percent NUMERIC(5,2),
      shared_events INTEGER,
      methodology_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TIMESTAMPTZ
    );
  `);

  console.log('Creating table: season_entrant_driver');
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

  console.log('Creating table: pace_metric_summary_driver_season');
  // Analytics tables
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

  console.log('Creating table: pace_metric_summary_driver_track');
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

  console.log('Creating table: teammate_gap_season_summary_2025');
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

  console.log('Creating table: laps_normalized');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS laps_normalized (
      season INTEGER,
      round INTEGER,
      track_id TEXT,
      driver_id TEXT,
      lap_number INTEGER,
      lap_time_seconds NUMERIC,
      is_valid_lap BOOLEAN,
      is_pit_lap BOOLEAN,
      clean_air_flag BOOLEAN,
      stint_id INTEGER DEFAULT 0,
      stint_lap_index INTEGER DEFAULT 0,
      compound TEXT,
      tyre_age_laps INTEGER,
      race_name TEXT,
      session_type TEXT,
      is_out_lap BOOLEAN DEFAULT false,
      is_in_lap BOOLEAN DEFAULT false,
      PRIMARY KEY (season, round, track_id, driver_id, lap_number)
    );
  `);

  console.log('Creating table: laps_normalized_v2');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS laps_normalized_v2 (
      season INTEGER NOT NULL, round INTEGER NOT NULL, track_id TEXT NOT NULL,
      driver_id TEXT NOT NULL, session_type TEXT NOT NULL, lap_number INTEGER NOT NULL,
      lap_time_seconds NUMERIC, is_valid_lap BOOLEAN NOT NULL, is_pit_lap BOOLEAN NOT NULL,
      clean_air_flag BOOLEAN NOT NULL, stint_id INTEGER NOT NULL DEFAULT 0,
      stint_lap_index INTEGER NOT NULL DEFAULT 0, compound TEXT, tyre_age_laps INTEGER,
      is_out_lap BOOLEAN NOT NULL DEFAULT false, is_in_lap BOOLEAN NOT NULL DEFAULT false,
      methodology_version TEXT NOT NULL,
      PRIMARY KEY (season, round, track_id, driver_id, session_type, lap_number)
    );
  `);

  console.log('Creating table: teammate gap compatibility tables');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_season_summary (
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
    CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_season_summary_2025 (
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
    CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_season_summary (
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
    CREATE VIEW qualifying_results_official AS
      SELECT
        qr.season,
        qr.round,
        qr.driver_id,
        qr.team_id,
        qr.track_id,
        qr.qualifying_position,
        COALESCE(qr.grid_position, qr.qualifying_position) AS official_grid_position,
        false AS has_grid_correction,
        NULL::text AS correction_reason,
        qr.q1_time_ms,
        qr.q2_time_ms,
        qr.q3_time_ms,
        qr.best_time_ms,
        qr.best_session,
        qr.eliminated_in_round,
        qr.is_dnf,
        qr.is_dns,
        qr.session_type
      FROM qualifying_results qr;
  `);

  console.log('Creating table: driver_season_entries');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_season_entries (
      driver_id TEXT,
      year INTEGER,
      PRIMARY KEY (driver_id, year)
    );
  `);

  await pool.query(`
    CREATE OR REPLACE VIEW f1ql.driver_standings AS
    SELECT
      s.year AS season,
      REPLACE(s.driver_id, '_', '-') AS driver_id,
      s.position_number AS championship_position,
      s.points AS points,
      s.championship_won
    FROM season_driver_standing s;

    CREATE OR REPLACE VIEW f1ql.lap_pace AS
    SELECT
      l.season,
      l.round,
      l.track_id AS event_id,
      REPLACE(l.driver_id, '_', '-') AS driver_id,
      l.lap_time_seconds,
      l.is_valid_lap,
      l.is_pit_lap,
      l.is_in_lap,
      l.is_out_lap,
      l.clean_air_flag,
      l.compound,
      l.tyre_age_laps,
      l.session_type,
      l.methodology_version
    FROM laps_normalized_v2 l;

    CREATE OR REPLACE VIEW f1ql.event_classification AS
    SELECT r.year AS season, r.round, REPLACE(rd.driver_id, '_', '-') AS driver_id, rd.constructor_id AS team_id,
      rd.position_number AS finishing_position, rd.race_points AS points,
      CASE
        WHEN UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('DSQ', 'DISQUALIFIED') THEN 'dsq'
        WHEN UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('DNS', 'DID NOT START') THEN 'dns'
        WHEN rd.position_number IS NOT NULL AND rd.race_reason_retired IS NULL THEN 'classified'
        WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('DNS', 'DID NOT START') THEN 'dns'
        WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('DSQ', 'DISQUALIFIED') THEN 'dsq'
        WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('NC', 'NOT CLASSIFIED') THEN 'not_classified'
        WHEN UPPER(COALESCE(rd.race_reason_retired, '')) IN ('WD', 'WITHDRAWN') THEN 'withdrawn'
        ELSE 'dnf'
      END AS classification_status,
      COALESCE(NULLIF(BTRIM(rd.position_text), ''), rd.race_reason_retired) AS status_reason
    FROM race_data rd JOIN race r ON r.id = rd.race_id
    WHERE LOWER(rd.type) IN ('race', 'race_result');

    CREATE OR REPLACE VIEW f1ql.qualifying_classification AS
    SELECT
      qr.season,
      qr.round,
      REPLACE(qr.driver_id, '_', '-') AS driver_id,
      qr.team_id,
      qr.qualifying_position,
      qr.best_time_ms,
      qr.best_session,
      qr.eliminated_in_round,
      CASE
        WHEN COALESCE(qr.is_dns, false) THEN 'dns'
        WHEN COALESCE(qr.is_dnf, false) THEN 'dnf'
        ELSE 'classified'
      END AS classification_status
    FROM qualifying_results qr;

    CREATE OR REPLACE VIEW f1ql.event_metadata AS
    SELECT
      r.year AS season,
      r.round,
      COALESCE(REPLACE(r.grand_prix_id, '_', '-'), r.circuit_id) AS event_id,
      COALESCE(gp.full_name, gp.name, r.official_name) AS event_name,
      r.circuit_id,
      r.date
    FROM race r
    LEFT JOIN grand_prix gp ON gp.id = r.grand_prix_id;
  `);

  if (options.seed !== false) {
    await insertTestData(pool);
  }
}

export async function cleanupTestDatabase(_pool: Pool): Promise<void> {
  // NOTE: Skipping table drops since setup already resets state per run.
}

async function insertTestData(pool: Pool): Promise<void> {
  // Seasons
  await pool.query(`
    INSERT INTO season (year) VALUES (2020), (2022), (2023), (2024), (2025)
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO race (id, year, round) VALUES
    (1001, 2025, 1),
    (1002, 2025, 2),
    (1003, 2025, 3)
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO race_data (race_id, type, driver_id, position_number, race_reason_retired) VALUES
    (1001, 'race', 'lando_norris', 1, NULL),
    (1002, 'race', 'lando_norris', 3, NULL),
    (1003, 'race', 'lando_norris', NULL, 'DNF')
    ON CONFLICT DO NOTHING;
  `);

  const driverColumnResult = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'driver'
  `);

  const driverColumns = new Set(
    driverColumnResult.rows.map(row => row.column_name)
  );

  const baseStats = {
    total_championship_wins: 0,
    total_race_entries: 0,
    total_race_starts: 0,
    total_race_wins: 0,
    total_race_laps: 0,
    total_podiums: 0,
    total_points: 0,
    total_championship_points: 0,
    total_pole_positions: 0,
    total_fastest_laps: 0,
    total_sprint_race_starts: 0,
    total_sprint_race_wins: 0,
    total_driver_of_the_day: 0,
    total_grand_slams: 0
  };

  const driverRows = [
    {
      id: 'max_verstappen',
      name: 'Verstappen',
      full_name: 'Max Verstappen',
      first_name: 'Max',
      last_name: 'Verstappen',
      abbreviation: 'VER',
      gender: 'male',
      date_of_birth: '1997-09-30',
      place_of_birth: 'Hasselt',
      country_of_birth_country_id: 'belgium',
      nationality_country_id: 'netherlands',
      ...baseStats,
      total_championship_wins: 3,
      total_race_wins: 54,
      total_podiums: 98
    },
    {
      id: 'charles_leclerc',
      name: 'Leclerc',
      full_name: 'Charles Leclerc',
      first_name: 'Charles',
      last_name: 'Leclerc',
      abbreviation: 'LEC',
      gender: 'male',
      date_of_birth: '1997-10-16',
      place_of_birth: 'Monte Carlo',
      country_of_birth_country_id: 'monaco',
      nationality_country_id: 'monaco',
      ...baseStats
    },
    {
      id: 'carlos_sainz',
      name: 'Sainz',
      full_name: 'Carlos Sainz',
      first_name: 'Carlos',
      last_name: 'Sainz',
      abbreviation: 'SAI',
      gender: 'male',
      date_of_birth: '1994-09-01',
      place_of_birth: 'Madrid',
      country_of_birth_country_id: 'spain',
      nationality_country_id: 'spain',
      ...baseStats
    },
    {
      id: 'fernando_alonso',
      name: 'Alonso',
      full_name: 'Fernando Alonso',
      first_name: 'Fernando',
      last_name: 'Alonso',
      abbreviation: 'ALO',
      gender: 'male',
      date_of_birth: '1981-07-29',
      place_of_birth: 'Oviedo',
      country_of_birth_country_id: 'spain',
      nationality_country_id: 'spain',
      ...baseStats
    },
    {
      id: 'lando_norris',
      name: 'Norris',
      full_name: 'Lando Norris',
      first_name: 'Lando',
      last_name: 'Norris',
      abbreviation: 'NOR',
      gender: 'male',
      date_of_birth: '1999-11-13',
      place_of_birth: 'Bristol',
      country_of_birth_country_id: 'united-kingdom',
      nationality_country_id: 'united-kingdom',
      ...baseStats
    },
    {
      id: 'oscar_piastri',
      name: 'Piastri',
      full_name: 'Oscar Piastri',
      first_name: 'Oscar',
      last_name: 'Piastri',
      abbreviation: 'PIA',
      gender: 'male',
      date_of_birth: '2001-04-06',
      place_of_birth: 'Melbourne',
      country_of_birth_country_id: 'australia',
      nationality_country_id: 'australia',
      ...baseStats
    },
    {
      id: 'charles_pic',
      name: 'Pic',
      full_name: 'Charles Pic',
      first_name: 'Charles',
      last_name: 'Pic',
      abbreviation: 'PIC',
      gender: 'male',
      date_of_birth: '1990-02-15',
      place_of_birth: 'Montelimar',
      country_of_birth_country_id: 'france',
      nationality_country_id: 'france',
      ...baseStats
    },
    {
      id: 'michael_schumacher',
      name: 'Schumacher',
      full_name: 'Michael Schumacher',
      first_name: 'Michael',
      last_name: 'Schumacher',
      abbreviation: 'MSC',
      gender: 'male',
      date_of_birth: '1969-01-03',
      place_of_birth: 'Huerth',
      country_of_birth_country_id: 'germany',
      nationality_country_id: 'germany',
      ...baseStats
    },
    {
      id: 'mick_schumacher',
      name: 'Schumacher',
      full_name: 'Mick Schumacher',
      first_name: 'Mick',
      last_name: 'Schumacher',
      abbreviation: 'MSC',
      gender: 'male',
      date_of_birth: '1999-03-22',
      place_of_birth: 'Vufflens',
      country_of_birth_country_id: 'switzerland',
      nationality_country_id: 'germany',
      ...baseStats
    },
    {
      id: 'ayrton_senna',
      name: 'Senna',
      full_name: 'Ayrton Senna',
      first_name: 'Ayrton',
      last_name: 'Senna',
      abbreviation: 'SEN',
      gender: 'male',
      date_of_birth: '1960-03-21',
      place_of_birth: 'Sao Paulo',
      country_of_birth_country_id: 'brazil',
      nationality_country_id: 'brazil',
      ...baseStats
    },
    {
      id: 'sergio_perez',
      name: 'Perez',
      full_name: 'Sergio Perez',
      first_name: 'Sergio',
      last_name: 'Perez',
      abbreviation: 'PER',
      gender: 'male',
      date_of_birth: '1990-01-26',
      place_of_birth: 'Guadalajara',
      country_of_birth_country_id: 'mexico',
      nationality_country_id: 'mexico',
      ...baseStats
    },
    {
      id: 'lewis_hamilton',
      name: 'Hamilton',
      full_name: 'Lewis Hamilton',
      first_name: 'Lewis',
      last_name: 'Hamilton',
      abbreviation: 'HAM',
      gender: 'male',
      date_of_birth: '1985-01-07',
      place_of_birth: 'Stevenage',
      country_of_birth_country_id: 'united-kingdom',
      nationality_country_id: 'united-kingdom',
      ...baseStats
    },
    {
      id: 'george_russell',
      name: 'Russell',
      full_name: 'George Russell',
      first_name: 'George',
      last_name: 'Russell',
      abbreviation: 'RUS',
      gender: 'male',
      date_of_birth: '1998-02-15',
      place_of_birth: 'King\'s Lynn',
      country_of_birth_country_id: 'united-kingdom',
      nationality_country_id: 'united-kingdom',
      ...baseStats
    },
    {
      id: 'max_chilton',
      name: 'Chilton',
      full_name: 'Max Chilton',
      first_name: 'Max',
      last_name: 'Chilton',
      abbreviation: 'CHI',
      gender: 'male',
      date_of_birth: '1991-04-21',
      place_of_birth: 'Reigate',
      country_of_birth_country_id: 'united-kingdom',
      nationality_country_id: 'united-kingdom',
      ...baseStats
    },
    {
      id: 'michael_andretti',
      name: 'Andretti',
      full_name: 'Michael Andretti',
      first_name: 'Michael',
      last_name: 'Andretti',
      abbreviation: 'AND',
      gender: 'male',
      date_of_birth: '1962-10-05',
      place_of_birth: 'Bethlehem',
      country_of_birth_country_id: 'united-states-of-america',
      nationality_country_id: 'united-states-of-america',
      ...baseStats
    },
    {
      id: 'luigi_piotti',
      name: 'Piotti',
      full_name: 'Luigi Piotti',
      first_name: 'Luigi',
      last_name: 'Piotti',
      abbreviation: 'PIO',
      gender: 'male',
      date_of_birth: '1921-01-01',
      place_of_birth: 'Brescia',
      country_of_birth_country_id: 'italy',
      nationality_country_id: 'italy',
      ...baseStats
    }
  ];

  const driverInsertColumns = [
    'id',
    'name',
    'full_name',
    'first_name',
    'last_name',
    'abbreviation',
    'gender',
    'date_of_birth',
    'place_of_birth',
    'country_of_birth_country_id',
    'nationality_country_id',
    'total_championship_wins',
    'total_race_entries',
    'total_race_starts',
    'total_race_wins',
    'total_race_laps',
    'total_podiums',
    'total_points',
    'total_championship_points',
    'total_pole_positions',
    'total_fastest_laps',
    'total_sprint_race_starts',
    'total_sprint_race_wins',
    'total_driver_of_the_day',
    'total_grand_slams'
  ].filter(column => driverColumns.has(column));

  if (driverInsertColumns.length > 0) {
    const driverValues: Array<string | number> = [];
    const driverPlaceholders: string[] = [];

    for (const row of driverRows) {
      const rowPlaceholders = driverInsertColumns.map(column => {
        const value = (row as Record<string, string | number>)[column];
        driverValues.push(value);
        return `$${driverValues.length}`;
      });
      driverPlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    await pool.query(
      `INSERT INTO driver (${driverInsertColumns.join(', ')}) VALUES ${driverPlaceholders.join(', ')} ON CONFLICT DO NOTHING;`,
      driverValues
    );
  }

  // Circuits
  await pool.query(`
    INSERT INTO circuit (id, name, full_name, previous_names) VALUES
    ('suzuka', 'Suzuka', 'Suzuka International Racing Course', 'Japan'),
    ('monza', 'Monza', 'Autodromo Nazionale di Monza', NULL),
    ('silverstone', 'Silverstone', 'Silverstone Circuit', NULL),
    ('bahrain', 'Bahrain', 'Bahrain International Circuit', NULL),
    ('jeddah', 'Jeddah', 'Jeddah Corniche Circuit', NULL),
    ('monaco', 'Monaco', 'Circuit de Monaco', NULL),
    ('autodromo_old', 'Autodromo', 'Autodromo (Old Layout)', NULL),
    ('autodromo_new', 'Autodromo', 'Autodromo (New Layout)', NULL)
    ON CONFLICT DO NOTHING;
  `);

  // Grand Prix
  await pool.query(`
    INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
    ('japanese_gp', 'Japanese Grand Prix', 'Formula 1 Japanese Grand Prix', 'Japanese GP', 'JPN'),
    ('italian_gp', 'Italian Grand Prix', 'Formula 1 Italian Grand Prix', 'Italian GP', 'ITA'),
    ('british_gp', 'British Grand Prix', 'Formula 1 British Grand Prix', 'British GP', 'GBR'),
    ('bahrain_gp', 'Bahrain Grand Prix', 'Formula 1 Bahrain Grand Prix', 'Bahrain GP', 'BHR'),
    ('saudi_gp', 'Saudi Arabian Grand Prix', 'Formula 1 Saudi Arabian Grand Prix', 'Saudi GP', 'SAU'),
    ('monaco_gp', 'Monaco Grand Prix', 'Formula 1 Monaco Grand Prix', 'Monaco GP', 'MON')
    ON CONFLICT DO NOTHING;
  `);

  // Season entrant drivers
  await pool.query(`
    INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
    (2020, 'haas', 'HAAS', 'mick_schumacher', false),
    (2023, 'ferrari', 'FER', 'charles_leclerc', false),
    (2023, 'ferrari', 'FER', 'carlos_sainz', false),
    (2023, 'red_bull', 'RBR', 'max_verstappen', false),
    (2023, 'aston', 'AMR', 'fernando_alonso', false),
    (2024, 'mclaren', 'MCL', 'lando_norris', false),
    (2024, 'mclaren', 'MCL', 'oscar_piastri', false),
    (2025, 'ferrari', 'FER', 'charles-leclerc', false),
    (2025, 'ferrari', 'FER', 'carlos-sainz', false),
    (2025, 'mclaren', 'MCL', 'lando-norris', false),
    (2025, 'mclaren', 'MCL', 'oscar-piastri', false),
    (2025, 'red_bull', 'RBR', 'max-verstappen', false),
    (2025, 'red_bull', 'RBR', 'sergio-perez', false),
    (2025, 'aston', 'AMR', 'fernando-alonso', false)
    ON CONFLICT DO NOTHING;
  `);

  // Driver Season Entries
  await pool.query(`
    INSERT INTO driver_season_entries (driver_id, year) VALUES
    ('michael_schumacher', 1991),
    ('mick_schumacher', 2020),
    ('ayrton_senna', 1984),
    ('max_verstappen', 2015),
    ('charles_leclerc', 2018),
    ('carlos_sainz', 2015),
    ('lando_norris', 2019),
    ('oscar_piastri', 2023)
    ON CONFLICT DO NOTHING;
  `);

  // Pace metrics (season-level)
  await pool.query(`
    INSERT INTO pace_metric_summary_driver_season
    (driver_id, season, metric_name, metric_value, normalization, laps_considered, clean_air_only, compound_context, session_scope)
    VALUES
    ('charles_leclerc', 2023, 'driver_above_baseline', 0.15, 'team_baseline', 250, false, 'mixed', 'all'),
    ('carlos_sainz', 2023, 'driver_above_baseline', 0.25, 'team_baseline', 240, false, 'mixed', 'all'),
    ('max_verstappen', 2023, 'driver_above_baseline', -0.35, 'car_baseline_adjusted', 300, false, 'mixed', 'all'),
    ('fernando_alonso', 2023, 'driver_above_baseline', 0.10, 'car_baseline_adjusted', 280, false, 'mixed', 'all'),
    ('charles_leclerc', 2023, 'avg_true_pace', 90.1, 'none', 245, false, 'mixed', 'all'),
    ('max_verstappen', 2023, 'avg_true_pace', 90.5, 'none', 250, false, 'mixed', 'all'),
    ('fernando_alonso', 2023, 'avg_true_pace', 91.0, 'none', 240, false, 'mixed', 'all'),
    ('max_verstappen', 2025, 'driver_above_baseline', -0.22, 'car_baseline_adjusted', 320, false, 'mixed', 'all'),
    ('lando_norris', 2025, 'driver_above_baseline', 0.08, 'car_baseline_adjusted', 295, false, 'mixed', 'all')
    ON CONFLICT DO NOTHING;
  `);

  // Pace metrics (track-level)
  await pool.query(`
    INSERT INTO pace_metric_summary_driver_track
    (driver_id, season, track_id, metric_name, metric_value, normalization, laps_considered, clean_air_only, compound_context, session_scope)
    VALUES
    ('max_verstappen', 2023, 'suzuka', 'avg_true_pace', 91.5, 'none', 50, false, 'mixed', 'race'),
    ('fernando_alonso', 2023, 'suzuka', 'avg_true_pace', 92.1, 'none', 48, false, 'mixed', 'race'),
    ('max_verstappen', 2023, 'monza', 'avg_true_pace', 84.2, 'none', 55, false, 'mixed', 'race'),
    ('charles_leclerc', 2023, 'monza', 'avg_true_pace', 84.0, 'none', 53, false, 'mixed', 'race'),
    ('lando_norris', 2024, 'silverstone', 'avg_true_pace', 88.5, 'none', 52, false, 'mixed', 'race'),
    ('oscar_piastri', 2024, 'silverstone', 'avg_true_pace', 88.7, 'none', 51, false, 'mixed', 'race')
    ON CONFLICT DO NOTHING;
  `);

  // Laps for shared-lap coverage checks
  await pool.query(`
    INSERT INTO laps_normalized
    (season, round, track_id, driver_id, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, clean_air_flag)
    VALUES
    (2023, 1, 'suzuka', 'max_verstappen', 1, 91.1, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 1, 92.0, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 2, 91.2, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 2, 92.1, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 3, 91.3, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 3, 92.2, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 4, 91.4, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 4, 92.3, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 5, 91.5, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 5, 92.4, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 6, 91.6, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 6, 92.5, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 7, 91.7, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 7, 92.6, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 8, 91.8, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 8, 92.7, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 9, 91.9, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 9, 92.8, true, false, true),
    (2023, 1, 'suzuka', 'max_verstappen', 10, 92.0, true, false, true),
    (2023, 1, 'suzuka', 'fernando_alonso', 10, 92.9, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 1, 85.0, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 2, 85.1, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 3, 85.2, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 4, 85.3, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 5, 85.4, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 6, 85.5, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 7, 85.6, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 8, 85.7, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 9, 85.8, true, false, true),
    (2006, 1, 'monza', 'michael_schumacher', 10, 85.9, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 1, 90.1, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 2, 90.2, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 3, 90.3, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 4, 90.4, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 5, 90.5, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 6, 90.6, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 7, 90.7, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 8, 90.8, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 9, 90.9, true, false, true),
    (2025, 1, 'suzuka', 'lando_norris', 10, 91.0, true, false, true)
  `);

  // TrackResolver returns the lap-data grand-prix ID, not the circuit ID.
  await pool.query(`
    UPDATE pace_metric_summary_driver_track
    SET track_id = 'japanese_grand_prix'
    WHERE track_id = 'suzuka';

    UPDATE laps_normalized
    SET track_id = 'japanese_grand_prix'
    WHERE track_id = 'suzuka';

    INSERT INTO laps_normalized (
      season,
      round,
      track_id,
      driver_id,
      lap_number,
      lap_time_seconds,
      is_valid_lap,
      is_pit_lap,
      clean_air_flag
    )
    SELECT
      season,
      round,
      track_id,
      'charles_leclerc',
      lap_number,
      lap_time_seconds + 0.4,
      is_valid_lap,
      is_pit_lap,
      clean_air_flag
    FROM laps_normalized
    WHERE season = 2023
      AND track_id = 'japanese_grand_prix'
      AND driver_id = 'max_verstappen'
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO teammate_gap_season_summary_2025
    (season, team_id, driver_primary_id, driver_secondary_id, driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races, faster_driver_primary_count, coverage_status, failure_reason)
    VALUES
    (2025, 'MCL', 'lando_norris', 'oscar_piastri', 0.140, 0.12, 0.140, 8, 5, 'valid', NULL)
  `);
}
