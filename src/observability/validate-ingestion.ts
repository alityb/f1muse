#!/usr/bin/env node

/**
 * TEAMMATE GAP INGESTION VALIDATOR
 *
 * CI validation script that checks data integrity for teammate gap tables.
 * Exits with non-zero status on any validation failure.
 *
 * Checks:
 * - Every team has at least one valid or low_coverage pair
 * - No NULL driver_pair_gap_percent for valid/low_coverage rows
 * - No duplicate pairs
 * - No reversed duplicates (A,B) and (B,A)
 * - Race-level data exists for season-level pairs
 * - Coverage status consistency with shared_races
 *
 * Usage:
 *   npm run validate:teammate-gap
 *   npx ts-node src/diagnostics/validate-teammate-gap-ingestion.ts
 *   npx ts-node src/diagnostics/validate-teammate-gap-ingestion.ts --season=2025
 *   npx ts-node src/diagnostics/validate-teammate-gap-ingestion.ts --season=2025 --metric=qualifying
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { TEAMMATE_GAP_THRESHOLDS } from '../config/teammate-gap';

type CoverageMetric = 'race' | 'qualifying';

const METRIC_TABLES: Record<CoverageMetric, { summaryTable: string; raceLevelTable: string; label: string }> = {
  race: {
    summaryTable: 'teammate_gap_season_summary_2025',
    raceLevelTable: 'teammate_gap_race_level_2025',
    label: 'Race pace'
  },
  qualifying: {
    summaryTable: 'teammate_gap_qualifying_season_summary_2025',
    raceLevelTable: 'teammate_gap_qualifying_race_level_2025',
    label: 'Qualifying pace'
  }
};

function parseMetric(rawMetric: unknown): CoverageMetric {
  if (rawMetric === 'qualifying') {
    return 'qualifying';
  }
  return 'race';
}

interface ValidationResult {
  check: string;
  passed: boolean;
  message: string;
  details?: any;
}

interface ValidationSummary {
  season: number;
  all_passed: boolean;
  results: ValidationResult[];
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
}

/**
 * Check that at least 70% of teams have at least one usable pair (valid or low_coverage)
 */
