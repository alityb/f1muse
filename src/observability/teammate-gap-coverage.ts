#!/usr/bin/env node

/**
 * TEAMMATE GAP COVERAGE DIAGNOSTIC
 *
 * Identifies missing 2025 teammate pairs and diagnoses why they are missing.
 * Supports race or qualifying teammate gap pipelines.
 * Does NOT modify any data - read-only analysis.
 *
 * Usage:
 *   npx ts-node src/diagnostics/teammate-gap-coverage.ts
 *   npx ts-node src/diagnostics/teammate-gap-coverage.ts --json
 *   npx ts-node src/diagnostics/teammate-gap-coverage.ts --season=2025
 *   npx ts-node src/diagnostics/teammate-gap-coverage.ts --season=2025 --metric=qualifying
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { TEAMMATE_GAP_THRESHOLDS } from '../config/teammate-gap';

type CoverageStatus = 'valid' | 'low_coverage' | 'insufficient' | 'missing';
type DiagnosticReason = 'valid' | 'low_coverage' | 'insufficient' | 'missing_row';
type CoverageMetric = 'race' | 'qualifying';

const METRIC_TABLES: Record<CoverageMetric, { summaryTable: string; entryType: string; label: string; unit: string }> = {
  race: {
    summaryTable: 'teammate_gap_season_summary_2025',
    entryType: 'RACE_RESULT',
    label: 'Race pace',
    unit: 'races'
  },
  qualifying: {
    summaryTable: 'teammate_gap_qualifying_season_summary_2025',
    entryType: 'QUALIFYING_RESULT',
    label: 'Qualifying pace',
    unit: 'qualifying sessions'
  }
};

function parseMetric(rawMetric: unknown): CoverageMetric {
  if (rawMetric === 'qualifying') {
    return 'qualifying';
  }
  return 'race';
}

function metricToLabel(metric: CoverageMetric): string {
  return METRIC_TABLES[metric].label;
}

function metricToUnit(metric: CoverageMetric): string {
  return METRIC_TABLES[metric].unit;
}

interface TeammatePairDiagnostic {
  team_id: string;
  driver_primary_id: string;
  driver_secondary_id: string;
  status: DiagnosticReason;
  shared_races: number | null;
  driver_pair_gap_percent: number | null;
  faster_driver_primary_count: number | null;
  failure_reason: string | null;
  diagnosis: string;
}

interface TeamBreakdown {
  team_id: string;
  pairs: TeammatePairDiagnostic[];
  valid_count: number;
  low_coverage_count: number;
  insufficient_count: number;
  missing_count: number;
}

interface DiagnosticSummary {
  season: number;
  expected_pairs: number;
  valid_pairs: number;
  low_coverage_pairs: number;
  insufficient_pairs: number;
  missing_pairs: number;
  coverage_percent: number;
  usable_percent: number;
  by_status: Record<DiagnosticReason, number>;
  by_team: TeamBreakdown[];
  pairs: TeammatePairDiagnostic[];
}

function normalizeTeamId(rawTeamId: string): string {
  if (!rawTeamId) {
    return rawTeamId;
  }

  const normalized = rawTeamId
    .toLowerCase()
    .replace(/_/g, '-')
    .trim()
    .replace(/-f1-team$/, '');

  switch (normalized) {
    case 'mcl':
    case 'mclaren':
      return 'mclaren';
    case 'fer':
    case 'ferrari':
      return 'ferrari';
    case 'rbr':
    case 'red-bull':
    case 'redbull':
      return 'red-bull';
    case 'amr':
    case 'aston':
    case 'aston-martin':
      return 'aston-martin';
    case 'rb':
    case 'racing-bulls':
    case 'racingbulls':
    case 'visa-cash-app-rb':
    case 'alphatauri':
    case 'alpha-tauri':
      return 'racing-bulls';
    case 'sauber':
    case 'kick-sauber':
    case 'kicksauber':
    case 'stake':
    case 'alfa-romeo':
      return 'kick-sauber';
    default:
      return normalized;
  }
}

/**
 * Get all expected teammate pairs from qualifying data
 */
