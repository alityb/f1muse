#!/usr/bin/env node

/**
 * TEAMMATE GAP INGESTION PIPELINE - 2025 SEASON
 *
 * RACE PACE (MEDIAN LAP TIMES) WITH SYMMETRIC PERCENT DIFFERENCE
 *
 * Methodology:
 * 1. For each race, identify teammate pairs (same constructor_id)
 * 2. Require both drivers are classified and have valid laps
 * 3. Compute median lap time per driver (filtered laps only)
 * 4. gap_percent = 100 * (a - b) / ((a + b) / 2)
 *    - Negative = primary driver faster
 *    - Positive = secondary driver faster
 * 5. Store race-level results
 * 6. Aggregate to season median
 *
 * Safety Rules:
 * - Manual execution only
 * - Deterministic SQL (no loops in JS)
 * - Fail-closed on schema mismatch
 * - Transactional (all-or-nothing)
 * - Auditable with execution_hash
 *
 * Usage:
 *   npx tsx src/ingestion/teammate-gap-race-2025.ts
 */

import 'dotenv/config';
import { Pool } from 'pg';
import {
  TEAMMATE_GAP_THRESHOLDS,
  DEFAULT_ETL_CONFIG,
  TeammateGapETLConfig
} from '../../config/teammate-gap';
import {
  validateTableSchema,
  fingerprintTable,
  computeExecutionHash
} from './utils';

interface ExecutionMetrics {
  race_rows_written: number;
  season_rows_written: number;
  valid_pairs: number;
  low_coverage_pairs: number;
  insufficient_pairs: number;
  execution_hash: string;
}

function buildTeamIdCase(columnRef: string): string {
  return `
    CASE
      WHEN LOWER(${columnRef}) IN ('mclaren', 'mcl') THEN 'mclaren'
      WHEN LOWER(${columnRef}) IN ('ferrari', 'fer') THEN 'ferrari'
      WHEN LOWER(${columnRef}) IN ('red-bull', 'red_bull', 'redbull', 'rbr') THEN 'red-bull'
      WHEN LOWER(${columnRef}) IN ('mercedes', 'mer') THEN 'mercedes'
      WHEN LOWER(${columnRef}) IN ('aston-martin', 'aston_martin', 'amr') THEN 'aston-martin'
      WHEN LOWER(${columnRef}) IN ('alpine', 'alp') THEN 'alpine'
      WHEN LOWER(${columnRef}) IN ('williams', 'wil') THEN 'williams'
      WHEN LOWER(${columnRef}) IN ('haas', 'haa') THEN 'haas'
      WHEN LOWER(${columnRef}) IN ('racing-bulls', 'racing_bulls', 'rb', 'visa-cash-app-rb', 'alphatauri', 'alpha_tauri') THEN 'racing-bulls'
      WHEN LOWER(${columnRef}) IN ('kick-sauber', 'kick_sauber', 'sauber', 'alfa-romeo', 'alfa_romeo', 'stake') THEN 'kick-sauber'
      ELSE LOWER(REPLACE(${columnRef}, '_', '-'))
    END
  `;
}

/**
 * Create output tables if they don't exist (and add required columns if missing)
 */
