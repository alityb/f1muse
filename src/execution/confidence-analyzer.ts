/**
 * PHASE Q: Confidence & Coverage Analyzer
 *
 * Computes statistical reliability metadata for query results.
 * Does NOT change metric math or execution logic.
 * Only provides interpretability and reliability diagnosis.
 *
 * FAIL-CLOSED: If confidence cannot be computed, query must fail.
 */

import { CoverageLevel, SampleBalanceFlag, ConfidenceMetadata } from '../types/results';

/**
 * Coverage thresholds (configurable constants)
 */
export const COVERAGE_THRESHOLDS = {
  HIGH: 50,
  MODERATE: 25,
  LOW: 10,
  MINIMUM: 10  // Queries below this MUST FAIL CLOSED
} as const;

/**
 * Sample balance threshold
 * If one driver has < 50% of other driver's laps → imbalanced
 */
export const SAMPLE_BALANCE_THRESHOLD = 0.5;

/**
 * Compute coverage level from lap count
 */
export function computeCoverageLevel(laps: number): CoverageLevel {
  if (laps >= COVERAGE_THRESHOLDS.HIGH) {
    return 'high';
  } else if (laps >= COVERAGE_THRESHOLDS.MODERATE) {
    return 'moderate';
  } else if (laps >= COVERAGE_THRESHOLDS.LOW) {
    return 'low';
  } else {
    return 'insufficient';
  }
}

/**
 * Compute sample balance flag for comparisons
 */
export function computeSampleBalance(laps_a: number, laps_b: number): SampleBalanceFlag {
  if (laps_a === 0 || laps_b === 0) {
    return 'imbalanced';
  }

  const ratio = Math.min(laps_a, laps_b) / Math.max(laps_a, laps_b);
  return ratio >= SAMPLE_BALANCE_THRESHOLD ? 'balanced' : 'imbalanced';
}

/**
 * Compute shared overlap laps (minimum of two samples)
 */
export function computeSharedOverlapLaps(laps_a: number, laps_b: number): number {
  return Math.min(laps_a, laps_b);
}

/**
 * Generate coverage notes based on confidence metadata
 */
function generateCoverageNotes(confidence: ConfidenceMetadata): string[] {
  const notes: string[] = [];

  // Coverage level notes
  if (confidence.coverage_level === 'low') {
    notes.push('Low sample size — treat results cautiously');
  } else if (confidence.coverage_level === 'moderate') {
    notes.push('Moderate sample size — results have reasonable confidence');
  } else if (confidence.coverage_level === 'high') {
    notes.push('High sample size — results have strong statistical confidence');
  }

  // Sample balance notes (for comparisons)
  if (confidence.sample_balance_flag === 'imbalanced') {
    notes.push('Imbalanced sample sizes between compared entities');
  }

  // Shared overlap notes
  if (confidence.shared_overlap_laps !== undefined && confidence.shared_overlap_laps < COVERAGE_THRESHOLDS.MODERATE) {
    notes.push('Low overlap sample — treat comparison cautiously');
  }

  // Clean air ratio notes
  if (confidence.clean_air_ratio !== undefined) {
    if (confidence.clean_air_ratio < 0.3) {
      notes.push('Clean-air coverage limited — results may include traffic effects');
    } else if (confidence.clean_air_ratio < 0.5) {
      notes.push('Moderate clean-air coverage');
    }
  }

  return notes;
}

/**
 * FAIL-CLOSED: Validate minimum coverage
 * Throws error if coverage is insufficient
 */
export function validateMinimumCoverage(laps: number, context: string): void {
  if (laps < COVERAGE_THRESHOLDS.MINIMUM) {
    throw new Error(`INSUFFICIENT_DATA: ${context} has ${laps} laps, minimum ${COVERAGE_THRESHOLDS.MINIMUM} required`);
  }
}

/**
 * Compute confidence metadata for single-driver query
 */
export function computeSingleDriverConfidence(
  laps_considered: number,
  clean_air_laps?: number
): ConfidenceMetadata {
  // FAIL-CLOSED: Validate minimum coverage
  validateMinimumCoverage(laps_considered, 'Query');

  const coverage_level = computeCoverageLevel(laps_considered);
  const clean_air_ratio = clean_air_laps !== undefined ? clean_air_laps / laps_considered : undefined;

  const confidence: ConfidenceMetadata = {
    coverage_level,
    laps_considered,
    clean_air_ratio,
    notes: []
  };

  confidence.notes = generateCoverageNotes(confidence);

  return confidence;
}