async function getExpectedTeammatePairs(
  pool: Pool,
  season: number,
  metric: CoverageMetric
): Promise<Array<{team_id: string, driver_a: string, driver_b: string}>> {
  const metricConfig = METRIC_TABLES[metric];
  const extraFilter = metric === 'race'
    ? 'AND rd.position_number IS NOT NULL'
    : 'AND (rd.qualifying_q1_millis IS NOT NULL OR rd.qualifying_q2_millis IS NOT NULL OR rd.qualifying_q3_millis IS NOT NULL)';

  const result = await pool.query(`
    WITH entries AS (
      SELECT
        r.year AS season,
        r.round,
        rd.driver_id,
        CASE
          WHEN LOWER(rd.constructor_id) IN ('mclaren', 'mcl') THEN 'mclaren'
          WHEN LOWER(rd.constructor_id) IN ('ferrari', 'fer') THEN 'ferrari'
          WHEN LOWER(rd.constructor_id) IN ('red-bull', 'red_bull', 'redbull', 'rbr') THEN 'red-bull'
          WHEN LOWER(rd.constructor_id) IN ('mercedes', 'mer') THEN 'mercedes'
          WHEN LOWER(rd.constructor_id) IN ('aston-martin', 'aston_martin', 'amr') THEN 'aston-martin'
          WHEN LOWER(rd.constructor_id) IN ('alpine', 'alp') THEN 'alpine'
          WHEN LOWER(rd.constructor_id) IN ('williams', 'wil') THEN 'williams'
          WHEN LOWER(rd.constructor_id) IN ('haas', 'haa') THEN 'haas'
          WHEN LOWER(rd.constructor_id) IN ('racing-bulls', 'racing_bulls', 'rb', 'visa-cash-app-rb', 'alphatauri', 'alpha_tauri') THEN 'racing-bulls'
          WHEN LOWER(rd.constructor_id) IN ('kick-sauber', 'kick_sauber', 'sauber', 'alfa-romeo', 'alfa_romeo', 'stake') THEN 'kick-sauber'
          ELSE LOWER(REPLACE(rd.constructor_id, '_', '-'))
        END AS team_id
      FROM race_data rd
      JOIN race r ON r.id = rd.race_id
      WHERE r.year = $1
        AND rd.type = $2
        AND rd.driver_id IS NOT NULL
        AND rd.constructor_id IS NOT NULL
        ${extraFilter}
    ),
    teammate_pairs AS (
      SELECT
        e1.team_id,
        LEAST(e1.driver_id, e2.driver_id) AS driver_primary_id,
        GREATEST(e1.driver_id, e2.driver_id) AS driver_secondary_id
      FROM entries e1
      JOIN entries e2
        ON e1.season = e2.season
        AND e1.round = e2.round
        AND e1.team_id = e2.team_id
        AND e1.driver_id < e2.driver_id
    )
    SELECT DISTINCT
      team_id,
      driver_primary_id AS driver_a,
      driver_secondary_id AS driver_b
    FROM teammate_pairs
    ORDER BY team_id, driver_a, driver_b
  `, [season, metricConfig.entryType]);

  return result.rows;
}

/**
 * Diagnose each teammate pair
 */
