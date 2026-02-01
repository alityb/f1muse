#!/usr/bin/env npx tsx
/**
 * MULTI-SEASON BACKFILL SCRIPT
 *
 * Populates teammate gap and matchup matrix tables for seasons 2022-2024.
 * Uses unified tables (teammate_gap_season_summary, driver_matchup_matrix, etc.)
 *
 * Usage: npx tsx src/ingestion/backfill-all-seasons.ts [--season=YYYY]
 *
 * If --season is not specified, runs for 2022, 2023, 2024.
 */

import 'dotenv/config';
import { Pool } from 'pg';

// Coverage thresholds
const TEAMMATE_GAP_THRESHOLDS = {
  valid_shared_races: 10,
  low_coverage_shared_races: 5
};

const MATCHUP_THRESHOLDS = {
  valid: 8,
  low_coverage: 4
};

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

async function checkSeasonData(pool: Pool, season: number): Promise<{ hasRaces: boolean; hasLaps: boolean; hasQualifying: boolean }> {
  const races = await pool.query(`SELECT COUNT(*) AS count FROM race WHERE year = $1`, [season]);
  const laps = await pool.query(`SELECT COUNT(*) AS count FROM laps_normalized WHERE season = $1`, [season]);
  const qualifying = await pool.query(`
    SELECT COUNT(*) AS count
    FROM race_data rd
    JOIN race r ON r.id = rd.race_id
    WHERE r.year = $1 AND rd.type = 'QUALIFYING_RESULT'
  `, [season]);

  return {
    hasRaces: parseInt(races.rows[0]?.count || '0', 10) > 0,
    hasLaps: parseInt(laps.rows[0]?.count || '0', 10) > 0,
    hasQualifying: parseInt(qualifying.rows[0]?.count || '0', 10) > 0
  };
}