/**
 * Compute confidence metadata for comparison query
 */
export function computeComparisonConfidence(
  laps_a: number,
  laps_b: number,
  clean_air_laps_a?: number,
  clean_air_laps_b?: number,
  shared_overlap_override?: number
): ConfidenceMetadata {
  // FAIL-CLOSED: Validate minimum coverage for both
  validateMinimumCoverage(laps_a, 'Driver A');
  validateMinimumCoverage(laps_b, 'Driver B');

  const shared_overlap_laps = shared_overlap_override !== undefined
    ? shared_overlap_override
    : computeSharedOverlapLaps(laps_a, laps_b);

  if (shared_overlap_override !== undefined && shared_overlap_laps < COVERAGE_THRESHOLDS.MINIMUM) {
    throw new Error(
      `INSUFFICIENT_DATA: Shared overlap has ${shared_overlap_laps} laps, minimum ${COVERAGE_THRESHOLDS.MINIMUM} required`
    );
  }
  const coverage_level = computeCoverageLevel(shared_overlap_laps);
  const sample_balance_flag = computeSampleBalance(laps_a, laps_b);

  // Compute clean air ratio (if available)
  let clean_air_ratio: number | undefined;
  if (clean_air_laps_a !== undefined && clean_air_laps_b !== undefined) {
    const total_clean_air = clean_air_laps_a + clean_air_laps_b;
    const total_laps = laps_a + laps_b;
    clean_air_ratio = total_clean_air / total_laps;
  }

  const confidence: ConfidenceMetadata = {
    coverage_level,
    laps_considered: shared_overlap_laps,
    clean_air_ratio,
    shared_overlap_laps,
    sample_balance_flag,
    notes: []
  };

  confidence.notes = generateCoverageNotes(confidence);

  return confidence;
}

/**
 * Compute confidence metadata for ranking query
 */
export function computeRankingConfidence(
  total_laps: number,
  min_laps_per_driver: number,
  max_laps_per_driver: number,
  clean_air_laps?: number
): ConfidenceMetadata {
  // FAIL-CLOSED: Validate minimum coverage
  validateMinimumCoverage(min_laps_per_driver, 'Minimum driver in ranking');

  const coverage_level = computeCoverageLevel(min_laps_per_driver);
  const clean_air_ratio = clean_air_laps !== undefined ? clean_air_laps / total_laps : undefined;

  // Check for imbalanced samples in ranking
  const ratio = min_laps_per_driver / max_laps_per_driver;
  const sample_balance_flag: SampleBalanceFlag = ratio >= SAMPLE_BALANCE_THRESHOLD ? 'balanced' : 'imbalanced';

  const confidence: ConfidenceMetadata = {
    coverage_level,
    laps_considered: min_laps_per_driver,
    clean_air_ratio,
    sample_balance_flag,
    notes: []
  };

  confidence.notes = generateCoverageNotes(confidence);

  if (sample_balance_flag === 'imbalanced') {
    confidence.notes.push(`Ranking has imbalanced sample sizes (${min_laps_per_driver} to ${max_laps_per_driver} laps)`);
  }

  return confidence;
}

/**
 * Compute confidence metadata for teammate gap query (shared races)
 */
export function computeTeammateGapConfidence(
  shared_races: number,
  coverage_status: 'valid' | 'low_coverage' | 'insufficient'
): ConfidenceMetadata {
  // Map coverage_status to coverage_level
  let coverage_level: CoverageLevel;
  if (coverage_status === 'insufficient') {
    coverage_level = 'insufficient';
  } else if (coverage_status === 'low_coverage') {
    coverage_level = 'low';
  } else if (shared_races >= 15) {
    coverage_level = 'high';
  } else if (shared_races >= 8) {
    coverage_level = 'moderate';
  } else {
    coverage_level = 'low';
  }

  const confidence: ConfidenceMetadata = {
    coverage_level,
    laps_considered: shared_races,
    notes: []
  };

  if (shared_races < 5) {
    confidence.notes.push(`Limited shared races (${shared_races})`);
  }

  if (coverage_status === 'low_coverage') {
    confidence.notes.push('Low coverage — season-level gap may not be representative');
  }

  confidence.notes.push(...generateCoverageNotes(confidence));

  return confidence;
}