async function diagnoseTeammatePair(
  pool: Pool,
  season: number,
  metric: CoverageMetric,
  team_id: string,
  driver_a: string,
  driver_b: string
): Promise<TeammatePairDiagnostic> {
  const normalizedTeamId = normalizeTeamId(team_id);
  const metricConfig = METRIC_TABLES[metric];

  // Check if row exists in summary table
  const summaryResult = await pool.query(`
    SELECT
      COALESCE(gap_percent, driver_pair_gap_percent) AS gap_percent,
      driver_pair_gap_seconds,
      shared_races,
      faster_driver_primary_count,
      coverage_status,
      failure_reason
    FROM ${metricConfig.summaryTable}
    WHERE season = $1
      AND driver_primary_id = $2
      AND driver_secondary_id = $3
    LIMIT 1
  `, [season, driver_a, driver_b]);

  if (summaryResult.rows.length === 0) {
    return {
      team_id: normalizedTeamId,
      driver_primary_id: driver_a,
      driver_secondary_id: driver_b,
      status: 'missing_row',
      shared_races: null,
      driver_pair_gap_percent: null,
      faster_driver_primary_count: null,
      failure_reason: null,
      diagnosis: 'No season summary row exists. May need to re-run ingestion.'
    };
  }

  const row = summaryResult.rows[0];
  const sharedRaces = row.shared_races !== null ? parseInt(row.shared_races, 10) : null;
  const gapPercent = row.gap_percent !== null ? parseFloat(row.gap_percent) : null;
  const fasterCount = row.faster_driver_primary_count !== null ? parseInt(row.faster_driver_primary_count, 10) : null;

  if (row.failure_reason) {
    return {
      team_id: normalizedTeamId,
      driver_primary_id: driver_a,
      driver_secondary_id: driver_b,
      status: 'insufficient',
      shared_races: sharedRaces,
      driver_pair_gap_percent: gapPercent,
      faster_driver_primary_count: fasterCount,
      failure_reason: row.failure_reason,
      diagnosis: `Row exists but has failure_reason: ${row.failure_reason}`
    };
  }

  if (gapPercent === null) {
    return {
      team_id: normalizedTeamId,
      driver_primary_id: driver_a,
      driver_secondary_id: driver_b,
      status: 'insufficient',
      shared_races: sharedRaces,
      driver_pair_gap_percent: null,
      faster_driver_primary_count: fasterCount,
      failure_reason: null,
      diagnosis: `Row exists but driver_pair_gap_percent is NULL. Shared races: ${sharedRaces} (min: ${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races})`
    };
  }

  if (sharedRaces !== null && sharedRaces < TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races) {
    return {
      team_id: normalizedTeamId,
      driver_primary_id: driver_a,
      driver_secondary_id: driver_b,
      status: 'insufficient',
      shared_races: sharedRaces,
      driver_pair_gap_percent: gapPercent,
      faster_driver_primary_count: fasterCount,
      failure_reason: null,
      diagnosis: `Shared races (${sharedRaces}) below minimum (${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races})`
    };
  }

  // Check for low_coverage vs valid
  if (sharedRaces !== null && sharedRaces < TEAMMATE_GAP_THRESHOLDS.valid_shared_races) {
    return {
      team_id: normalizedTeamId,
      driver_primary_id: driver_a,
      driver_secondary_id: driver_b,
      status: 'low_coverage',
      shared_races: sharedRaces,
      driver_pair_gap_percent: gapPercent,
      faster_driver_primary_count: fasterCount,
      failure_reason: null,
      diagnosis: `Low coverage. Gap: ${gapPercent.toFixed(3)}%, Shared races: ${sharedRaces}, Faster: ${driver_a.replace(/_/g, ' ')} ${fasterCount}x`
    };
  }

  return {
    team_id: normalizedTeamId,
    driver_primary_id: driver_a,
    driver_secondary_id: driver_b,
    status: 'valid',
    shared_races: sharedRaces,
    driver_pair_gap_percent: gapPercent,
    faster_driver_primary_count: fasterCount,
    failure_reason: null,
    diagnosis: `Valid. Gap: ${gapPercent.toFixed(3)}%, Shared races: ${sharedRaces}, Faster: ${driver_a.replace(/_/g, ' ')} ${fasterCount}x`
  };
}

/**
 * Main diagnostic entry point
 */
export async function runTeammateGapDiagnostics(
  pool: Pool,
  season: number = 2025,
  metric: CoverageMetric = 'race'
): Promise<DiagnosticSummary> {
  const expectedPairs = await getExpectedTeammatePairs(pool, season, metric);
  const expectedPairMap = new Map<string, {team_id: string, driver_a: string, driver_b: string}>();

  for (const pair of expectedPairs) {
    const teamId = normalizeTeamId(pair.team_id);
    const key = `${teamId}::${pair.driver_a}::${pair.driver_b}`;
    if (!expectedPairMap.has(key)) {
      expectedPairMap.set(key, {
        team_id: teamId,
        driver_a: pair.driver_a,
        driver_b: pair.driver_b
      });
    }
  }

  const normalizedPairs = Array.from(expectedPairMap.values());
  const diagnostics: TeammatePairDiagnostic[] = [];

  for (const pair of normalizedPairs) {
    const diagnostic = await diagnoseTeammatePair(
      pool,
      season,
      metric,
      pair.team_id,
      pair.driver_a,
      pair.driver_b
    );
    diagnostics.push(diagnostic);
  }

  // Count by status
  const byStatus: Record<DiagnosticReason, number> = {
    valid: 0,
    low_coverage: 0,
    missing_row: 0,
    insufficient: 0
  };

  for (const d of diagnostics) {
    byStatus[d.status]++;
  }

  // Group by team
  const teamMap = new Map<string, TeammatePairDiagnostic[]>();
  for (const d of diagnostics) {
    const existing = teamMap.get(d.team_id) || [];
    existing.push(d);
    teamMap.set(d.team_id, existing);
  }

  const byTeam: TeamBreakdown[] = [];
  for (const [team_id, pairs] of teamMap.entries()) {
    byTeam.push({
      team_id,
      pairs,
      valid_count: pairs.filter(p => p.status === 'valid').length,
      low_coverage_count: pairs.filter(p => p.status === 'low_coverage').length,
      insufficient_count: pairs.filter(p => p.status === 'insufficient').length,
      missing_count: pairs.filter(p => p.status === 'missing_row').length
    });
  }

  const validPairs = byStatus.valid;
  const lowCoveragePairs = byStatus.low_coverage;
  const insufficientPairs = byStatus.insufficient;
  const missingPairs = byStatus.missing_row;
  const usablePairs = validPairs + lowCoveragePairs;
  const coveragePercent = normalizedPairs.length > 0
    ? Math.round((usablePairs / normalizedPairs.length) * 100)
    : 0;
  const usablePercent = normalizedPairs.length > 0
    ? Math.round((usablePairs / normalizedPairs.length) * 100)
    : 0;

  return {
    season,
    expected_pairs: normalizedPairs.length,
    valid_pairs: validPairs,
    low_coverage_pairs: lowCoveragePairs,
    insufficient_pairs: insufficientPairs,
    missing_pairs: missingPairs,
    coverage_percent: coveragePercent,
    usable_percent: usablePercent,
    by_status: byStatus,
    by_team: byTeam.sort((a, b) => a.team_id.localeCompare(b.team_id)),
    pairs: diagnostics
  };
}

