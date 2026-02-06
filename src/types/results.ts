import { QueryIntent, ApprovedMetric, CompoundContext } from './query-intent';

/**
 * Season driver summary result payload
 */
export interface SeasonDriverSummaryPayload {
  type: 'driver_season_summary';
  season: number;
  driver_id: string;
  wins: number;
  podiums: number;
  dnfs: number;
  race_count: number;
  avg_race_pace: number | null;
  laps_considered: number;
}

/**
 * Season driver vs driver result payload
 *
 * Supports two modes:
 * - Normalized (default): session_median_percent normalization, values in %
 * - Raw pace: normalization='none', values in seconds
 */
export interface SeasonDriverVsDriverPayload {
  type: 'season_driver_vs_driver';
  season: number;
  driver_a: string;
  driver_b: string;
  metric: ApprovedMetric;
  driver_a_value: number;
  driver_b_value: number;
  difference: number;
  normalization: string;
  driver_a_laps: number;
  driver_b_laps: number;
  laps_considered: number;
  /** Number of shared races (normalized mode only) */
  shared_races?: number;
  /** Coverage status based on shared races (normalized mode only) */
  coverage_status?: 'valid' | 'low_coverage' | 'insufficient';
  /** Units: 'percent' for normalized, 'seconds' for raw */
  units?: 'percent' | 'seconds';
}


/**
 * Driver ranking entry
 */
export interface DriverRankingEntry {
  driver_id: string;
  value: number;
  laps_considered: number;
}

/**
 * Race results entry
 */
export interface RaceResultsEntry {
  position: number;
  driver_id: string;
  driver_name: string;
  constructor_name: string;
  laps_completed: number | null;
  race_time: string | null;
  fastest_lap: string | null;
  grid_position: number | null;
  points: number | null;
}

/**
 * Race results summary payload
 */
export interface RaceResultsSummaryPayload {
  type: 'race_results_summary';
  season: number;
  track_id: string;
  race_name: string | null;
  race_date: string | null;
  circuit_name: string | null;
  podium: RaceResultsEntry[];
  top10: RaceResultsEntry[];
  laps_completed: number | null;
  winner_time: string | null;
}

/**
 * Driver ranking result payload
 *
 * PHASE L2: Extended to support per_compound mode
 */
export interface DriverRankingPayload {
  type: 'driver_ranking';
  season: number;
  track_id: string;
  metric: ApprovedMetric;
  ranking_basis: 'lower_is_faster';
  entries: DriverRankingEntry[];
  compound_mode?: 'mixed' | 'per_compound';
  entries_by_compound?: {
    [compound: string]: DriverRankingEntry[];
  };
}

/**
 * PHASE L1: Cross-team track-scoped driver comparison result payload
 */
export interface CrossTeamTrackScopedDriverComparisonPayload {
  type: 'cross_team_track_scoped_driver_comparison';
  season: number;
  track_id: string;
  metric: ApprovedMetric;
  driver_a: string;
  driver_b: string;
  driver_a_value: number;
  driver_b_value: number;
  pace_delta: number;  // driver_a_value - driver_b_value
  compound_context: CompoundContext;
  driver_a_laps: number;
  driver_b_laps: number;
  laps_considered: number;
}

/**
 * PHASE M: Gap band classification
 */
export type GapBand = 'effectively_equal' | 'marginal_advantage' | 'meaningful_advantage' | 'dominant_advantage';

/**
 * PHASE M: Coverage status
 */
export type CoverageStatus = 'valid' | 'low_coverage' | 'insufficient';

/**
 * PHASE M: Teammate gap summary season result payload
 *
 * Methodology: Race pace symmetric percent difference
 * - For each race, use median lap times for both drivers
 * - gap_pct = 100 * (primary_time - secondary_time) / ((primary_time + secondary_time) / 2)
 * - Negative = primary faster, Positive = secondary faster
 */
export interface TeammateGapSummarySeasonPayload {
  type: 'teammate_gap_summary_season';
  season: number;
  team_id: string;
  driver_primary_id: string;
  driver_secondary_id: string;
  gap_seconds: number;                   // signed median gap in seconds (negative = primary faster)
  gap_seconds_abs: number;               // |gap_seconds|
  gap_pct: number | null;                // symmetric percent difference (track-length invariant)
  gap_pct_abs: number | null;            // |gap_pct|
  shared_races: number;                  // number of shared races compared
  faster_driver_primary_count: number;   // times primary driver was faster
  coverage_status: CoverageStatus;
  gap_band: GapBand;
}

/**
 * Single metric component of dual comparison
 */
export interface DualComparisonMetricComponent {
  gap_percent: number | null;
  gap_seconds: number | null;
  winner: string | null;              // driver_id of winner, or 'equal', or null if unavailable
  shared_races: number;
  faster_primary_count: number;
  coverage_status: CoverageStatus;
  available: boolean;
}

/**
 * Overall summary for dual comparison
 */
