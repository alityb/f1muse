import { ApprovedMetric, NormalizationStrategy, QueryIntentKind } from '../types/query-intent';

/**
 * Metric scope
 */
export type MetricScope = 'track' | 'season';

/**
 * Ranking basis (direction)
 */
export type RankingBasis = 'lower_is_faster' | 'higher_is_better';

/**
 * Metric registry entry
 */
export interface MetricRegistryEntry {
  scope: MetricScope;
  ranking_basis: RankingBasis;
  normalization: NormalizationStrategy;
  allowed_contexts: QueryIntentKind[];
  description: string;
}

/**
 * CENTRAL METRIC REGISTRY (STATMUSE REFACTOR)
 *
 * This is the single source of truth for all approved metrics.
 * NO car baseline metrics exist.
 * ALL performance metrics are either teammate-relative or raw pace.
 *
 * Rules:
 * - Each metric has explicit scope (track or season)
 * - Each metric has explicit ranking direction
 * - Each metric has required normalization strategy
 * - Each metric lists allowed query contexts
 *
 * Validator MUST enforce:
 * - Metric exists in registry
 * - Context is in allowed_contexts
 * - Normalization matches registry
 * - Ranking direction is explicit
 *
 * If metric used incorrectly → REJECT (fail-closed)
 */
export const METRIC_REGISTRY: Record<ApprovedMetric, MetricRegistryEntry> = {
  /**
   * Average true pace (raw lap time)
   * - Track-scoped OR season-scoped (for comparisons)
   * - Lower is faster
   * - No normalization (raw pace)
   * - Used for track-bounded comparisons, rankings, and cross-team season comparisons
   */
  avg_true_pace: {
    scope: 'track',
    ranking_basis: 'lower_is_faster',
    normalization: 'none',
    allowed_contexts: [
      'cross_team_track_scoped_driver_comparison',  // Track-scoped raw pace
      'track_fastest_drivers',                      // Track ranking
      'season_driver_vs_driver'                     // Season comparison (raw pace, no baseline)
    ],
    description: 'Average true pace in seconds (lower is faster). Excludes invalid, pit, and heavily traffic-affected laps.'
  },

  /**
   * Clean air pace (traffic-free lap time)
   * - Track-scoped only
   * - Lower is faster
   * - No normalization (raw pace)
   * - Used ONLY when explicitly requested (clean_air_only=true)
   */
  clean_air_pace: {
    scope: 'track',
    ranking_basis: 'lower_is_faster',
    normalization: 'none',
    allowed_contexts: [
      'cross_team_track_scoped_driver_comparison',  // Track-scoped raw pace (clean air)
      'track_fastest_drivers',                      // Track ranking (clean air)
      'season_driver_vs_driver'                     // Season comparison (clean air, no baseline)
    ],
    description: 'Average pace in clean air conditions only. Strictly excludes all traffic-affected laps.'
  },

  /**
   * Teammate gap raw (season-level median shared-lap pace difference)
   * - Season-scoped
   * - Lower absolute gap is "closer" (smaller gap = more equal)
   * - Team-baseline normalization (teammate-relative)
   * - Used ONLY for teammate_gap_summary_season
   * - This is the PRIMARY way to express driver performance
   */
  teammate_gap_raw: {
    scope: 'season',
    ranking_basis: 'lower_is_faster',  // Smaller absolute gap = closer/more equal
    normalization: 'team_baseline',    // Teammate-relative
    allowed_contexts: [
      'teammate_gap_summary_season'
    ],
    description: 'Season-level teammate gap (median shared-lap pace difference). Signed: primary - secondary (negative = primary faster).'
  },

  /**
   * Teammate gap dual (qualifying vs race pace comparison)
   * - Season-scoped
   * - Compares two metrics: qualifying gap and race pace gap
   * - Team-baseline normalization (teammate-relative)
   * - Used for teammate_gap_dual_comparison
   */
  teammate_gap_dual: {
    scope: 'season',
    ranking_basis: 'lower_is_faster',
    normalization: 'team_baseline',
    allowed_contexts: [
      'teammate_gap_dual_comparison'
    ],
    description: 'Dual comparison of qualifying gap and race pace gap between teammates. Shows where each driver has advantage.'
  }
};