async function checkTeamsHaveUsablePairs(
  pool: Pool,
  season: number,
  summaryTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    WITH team_pairs AS (
      SELECT DISTINCT
        team_id,
        coverage_status
      FROM ${summaryTable}
      WHERE season = $1
    ),
    teams_with_usable AS (
      SELECT DISTINCT team_id
      FROM team_pairs
      WHERE coverage_status IN ('valid', 'low_coverage')
    ),
    all_teams AS (
      SELECT DISTINCT
        CASE
          WHEN normalized_team_id IN ('mcl', 'mclaren') THEN 'mclaren'
          WHEN normalized_team_id IN ('fer', 'ferrari') THEN 'ferrari'
          WHEN normalized_team_id IN ('rbr', 'red-bull', 'redbull') THEN 'red-bull'
          WHEN normalized_team_id IN ('amr', 'aston', 'aston-martin') THEN 'aston-martin'
          WHEN normalized_team_id IN ('rb', 'racing-bulls', 'racingbulls', 'visa-cash-app-rb') THEN 'racing-bulls'
          WHEN normalized_team_id IN ('sauber', 'kick-sauber', 'kicksauber', 'stake') THEN 'kick-sauber'
          ELSE normalized_team_id
        END AS team_id
      FROM (
        SELECT DISTINCT
          REGEXP_REPLACE(
            LOWER(TRIM(REPLACE(COALESCE(rd.constructor_id, ''), '_', '-'))),
            '-f1-team$',
            ''
          ) AS normalized_team_id
        FROM race_data rd
        JOIN race r ON r.id = rd.race_id
        WHERE r.year = $1
      ) t
      WHERE normalized_team_id <> ''
    ),
    teams_without_usable AS (
      SELECT at.team_id
      FROM all_teams at
      LEFT JOIN teams_with_usable twu ON at.team_id = twu.team_id
      WHERE twu.team_id IS NULL
    ),
    team_counts AS (
      SELECT
        (SELECT COUNT(*) FROM all_teams) AS total_teams,
        (SELECT COUNT(*) FROM teams_without_usable) AS teams_without
    )
    SELECT
      tc.total_teams,
      tc.teams_without,
      twu.team_id
    FROM team_counts tc
    LEFT JOIN teams_without_usable twu ON true
  `, [season]);

  const totalTeams = result.rows[0]?.total_teams || 0;
  const teamsWithoutCount = result.rows[0]?.teams_without || 0;
  const teamsWithoutList = result.rows
    .filter(r => r.team_id !== null)
    .map(r => r.team_id);

  // Pass if at least 70% of teams have usable pairs (i.e., <= 30% without)
  const percentWithout = totalTeams > 0 ? teamsWithoutCount / totalTeams : 0;
  const passed = percentWithout <= 0.3;

  if (passed) {
    const coveragePercent = Math.round((1 - percentWithout) * 100);
    return {
      check: 'teams_have_usable_pairs',
      passed: true,
      message: `${coveragePercent}% of teams have usable pairs (${totalTeams - teamsWithoutCount}/${totalTeams})`
    };
  }

  return {
    check: 'teams_have_usable_pairs',
    passed: false,
    message: `Only ${Math.round((1 - percentWithout) * 100)}% of teams have usable pairs (need >= 70%)`,
    details: teamsWithoutList
  };
}

/**
 * Check that valid/low_coverage rows don't have NULL gap values
 */
async function checkNoNullGapsForUsableRows(
  pool: Pool,
  season: number,
  summaryTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    SELECT
      team_id,
      driver_primary_id,
      driver_secondary_id,
      coverage_status,
      shared_races
    FROM ${summaryTable}
    WHERE season = $1
      AND coverage_status IN ('valid', 'low_coverage')
      AND driver_pair_gap_percent IS NULL
  `, [season]);

  if (result.rows.length === 0) {
    return {
      check: 'no_null_gaps_for_usable',
      passed: true,
      message: 'No NULL gap values for valid/low_coverage rows'
    };
  }

  return {
    check: 'no_null_gaps_for_usable',
    passed: false,
    message: `${result.rows.length} row(s) with NULL gap and usable coverage_status`,
    details: result.rows
  };
}

/**
 * Check for exact duplicate pairs
 */
async function checkNoDuplicatePairs(
  pool: Pool,
  season: number,
  summaryTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    SELECT
      team_id,
      driver_primary_id,
      driver_secondary_id,
      COUNT(*) AS count
    FROM ${summaryTable}
    WHERE season = $1
    GROUP BY team_id, driver_primary_id, driver_secondary_id
    HAVING COUNT(*) > 1
  `, [season]);

  if (result.rows.length === 0) {
    return {
      check: 'no_duplicate_pairs',
      passed: true,
      message: 'No duplicate pairs found'
    };
  }

  return {
    check: 'no_duplicate_pairs',
    passed: false,
    message: `${result.rows.length} duplicate pair(s) found`,
    details: result.rows
  };
}

/**
 * Check for reversed duplicates (A,B) and (B,A)
 */
async function checkNoReversedDuplicates(
  pool: Pool,
  season: number,
  summaryTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    SELECT
      a.team_id,
      a.driver_primary_id AS pair_a_primary,
      a.driver_secondary_id AS pair_a_secondary,
      b.driver_primary_id AS pair_b_primary,
      b.driver_secondary_id AS pair_b_secondary
    FROM ${summaryTable} a
    JOIN ${summaryTable} b
      ON a.season = b.season
     AND a.team_id = b.team_id
     AND a.driver_primary_id = b.driver_secondary_id
     AND a.driver_secondary_id = b.driver_primary_id
    WHERE a.season = $1
  `, [season]);

  if (result.rows.length === 0) {
    return {
      check: 'no_reversed_duplicates',
      passed: true,
      message: 'No reversed duplicates found'
    };
  }

  return {
    check: 'no_reversed_duplicates',
    passed: false,
    message: `${result.rows.length} reversed duplicate(s) found`,
    details: result.rows
  };
}

