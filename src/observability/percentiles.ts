/**
 * TIER 2: Percentile Calculator
 *
 * Computes percentile rankings for driver performance metrics.
 * Used in driver profile and season summaries.
 *
 * METHODOLOGY:
 * - Percentile = (rank - 1) / (total - 1) * 100
 * - 100th percentile = best performer
 * - 0th percentile = worst performer
 */

import { Pool } from 'pg';
import { PercentileRanking } from '../types/results';

/**
 * Percentile thresholds for interpretation
 */
export const PERCENTILE_THRESHOLDS = {
  ELITE: 90,      // Top 10%
  EXCELLENT: 75,  // Top 25%
  GOOD: 50,       // Above median
  AVERAGE: 25,    // Below median
  POOR: 10        // Bottom 10%
} as const;

/**
 * Get interpretation of percentile
 */
export function interpretPercentile(percentile: number): string {
  if (percentile >= PERCENTILE_THRESHOLDS.ELITE) { return 'elite'; }
  if (percentile >= PERCENTILE_THRESHOLDS.EXCELLENT) { return 'excellent'; }
  if (percentile >= PERCENTILE_THRESHOLDS.GOOD) { return 'good'; }
  if (percentile >= PERCENTILE_THRESHOLDS.AVERAGE) { return 'average'; }
  return 'below_average';
}

/**
 * Calculate percentile from rank and total
 */
export function calculatePercentile(rank: number, total: number): number {
  if (total <= 1) { return 100; }
  // Higher percentile = better (rank 1 = 100th percentile)
  return Math.round(((total - rank) / (total - 1)) * 100);
}

/**
 * Compute qualifying pace percentile for a driver in a season
 */
export async function computeQualifyingPacePercentile(
  pool: Pool,
  driverId: string,
  season: number
): Promise<PercentileRanking | null> {
  const query = `
    WITH driver_gaps AS (
      SELECT
        CASE
          WHEN driver_primary_id = $1 THEN gap_percent
          ELSE -gap_percent
        END AS gap,
        driver_primary_id,
        driver_secondary_id
      FROM teammate_gap_qualifying_season_summary_2025
      WHERE (driver_primary_id = $1 OR driver_secondary_id = $1)
        AND season = $2
        AND coverage_status IN ('valid', 'low_coverage')
      LIMIT 1
    ),
    all_gaps AS (
      SELECT
        driver_primary_id,
        gap_percent AS gap
      FROM teammate_gap_qualifying_season_summary_2025
      WHERE season = $2
        AND coverage_status IN ('valid', 'low_coverage')
    ),
    ranked AS (
      SELECT
        driver_primary_id,
        gap,
        RANK() OVER (ORDER BY gap ASC) as rank,
        COUNT(*) OVER () as total
      FROM all_gaps
    )
    SELECT
      dg.gap AS driver_gap,
      r.rank,
      r.total
    FROM driver_gaps dg
    LEFT JOIN ranked r ON r.driver_primary_id = $1
  `;

  try {
    const result = await pool.query(query, [driverId, season]);
    if (result.rows.length === 0 || result.rows[0].total === null) {
      return null;
    }

    const { rank, total } = result.rows[0];
    const percentile = calculatePercentile(rank, total);

    return {
      metric: 'qualifying_pace',
      percentile,
      rank,
      total_drivers: total
    };
  } catch {
    return null;
  }
}

/**
 * Compute race pace percentile for a driver in a season
 */
export async function computeRacePacePercentile(
  pool: Pool,
  driverId: string,
  season: number
): Promise<PercentileRanking | null> {
  const query = `
    WITH driver_gaps AS (
      SELECT
        CASE
          WHEN driver_primary_id = $1 THEN gap_percent
          ELSE -gap_percent
        END AS gap
      FROM teammate_gap_season_summary_2025
      WHERE (driver_primary_id = $1 OR driver_secondary_id = $1)
        AND season = $2
        AND coverage_status IN ('valid', 'low_coverage')
      LIMIT 1
    ),
    all_gaps AS (
      SELECT
        driver_primary_id,
        gap_percent AS gap
      FROM teammate_gap_season_summary_2025
      WHERE season = $2
        AND coverage_status IN ('valid', 'low_coverage')
    ),
    ranked AS (
      SELECT
        driver_primary_id,
        gap,
        RANK() OVER (ORDER BY gap ASC) as rank,
        COUNT(*) OVER () as total
      FROM all_gaps
    )
    SELECT
      dg.gap AS driver_gap,
      r.rank,
      r.total
    FROM driver_gaps dg
    LEFT JOIN ranked r ON r.driver_primary_id = $1
  `;

  try {
    const result = await pool.query(query, [driverId, season]);
    if (result.rows.length === 0 || result.rows[0].total === null) {
      return null;
    }

    const { rank, total } = result.rows[0];
    const percentile = calculatePercentile(rank, total);

    return {
      metric: 'race_pace',
      percentile,
      rank,
      total_drivers: total
    };
  } catch {
    return null;
  }
}