/**
 * Validation error for metric usage
 */
export interface MetricValidationError {
  valid: false;
  reason: string;
}

/**
 * Validation success
 */
export interface MetricValidationSuccess {
  valid: true;
  entry?: MetricRegistryEntry;  // Optional for query kinds that don't use metrics
}

/**
 * Validation result
 */
export type MetricValidationResult = MetricValidationSuccess | MetricValidationError;

/**
 * Metric registry validator
 *
 * Enforces all metric usage rules from the central registry.
 * FAIL CLOSED if any rule is violated.
 */
export class MetricRegistryValidator {
  /**
   * Validate metric usage
   *
   * @param metric Metric being used
   * @param context Query intent kind (context)
   * @param normalization Normalization strategy being used
   * @returns Validation result (fail-closed)
   */
  static validate(
    metric: ApprovedMetric,
    context: QueryIntentKind,
    normalization: NormalizationStrategy
  ): MetricValidationResult {
    // Skip metric validation for query kinds that don't use lap-based metrics
    // These use race results from F1DB instead of lap data
    const METRIC_FREE_CONTEXTS: QueryIntentKind[] = [
      'race_results_summary',
      'driver_career_summary',
      'driver_career_wins_by_circuit',
      'teammate_comparison_career',
      'driver_vs_driver_comprehensive',
    ];

    if (METRIC_FREE_CONTEXTS.includes(context)) {
      return { valid: true, entry: undefined };
    }

    // 1. Check if metric exists in registry
    const entry = METRIC_REGISTRY[metric];
    if (!entry) {
      return {
        valid: false,
        reason: `VALIDATION_FAILED: Metric "${metric}" not found in registry`
      };
    }

    // 2. Check if context is allowed
    if (!entry.allowed_contexts.includes(context)) {
      return {
        valid: false,
        reason: `VALIDATION_FAILED: Metric "${metric}" cannot be used in context "${context}". ` +
          `Allowed contexts: ${entry.allowed_contexts.join(', ')}`
      };
    }

    // 3. Check if normalization matches registry
    // Special case: season_driver_vs_driver allows session_median_percent normalization
    // for avg_true_pace and clean_air_pace as a cross-circuit comparable alternative
    const allowsSessionMedianPercent =
      context === 'season_driver_vs_driver' &&
      (metric === 'avg_true_pace' || metric === 'clean_air_pace') &&
      normalization === 'session_median_percent';

    if (normalization !== entry.normalization && !allowsSessionMedianPercent) {
      return {
        valid: false,
        reason: `VALIDATION_FAILED: Metric "${metric}" requires normalization="${entry.normalization}". ` +
          `Got: "${normalization}"`
      };
    }

    // 4. All checks passed
    return {
      valid: true,
      entry
    };
  }

  /**
   * Get metric entry from registry
   *
   * @param metric Metric name
   * @returns Registry entry or undefined
   */
  static getEntry(metric: ApprovedMetric): MetricRegistryEntry | undefined {
    return METRIC_REGISTRY[metric];
  }

  /**
   * Check if metric is allowed in context
   *
   * @param metric Metric name
   * @param context Query intent kind
   * @returns true if allowed, false otherwise
   */
  static isAllowedInContext(metric: ApprovedMetric, context: QueryIntentKind): boolean {
    const entry = METRIC_REGISTRY[metric];
    return entry ? entry.allowed_contexts.includes(context) : false;
  }

  /**
   * Get ranking basis for metric
   *
   * @param metric Metric name
   * @returns Ranking basis or undefined
   */
  static getRankingBasis(metric: ApprovedMetric): RankingBasis | undefined {
    const entry = METRIC_REGISTRY[metric];
    return entry?.ranking_basis;
  }
}
