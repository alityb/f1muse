#!/usr/bin/env npx ts-node
/**
 * PART 6: Driver Matchup Matrix Ingestion Script
 *
 * Computes and stores precomputed head-to-head matchup results for all driver pairs
 * in the 2026 season. This enables fast lookup without runtime computation.
 *
 * Usage: npm run ingest:matchup-matrix:2026
 *
 * Requirements:
 * - race_data table must be populated with qualifying and race results
 * - driver table must be populated with driver identities
 */

import { Pool } from 'pg';

const SEASON = 2026;

// Coverage thresholds (matching head-to-head count thresholds)
const VALID_THRESHOLD = 8;
const LOW_COVERAGE_THRESHOLD = 4;

interface MatchupResult {
  driver_a_id: string;
  driver_b_id: string;
  metric: 'qualifying_position' | 'race_finish_position';
  driver_a_wins: number;
  driver_b_wins: number;
  ties: number;
  shared_events: number;
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
}

function getCoverageStatus(sharedEvents: number): 'valid' | 'low_coverage' | 'insufficient' {
  if (sharedEvents >= VALID_THRESHOLD) {
    return 'valid';
  }
  if (sharedEvents >= LOW_COVERAGE_THRESHOLD) {
    return 'low_coverage';
  }
  return 'insufficient';
}