export interface DualComparisonSummary {
  same_winner: boolean | null;        // null if one or both metrics unavailable
  advantage_area: 'qualifying' | 'race' | 'mixed' | 'partial';
}

/**
 * Teammate gap dual comparison result payload
 *
 * Compares qualifying gap vs race pace gap for the same teammate pair.
 */
export interface TeammateGapDualComparisonPayload {
  type: 'teammate_gap_dual_comparison';
  season: number;
  team_id: string | null;
  driver_primary_id: string;
  driver_secondary_id: string;
  qualifying: DualComparisonMetricComponent;
  race_pace: DualComparisonMetricComponent;
  overall_summary: DualComparisonSummary;
}

/**
 * Driver career summary result payload
 */
export interface DriverCareerSummaryPayload {
  type: 'driver_career_summary';
  driver_id: string;
  championships: number;
  seasons_raced: number;
  career_podiums: number;
  career_wins: number;
  pace_trend_start_season: number | null;
  pace_trend_start_value: number | null;
  pace_trend_end_season: number | null;
  pace_trend_end_value: number | null;
  pace_trend_per_season: number | null;
}

/**
 * TIER 2: Track performance entry (for best/worst tracks)
 */
export interface TrackPerformanceEntry {
  track_id: string;
  track_name: string;
  avg_position: number;
  races: number;
  wins: number;
  podiums: number;
}

/**
 * TIER 2: Season performance entry (for trend analysis)
 */
export interface SeasonPerformanceEntry {
  season: number;
  teammate_gap_percent: number | null;
  qualifying_gap_percent: number | null;
  wins: number;
  podiums: number;
  dnfs: number;
}

/**
 * TIER 2: Percentile ranking
 */
export interface PercentileRanking {
  metric: string;
  percentile: number;  // 0-100
  rank: number;
  total_drivers: number;
}

/**
 * TIER 2: Driver profile summary result payload
 *
 * Comprehensive driver profile including:
 * - Career stats
 * - Best/worst tracks
 * - Latest season teammate gap (qualifying vs race)
 * - Performance trend (last 3 seasons)
 * - Percentile rankings
 */
export interface DriverProfileSummaryPayload {
  type: 'driver_profile_summary';
  driver_id: string;
  driver_name: string;

  // Career stats
  career: {
    championships: number;
    seasons_raced: number;
    total_wins: number;
    total_podiums: number;
    total_poles: number;
    first_season: number;
    latest_season: number;
  };

  // Best/worst tracks
  best_tracks: TrackPerformanceEntry[];
  worst_tracks: TrackPerformanceEntry[];

  // Latest season teammate comparison
  latest_season_teammate: {
    season: number;
    teammate_id: string | null;
    teammate_name: string | null;
    qualifying_gap_percent: number | null;
    race_pace_gap_percent: number | null;
    shared_races: number;
  } | null;

  // Performance trend (last N seasons)
  trend: {
    seasons: SeasonPerformanceEntry[];
    classification: 'improving' | 'declining' | 'stable';
    slope_per_season: number | null;
  };

  // Percentile rankings (latest season)
  percentiles: PercentileRanking[];
}

/**
 * TIER 2: Driver trend summary result payload
 *
 * Multi-season performance trend analysis:
 * - Slope per season (improvement/decline rate)
 * - Volatility measure
 * - Classification: improving | declining | stable
 */
export interface DriverTrendSummaryPayload {
  type: 'driver_trend_summary';
  driver_id: string;
  driver_name: string;

  // Analysis period
  start_season: number;
  end_season: number;
  seasons_analyzed: number;

  // Per-season data
  season_data: SeasonPerformanceEntry[];

  // Trend metrics
  trend: {
    classification: 'improving' | 'declining' | 'stable';
    slope_per_season: number | null;  // Negative = improving (faster), Positive = declining
    volatility: number | null;        // Standard deviation of gap changes
    r_squared: number | null;         // Goodness of fit (0-1)
  };

  // Context
  methodology: string;
}

/**
 * Filters applied to head-to-head query (for transparency)
 */
export interface HeadToHeadFiltersApplied {
  session?: string | null;
  track_type?: string | null;
  weather?: string | null;
  rounds?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  exclude_dnfs?: boolean | null;
}

/**
 * Driver head-to-head count result payload
 *
 * Position-based comparison between ANY two drivers.
 * Counts who finished/qualified ahead more often.
 *
 * NOT pace-based - purely positional comparison.
 * Supports optional conditional filters.
 */
export interface DriverHeadToHeadCountPayload {
  type: 'driver_head_to_head_count';
  season: number;
  metric: 'qualifying_position' | 'race_finish_position';
  driver_primary_id: string;
  driver_secondary_id: string;
  shared_events: number;
  primary_wins: number;
  secondary_wins: number;
  ties: number;
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
  /** Filters that were applied (if any) */
  filters_applied?: HeadToHeadFiltersApplied;
}

/**
 * PART 4: Driver performance vector result payload
 *
 * Cross-metric performance profile showing:
 * - Percentile rankings for qualifying and race pace
 * - Consistency score
 * - Contextual performance (street circuits, wet conditions)
 */
