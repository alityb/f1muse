/**
 * METRIC REGISTRY
 *
 * Central registry of all analytical metrics supported by the system.
 * Each metric definition includes:
 * - Unique identifier
 * - Human-readable description
 * - Methodology documentation
 * - Source tables
 * - Coverage thresholds
 * - Units of measurement
 *
 * This registry serves as:
 * 1. Single source of truth for metric definitions
 * 2. Documentation for API consumers
 * 3. Configuration for query execution
 * 4. Basis for /capabilities endpoint
 */

import { Methodology } from '../types/api-response';

// ============================================================================
// METRIC DEFINITION INTERFACE
// ============================================================================

/**
 * Complete metric definition
 */
export interface MetricDefinition {
  /** Unique metric identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Human-readable description */
  description: string;

  /** Full methodology documentation */
  methodology: Methodology;

  /** Database tables used by this metric */
  source_tables: string[];

  /** Coverage thresholds for confidence assessment */
  coverage_thresholds: {
    /** Minimum sample size for 'valid' coverage */
    valid: number;
    /** Minimum sample size for 'low_coverage' (below this = 'insufficient') */
    low_coverage: number;
  };

  /** Unit of measurement for the metric value */
  units: string;

  /** Whether this metric supports partial results */
  supports_partial: boolean;

  /** Related metrics that can be combined with this one */
  related_metrics?: string[];
}

// ============================================================================
// METRIC DEFINITIONS
// ============================================================================

/**
 * Teammate gap from qualifying sessions
 */
const TEAMMATE_GAP_QUALIFYING: MetricDefinition = {
  id: 'teammate_gap_qualifying',
  name: 'Teammate Gap (Qualifying)',
  description: 'Qualifying pace gap between teammates using symmetric percent difference from highest shared qualifying session (Q3 > Q2 > Q1)',
  methodology: {
    metric_type: 'teammate_gap',
    data_source: ['teammate_gap_qualifying_season_summary_2025'],
    aggregation: 'median',
    normalization: 'symmetric_percent_difference',
    formula: 'gap_percent = 100 * (primary_time - secondary_time) / ((primary_time + secondary_time) / 2)',
    scope: 'season',
    exclusions: [
      'Sessions where either driver has no time',
      'Sprint qualifying sessions',
      'Wet qualifying sessions (if flagged)'
    ]
  },
  source_tables: [
    'teammate_gap_qualifying_season_summary_2025',
    'teammate_gap_qualifying_race_level_2025'
  ],
  coverage_thresholds: {
    valid: 8,
    low_coverage: 4
  },
  units: 'percent',
  supports_partial: false,
  related_metrics: ['teammate_gap_race_pace', 'teammate_gap_comparison_dual']
};

/**
 * Teammate gap from race pace (median lap times)
 */
const TEAMMATE_GAP_RACE_PACE: MetricDefinition = {
  id: 'teammate_gap_race_pace',
  name: 'Teammate Gap (Race Pace)',
  description: 'Race pace gap between teammates using symmetric percent difference from median lap times per race',
  methodology: {
    metric_type: 'teammate_gap',
    data_source: ['teammate_gap_season_summary_2025'],
    aggregation: 'median',
    normalization: 'symmetric_percent_difference',
    formula: 'gap_percent = 100 * (primary_median - secondary_median) / ((primary_median + secondary_median) / 2)',
    scope: 'season',
    exclusions: [
      'Pit laps',
      'In laps',
      'Out laps',
      'Invalid laps (yellow flag, off-track)',
      'Races where either driver DNF before lap 10'
    ]
  },
  source_tables: [
    'teammate_gap_season_summary_2025',
    'teammate_gap_race_level_2025'
  ],
  coverage_thresholds: {
    valid: 8,
    low_coverage: 4
  },
  units: 'percent',
  supports_partial: false,
  related_metrics: ['teammate_gap_qualifying', 'teammate_gap_comparison_dual']
};

/**
 * Dual comparison: qualifying vs race pace
 *
 * Registry entry for teammate_gap_comparison_dual.
 */