/**
 * Print diagnostics in human-readable format
 */
function printDiagnostics(summary: DiagnosticSummary, metric: CoverageMetric): void {
  console.log(`\n=== TEAMMATE GAP COVERAGE DIAGNOSTIC (Season ${summary.season}) ===`);
  console.log(`    Metric: ${metricToLabel(metric)}\n`);
  console.log(`Expected pairs: ${summary.expected_pairs}`);
  console.log(`\n=== SUMMARY ===\n`);
  console.log(
    `Valid pairs (≥${TEAMMATE_GAP_THRESHOLDS.valid_shared_races} ${metricToUnit(metric)}): ${summary.valid_pairs}`
  );
  console.log(`Low coverage pairs (≥${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races} ${metricToUnit(metric)}): ${summary.low_coverage_pairs}`);
  console.log(`Insufficient pairs:              ${summary.insufficient_pairs}`);
  console.log(`Missing pairs:                   ${summary.missing_pairs}`);
  console.log(`\nUsable pairs (valid + low_coverage): ${summary.valid_pairs + summary.low_coverage_pairs}`);
  console.log(`Coverage percent: ${summary.coverage_percent}%`);

  console.log('\n=== BY STATUS ===\n');
  for (const [status, count] of Object.entries(summary.by_status)) {
    console.log(`${status}: ${count}`);
  }

  console.log('\n=== BY TEAM ===\n');
  for (const team of summary.by_team) {
    const statusParts = [];
    if (team.valid_count > 0) { statusParts.push(`${team.valid_count} valid`); }
    if (team.low_coverage_count > 0) { statusParts.push(`${team.low_coverage_count} low_coverage`); }
    if (team.insufficient_count > 0) { statusParts.push(`${team.insufficient_count} insufficient`); }
    if (team.missing_count > 0) { statusParts.push(`${team.missing_count} missing`); }
    console.log(`${team.team_id}: ${statusParts.join(', ') || 'no pairs'}`);
  }

  // Print details by status
  const validPairs = summary.pairs.filter(d => d.status === 'valid');
  const lowCoveragePairs = summary.pairs.filter(d => d.status === 'low_coverage');
  const missingRow = summary.pairs.filter(d => d.status === 'missing_row');
  const insufficientCoverage = summary.pairs.filter(d => d.status === 'insufficient');

  if (validPairs.length > 0) {
    console.log('\n=== VALID PAIRS ===');
    for (const d of validPairs) {
      const primaryName = d.driver_primary_id.replace(/_/g, ' ');
      const secondaryName = d.driver_secondary_id.replace(/_/g, ' ');
      console.log(`\n✓ ${d.team_id}: ${primaryName} vs ${secondaryName}`);
      console.log(`  ${d.diagnosis}`);
    }
  }

  if (lowCoveragePairs.length > 0) {
    console.log('\n=== LOW COVERAGE PAIRS ===');
    for (const d of lowCoveragePairs) {
      const primaryName = d.driver_primary_id.replace(/_/g, ' ');
      const secondaryName = d.driver_secondary_id.replace(/_/g, ' ');
      console.log(`\n~ ${d.team_id}: ${primaryName} vs ${secondaryName}`);
      console.log(`  ${d.diagnosis}`);
    }
  }

  if (missingRow.length > 0) {
    console.log('\n=== MISSING ROW ===');
    for (const d of missingRow) {
      const primaryName = d.driver_primary_id.replace(/_/g, ' ');
      const secondaryName = d.driver_secondary_id.replace(/_/g, ' ');
      console.log(`\n✗ ${d.team_id}: ${primaryName} vs ${secondaryName}`);
      console.log(`  ${d.diagnosis}`);
    }
  }

  if (insufficientCoverage.length > 0) {
    console.log('\n=== INSUFFICIENT COVERAGE ===');
    for (const d of insufficientCoverage) {
      const primaryName = d.driver_primary_id.replace(/_/g, ' ');
      const secondaryName = d.driver_secondary_id.replace(/_/g, ' ');
      console.log(`\n⚠ ${d.team_id}: ${primaryName} vs ${secondaryName}`);
      console.log(`  ${d.diagnosis}`);
    }
  }

  console.log('');
}