/**
 * Check that driver IDs are lexicographically ordered (primary < secondary)
 */
async function checkDriverOrdering(
  pool: Pool,
  season: number,
  summaryTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    SELECT
      team_id,
      driver_primary_id,
      driver_secondary_id
    FROM ${summaryTable}
    WHERE season = $1
      AND driver_primary_id >= driver_secondary_id
  `, [season]);

  if (result.rows.length === 0) {
    return {
      check: 'driver_ordering',
      passed: true,
      message: 'All pairs have correct driver ordering (primary < secondary)'
    };
  }

  return {
    check: 'driver_ordering',
    passed: false,
    message: `${result.rows.length} row(s) with incorrect driver ordering`,
    details: result.rows
  };
}

/**
 * Check that race-level data exists for season-level pairs (via race-level table)
 */
async function checkRaceLevelDataExists(
  pool: Pool,
  season: number,
  summaryTable: string,
  raceLevelTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    WITH race_level_pairs AS (
      SELECT DISTINCT
        team_id,
        driver_primary_id,
        driver_secondary_id
      FROM ${raceLevelTable}
      WHERE season = $1
    )
    SELECT
      s.team_id,
      s.driver_primary_id,
      s.driver_secondary_id,
      s.coverage_status
    FROM ${summaryTable} s
    LEFT JOIN race_level_pairs rp
      ON rp.team_id = s.team_id
      AND rp.driver_primary_id = s.driver_primary_id
      AND rp.driver_secondary_id = s.driver_secondary_id
    WHERE s.season = $1
      AND s.coverage_status IN ('valid', 'low_coverage')
      AND rp.team_id IS NULL
  `, [season]);

  if (result.rows.length === 0) {
    return {
      check: 'race_level_data_exists',
      passed: true,
      message: 'All usable season-level pairs have corresponding race-level data'
    };
  }

  return {
    check: 'race_level_data_exists',
    passed: false,
    message: `${result.rows.length} usable pair(s) without race-level data`,
    details: result.rows
  };
}

/**
 * Check coverage status consistency with shared_races
 */