async function backfillTeammateGapRace(pool: Pool, season: number): Promise<number> {
  console.log(`  → Computing race pace teammate gaps for ${season}...`);

  // Check lap flag quality
  const flagResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE is_pit_lap = false) AS pit_false,
      COUNT(*) FILTER (WHERE is_out_lap = false) AS out_false,
      COUNT(*) FILTER (WHERE is_in_lap = false) AS in_false
    FROM laps_normalized WHERE season = $1
  `, [season]);

  const applyPitFilter = parseInt(flagResult.rows[0]?.pit_false || '0', 10) > 0;
  const applyOutFilter = parseInt(flagResult.rows[0]?.out_false || '0', 10) > 0;
  const applyInFilter = parseInt(flagResult.rows[0]?.in_false || '0', 10) > 0;

  // Delete existing data for this season
  await pool.query(`DELETE FROM teammate_gap_race_level WHERE season = $1`, [season]);
  await pool.query(`DELETE FROM teammate_gap_season_summary WHERE season = $1`, [season]);

  // Insert race-level gaps
  const raceResult = await pool.query(`
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
      SELECT season, round, driver_id, lap_time_seconds
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
        cd.season, cd.round, cd.team_id, cd.driver_id,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY vl.lap_time_seconds)::NUMERIC(10,6) AS median_lap_time_seconds,
        COUNT(*) AS valid_laps
      FROM valid_laps vl
      JOIN classified_drivers cd ON cd.season = vl.season AND cd.round = vl.round AND cd.driver_id = vl.driver_id
      GROUP BY cd.season, cd.round, cd.team_id, cd.driver_id
      HAVING COUNT(*) > 0
    ),
    teammate_pairs AS (
      SELECT
        dm1.season, dm1.round, dm1.team_id,
        LEAST(dm1.driver_id, dm2.driver_id) AS driver_primary_id,
        GREATEST(dm1.driver_id, dm2.driver_id) AS driver_secondary_id,
        CASE WHEN dm1.driver_id < dm2.driver_id THEN dm1.median_lap_time_seconds ELSE dm2.median_lap_time_seconds END AS primary_median_lap_time_seconds,
        CASE WHEN dm1.driver_id < dm2.driver_id THEN dm2.median_lap_time_seconds ELSE dm1.median_lap_time_seconds END AS secondary_median_lap_time_seconds,
        CASE WHEN dm1.driver_id < dm2.driver_id THEN dm1.valid_laps ELSE dm2.valid_laps END AS primary_valid_laps,
        CASE WHEN dm1.driver_id < dm2.driver_id THEN dm2.valid_laps ELSE dm1.valid_laps END AS secondary_valid_laps
      FROM driver_medians dm1
      JOIN driver_medians dm2 ON dm1.season = dm2.season AND dm1.round = dm2.round AND dm1.team_id = dm2.team_id AND dm1.driver_id < dm2.driver_id
    )
    INSERT INTO teammate_gap_race_level (
      season, round, team_id, driver_primary_id, driver_secondary_id,
      primary_median_lap_time_seconds, secondary_median_lap_time_seconds, shared_laps, gap_seconds, gap_percent
    )
    SELECT
      season, round, team_id, driver_primary_id, driver_secondary_id,
      primary_median_lap_time_seconds, secondary_median_lap_time_seconds,
      LEAST(primary_valid_laps, secondary_valid_laps)::INTEGER,
      (primary_median_lap_time_seconds - secondary_median_lap_time_seconds)::NUMERIC(8,6),
      (100.0 * (primary_median_lap_time_seconds - secondary_median_lap_time_seconds) /
        ((primary_median_lap_time_seconds + secondary_median_lap_time_seconds) / 2.0))::NUMERIC(8,3)
    FROM teammate_pairs
  `, [season, applyPitFilter, applyOutFilter, applyInFilter]);

  const raceRows = raceResult.rowCount || 0;

  // Insert season-level summaries
  await pool.query(`
    WITH race_gaps AS (SELECT * FROM teammate_gap_race_level WHERE season = $1),
    pair_stats AS (
      SELECT
        season, team_id, driver_primary_id, driver_secondary_id,
        COUNT(*) AS shared_races,
        SUM(shared_laps)::INTEGER AS total_shared_laps,
        COUNT(*) FILTER (WHERE gap_percent < 0) AS faster_driver_primary_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_percent) AS median_gap_percent,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap_seconds
      FROM race_gaps
      GROUP BY season, team_id, driver_primary_id, driver_secondary_id
    )
    INSERT INTO teammate_gap_season_summary (
      season, team_id, driver_primary_id, driver_secondary_id,
      driver_pair_gap_season, driver_pair_dispersion, total_shared_laps, num_valid_stints,
      driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races,
      faster_driver_primary_count, coverage_status, failure_reason
    )
    SELECT
      season, team_id, driver_primary_id, driver_secondary_id,
      CASE WHEN shared_races >= $2 THEN median_gap_seconds ELSE NULL END,
      NULL::NUMERIC,
      total_shared_laps,
      shared_races,
      CASE WHEN shared_races >= $2 THEN median_gap_percent ELSE NULL END,
      CASE WHEN shared_races >= $2 THEN median_gap_seconds ELSE NULL END,
      CASE WHEN shared_races >= $2 THEN median_gap_percent ELSE NULL END,
      shared_races,
      faster_driver_primary_count,
      CASE
        WHEN shared_races >= $3 THEN 'valid'
        WHEN shared_races >= $2 THEN 'low_coverage'
        ELSE 'insufficient'
      END,
      CASE WHEN shared_races < $2 THEN 'INSUFFICIENT_RACES' ELSE NULL END
    FROM pair_stats
  `, [season, TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races, TEAMMATE_GAP_THRESHOLDS.valid_shared_races]);

  return raceRows;
}

async function backfillTeammateGapQualifying(pool: Pool, season: number): Promise<number> {
  console.log(`  → Computing qualifying teammate gaps for ${season}...`);

  // Delete existing data
  await pool.query(`DELETE FROM teammate_gap_qualifying_race_level WHERE season = $1`, [season]);
  await pool.query(`DELETE FROM teammate_gap_qualifying_season_summary WHERE season = $1`, [season]);

  // Insert race-level qualifying gaps
  const raceResult = await pool.query(`
    WITH quali_times AS (
      SELECT
        r.year AS season, r.round, rd.driver_id,
        ${buildTeamIdCase('rd.constructor_id')} AS team_id,
        rd.qualifying_q1_millis, rd.qualifying_q2_millis, rd.qualifying_q3_millis
      FROM race_data rd
      JOIN race r ON r.id = rd.race_id
      WHERE r.year = $1 AND rd.type = 'QUALIFYING_RESULT' AND rd.driver_id IS NOT NULL AND rd.constructor_id IS NOT NULL
    ),
    teammate_pairs AS (
      SELECT
        qt1.season, qt1.round, qt1.team_id,
        LEAST(qt1.driver_id, qt2.driver_id) AS driver_primary_id,
        GREATEST(qt1.driver_id, qt2.driver_id) AS driver_secondary_id,
        CASE WHEN qt1.driver_id < qt2.driver_id THEN qt1.qualifying_q1_millis ELSE qt2.qualifying_q1_millis END AS p_q1,
        CASE WHEN qt1.driver_id < qt2.driver_id THEN qt1.qualifying_q2_millis ELSE qt2.qualifying_q2_millis END AS p_q2,
        CASE WHEN qt1.driver_id < qt2.driver_id THEN qt1.qualifying_q3_millis ELSE qt2.qualifying_q3_millis END AS p_q3,
        CASE WHEN qt1.driver_id < qt2.driver_id THEN qt2.qualifying_q1_millis ELSE qt1.qualifying_q1_millis END AS s_q1,
        CASE WHEN qt1.driver_id < qt2.driver_id THEN qt2.qualifying_q2_millis ELSE qt1.qualifying_q2_millis END AS s_q2,
        CASE WHEN qt1.driver_id < qt2.driver_id THEN qt2.qualifying_q3_millis ELSE qt1.qualifying_q3_millis END AS s_q3
      FROM quali_times qt1
      JOIN quali_times qt2 ON qt1.season = qt2.season AND qt1.round = qt2.round AND qt1.team_id = qt2.team_id AND qt1.driver_id < qt2.driver_id
    ),
    session_selection AS (
      SELECT
        season, round, team_id, driver_primary_id, driver_secondary_id,
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
    )
    INSERT INTO teammate_gap_qualifying_race_level (
      season, round, team_id, driver_primary_id, driver_secondary_id,
      session_used, primary_time_ms, secondary_time_ms, gap_seconds, gap_percent
    )
    SELECT
      season, round, team_id, driver_primary_id, driver_secondary_id, session_used,
      primary_time_ms, secondary_time_ms,
      ((primary_time_ms - secondary_time_ms) / 1000.0)::NUMERIC(8,6),
      (100.0 * (primary_time_ms - secondary_time_ms) / ((primary_time_ms + secondary_time_ms) / 2.0))::NUMERIC(8,3)
    FROM session_selection
    WHERE session_used IS NOT NULL AND primary_time_ms > 0 AND secondary_time_ms > 0
  `, [season]);

  const raceRows = raceResult.rowCount || 0;

  // Insert season-level summaries
  await pool.query(`
    WITH race_gaps AS (SELECT * FROM teammate_gap_qualifying_race_level WHERE season = $1),
    session_counts AS (
      SELECT season, team_id, driver_primary_id, driver_secondary_id, session_used, COUNT(*) AS session_count,
        CASE WHEN session_used = 'Q3' THEN 3 WHEN session_used = 'Q2' THEN 2 WHEN session_used = 'Q1' THEN 1 ELSE 0 END AS session_rank
      FROM race_gaps
      GROUP BY season, team_id, driver_primary_id, driver_secondary_id, session_used
    ),
    session_choice AS (
      SELECT DISTINCT ON (season, team_id, driver_primary_id, driver_secondary_id)
        season, team_id, driver_primary_id, driver_secondary_id, session_used
      FROM session_counts
      ORDER BY season, team_id, driver_primary_id, driver_secondary_id, session_count DESC, session_rank DESC
    ),
    pair_stats AS (
      SELECT
        season, team_id, driver_primary_id, driver_secondary_id,
        COUNT(*) AS shared_races,
        COUNT(*) FILTER (WHERE gap_percent < 0) AS faster_driver_primary_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_percent) AS median_gap_percent,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap_seconds
      FROM race_gaps
      GROUP BY season, team_id, driver_primary_id, driver_secondary_id
    )
    INSERT INTO teammate_gap_qualifying_season_summary (
      season, team_id, driver_primary_id, driver_secondary_id,
      driver_pair_gap_percent, driver_pair_gap_seconds, gap_percent, shared_races,
      faster_driver_primary_count, coverage_status, failure_reason, session_used
    )
    SELECT
      ps.season, ps.team_id, ps.driver_primary_id, ps.driver_secondary_id,
      CASE WHEN ps.shared_races >= $2 THEN ps.median_gap_percent ELSE NULL END,
      CASE WHEN ps.shared_races >= $2 THEN ps.median_gap_seconds ELSE NULL END,
      CASE WHEN ps.shared_races >= $2 THEN ps.median_gap_percent ELSE NULL END,
      ps.shared_races,
      ps.faster_driver_primary_count,
      CASE
        WHEN ps.shared_races >= $3 THEN 'valid'
        WHEN ps.shared_races >= $2 THEN 'low_coverage'
        ELSE 'insufficient'
      END,
      CASE WHEN ps.shared_races < $2 THEN 'INSUFFICIENT_QUALIFYING_SESSIONS' ELSE NULL END,
      sc.session_used
    FROM pair_stats ps
    LEFT JOIN session_choice sc ON sc.season = ps.season AND sc.team_id = ps.team_id
      AND sc.driver_primary_id = ps.driver_primary_id AND sc.driver_secondary_id = ps.driver_secondary_id
  `, [season, TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races, TEAMMATE_GAP_THRESHOLDS.valid_shared_races]);

  return raceRows;
}

async function backfillMatchupMatrix(pool: Pool, season: number): Promise<number> {
  console.log(`  → Computing matchup matrix for ${season}...`);

  // Delete existing data
  await pool.query(`DELETE FROM driver_matchup_matrix WHERE season = $1`, [season]);

  // Insert qualifying matchups
  const qualResult = await pool.query(`
    WITH driver_qualifying AS (
      SELECT DISTINCT rd.driver_id, r.id AS race_id, rd.position_number AS grid_position
      FROM race_data rd
      JOIN race r ON r.id = rd.race_id
      WHERE r.year = $1 AND rd.type = 'QUALIFYING_RESULT' AND rd.position_number IS NOT NULL AND rd.position_number > 0
    ),
    driver_pairs AS (
      SELECT
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq1.driver_id ELSE dq2.driver_id END AS driver_a_id,
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq2.driver_id ELSE dq1.driver_id END AS driver_b_id,
        dq1.race_id,
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq1.grid_position ELSE dq2.grid_position END AS driver_a_pos,
        CASE WHEN dq1.driver_id < dq2.driver_id THEN dq2.grid_position ELSE dq1.grid_position END AS driver_b_pos
      FROM driver_qualifying dq1
      JOIN driver_qualifying dq2 ON dq1.race_id = dq2.race_id AND dq1.driver_id < dq2.driver_id
    )
    INSERT INTO driver_matchup_matrix (driver_a_id, driver_b_id, metric, season, driver_a_wins, driver_b_wins, ties, shared_events, coverage_status)
    SELECT
      driver_a_id, driver_b_id, 'qualifying_position', $1,
      SUM(CASE WHEN driver_a_pos < driver_b_pos THEN 1 ELSE 0 END),
      SUM(CASE WHEN driver_b_pos < driver_a_pos THEN 1 ELSE 0 END),
      SUM(CASE WHEN driver_a_pos = driver_b_pos THEN 1 ELSE 0 END),
      COUNT(*),
      CASE
        WHEN COUNT(*) >= $2 THEN 'valid'
        WHEN COUNT(*) >= $3 THEN 'low_coverage'
        ELSE 'insufficient'
      END
    FROM driver_pairs
    GROUP BY driver_a_id, driver_b_id
  `, [season, MATCHUP_THRESHOLDS.valid, MATCHUP_THRESHOLDS.low_coverage]);

  // Insert race finish matchups
  const raceResult = await pool.query(`
    WITH driver_race AS (
      SELECT DISTINCT rd.driver_id, r.id AS race_id, rd.position_number
      FROM race_data rd
      JOIN race r ON r.id = rd.race_id
      WHERE r.year = $1 AND rd.type = 'RACE_RESULT' AND rd.position_number IS NOT NULL AND rd.position_number > 0
    ),
    driver_pairs AS (
      SELECT
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr1.driver_id ELSE dr2.driver_id END AS driver_a_id,
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr2.driver_id ELSE dr1.driver_id END AS driver_b_id,
        dr1.race_id,
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr1.position_number ELSE dr2.position_number END AS driver_a_pos,
        CASE WHEN dr1.driver_id < dr2.driver_id THEN dr2.position_number ELSE dr1.position_number END AS driver_b_pos
      FROM driver_race dr1
      JOIN driver_race dr2 ON dr1.race_id = dr2.race_id AND dr1.driver_id < dr2.driver_id
    )
    INSERT INTO driver_matchup_matrix (driver_a_id, driver_b_id, metric, season, driver_a_wins, driver_b_wins, ties, shared_events, coverage_status)
    SELECT
      driver_a_id, driver_b_id, 'race_finish_position', $1,
      SUM(CASE WHEN driver_a_pos < driver_b_pos THEN 1 ELSE 0 END),
      SUM(CASE WHEN driver_b_pos < driver_a_pos THEN 1 ELSE 0 END),
      SUM(CASE WHEN driver_a_pos = driver_b_pos THEN 1 ELSE 0 END),
      COUNT(*),
      CASE
        WHEN COUNT(*) >= $2 THEN 'valid'
        WHEN COUNT(*) >= $3 THEN 'low_coverage'
        ELSE 'insufficient'
      END
    FROM driver_pairs
    GROUP BY driver_a_id, driver_b_id
  `, [season, MATCHUP_THRESHOLDS.valid, MATCHUP_THRESHOLDS.low_coverage]);

  return (qualResult.rowCount || 0) + (raceResult.rowCount || 0);
}

async function backfillSeason(pool: Pool, season: number): Promise<void> {
  console.log(`\n=== Backfilling season ${season} ===\n`);

  const data = await checkSeasonData(pool, season);
  console.log(`  Data check: races=${data.hasRaces}, laps=${data.hasLaps}, qualifying=${data.hasQualifying}`);

  if (!data.hasRaces) {
    console.log(`  SKIP: No race data for ${season}`);
    return;
  }

  let totalRows = 0;

  // Teammate gaps (race pace)
  if (data.hasLaps) {
    totalRows += await backfillTeammateGapRace(pool, season);
  } else {
    console.log(`  SKIP: No lap data for ${season} (teammate race gaps)`);
  }

  // Teammate gaps (qualifying)
  if (data.hasQualifying) {
    totalRows += await backfillTeammateGapQualifying(pool, season);
  } else {
    console.log(`  SKIP: No qualifying data for ${season} (teammate qualifying gaps)`);
  }

  // Matchup matrix
  totalRows += await backfillMatchupMatrix(pool, season);

  console.log(`  ✓ Season ${season} complete: ${totalRows} rows inserted`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let seasons = [2022, 2023, 2024];

  for (const arg of args) {
    if (arg.startsWith('--season=')) {
      const s = parseInt(arg.split('=')[1], 10);
      if (!isNaN(s)) {
        seasons = [s];
      }
    }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('=== Multi-Season Backfill ===');
    console.log(`Seasons: ${seasons.join(', ')}`);

    for (const season of seasons) {
      await backfillSeason(pool, season);
    }

    // Print summary
    console.log('\n=== Final Summary ===\n');

    const summary = await pool.query(`
      SELECT
        'teammate_gap_season_summary' AS table_name,
        season,
        COUNT(*) AS rows,
        COUNT(*) FILTER (WHERE coverage_status = 'valid') AS valid
      FROM teammate_gap_season_summary
      GROUP BY season
      UNION ALL
      SELECT
        'teammate_gap_qualifying_season_summary',
        season,
        COUNT(*),
        COUNT(*) FILTER (WHERE coverage_status = 'valid')
      FROM teammate_gap_qualifying_season_summary
      GROUP BY season
      UNION ALL
      SELECT
        'driver_matchup_matrix',
        season,
        COUNT(*),
        COUNT(*) FILTER (WHERE coverage_status = 'valid')
      FROM driver_matchup_matrix
      GROUP BY season
      ORDER BY table_name, season
    `);

    console.log('Table                                  | Season | Rows | Valid');
    console.log('---------------------------------------|--------|------|------');
    for (const row of summary.rows) {
      console.log(`${row.table_name.padEnd(38)} | ${row.season}   | ${String(row.rows).padStart(4)} | ${String(row.valid).padStart(5)}`);
    }

    console.log('\n✓ Backfill complete!\n');
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
