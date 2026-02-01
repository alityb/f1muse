/**
 * TIER 2: Coverage-Aware Fallback
 *
 * Automatically falls back to previous seasons when current season
 * has insufficient coverage. Always explicitly marks when fallback is used.
 *
 * FAIL-CLOSED: Never silently changes season without marking it.
 */

import { Pool } from 'pg';
import { Confidence, CoverageStatus } from '../types/api-response';
import { DebugTracer } from '../execution/debug-tracer';

/**
 * Fallback result with metadata
 */
export interface FallbackResult {
  season: number;
  usedFallback: boolean;
  originalSeason?: number;
  fallbackReason?: string;
  coverageStatus: CoverageStatus;
  sharedRaces: number;
}

/**
 * Minimum coverage thresholds
 */
export const FALLBACK_THRESHOLDS = {
  MIN_SHARED_RACES: 4,        // Minimum for any result
  PREFERRED_SHARED_RACES: 8,  // Preferred for high confidence
  MAX_FALLBACK_YEARS: 3       // Maximum years to look back
} as const;

/**
 * Check if a season has sufficient teammate gap coverage for a driver
 */
export async function checkSeasonCoverage(
  pool: Pool,
  driverId: string,
  season: number,
  metric: 'race' | 'qualifying' = 'race'
): Promise<{ hasData: boolean; sharedRaces: number; coverageStatus: CoverageStatus }> {
  const tableName = metric === 'qualifying'
    ? 'teammate_gap_qualifying_season_summary_2025'
    : 'teammate_gap_season_summary_2025';

  const query = `
    SELECT
      shared_races,
      coverage_status
    FROM ${tableName}
    WHERE (driver_primary_id = $1 OR driver_secondary_id = $1)
      AND season = $2
      AND coverage_status IN ('valid', 'low_coverage')
    ORDER BY shared_races DESC
    LIMIT 1
  `;

  try {
    const result = await pool.query(query, [driverId, season]);
    if (result.rows.length === 0) {
      return { hasData: false, sharedRaces: 0, coverageStatus: 'insufficient' };
    }

    const { shared_races, coverage_status } = result.rows[0];
    return {
      hasData: true,
      sharedRaces: shared_races,
      coverageStatus: coverage_status as CoverageStatus
    };
  } catch {
    return { hasData: false, sharedRaces: 0, coverageStatus: 'insufficient' };
  }
}

/**
 * Find the best available season for a driver's teammate gap data
 *
 * Starts with requested season and falls back to previous seasons
 * if coverage is insufficient.
 *
 * NEVER silently changes season - always returns metadata about fallback.
 */
export async function findBestSeasonWithCoverage(
  pool: Pool,
  driverId: string,
  requestedSeason: number,
  metric: 'race' | 'qualifying' = 'race',
  tracer?: DebugTracer
): Promise<FallbackResult> {
  // First, check the requested season
  const requestedCoverage = await checkSeasonCoverage(pool, driverId, requestedSeason, metric);

  tracer?.addRoutingStep(`Requested season ${requestedSeason}: ${requestedCoverage.sharedRaces} races, ${requestedCoverage.coverageStatus}`);

  // If requested season has valid coverage, use it
  if (requestedCoverage.hasData && requestedCoverage.sharedRaces >= FALLBACK_THRESHOLDS.MIN_SHARED_RACES) {
    return {
      season: requestedSeason,
      usedFallback: false,
      coverageStatus: requestedCoverage.coverageStatus,
      sharedRaces: requestedCoverage.sharedRaces
    };
  }

  // Try previous seasons
  let bestSeason = requestedSeason;
  let bestCoverage = requestedCoverage;

  for (let yearOffset = 1; yearOffset <= FALLBACK_THRESHOLDS.MAX_FALLBACK_YEARS; yearOffset++) {
    const fallbackSeason = requestedSeason - yearOffset;
    const fallbackCoverage = await checkSeasonCoverage(pool, driverId, fallbackSeason, metric);

    tracer?.addRoutingStep(`Fallback season ${fallbackSeason}: ${fallbackCoverage.sharedRaces} races, ${fallbackCoverage.coverageStatus}`);

    if (fallbackCoverage.hasData && fallbackCoverage.sharedRaces > bestCoverage.sharedRaces) {
      bestSeason = fallbackSeason;
      bestCoverage = fallbackCoverage;

      // If we found a season with preferred coverage, stop searching
      if (fallbackCoverage.sharedRaces >= FALLBACK_THRESHOLDS.PREFERRED_SHARED_RACES) {
        break;
      }
    }
  }

  // Return best found season (may still be the original if no better found)
  const usedFallback = bestSeason !== requestedSeason;

  if (usedFallback) {
    tracer?.setFallbackInfo(
      requestedSeason,
      bestSeason,
      `Insufficient coverage in ${requestedSeason} (${requestedCoverage.sharedRaces} races), using ${bestSeason} (${bestCoverage.sharedRaces} races)`
    );
  }

  return {
    season: bestSeason,
    usedFallback,
    originalSeason: usedFallback ? requestedSeason : undefined,
    fallbackReason: usedFallback
      ? `Insufficient coverage in ${requestedSeason}, fell back to ${bestSeason}`
      : undefined,
    coverageStatus: bestCoverage.coverageStatus,
    sharedRaces: bestCoverage.sharedRaces
  };
}

/**
 * Apply fallback information to confidence object
 *
 * Explicitly marks when fallback was used.
 */
export function applyFallbackToConfidence(
  confidence: Confidence,
  fallback: FallbackResult
): Confidence {
  const updated = { ...confidence };

  if (fallback.usedFallback) {
    updated.fallback_season_used = fallback.season;

    if (!updated.reasons) {
      updated.reasons = [];
    }

    updated.reasons.push(
      `Fallback season used: ${fallback.season} (original request: ${fallback.originalSeason})`
    );
    updated.reasons.push(fallback.fallbackReason || 'Insufficient coverage in requested season');
  }

  return updated;
}

/**
 * Get fallback warning message
 */
export function getFallbackWarning(fallback: FallbackResult): string | null {
  if (!fallback.usedFallback) {
    return null;
  }

  return `Data from ${fallback.season} used instead of ${fallback.originalSeason} due to insufficient coverage`;
}