async function createOutputTables(pool: Pool): Promise<void> {
  console.log('→ Creating output tables (if not exist)...');

  // 1. Race-level gaps
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_race_level_2025 (
      race_gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      driver_primary_id TEXT NOT NULL,
      driver_secondary_id TEXT NOT NULL,
      primary_median_lap_time_seconds NUMERIC(10,6) NOT NULL,
      secondary_median_lap_time_seconds NUMERIC(10,6) NOT NULL,
      shared_laps INTEGER,
      gap_seconds NUMERIC(8,6) NOT NULL,
      gap_percent NUMERIC(8,3) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (season, round, team_id, driver_primary_id, driver_secondary_id)
    )
  `);

  await pool.query(`
    ALTER TABLE teammate_gap_race_level_2025
      ADD COLUMN IF NOT EXISTS primary_median_lap_time_seconds NUMERIC(10,6),
      ADD COLUMN IF NOT EXISTS secondary_median_lap_time_seconds NUMERIC(10,6),
      ADD COLUMN IF NOT EXISTS shared_laps INTEGER,
      ADD COLUMN IF NOT EXISTS gap_seconds NUMERIC(8,6),
      ADD COLUMN IF NOT EXISTS gap_percent NUMERIC(8,3)
  `);

  // 2. Season-level summary
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_season_summary_2025 (
      season_summary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      season INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      driver_primary_id TEXT NOT NULL,
      driver_secondary_id TEXT NOT NULL,
      driver_pair_gap_season NUMERIC,
      driver_pair_dispersion NUMERIC,
      total_shared_laps INTEGER NOT NULL,
      num_valid_stints INTEGER NOT NULL,
      driver_pair_gap_percent NUMERIC(8,3),
      driver_pair_gap_seconds NUMERIC(8,6),
      gap_percent NUMERIC(8,3),
      shared_races INTEGER NOT NULL,
      faster_driver_primary_count INTEGER NOT NULL,
      coverage_status TEXT NOT NULL,
      failure_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (season, team_id, driver_primary_id, driver_secondary_id)
    )
  `);

  await pool.query(`
    ALTER TABLE teammate_gap_season_summary_2025
      ADD COLUMN IF NOT EXISTS driver_pair_gap_season NUMERIC,
      ADD COLUMN IF NOT EXISTS driver_pair_dispersion NUMERIC,
      ADD COLUMN IF NOT EXISTS total_shared_laps INTEGER,
      ADD COLUMN IF NOT EXISTS num_valid_stints INTEGER,
      ADD COLUMN IF NOT EXISTS driver_pair_gap_percent NUMERIC(8,3),
      ADD COLUMN IF NOT EXISTS driver_pair_gap_seconds NUMERIC(8,6),
      ADD COLUMN IF NOT EXISTS gap_percent NUMERIC(8,3),
      ADD COLUMN IF NOT EXISTS shared_races INTEGER,
      ADD COLUMN IF NOT EXISTS faster_driver_primary_count INTEGER,
      ADD COLUMN IF NOT EXISTS coverage_status TEXT,
      ADD COLUMN IF NOT EXISTS failure_reason TEXT
  `);

  // 3. Audit log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingestion_runs_teammate_gap (
      run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      season INTEGER NOT NULL,
      status TEXT NOT NULL,
      rows_written INTEGER NOT NULL,
      rows_failed INTEGER NOT NULL,
      execution_hash TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL
    )
  `);

  console.log('✓ Output tables ready');
}

/**
 * Check if race and lap data exists for the season
 */
async function assertSeasonDataExists(pool: Pool, season: number): Promise<void> {
  const races = await pool.query(
    `SELECT COUNT(*) AS count FROM race WHERE year = $1`,
    [season]
  );

  if (parseInt(races.rows[0]?.count || '0', 10) === 0) {
    throw new Error(`FAIL_CLOSED: No race rows for season ${season}`);
  }

  const raceResults = await pool.query(
    `
    SELECT COUNT(*) AS count
    FROM race_data rd
    JOIN race r ON r.id = rd.race_id
    WHERE r.year = $1
      AND rd.type = 'RACE_RESULT'
    `,
    [season]
  );

  if (parseInt(raceResults.rows[0]?.count || '0', 10) === 0) {
    throw new Error(`FAIL_CLOSED: No race classification data for season ${season}`);
  }

  const laps = await pool.query(
    `SELECT COUNT(*) AS count FROM laps_normalized WHERE season = $1`,
    [season]
  );

  if (parseInt(laps.rows[0]?.count || '0', 10) === 0) {
    throw new Error(`FAIL_CLOSED: No laps_normalized rows for season ${season}`);
  }
}

/**
 * Main ingestion logic - uses pure SQL CTEs, no JS loops
 */
async function runIngestion(
  pool: Pool,
  config: TeammateGapETLConfig = DEFAULT_ETL_CONFIG
): Promise<ExecutionMetrics> {
  const startedAt = new Date();

  console.log('\n=== TEAMMATE GAP INGESTION 2025 (RACE PACE) ===\n');
  console.log(`Season: ${config.season}`);
  console.log(`Methodology: Median race lap times (symmetric percent difference)`);
  console.log(
    `Thresholds: valid_races=${TEAMMATE_GAP_THRESHOLDS.valid_shared_races}, ` +
    `low_coverage_races=${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races}`
  );
  console.log(`Started: ${startedAt.toISOString()}\n`);

  // Step 1: Validate input table schemas
  console.log('→ Validating input table schemas...');

  const raceSchema: Array<{ name: string; type: string }> = [
    { name: 'id', type: 'integer' },
    { name: 'year', type: 'integer' },
    { name: 'round', type: 'integer' }
  ];

  const raceValidation = await validateTableSchema(pool, 'race', raceSchema);
  if (!raceValidation.valid) {
    throw new Error(raceValidation.error);
  }

  const raceDataSchema: Array<{ name: string; type: string }> = [
    { name: 'race_id', type: 'integer' },
    { name: 'type', type: 'text' },
    { name: 'driver_id', type: 'text' },
    { name: 'constructor_id', type: 'text' },
    { name: 'position_number', type: 'integer' }
  ];

  const raceDataValidation = await validateTableSchema(pool, 'race_data', raceDataSchema);
  if (!raceDataValidation.valid) {
    throw new Error(raceDataValidation.error);
  }

  const lapsSchema: Array<{ name: string; type: string }> = [
    { name: 'season', type: 'integer' },
    { name: 'round', type: 'integer' },
    { name: 'driver_id', type: 'text' },
    { name: 'lap_time_seconds', type: 'numeric' },
    { name: 'is_valid_lap', type: 'boolean' },
    { name: 'is_pit_lap', type: 'boolean' },
    { name: 'is_out_lap', type: 'boolean' },
    { name: 'is_in_lap', type: 'boolean' }
  ];

  const lapsValidation = await validateTableSchema(pool, 'laps_normalized', lapsSchema);
  if (!lapsValidation.valid) {
    throw new Error(lapsValidation.error);
  }

  console.log('✓ Input schemas validated');

  // Step 2: Verify season data exists
  console.log('→ Verifying season data exists...');
  await assertSeasonDataExists(pool, config.season);
  console.log('✓ Season data verified');

  // Step 2b: Validate lap flag quality (avoid filtering everything if flags are degenerate)
  const lapFlagResult = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE is_pit_lap = false) AS pit_false,
      COUNT(*) FILTER (WHERE is_out_lap = false) AS out_false,
      COUNT(*) FILTER (WHERE is_in_lap = false) AS in_false
    FROM laps_normalized
    WHERE season = $1
    `,
    [config.season]
  );

  const pitFalse = parseInt(lapFlagResult.rows[0]?.pit_false || '0', 10);
  const outFalse = parseInt(lapFlagResult.rows[0]?.out_false || '0', 10);
  const inFalse = parseInt(lapFlagResult.rows[0]?.in_false || '0', 10);

  const applyPitFilter = pitFalse > 0;
  const applyOutFilter = outFalse > 0;
  const applyInFilter = inFalse > 0;

  if (!applyPitFilter || !applyOutFilter || !applyInFilter) {
    const disabled = [
      !applyPitFilter ? 'pit' : null,
      !applyOutFilter ? 'out' : null,
      !applyInFilter ? 'in' : null
    ].filter(Boolean);
    console.warn(`⚠ Lap flags degenerate for season ${config.season}; disabling ${disabled.join(', ')} lap filters.`);
  }

  const validLapCountResult = await pool.query(
    `
    SELECT COUNT(*) AS count
    FROM laps_normalized
    WHERE season = $1
      AND is_valid_lap = true
      AND lap_time_seconds IS NOT NULL
      AND (NOT $2 OR COALESCE(is_pit_lap, false) = false)
      AND (NOT $3 OR COALESCE(is_out_lap, false) = false)
      AND (NOT $4 OR COALESCE(is_in_lap, false) = false)
    `,
    [config.season, applyPitFilter, applyOutFilter, applyInFilter]
  );

  const validLapCount = parseInt(validLapCountResult.rows[0]?.count || '0', 10);
  if (validLapCount === 0) {
    throw new Error(`FAIL_CLOSED: No valid race laps found for season ${config.season} after filtering`);
  }

  // Step 3: Fingerprint input tables for execution hash
  console.log('→ Fingerprinting input tables...');

  const raceFingerprint = await fingerprintTable(pool, 'race');
  const raceDataFingerprint = await fingerprintTable(pool, 'race_data');
  const lapsFingerprint = await fingerprintTable(pool, 'laps_normalized');

  const execution_hash = computeExecutionHash(
    [raceFingerprint, raceDataFingerprint, lapsFingerprint],
    config.season,
    config,
    'race_pace_symmetric_percent_diff_v1'
  );

  console.log(`✓ Execution hash: ${execution_hash}`);

  // Step 4: Create output tables
  await createOutputTables(pool);

  // Step 5: Start transaction
  console.log('\n→ Starting transaction...');
  await pool.query('BEGIN');
  await pool.query(`SET LOCAL statement_timeout = '10min'`);
  await pool.query(`SET LOCAL lock_timeout = '10s'`);

  try {
    // Step 6: Clear existing data for this season
    console.log('→ Clearing existing data for season...');
    await pool.query(`DELETE FROM teammate_gap_race_level_2025 WHERE season = $1`, [config.season]);
    await pool.query(`DELETE FROM teammate_gap_season_summary_2025 WHERE season = $1`, [config.season]);
    console.log('✓ Existing data cleared');

    // Step 7: Compute and insert race-level gaps
    console.log('→ Computing race-level gaps...');

    const raceGapInsertResult = await pool.query(`
      WITH classified_drivers AS (
        SELECT
          r.year AS season,
          r.round,
          rd.driver_id,
          ${buildTeamIdCase('rd.constructor_id')} AS team_id
        FROM race_data rd
        JOIN race r ON r.id = rd.race_id
        WHERE r.year = $1
          AND rd.type = 'RACE_RESULT'
          AND rd.driver_id IS NOT NULL
          AND rd.constructor_id IS NOT NULL
          AND rd.position_number IS NOT NULL
      ),
      valid_laps AS (
        SELECT
          season,
          round,
          driver_id,
          lap_time_seconds
        FROM laps_normalized
        WHERE season = $1
          AND is_valid_lap = true
          AND lap_time_seconds IS NOT NULL
          AND (NOT $2 OR COALESCE(is_pit_lap, false) = false)
          AND (NOT $3 OR COALESCE(is_out_lap, false) = false)
          AND (NOT $4 OR COALESCE(is_in_lap, false) = false)
      ),
      driver_medians AS (
        SELECT
          cd.season,
          cd.round,
          cd.team_id,
          cd.driver_id,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vl.lap_time_seconds)::NUMERIC(10,6)
            AS median_lap_time_seconds,
          COUNT(*) AS valid_laps
        FROM valid_laps vl
        JOIN classified_drivers cd
          ON cd.season = vl.season
         AND cd.round = vl.round
         AND cd.driver_id = vl.driver_id
        GROUP BY cd.season, cd.round, cd.team_id, cd.driver_id
        HAVING COUNT(*) > 0
      ),
      teammate_pairs AS (
        SELECT
          dm1.season,
          dm1.round,
          dm1.team_id,
          LEAST(dm1.driver_id, dm2.driver_id) AS driver_primary_id,
          GREATEST(dm1.driver_id, dm2.driver_id) AS driver_secondary_id,
          CASE WHEN dm1.driver_id < dm2.driver_id THEN dm1.median_lap_time_seconds ELSE dm2.median_lap_time_seconds END
            AS primary_median_lap_time_seconds,
          CASE WHEN dm1.driver_id < dm2.driver_id THEN dm2.median_lap_time_seconds ELSE dm1.median_lap_time_seconds END
            AS secondary_median_lap_time_seconds,
          CASE WHEN dm1.driver_id < dm2.driver_id THEN dm1.valid_laps ELSE dm2.valid_laps END
            AS primary_valid_laps,
          CASE WHEN dm1.driver_id < dm2.driver_id THEN dm2.valid_laps ELSE dm1.valid_laps END
            AS secondary_valid_laps
        FROM driver_medians dm1
        JOIN driver_medians dm2
          ON dm1.season = dm2.season
         AND dm1.round = dm2.round
         AND dm1.team_id = dm2.team_id
         AND dm1.driver_id < dm2.driver_id
      ),
      computed_gaps AS (
        SELECT
          season,
          round,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          primary_median_lap_time_seconds,
          secondary_median_lap_time_seconds,
          LEAST(primary_valid_laps, secondary_valid_laps)::INTEGER AS shared_laps,
          (primary_median_lap_time_seconds - secondary_median_lap_time_seconds)::NUMERIC(8,6) AS gap_seconds,
          (100.0 * (primary_median_lap_time_seconds - secondary_median_lap_time_seconds) /
            ((primary_median_lap_time_seconds + secondary_median_lap_time_seconds) / 2.0))::NUMERIC(8,3)
            AS gap_percent
        FROM teammate_pairs
      )
      INSERT INTO teammate_gap_race_level_2025 (
        season,
        round,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        primary_median_lap_time_seconds,
        secondary_median_lap_time_seconds,
        shared_laps,
        gap_seconds,
        gap_percent
      )
      SELECT
        season,
        round,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        primary_median_lap_time_seconds,
        secondary_median_lap_time_seconds,
        shared_laps,
        gap_seconds,
        gap_percent
      FROM computed_gaps
      RETURNING *
    `, [config.season, applyPitFilter, applyOutFilter, applyInFilter]);

    const race_rows_written = raceGapInsertResult.rowCount || 0;
    console.log(`✓ Race-level gaps computed: ${race_rows_written} race entries`);

    // Step 8: Compute and insert season-level summaries
    console.log('→ Computing season-level summaries...');

    const seasonInsertResult = await pool.query(`
      WITH race_gaps AS (
        SELECT *
        FROM teammate_gap_race_level_2025
        WHERE season = $1
      ),
      pair_stats AS (
        SELECT
          season,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          COUNT(*) AS shared_races,
          SUM(shared_laps)::INTEGER AS total_shared_laps,
          COUNT(*) FILTER (WHERE gap_percent < 0) AS faster_driver_primary_count,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_percent) AS median_gap_percent,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap_seconds
        FROM race_gaps
        GROUP BY season, team_id, driver_primary_id, driver_secondary_id
      )
      INSERT INTO teammate_gap_season_summary_2025 (
        season,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        driver_pair_gap_season,
        driver_pair_dispersion,
        total_shared_laps,
        num_valid_stints,
        driver_pair_gap_percent,
        driver_pair_gap_seconds,
        gap_percent,
        shared_races,
        faster_driver_primary_count,
        coverage_status,
        failure_reason
      )
      SELECT
        season,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        CASE
          WHEN shared_races >= $2 THEN median_gap_seconds
          ELSE NULL
        END AS driver_pair_gap_season,
        NULL::NUMERIC AS driver_pair_dispersion,
        total_shared_laps,
        shared_races AS num_valid_stints,
        CASE
          WHEN shared_races >= $2 THEN median_gap_percent
          ELSE NULL
        END AS driver_pair_gap_percent,
        CASE
          WHEN shared_races >= $2 THEN median_gap_seconds
          ELSE NULL
        END AS driver_pair_gap_seconds,
        CASE
          WHEN shared_races >= $2 THEN median_gap_percent
          ELSE NULL
        END AS gap_percent,
        shared_races,
        faster_driver_primary_count,
        CASE
          WHEN shared_races >= $3 THEN 'valid'
          WHEN shared_races >= $2 THEN 'low_coverage'
          ELSE 'insufficient'
        END AS coverage_status,
        CASE
          WHEN shared_races < $2 THEN 'INSUFFICIENT_RACES'
          ELSE NULL
        END AS failure_reason
      FROM pair_stats
      RETURNING *
    `, [
      config.season,
      TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races,
      TEAMMATE_GAP_THRESHOLDS.valid_shared_races
    ]);

    const validPairs = seasonInsertResult.rows.filter(r => r.coverage_status === 'valid');
    const lowCoveragePairs = seasonInsertResult.rows.filter(r => r.coverage_status === 'low_coverage');
    const insufficientPairs = seasonInsertResult.rows.filter(r => r.coverage_status === 'insufficient');

    const season_rows_written = seasonInsertResult.rowCount || 0;

    console.log(`✓ Season summaries computed:`);
    console.log(`  Valid (≥${TEAMMATE_GAP_THRESHOLDS.valid_shared_races} races): ${validPairs.length}`);
    console.log(`  Low coverage (≥${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races} races): ${lowCoveragePairs.length}`);
    console.log(`  Insufficient (<${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races} races): ${insufficientPairs.length}`);

    // Step 9: Write audit log
    console.log('→ Writing audit log entry...');

    const finishedAt = new Date();

    await pool.query(`
      INSERT INTO ingestion_runs_teammate_gap (
        season,
        status,
        rows_written,
        rows_failed,
        execution_hash,
        started_at,
        finished_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      config.season,
      'success',
      race_rows_written + season_rows_written,
      insufficientPairs.length,
      execution_hash,
      startedAt,
      finishedAt
    ]);

    console.log('✓ Audit log written');

    // Step 10: Commit transaction
    console.log('→ Committing transaction...');
    await pool.query('COMMIT');
    console.log('✓ Transaction committed');

    return {
      race_rows_written,
      season_rows_written,
      valid_pairs: validPairs.length,
      low_coverage_pairs: lowCoveragePairs.length,
      insufficient_pairs: insufficientPairs.length,
      execution_hash
    };
  } catch (error) {
    console.error('\n✗ INGESTION FAILED');
    console.error(`Reason: ${error}`);
    console.log('→ Rolling back transaction...');
    await pool.query('ROLLBACK');
    console.log('✓ Transaction rolled back');

    // Write failure audit log
    const finishedAt = new Date();
    await pool.query(`
      INSERT INTO ingestion_runs_teammate_gap (
        season,
        status,
        rows_written,
        rows_failed,
        execution_hash,
        started_at,
        finished_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      config.season,
      'failed',
      0,
      0,
      execution_hash,
      startedAt,
      finishedAt
    ]);

    throw error;
  }
}