export interface DriverPerformanceVectorPayload {
  type: 'driver_performance_vector';
  season: number;
  driver_id: string;

  /** Percentile rank for avg qualifying pace (0-100, 100=fastest) */
  qualifying_percentile: number | null;

  /** Percentile rank for avg race pace (0-100, 100=fastest) */
  race_pace_percentile: number | null;

  /** Consistency score (0-100, 100=most consistent) */
  consistency_score: number | null;

  /** Gap to grid median on street circuits (negative=faster) */
  street_delta: number | null;

  /** Gap to grid median in wet races (negative=faster) */
  wet_delta: number | null;

  /** Sample sizes for confidence assessment */
  sample_sizes: {
    qualifying_laps: number;
    race_laps: number;
    street_laps: number;
    wet_laps: number;
  };

  /** Coverage status based on sample sizes */
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
}

/**
 * PART 5: Driver multi-comparison entry
 */
export interface DriverMultiComparisonEntry {
  driver_id: string;
  rank: number;
  metric_value: number;
  laps_considered: number;
}

/**
 * PART 5: Driver multi-comparison result payload
 *
 * Compares 2-6 drivers on a single metric.
 * comparison_type indicates if this is a multi-driver or head-to-head comparison.
 */
export interface DriverMultiComparisonPayload {
  type: 'driver_multi_comparison';
  season: number;
  metric: string;
  comparison_type: 'multi_driver' | 'head_to_head';
  entries: DriverMultiComparisonEntry[];
  total_drivers: number;
  ranked_drivers: number;
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
}

/**
 * PART 6: Driver matchup lookup result payload
 *
 * Precomputed head-to-head results from driver_matchup_matrix_2025.
 * Driver primary is always lexicographically first.
 */
export interface DriverMatchupLookupPayload {
  type: 'driver_matchup_lookup';
  season: number;
  metric: 'qualifying_position' | 'race_finish_position';
  driver_primary_id: string;
  driver_secondary_id: string;
  primary_wins: number;
  secondary_wins: number;
  ties: number;
  shared_events: number;
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
  computed_at: string;  // ISO 8601 timestamp
}

/**
 * Union of all result payload types
 */
export type ResultPayload =
  | SeasonDriverSummaryPayload
  | SeasonDriverVsDriverPayload
  | DriverRankingPayload
  | RaceResultsSummaryPayload
  | CrossTeamTrackScopedDriverComparisonPayload
  | TeammateGapSummarySeasonPayload
  | TeammateGapDualComparisonPayload
  | DriverCareerSummaryPayload
  | DriverProfileSummaryPayload
  | DriverTrendSummaryPayload
  | DriverHeadToHeadCountPayload
  | DriverPerformanceVectorPayload
  | DriverMultiComparisonPayload
  | DriverMatchupLookupPayload;

/**
 * PHASE Q: Coverage level classification
 */
export type CoverageLevel = 'high' | 'moderate' | 'low' | 'insufficient';

/**
 * PHASE Q: Sample balance flag for comparisons
 */
export type SampleBalanceFlag = 'balanced' | 'imbalanced';

/**
 * PHASE Q: Confidence metadata
 *
 * Describes statistical reliability of query results.
 * Does NOT change metric math or execution logic.
 * Only provides interpretability and reliability diagnosis.
 */
export interface ConfidenceMetadata {
  coverage_level: CoverageLevel;
  laps_considered: number;
  clean_air_ratio?: number;
  shared_overlap_laps?: number;
  sample_balance_flag?: SampleBalanceFlag;
  notes: string[];
}

/**
 * Interpretation block (mandatory)
 *
 * PHASE B: Row coverage validation
 * - constraints: Includes min_lap_requirement, rows_included, rows_excluded_reason
 *
 * PHASE Q: Confidence metadata
 * - confidence: Statistical reliability diagnosis
 */
export interface Interpretation {
  comparison_basis: string;
  normalization_scope: string;
  metric_definition: string;
  constraints: {
    min_lap_requirement: number;
    rows_included: number;
    rows_excluded_reason?: string;
    other_constraints: string[];
  };
  confidence_notes: string[];
  confidence: ConfidenceMetadata;
}

/**
 * PHASE R: Source table snapshot information
 */
/**
 * Metadata block (mandatory)
 *
 * Minimal provenance (no hashing/fingerprinting).
 */
export interface Metadata {
  sql_template_id: string;
  data_scope: string;
  rows: number;
}

/**
 * Successful query result
 */
export interface QueryResult {
  intent: QueryIntent;
  result: {
    type: string;
    payload: ResultPayload;
  };
  interpretation: Interpretation;
  metadata: Metadata;
}


/**
 * Query error (fail-closed)
 */
export interface QueryError {
  error: 'intent_resolution_failed' | 'validation_failed' | 'execution_failed';
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Query response (success or error)
 */
export type QueryResponse = QueryResult | QueryError;