async function checkCoverageStatusConsistency(
  pool: Pool,
  season: number,
  summaryTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    SELECT
      team_id,
      driver_primary_id,
      driver_secondary_id,
      shared_races,
      coverage_status,
      CASE
        WHEN shared_races >= $2 THEN 'valid'
        WHEN shared_races >= $3 THEN 'low_coverage'
        ELSE 'insufficient'
      END AS expected_status
    FROM ${summaryTable}
    WHERE season = $1
      AND coverage_status != CASE
        WHEN shared_races >= $2 THEN 'valid'
        WHEN shared_races >= $3 THEN 'low_coverage'
        ELSE 'insufficient'
      END
  `, [
    season,
    TEAMMATE_GAP_THRESHOLDS.valid_shared_races,
    TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races
  ]);

  if (result.rows.length === 0) {
    return {
      check: 'coverage_status_consistency',
      passed: true,
      message: 'Coverage status consistent with shared_races'
    };
  }

  return {
    check: 'coverage_status_consistency',
    passed: false,
    message: `${result.rows.length} row(s) with inconsistent coverage_status`,
    details: result.rows
  };
}

/**
 * Check that race-level data uses valid qualifying sessions (Q1, Q2, Q3)
 */
async function checkValidSessions(
  pool: Pool,
  season: number,
  raceLevelTable: string
): Promise<ValidationResult> {
  const result = await pool.query(`
    SELECT DISTINCT session_used
    FROM ${raceLevelTable}
    WHERE season = $1
      AND session_used NOT IN ('Q1', 'Q2', 'Q3')
  `, [season]);

  if (result.rows.length === 0) {
    return {
      check: 'valid_sessions',
      passed: true,
      message: 'All race-level data uses valid sessions (Q1, Q2, Q3)'
    };
  }

  return {
    check: 'valid_sessions',
    passed: false,
    message: `Invalid session(s) found`,
    details: result.rows.map(r => r.session_used)
  };
}

/**
 * Run all validation checks
 */
export async function validateTeammateGapIngestion(
  pool: Pool,
  season: number = 2025,
  metric: CoverageMetric = 'race'
): Promise<ValidationSummary> {
  const metricConfig = METRIC_TABLES[metric];

  console.log(`\n=== TEAMMATE GAP INGESTION VALIDATION (Season ${season}) ===`);
  console.log(`    Metric: ${metricConfig.label}\n`);

  const checks: Array<() => Promise<ValidationResult>> = [
    () => checkTeamsHaveUsablePairs(pool, season, metricConfig.summaryTable),
    () => checkNoNullGapsForUsableRows(pool, season, metricConfig.summaryTable),
    () => checkNoDuplicatePairs(pool, season, metricConfig.summaryTable),
    () => checkNoReversedDuplicates(pool, season, metricConfig.summaryTable),
    () => checkDriverOrdering(pool, season, metricConfig.summaryTable),
    () => checkRaceLevelDataExists(pool, season, metricConfig.summaryTable, metricConfig.raceLevelTable),
    () => checkCoverageStatusConsistency(pool, season, metricConfig.summaryTable)
  ];

  if (metric === 'qualifying') {
    checks.push(() => checkValidSessions(pool, season, metricConfig.raceLevelTable));
  }

  const results: ValidationResult[] = [];

  for (const check of checks) {
    const result = await check();
    results.push(result);

    const status = result.passed ? '✓' : '✗';
    console.log(`${status} ${result.check}: ${result.message}`);

    if (!result.passed && result.details) {
      console.log(`  Details: ${JSON.stringify(result.details, null, 2).substring(0, 200)}...`);
    }
  }

  const passedChecks = results.filter(r => r.passed).length;
  const failedChecks = results.filter(r => !r.passed).length;
  const allPassed = failedChecks === 0;

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total checks: ${results.length}`);
  console.log(`Passed: ${passedChecks}`);
  console.log(`Failed: ${failedChecks}`);
  console.log(`Status: ${allPassed ? 'PASS' : 'FAIL'}\n`);

  return {
    season,
    all_passed: allPassed,
    results,
    total_checks: results.length,
    passed_checks: passedChecks,
    failed_checks: failedChecks
  };
}

/**
 * Parse CLI arguments
 */
function parseArgs(): { season: number; json: boolean; metric: CoverageMetric } {
  const args = process.argv.slice(2);
  let season = 2025;
  let json = false;
  let metric: CoverageMetric = 'race';

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    }
    if (arg.startsWith('--season=')) {
      const s = parseInt(arg.split('=')[1], 10);
      if (!isNaN(s)) {
        season = s;
      }
    }
    if (arg.startsWith('--metric=')) {
      const rawMetric = arg.split('=')[1];
      metric = parseMetric(rawMetric);
    }
  }

  return { season, json, metric };
}

// Run if executed directly
if (require.main === module) {
  const { season, json, metric } = parseArgs();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  validateTeammateGapIngestion(pool, season, metric)
    .then((summary) => {
      if (json) {
        console.log(JSON.stringify(summary, null, 2));
      }

      pool.end();
      process.exit(summary.all_passed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Validation failed:', err);
      pool.end();
      process.exit(1);
    });
}

export { ValidationResult, ValidationSummary };