/**
 * Compute teammate gap percentile for a driver in a season
 */
export async function computeTeammateGapPercentile(
  pool: Pool,
  driverId: string,
  season: number
): Promise<PercentileRanking | null> {
  // For teammate gap, we want to see how the driver compares to their teammate
  // This is inherently a binary comparison (winner/loser within pair)
  // So we compute how many drivers beat their teammates vs were beaten

  const query = `
    WITH driver_result AS (
      SELECT
        CASE
          WHEN driver_primary_id = $1 THEN
            CASE WHEN gap_percent < 0 THEN 1 ELSE 0 END
          ELSE
            CASE WHEN gap_percent > 0 THEN 1 ELSE 0 END
        END AS beat_teammate,
        ABS(gap_percent) AS gap_magnitude
      FROM teammate_gap_season_summary_2025
      WHERE (driver_primary_id = $1 OR driver_secondary_id = $1)
        AND season = $2
        AND coverage_status IN ('valid', 'low_coverage')
      LIMIT 1
    ),
    all_magnitudes AS (
      SELECT
        driver_primary_id,
        ABS(gap_percent) AS gap_magnitude,
        CASE WHEN gap_percent < 0 THEN 1 ELSE 0 END AS primary_won
      FROM teammate_gap_season_summary_2025
      WHERE season = $2
        AND coverage_status IN ('valid', 'low_coverage')
    ),
    winning_gaps AS (
      SELECT gap_magnitude
      FROM all_magnitudes
      WHERE primary_won = 1
    ),
    ranked AS (
      SELECT
        gap_magnitude,
        RANK() OVER (ORDER BY gap_magnitude DESC) as rank,
        COUNT(*) OVER () as total
      FROM winning_gaps
    )
    SELECT
      dr.beat_teammate,
      dr.gap_magnitude,
      r.rank,
      r.total
    FROM driver_result dr
    LEFT JOIN ranked r ON r.gap_magnitude = dr.gap_magnitude
  `;

  try {
    const result = await pool.query(query, [driverId, season]);
    if (result.rows.length === 0) {
      return null;
    }

    const { beat_teammate, rank, total } = result.rows[0];

    // If driver didn't beat teammate, they're in the bottom half
    if (!beat_teammate) {
      return {
        metric: 'teammate_gap',
        percentile: 25,  // Below median
        rank: total || 1,
        total_drivers: (total || 1) * 2  // Approximate total drivers
      };
    }

    if (rank === null || total === null) {
      return {
        metric: 'teammate_gap',
        percentile: 75,  // Beat teammate but no ranking data
        rank: 1,
        total_drivers: 2
      };
    }

    const percentile = calculatePercentile(rank, total) / 2 + 50;  // Scale to 50-100

    return {
      metric: 'teammate_gap',
      percentile: Math.round(percentile),
      rank,
      total_drivers: total
    };
  } catch {
    return null;
  }
}

/**
 * Compute all percentile rankings for a driver in a season
 */
export async function computeAllPercentiles(
  pool: Pool,
  driverId: string,
  season: number
): Promise<PercentileRanking[]> {
  const percentiles: PercentileRanking[] = [];

  const [qualifying, race, teammate] = await Promise.all([
    computeQualifyingPacePercentile(pool, driverId, season),
    computeRacePacePercentile(pool, driverId, season),
    computeTeammateGapPercentile(pool, driverId, season)
  ]);

  if (qualifying) { percentiles.push(qualifying); }
  if (race) { percentiles.push(race); }
  if (teammate) { percentiles.push(teammate); }

  return percentiles;
}
