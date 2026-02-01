#!/usr/bin/env node

/**
 * TEAMMATE GAP INGESTION PIPELINE - 2025 SEASON
 *
 * QUALIFYING-BASED SYMMETRIC PERCENT DIFFERENCE
 *
 * Methodology:
 * 1. For each race, identify teammate pairs (same constructor_id)
 * 2. Find highest qualifying session where both drivers set a time (Q3 > Q2 > Q1)
 * 3. Compute symmetric percent difference: 100 * (a - b) / ((a + b) / 2)
 *    - Negative = primary driver faster
 *    - Positive = secondary driver faster
 * 4. Store race-level results
 * 5. Aggregate to season median
 *
 * Safety Rules:
 * - Manual execution only
 * - Deterministic SQL (no loops in JS)
 * - Fail-closed on schema mismatch
 * - Transactional (all-or-nothing)
 * - Auditable with execution_hash
 *
 * Usage:
 *   npx tsx src/ingestion/teammate-gap-qualifying-2025.ts
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

  // 1. Race-level qualifying gaps
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_race_level_2025 (
      race_gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      driver_primary_id TEXT NOT NULL,
      driver_secondary_id TEXT NOT NULL,
      session_used TEXT NOT NULL,
      primary_time_ms INTEGER NOT NULL,
      secondary_time_ms INTEGER NOT NULL,
      gap_seconds NUMERIC(8,6) NOT NULL,
      gap_percent NUMERIC(8,3) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (season, round, team_id, driver_primary_id, driver_secondary_id)
    )
  `);

  await pool.query(`
    ALTER TABLE teammate_gap_qualifying_race_level_2025
      ADD COLUMN IF NOT EXISTS session_used TEXT,
      ADD COLUMN IF NOT EXISTS gap_seconds NUMERIC(8,6),
      ADD COLUMN IF NOT EXISTS gap_percent NUMERIC(8,3)
  `);

  // 2. Season-level summary
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_season_summary_2025 (
      season_summary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      season INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      driver_primary_id TEXT NOT NULL,
      driver_secondary_id TEXT NOT NULL,
      driver_pair_gap_percent NUMERIC(8,3),
      driver_pair_gap_seconds NUMERIC(8,6),
      gap_percent NUMERIC(8,3),
      shared_races INTEGER NOT NULL,
      faster_driver_primary_count INTEGER NOT NULL,
      coverage_status TEXT NOT NULL,
      failure_reason TEXT,
      session_used TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (season, team_id, driver_primary_id, driver_secondary_id)
    )
  `);

  await pool.query(`
    ALTER TABLE teammate_gap_qualifying_season_summary_2025
      ADD COLUMN IF NOT EXISTS driver_pair_gap_percent NUMERIC(8,3),
      ADD COLUMN IF NOT EXISTS driver_pair_gap_seconds NUMERIC(8,6),
      ADD COLUMN IF NOT EXISTS gap_percent NUMERIC(8,3),
      ADD COLUMN IF NOT EXISTS shared_races INTEGER,
      ADD COLUMN IF NOT EXISTS faster_driver_primary_count INTEGER,
      ADD COLUMN IF NOT EXISTS coverage_status TEXT,
      ADD COLUMN IF NOT EXISTS failure_reason TEXT,
      ADD COLUMN IF NOT EXISTS session_used TEXT
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
 * Check if race and qualifying data exists for the season
 */