/**
 * Parse CLI arguments
 */
function parseArgs(): TeammateGapETLConfig {
  const args = process.argv.slice(2);
  const config: TeammateGapETLConfig = { ...DEFAULT_ETL_CONFIG };

  for (const arg of args) {
    if (arg.startsWith('--season=')) {
      const season = parseInt(arg.split('=')[1], 10);
      if (!isNaN(season)) {
        config.season = season;
      }
    }
  }

  return config;
}

/**
 * Main entry point
 */
async function main() {
  const config = parseArgs();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    const metrics = await runIngestion(pool, config);

    console.log('\n=== INGESTION COMPLETE ===\n');
    console.log(`Execution Hash: ${metrics.execution_hash}`);
    console.log(`\nRace-level:`);
    console.log(`  Written: ${metrics.race_rows_written}`);
    console.log(`\nSeason-level:`);
    console.log(`  Valid pairs:        ${metrics.valid_pairs}`);
    console.log(`  Low coverage pairs: ${metrics.low_coverage_pairs}`);
    console.log(`  Insufficient pairs: ${metrics.insufficient_pairs}`);
    console.log(`  Total written:      ${metrics.season_rows_written}\n`);

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error(`\nFATAL ERROR: ${error}\n`);
    await pool.end();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { runIngestion };