async function computeMatchups(pool: Pool, season: number): Promise<MatchupResult[]> {
  console.log(`Computing matchups for season ${season}...`);

  // Get all unique driver pairs that participated in the season
  // We need to compute h2h for both qualifying and race
  const matchups: MatchupResult[] = [];

  // Query 1: Qualifying head-to-head (use qualifying_results, FastF1-sourced)
  console.log('Computing qualifying matchups...');
  const qualifyingResult = await pool.query<{
    driver_a_id: string;
    driver_b_id: string;
    driver_a_wins: string;
    driver_b_wins: string;
    ties: string;
    shared_events: string;
  }>(`
    WITH driver_qualifying AS (
      SELECT DISTINCT
        qr.driver_id,
        qr.round AS race_id,
        qr.qualifying_position AS position
      FROM qualifying_results qr
      WHERE qr.season = $1
        AND qr.qualifying_position IS NOT NULL
        AND qr.qualifying_position > 0
    ),
    driver_pairs AS (
      SELECT DISTINCT
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq1.driver_id ELSE dq2.driver_id END AS driver_a_id,
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq2.driver_id ELSE dq1.driver_id END AS driver_b_id,
        dq1.race_id,
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq1.position ELSE dq2.position END AS driver_a_pos,
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq2.position ELSE dq1.position END AS driver_b_pos
      FROM driver_qualifying dq1
      JOIN driver_qualifying dq2 ON dq1.race_id = dq2.race_id AND dq1.driver_id < dq2.driver_id
    )
    SELECT
      driver_a_id,
      driver_b_id,
      COUNT(*) AS shared_events,
      SUM(CASE WHEN driver_a_pos < driver_b_pos THEN 1 ELSE 0 END) AS driver_a_wins,
      SUM(CASE WHEN driver_b_pos < driver_a_pos THEN 1 ELSE 0 END) AS driver_b_wins,
      SUM(CASE WHEN driver_a_pos = driver_b_pos THEN 1 ELSE 0 END) AS ties
    FROM driver_pairs
    GROUP BY driver_a_id, driver_b_id
    ORDER BY shared_events DESC
  `, [season]);

  for (const row of qualifyingResult.rows) {
    const sharedEvents = parseInt(row.shared_events, 10);
    matchups.push({
      driver_a_id: row.driver_a_id,
      driver_b_id: row.driver_b_id,
      metric: 'qualifying_position',
      driver_a_wins: parseInt(row.driver_a_wins, 10),
      driver_b_wins: parseInt(row.driver_b_wins, 10),
      ties: parseInt(row.ties, 10),
      shared_events: sharedEvents,
      coverage_status: getCoverageStatus(sharedEvents)
    });
  }

  console.log(`  Found ${qualifyingResult.rows.length} qualifying matchups`);

  // Query 2: Race finish head-to-head (requires RACE_RESULT rows in race_data)
  // Skipped gracefully mid-season when F1DB hasn't published race results yet.
  console.log('Computing race finish matchups...');
  const raceResultCheck = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM race_data rd
     JOIN race r ON r.id = rd.race_id
     WHERE r.year = $1 AND rd.type = 'RACE_RESULT'`,
    [season]
  );
  const hasRaceResults = parseInt(raceResultCheck.rows[0]?.count || '0', 10) > 0;

  if (!hasRaceResults) {
    console.log('  ⚠ No RACE_RESULT data yet — skipping race finish matchups');
  } else {
  const raceResult = await pool.query<{
    driver_a_id: string;
    driver_b_id: string;
    driver_a_wins: string;
    driver_b_wins: string;
    ties: string;
    shared_events: string;
  }>(`
    WITH driver_race AS (
      SELECT DISTINCT
        rd.driver_id,
        r.id AS race_id,
        rd.position_number,
        rd.position_text
      FROM race_data rd
      JOIN race r ON r.id = rd.race_id
      WHERE r.year = $1
        AND rd.type = 'RACE_RESULT'
        AND rd.position_number IS NOT NULL
        AND rd.position_number > 0
    ),
    driver_pairs AS (
      SELECT DISTINCT
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr1.driver_id ELSE dr2.driver_id END AS driver_a_id,
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr2.driver_id ELSE dr1.driver_id END AS driver_b_id,
        dr1.race_id,
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr1.position_number ELSE dr2.position_number END AS driver_a_pos,
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr2.position_number ELSE dr1.position_number END AS driver_b_pos
      FROM driver_race dr1
      JOIN driver_race dr2 ON dr1.race_id = dr2.race_id AND dr1.driver_id < dr2.driver_id
    )
    SELECT
      driver_a_id,
      driver_b_id,
      COUNT(*) AS shared_events,
      SUM(CASE WHEN driver_a_pos < driver_b_pos THEN 1 ELSE 0 END) AS driver_a_wins,
      SUM(CASE WHEN driver_b_pos < driver_a_pos THEN 1 ELSE 0 END) AS driver_b_wins,
      SUM(CASE WHEN driver_a_pos = driver_b_pos THEN 1 ELSE 0 END) AS ties
    FROM driver_pairs
    GROUP BY driver_a_id, driver_b_id
    ORDER BY shared_events DESC
  `, [season]);

  for (const row of raceResult.rows) {
    const sharedEvents = parseInt(row.shared_events, 10);
    matchups.push({
      driver_a_id: row.driver_a_id,
      driver_b_id: row.driver_b_id,
      metric: 'race_finish_position',
      driver_a_wins: parseInt(row.driver_a_wins, 10),
      driver_b_wins: parseInt(row.driver_b_wins, 10),
      ties: parseInt(row.ties, 10),
      shared_events: sharedEvents,
      coverage_status: getCoverageStatus(sharedEvents)
    });
  }
  } // end if (hasRaceResults)

  console.log(`Total matchups: ${matchups.length}`);

  return matchups;
}

async function upsertMatchups(pool: Pool, matchups: MatchupResult[], season: number): Promise<void> {
  console.log('Upserting matchups into driver_matchup_matrix_2025...');

  let insertCount = 0;
  let updateCount = 0;

  for (const matchup of matchups) {
    const result = await pool.query(`
      INSERT INTO driver_matchup_matrix_2025 (
        driver_a_id, driver_b_id, metric, season,
        driver_a_wins, driver_b_wins, ties, shared_events,
        coverage_status, computed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (driver_a_id, driver_b_id, metric, season)
      DO UPDATE SET
        driver_a_wins = EXCLUDED.driver_a_wins,
        driver_b_wins = EXCLUDED.driver_b_wins,
        ties = EXCLUDED.ties,
        shared_events = EXCLUDED.shared_events,
        coverage_status = EXCLUDED.coverage_status,
        computed_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `, [
      matchup.driver_a_id,
      matchup.driver_b_id,
      matchup.metric,
      season,
      matchup.driver_a_wins,
      matchup.driver_b_wins,
      matchup.ties,
      matchup.shared_events,
      matchup.coverage_status
    ]);

    if (result.rows[0]?.inserted) {
      insertCount++;
    } else {
      updateCount++;
    }
  }

  console.log(`  Inserted: ${insertCount}`);
  console.log(`  Updated: ${updateCount}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await runMatchupSync(pool, SEASON);
  } catch (error) {
    console.error('Ingestion failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

export async function runMatchupSync(pool: Pool, season: number = SEASON): Promise<void> {
  console.log('=== Driver Matchup Matrix Ingestion ===');
  console.log(`Season: ${season}`);
  console.log('');

  // Check if table exists
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'driver_matchup_matrix_2025'
    )
  `);

  if (!tableCheck.rows[0]?.exists) {
    throw new Error('Table driver_matchup_matrix_2025 does not exist. Run migration first.');
  }

  const matchups = await computeMatchups(pool, season);
  await upsertMatchups(pool, matchups, season);

  console.log('');
  console.log('=== Ingestion Complete ===');

  const stats = await pool.query(`
    SELECT
      metric,
      coverage_status,
      COUNT(*) as count
    FROM driver_matchup_matrix_2025
    WHERE season = $1
    GROUP BY metric, coverage_status
    ORDER BY metric, coverage_status
  `, [season]);

  console.log('');
  console.log('Coverage Distribution:');
  for (const row of stats.rows) {
    console.log(`  ${row.metric} / ${row.coverage_status}: ${row.count}`);
  }
}

// Allow the API to import runMatchupSync without starting a separate ETL
// process. The standalone ingestion only runs from its npm script.
if (require.main === module) {
  main();
}