async function assertSeasonDataExists(pool: Pool, season: number): Promise<void> {
  const races = await pool.query(
    `SELECT COUNT(*) AS count FROM race WHERE year = $1`,
    [season]
  );

  if (parseInt(races.rows[0]?.count || '0', 10) === 0) {
    throw new Error(`FAIL_CLOSED: No race rows for season ${season}`);
  }

  const qualifyingData = await pool.query(
    `
    SELECT COUNT(*) AS count
    FROM race_data rd
    JOIN race r ON r.id = rd.race_id
    WHERE r.year = $1
      AND rd.type = 'QUALIFYING_RESULT'
    `,
    [season]
  );

  if (parseInt(qualifyingData.rows[0]?.count || '0', 10) === 0) {
    throw new Error(`FAIL_CLOSED: No qualifying data for season ${season}`);
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

  console.log('\n=== TEAMMATE GAP INGESTION 2025 (QUALIFYING) ===\n');
  console.log(`Season: ${config.season}`);
  console.log(`Methodology: Symmetric percent difference from qualifying sessions`);
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

  const qualifyingSchema: Array<{ name: string; type: string }> = [
    { name: 'race_id', type: 'integer' },
    { name: 'type', type: 'text' },
    { name: 'driver_id', type: 'text' },
    { name: 'constructor_id', type: 'text' },
    { name: 'qualifying_q1_millis', type: 'integer' },
    { name: 'qualifying_q2_millis', type: 'integer' },
    { name: 'qualifying_q3_millis', type: 'integer' }
  ];

  const qualifyingValidation = await validateTableSchema(pool, 'race_data', qualifyingSchema);
  if (!qualifyingValidation.valid) {
    throw new Error(qualifyingValidation.error);
  }

  console.log('✓ Input schemas validated');

  // Step 2: Verify season data exists
  console.log('→ Verifying season data exists...');
  await assertSeasonDataExists(pool, config.season);
  console.log('✓ Season data verified');

  // Step 3: Fingerprint input tables for execution hash
  console.log('→ Fingerprinting input tables...');

  const raceFingerprint = await fingerprintTable(pool, 'race');
  const raceDataFingerprint = await fingerprintTable(pool, 'race_data');

  const execution_hash = computeExecutionHash(
    [raceFingerprint, raceDataFingerprint],
    config.season,
    config,
    'qualifying_symmetric_percent_diff_v2'
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
    await pool.query(`DELETE FROM teammate_gap_qualifying_race_level_2025 WHERE season = $1`, [config.season]);
    await pool.query(`DELETE FROM teammate_gap_qualifying_season_summary_2025 WHERE season = $1`, [config.season]);
    console.log('✓ Existing data cleared');

    // Step 7: Compute and insert race-level qualifying gaps
    console.log('→ Computing race-level qualifying gaps...');

    const raceGapInsertResult = await pool.query(`
      WITH quali_times AS (
        SELECT
          r.year AS season,
          r.round,
          rd.driver_id,
          ${buildTeamIdCase('rd.constructor_id')} AS team_id,
          rd.qualifying_q1_millis,
          rd.qualifying_q2_millis,
          rd.qualifying_q3_millis
        FROM race_data rd
        JOIN race r ON r.id = rd.race_id
        WHERE r.year = $1
          AND rd.type = 'QUALIFYING_RESULT'
          AND rd.driver_id IS NOT NULL
          AND rd.constructor_id IS NOT NULL
      ),
      teammate_pairs AS (
        SELECT
          qt1.season,
          qt1.round,
          qt1.team_id,
          LEAST(qt1.driver_id, qt2.driver_id) AS driver_primary_id,
          GREATEST(qt1.driver_id, qt2.driver_id) AS driver_secondary_id,
          CASE WHEN qt1.driver_id < qt2.driver_id THEN qt1.qualifying_q1_millis ELSE qt2.qualifying_q1_millis END AS p_q1,
          CASE WHEN qt1.driver_id < qt2.driver_id THEN qt1.qualifying_q2_millis ELSE qt2.qualifying_q2_millis END AS p_q2,
          CASE WHEN qt1.driver_id < qt2.driver_id THEN qt1.qualifying_q3_millis ELSE qt2.qualifying_q3_millis END AS p_q3,
          CASE WHEN qt1.driver_id < qt2.driver_id THEN qt2.qualifying_q1_millis ELSE qt1.qualifying_q1_millis END AS s_q1,
          CASE WHEN qt1.driver_id < qt2.driver_id THEN qt2.qualifying_q2_millis ELSE qt1.qualifying_q2_millis END AS s_q2,
          CASE WHEN qt1.driver_id < qt2.driver_id THEN qt2.qualifying_q3_millis ELSE qt1.qualifying_q3_millis END AS s_q3
        FROM quali_times qt1
        JOIN quali_times qt2
          ON qt1.season = qt2.season
          AND qt1.round = qt2.round
          AND qt1.team_id = qt2.team_id
          AND qt1.driver_id < qt2.driver_id
      ),
      session_selection AS (
        SELECT
          season,
          round,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          CASE
            WHEN p_q3 IS NOT NULL AND s_q3 IS NOT NULL THEN 'Q3'
            WHEN p_q2 IS NOT NULL AND s_q2 IS NOT NULL THEN 'Q2'
            WHEN p_q1 IS NOT NULL AND s_q1 IS NOT NULL THEN 'Q1'
            ELSE NULL
          END AS session_used,
          CASE
            WHEN p_q3 IS NOT NULL AND s_q3 IS NOT NULL THEN p_q3
            WHEN p_q2 IS NOT NULL AND s_q2 IS NOT NULL THEN p_q2
            WHEN p_q1 IS NOT NULL AND s_q1 IS NOT NULL THEN p_q1
            ELSE NULL
          END AS primary_time_ms,
          CASE
            WHEN p_q3 IS NOT NULL AND s_q3 IS NOT NULL THEN s_q3
            WHEN p_q2 IS NOT NULL AND s_q2 IS NOT NULL THEN s_q2
            WHEN p_q1 IS NOT NULL AND s_q1 IS NOT NULL THEN s_q1
            ELSE NULL
          END AS secondary_time_ms
        FROM teammate_pairs
      ),
      valid_sessions AS (
        SELECT *
        FROM session_selection
        WHERE session_used IS NOT NULL
          AND primary_time_ms > 0
          AND secondary_time_ms > 0
      ),
      computed_gaps AS (
        SELECT
          season,
          round,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          session_used,
          primary_time_ms,
          secondary_time_ms,
          ((primary_time_ms - secondary_time_ms) / 1000.0)::NUMERIC(8,6) AS gap_seconds,
          (100.0 * (primary_time_ms - secondary_time_ms) /
            ((primary_time_ms + secondary_time_ms) / 2.0))::NUMERIC(8,3) AS gap_percent
        FROM valid_sessions
      )
      INSERT INTO teammate_gap_qualifying_race_level_2025 (
        season,
        round,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        session_used,
        primary_time_ms,
        secondary_time_ms,
        gap_seconds,
        gap_percent
      )
      SELECT
        season,
        round,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        session_used,
        primary_time_ms,
        secondary_time_ms,
        gap_seconds,
        gap_percent
      FROM computed_gaps
      RETURNING *
    `, [config.season]);

    const race_rows_written = raceGapInsertResult.rowCount || 0;
    console.log(`✓ Race-level gaps computed: ${race_rows_written} race entries`);

    // Step 8: Compute and insert season-level summaries
    console.log('→ Computing season-level summaries...');

    const seasonInsertResult = await pool.query(`
      WITH race_gaps AS (
        SELECT *
        FROM teammate_gap_qualifying_race_level_2025
        WHERE season = $1
      ),
      session_counts AS (
        SELECT
          season,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          session_used,
          COUNT(*) AS session_count,
          CASE
            WHEN session_used = 'Q3' THEN 3
            WHEN session_used = 'Q2' THEN 2
            WHEN session_used = 'Q1' THEN 1
            ELSE 0
          END AS session_rank
        FROM race_gaps
        GROUP BY season, team_id, driver_primary_id, driver_secondary_id, session_used
      ),
      session_choice AS (
        SELECT DISTINCT ON (season, team_id, driver_primary_id, driver_secondary_id)
          season,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          session_used
        FROM session_counts
        ORDER BY season, team_id, driver_primary_id, driver_secondary_id, session_count DESC, session_rank DESC
      ),
      pair_stats AS (
        SELECT
          season,
          team_id,
          driver_primary_id,
          driver_secondary_id,
          COUNT(*) AS shared_races,
          COUNT(*) FILTER (WHERE gap_percent < 0) AS faster_driver_primary_count,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_percent) AS median_gap_percent,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap_seconds
        FROM race_gaps
        GROUP BY season, team_id, driver_primary_id, driver_secondary_id
      )
      INSERT INTO teammate_gap_qualifying_season_summary_2025 (
        season,
        team_id,
        driver_primary_id,
        driver_secondary_id,
        driver_pair_gap_percent,
        driver_pair_gap_seconds,
        gap_percent,
        shared_races,
        faster_driver_primary_count,
        coverage_status,
        failure_reason,
        session_used
      )
      SELECT
        ps.season,
        ps.team_id,
        ps.driver_primary_id,
        ps.driver_secondary_id,
        CASE
          WHEN ps.shared_races >= $2 THEN ps.median_gap_percent
          ELSE NULL
        END AS driver_pair_gap_percent,
        CASE
          WHEN ps.shared_races >= $2 THEN ps.median_gap_seconds
          ELSE NULL
        END AS driver_pair_gap_seconds,
        CASE
          WHEN ps.shared_races >= $2 THEN ps.median_gap_percent
          ELSE NULL
        END AS gap_percent,
        ps.shared_races,
        ps.faster_driver_primary_count,
        CASE
          WHEN ps.shared_races >= $3 THEN 'valid'
          WHEN ps.shared_races >= $2 THEN 'low_coverage'
          ELSE 'insufficient'
        END AS coverage_status,
        CASE
          WHEN ps.shared_races < $2 THEN 'INSUFFICIENT_QUALIFYING_SESSIONS'
          ELSE NULL
        END AS failure_reason,
        sc.session_used
      FROM pair_stats ps
      LEFT JOIN session_choice sc
        ON sc.season = ps.season
       AND sc.team_id = ps.team_id
       AND sc.driver_primary_id = ps.driver_primary_id
       AND sc.driver_secondary_id = ps.driver_secondary_id
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
