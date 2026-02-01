/**
 * PHASE M: Gap band classification thresholds
 *
 * Centralized constants for gap band classification.
 * These thresholds MUST be referenced in interpretation.constraints for transparency.
 */

export type GapBand = 'effectively_equal' | 'marginal_advantage' | 'meaningful_advantage' | 'dominant_advantage';

/**
 * Gap band classification thresholds (in seconds)
 * 
 * These thresholds are applied to the absolute gap (|gap_seconds|).
 */
export const GAP_BAND_THRESHOLDS = {
  EFFECTIVELY_EQUAL: 0.05,      // |gap| < 0.05s
  MARGINAL_ADVANTAGE: 0.15,      // 0.05s ≤ |gap| < 0.15s
  MEANINGFUL_ADVANTAGE: 0.30,    // 0.15s ≤ |gap| < 0.30s
  // |gap| ≥ 0.30s → dominant_advantage
} as const;

/**
 * Classify gap band based on absolute gap in seconds
 * 
 * @param gapSecondsAbs - Absolute gap in seconds (|gap_seconds|)
 * @returns GapBand classification
 */
export function classifyGapBand(gapSecondsAbs: number): GapBand {
  if (gapSecondsAbs < GAP_BAND_THRESHOLDS.EFFECTIVELY_EQUAL) {
    return 'effectively_equal';
  } else if (gapSecondsAbs < GAP_BAND_THRESHOLDS.MARGINAL_ADVANTAGE) {
    return 'marginal_advantage';
  } else if (gapSecondsAbs < GAP_BAND_THRESHOLDS.MEANINGFUL_ADVANTAGE) {
    return 'meaningful_advantage';
  } else {
    return 'dominant_advantage';
  }
}

/**
 * Get human-readable description of gap band thresholds
 * Used in interpretation.constraints for transparency
 */
export function getGapBandThresholdDescriptions(): string[] {
  return [
    `effectively_equal: |gap| < ${GAP_BAND_THRESHOLDS.EFFECTIVELY_EQUAL}s`,
    `marginal_advantage: ${GAP_BAND_THRESHOLDS.EFFECTIVELY_EQUAL}s ≤ |gap| < ${GAP_BAND_THRESHOLDS.MARGINAL_ADVANTAGE}s`,
    `meaningful_advantage: ${GAP_BAND_THRESHOLDS.MARGINAL_ADVANTAGE}s ≤ |gap| < ${GAP_BAND_THRESHOLDS.MEANINGFUL_ADVANTAGE}s`,
    `dominant_advantage: |gap| ≥ ${GAP_BAND_THRESHOLDS.MEANINGFUL_ADVANTAGE}s`
  ];
}

