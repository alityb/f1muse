/**
 * TEAMMATE GAP CONFIGURATION
 *
 * Centralized thresholds and settings for teammate gap analysis.
 * Used by both ETL ingestion and query execution.
 *
 * METHODOLOGY: Teammate gap symmetric percent difference
 * - Race pace: median race lap times per driver, per race
 * - Qualifying pace: highest shared session (Q3 > Q2 > Q1)
 * - Aggregate to season median
 */

/**
 * Coverage status thresholds (shared races)
 *
 * - valid: >= 8 shared races
 * - low_coverage: >= 4 shared races
 * - insufficient: otherwise
 */
export const TEAMMATE_GAP_THRESHOLDS = {
  /** Minimum shared races for 'valid' coverage status */
  valid_shared_races: 8,

  /** Minimum shared races for 'low_coverage' coverage status */
  low_coverage_shared_races: 4,

  /** Gap below which difference is considered indeterminate (symmetric %) */
  indeterminate_threshold: 0.1
};

/**
 * ETL mode configuration
 */
export interface TeammateGapETLConfig {
  /** Season to process */
  season: number;
}

/**
 * Default ETL configuration
 */
export const DEFAULT_ETL_CONFIG: TeammateGapETLConfig = {
  season: 2025
};

/**
 * Coverage status type
 */
export type CoverageStatusType = 'valid' | 'low_coverage' | 'insufficient';

/**
 * Determine coverage status from shared races
 */
export function getCoverageStatus(sharedRaces: number): CoverageStatusType {
  if (sharedRaces >= TEAMMATE_GAP_THRESHOLDS.valid_shared_races) {
    return 'valid';
  }
  if (sharedRaces >= TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races) {
    return 'low_coverage';
  }
  return 'insufficient';
}

/**
 * Check if coverage status allows returning results
 */
export function isResultAllowed(status: CoverageStatusType): boolean {
  return status === 'valid' || status === 'low_coverage';
}

/**
 * User-facing copy for coverage statuses
 */
export const COVERAGE_STATUS_COPY = {
  valid: null,
  low_coverage: 'Low sample size — results are directional, not definitive.',
  insufficient: 'Teammate gaps are reported only when drivers share enough races.'
};