const TEAMMATE_GAP_COMPARISON_DUAL: MetricDefinition = {
  id: 'teammate_gap_comparison_dual',
  name: 'Teammate Gap Dual Comparison',
  description: 'Side-by-side comparison of qualifying gap vs race pace gap between teammates, showing where each driver has the advantage',
  methodology: {
    metric_type: 'teammate_gap_dual',
    data_source: [
      'teammate_gap_qualifying_season_summary_2025',
      'teammate_gap_season_summary_2025'
    ],
    aggregation: 'median (both metrics)',
    normalization: 'symmetric_percent_difference (both metrics)',
    formula: 'Combines qualifying and race pace metrics independently; compares winners',
    scope: 'season',
    exclusions: [
      'Pairs with insufficient qualifying coverage',
      'Pairs with insufficient race pace coverage',
      '(Partial results returned if one metric is valid)'
    ]
  },
  source_tables: [
    'teammate_gap_qualifying_season_summary_2025',
    'teammate_gap_season_summary_2025'
  ],
  coverage_thresholds: {
    valid: 8,      // Both metrics must have ≥8 for full validity
    low_coverage: 4 // At least one metric must have ≥4
  },
  units: 'percent',
  supports_partial: true, // Can return partial if one metric is valid
  related_metrics: ['teammate_gap_qualifying', 'teammate_gap_race_pace']
};

// ============================================================================
// METRIC REGISTRY
// ============================================================================

/**
 * Central metric registry
 *
 * All supported metrics indexed by ID.
 */
export const METRIC_REGISTRY: Record<string, MetricDefinition> = {
  teammate_gap_qualifying: TEAMMATE_GAP_QUALIFYING,
  teammate_gap_race_pace: TEAMMATE_GAP_RACE_PACE,
  teammate_gap_comparison_dual: TEAMMATE_GAP_COMPARISON_DUAL
};

// ============================================================================
// REGISTRY HELPERS
// ============================================================================

/**
 * Get metric definition by ID
 *
 * @param metricId - Metric identifier
 * @returns MetricDefinition or null if not found
 */
export function getMetric(metricId: string): MetricDefinition | null {
  return METRIC_REGISTRY[metricId] || null;
}

/**
 * Get methodology for a metric
 *
 * @param metricId - Metric identifier
 * @returns Methodology object or null if metric not found
 */
export function getMethodology(metricId: string): Methodology | null {
  const metric = getMetric(metricId);
  return metric?.methodology || null;
}

/**
 * Check if a metric exists
 *
 * @param metricId - Metric identifier
 * @returns true if metric exists in registry
 */
export function hasMetric(metricId: string): boolean {
  return metricId in METRIC_REGISTRY;
}

/**
 * Get all metric IDs
 *
 * @returns Array of all registered metric IDs
 */
export function getAllMetricIds(): string[] {
  return Object.keys(METRIC_REGISTRY);
}

/**
 * Get all metrics as array
 *
 * @returns Array of all MetricDefinition objects
 */
export function getAllMetrics(): MetricDefinition[] {
  return Object.values(METRIC_REGISTRY);
}

/**
 * Get coverage thresholds for a metric
 *
 * @param metricId - Metric identifier
 * @returns Coverage thresholds or default values if metric not found
 */
export function getCoverageThresholds(metricId: string): { valid: number; low_coverage: number } {
  const metric = getMetric(metricId);
  return metric?.coverage_thresholds || { valid: 8, low_coverage: 4 };
}

/**
 * Determine coverage status from sample size
 *
 * @param metricId - Metric identifier
 * @param sampleSize - Number of shared races/sessions
 * @returns Coverage status string
 */
export function determineCoverageStatus(
  metricId: string,
  sampleSize: number
): 'valid' | 'low_coverage' | 'insufficient' {
  const thresholds = getCoverageThresholds(metricId);

  if (sampleSize >= thresholds.valid) {
    return 'valid';
  }
  if (sampleSize >= thresholds.low_coverage) {
    return 'low_coverage';
  }
  return 'insufficient';
}

/**
 * Get related metrics for a given metric
 *
 * @param metricId - Metric identifier
 * @returns Array of related metric IDs
 */
export function getRelatedMetrics(metricId: string): string[] {
  const metric = getMetric(metricId);
  return metric?.related_metrics || [];
}

/**
 * Export registry for /capabilities endpoint
 *
 * Returns a sanitized version of the registry suitable for public API exposure.
 */
export function exportRegistryForCapabilities(): Array<{
  id: string;
  description: string;
  units: string;
  coverage_thresholds: { valid: number; low_coverage: number };
  methodology_summary: string;
}> {
  return getAllMetrics().map(metric => ({
    id: metric.id,
    description: metric.description,
    units: metric.units,
    coverage_thresholds: metric.coverage_thresholds,
    methodology_summary: `${metric.methodology.aggregation} ${metric.methodology.normalization} over ${metric.methodology.scope}`
  }));
}