/**
 * Get coverage status for a specific driver pair (used by debug endpoint)
 */
export async function getTeammateGapCoverage(
  pool: Pool,
  season: number,
  driverA: string,
  driverB: string,
  metric: CoverageMetric = 'race'
): Promise<{
  exists: boolean;
  shared_races: number | null;
  min_required_races: number;
  gap_present: boolean;
  gap_percent: number | null;
  faster_driver_primary_count: number | null;
  coverage_status: CoverageStatus;
  failure_reason: string | null;
}> {
  // Normalize driver order
  const driverPrimary = driverA < driverB ? driverA : driverB;
  const driverSecondary = driverA < driverB ? driverB : driverA;
  const metricConfig = METRIC_TABLES[metric];

  const result = await pool.query(`
    SELECT
      COALESCE(gap_percent, driver_pair_gap_percent) AS gap_percent,
      driver_pair_gap_seconds,
      shared_races,
      faster_driver_primary_count,
      coverage_status,
      failure_reason
    FROM ${metricConfig.summaryTable}
    WHERE season = $1
      AND driver_primary_id = $2
      AND driver_secondary_id = $3
    LIMIT 1
  `, [season, driverPrimary, driverSecondary]);

  if (result.rows.length === 0) {
    return {
      exists: false,
      shared_races: null,
      min_required_races: TEAMMATE_GAP_THRESHOLDS.valid_shared_races,
      gap_present: false,
      gap_percent: null,
      faster_driver_primary_count: null,
      coverage_status: 'missing',
      failure_reason: 'No summary row exists for this driver pair'
    };
  }

  const row = result.rows[0];
  const sharedRaces = row.shared_races !== null ? parseInt(row.shared_races, 10) : null;
  const gapPercent = row.gap_percent !== null ? parseFloat(row.gap_percent) : null;
  const gapPresent = gapPercent !== null;
  const fasterCount = row.faster_driver_primary_count !== null ? parseInt(row.faster_driver_primary_count, 10) : null;

  let coverageStatus: CoverageStatus;
  let failureReason = row.failure_reason || null;

  if (row.failure_reason) {
    coverageStatus = 'insufficient';
  } else if (!gapPresent) {
    coverageStatus = 'insufficient';
    failureReason = 'driver_pair_gap_percent is null';
  } else if (sharedRaces !== null && sharedRaces < TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races) {
    coverageStatus = 'insufficient';
    failureReason = `shared_races (${sharedRaces}) below minimum (${TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races})`;
  } else if (sharedRaces !== null && sharedRaces < TEAMMATE_GAP_THRESHOLDS.valid_shared_races) {
    coverageStatus = 'low_coverage';
  } else {
    coverageStatus = 'valid';
  }

  return {
    exists: true,
    shared_races: sharedRaces,
    min_required_races: TEAMMATE_GAP_THRESHOLDS.valid_shared_races,
    gap_present: gapPresent,
    gap_percent: gapPercent,
    faster_driver_primary_count: fasterCount,
    coverage_status: coverageStatus,
    failure_reason: failureReason
  };
}

/**
 * Get coverage summary for health endpoint
 */
export async function getTeammateGapCoverageSummary(
  pool: Pool,
  season: number,
  metric: CoverageMetric = 'race'
): Promise<{
  expected_pairs: number;
  valid_pairs: number;
  low_coverage_pairs: number;
  insufficient_pairs: number;
  coverage_percent: number;
}> {
  const summary = await runTeammateGapDiagnostics(pool, season, metric);

  return {
    expected_pairs: summary.expected_pairs,
    valid_pairs: summary.valid_pairs,
    low_coverage_pairs: summary.low_coverage_pairs,
    insufficient_pairs: summary.insufficient_pairs + summary.missing_pairs,
    coverage_percent: summary.coverage_percent
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

  runTeammateGapDiagnostics(pool, season, metric)
    .then((summary) => {
      if (json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        printDiagnostics(summary, metric);
      }
      pool.end();
      process.exit(0);
    })
    .catch((err) => {
      console.error('Diagnostic failed:', err);
      pool.end();
      process.exit(1);
    });
}

export { TeammatePairDiagnostic, DiagnosticSummary };
