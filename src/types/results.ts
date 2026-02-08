import { QueryIntent, ApprovedMetric, CompoundContext } from './query-intent';
import { DriverRef, Metric, OrderedDriverPair, Coverage, TrackRef, TeamRef } from './semantic';

/**
 * Season driver summary result payload
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface SeasonDriverSummaryPayload {
  type: 'driver_season_summary';
  season: number;
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** Self-describing metrics */
  metrics: {
    wins: Metric<number>;
    podiums: Metric<number>;
    poles: Metric<number>;
    dnfs: Metric<number>;
    race_count: Metric<number>;
    /**
     * Average race pace as percent vs session median.
     * NORMALIZED: negative = faster, positive = slower.
     * Units: percent (not raw seconds).
     */
    avg_race_pace: Metric<number> | null;
    laps_considered: Metric<number>;
  };
  /** @deprecated Use metrics.poles.value */
  poles: number;
  /** Coverage metadata for pace calculation */
  coverage?: {
    status: 'valid' | 'low_coverage' | 'insufficient';
    sample_size: number;
    sample_type: 'races';
  };
  /** @deprecated Use metrics.wins.value */
  wins: number;
  /** @deprecated Use metrics.podiums.value */
  podiums: number;
  /** @deprecated Use metrics.dnfs.value */
  dnfs: number;
  /** @deprecated Use metrics.race_count.value */
  race_count: number;
  /** @deprecated Use metrics.avg_race_pace?.value - NOW PERCENT not seconds */
  avg_race_pace: number | null;
  /** @deprecated Use metrics.laps_considered.value */
  laps_considered: number;
}

/**
 * Season driver vs driver result payload
 *
 * Supports two modes:
 * - Normalized (default): session_median_percent normalization, values in %
 * - Raw pace: normalization='none', values in seconds
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface SeasonDriverVsDriverPayload {
  type: 'season_driver_vs_driver';
  season: number;
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;
  /** Self-describing metrics with labels and units */
  metrics: {
    driver_a_value: Metric<number>;
    driver_b_value: Metric<number>;
    difference: Metric<number>;
    shared_races?: Metric<number>;
    driver_a_laps: Metric<number>;
    driver_b_laps: Metric<number>;
  };
  /** Coverage information */
  coverage: Coverage;
  /** @deprecated Use drivers.drivers[0].id */
  driver_a: string;
  /** @deprecated Use drivers.drivers[1].id */
  driver_b: string;
  metric: ApprovedMetric;
  /** @deprecated Use metrics.driver_a_value.value */
  driver_a_value: number;
  /** @deprecated Use metrics.driver_b_value.value */
  driver_b_value: number;
  /** @deprecated Use metrics.difference.value */
  difference: number;
  normalization: string;
  /** @deprecated Use metrics.driver_a_laps.value */
  driver_a_laps: number;
  /** @deprecated Use metrics.driver_b_laps.value */
  driver_b_laps: number;
  /** @deprecated Computed from metrics */
  laps_considered: number;
  /** @deprecated Use metrics.shared_races?.value */
  shared_races?: number;
  /** @deprecated Use coverage.status */
  coverage_status?: 'valid' | 'low_coverage' | 'insufficient';
  /** @deprecated Use metrics.difference.units */
  units?: 'percent' | 'seconds';
}


/**
 * Driver ranking entry
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverRankingEntry {
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** Self-describing metric value */
  pace: Metric<number>;
  /** @deprecated Use pace.value */
  value: number;
  /** Laps analyzed */
  laps: Metric<number>;
  /** @deprecated Use laps.value */
  laps_considered: number;
}

/**
 * Race results entry
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface RaceResultsEntry {
  /** Finishing position */
  position: number;
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** @deprecated Use driver.name */
  driver_name: string;
  /** Constructor/team name */
  constructor_name: string;
  /** Laps completed in race */
  laps_completed: number | null;
  /** Finishing time or gap to leader */
  race_time: string | null;
  /** Fastest lap time if set */
  fastest_lap: string | null;
  /** Starting grid position */
  grid_position: number | null;
  /** Points scored */
  points: number | null;
}

/**
 * Race results summary payload
 */
export interface RaceResultsSummaryPayload {
  type: 'race_results_summary';
  season: number;
  /** Self-describing track reference */
  track: TrackRef;
  /** @deprecated Use track.id */
  track_id: string;
  race_name: string | null;
  race_date: string | null;
  circuit_name: string | null;
  /** Winner driver ID */
  winner: string | null;
  /** Winner display name */
  winner_name: string | null;
  podium: RaceResultsEntry[];
  top10: RaceResultsEntry[];
  laps_completed: number | null;
  winner_time: string | null;
}

/**
 * Qualifying results entry
 */
export interface QualifyingResultsEntry {
  /** Qualifying position */
  position: number;
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** @deprecated Use driver.name */
  driver_name: string;
  /** Constructor/team name */
  constructor_name: string;
  /** Q1 time (formatted MM:SS.sss) */
  q1_time: string | null;
  /** Q2 time (formatted MM:SS.sss) */
  q2_time: string | null;
  /** Q3 time (formatted MM:SS.sss) */
  q3_time: string | null;
  /** Qualifying time display: P1 shows full time, P2+ show gap from P1 */
  qualifying_time: string | null;
}

/**
 * Qualifying results summary payload
 */
export interface QualifyingResultsSummaryPayload {
  type: 'qualifying_results_summary';
  season: number;
  round: number | null;
  /** Self-describing track reference */
  track: TrackRef;
  /** @deprecated Use track.id */
  track_id: string;
  track_name: string | null;
  /** Pole sitter driver ID */
  pole_sitter: string | null;
  /** Pole sitter display name */
  pole_sitter_name: string | null;
  /** Pole time */
  pole_time: string | null;
  /** Front row (top 2 qualifiers) */
  front_row: QualifyingResultsEntry[];
  /** Top 10 (Q3) qualifiers */
  top10: QualifyingResultsEntry[];
  /** Full grid */
  full_grid: QualifyingResultsEntry[];
}

/**
 * Driver ranking result payload
 *
 * PHASE L2: Extended to support per_compound mode
 */
export interface DriverRankingPayload {
  type: 'driver_ranking';
  season: number;
  /** Self-describing track reference */
  track: TrackRef;
  /** @deprecated Use track.id */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
/**
 * Track-scoped coverage for driver comparisons
 * basis_laps = min(driver_a_laps, driver_b_laps)
 * Confidence thresholds: high (>=30), medium (10-29), low (<10)
 */
export interface TrackComparisonCoverage {
  driver_a_laps: number;
  driver_b_laps: number;
  basis_laps: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface CrossTeamTrackScopedDriverComparisonPayload {
  type: 'cross_team_track_scoped_driver_comparison';
  season: number;
  /** Self-describing track reference */
  track: TrackRef;
  /** @deprecated Use track.id */
  track_id: string;
  metric: ApprovedMetric;
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;
  /** Self-describing metrics */
  metrics: {
    driver_a_value: Metric<number>;
    driver_b_value: Metric<number>;
    pace_delta: Metric<number>;
    driver_a_laps: Metric<number>;
    driver_b_laps: Metric<number>;
  };
  /** Coverage model with confidence assessment */
  coverage: TrackComparisonCoverage;
  compound_context: CompoundContext;
  /** @deprecated Use drivers.drivers[0].id */
  driver_a: string;
  /** @deprecated Use drivers.drivers[1].id */
  driver_b: string;
  /** @deprecated Use metrics.driver_a_value.value */
  driver_a_value: number;
  /** @deprecated Use metrics.driver_b_value.value */
  driver_b_value: number;
  /** @deprecated Use metrics.pace_delta.value */
  pace_delta: number;
  /** @deprecated Use metrics.driver_a_laps.value */
  driver_a_laps: number;
  /** @deprecated Use metrics.driver_b_laps.value */
  driver_b_laps: number;
  /** @deprecated Use coverage.basis_laps */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface TeammateGapSummarySeasonPayload {
  type: 'teammate_gap_summary_season';
  season: number;
  team_id: string;
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;
  /** Self-describing metrics */
  metrics: {
    gap_seconds: Metric<number>;
    gap_pct: Metric<number> | null;
    shared_races: Metric<number>;
    faster_count: Metric<number>;
  };
  /** Coverage information */
  coverage: Coverage;
  /** @deprecated Use drivers.drivers[0].id */
  driver_primary_id: string;
  /** @deprecated Use drivers.drivers[1].id */
  driver_secondary_id: string;
  /** @deprecated Use metrics.gap_seconds.value */
  gap_seconds: number;
  /** @deprecated Computed from metrics.gap_seconds.value */
  gap_seconds_abs: number;
  /** @deprecated Use metrics.gap_pct?.value */
  gap_pct: number | null;
  /** @deprecated Computed from metrics.gap_pct?.value */
  gap_pct_abs: number | null;
  /** @deprecated Use metrics.shared_races.value */
  shared_races: number;
  /** @deprecated Use metrics.faster_count.value */
  faster_driver_primary_count: number;
  /** @deprecated Use coverage.status */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface TeammateGapDualComparisonPayload {
  type: 'teammate_gap_dual_comparison';
  season: number;
  team_id: string | null;
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;
  qualifying: DualComparisonMetricComponent;
  race_pace: DualComparisonMetricComponent;
  overall_summary: DualComparisonSummary;
  /** @deprecated Use drivers.drivers[0].id */
  driver_primary_id: string;
  /** @deprecated Use drivers.drivers[1].id */
  driver_secondary_id: string;
}

/**
 * Driver career summary result payload
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverCareerSummaryPayload {
  type: 'driver_career_summary';
  /** Driver with resolved name */
  driver: DriverRef;
  /** Self-describing metrics */
  metrics: {
    championships: Metric<number>;
    seasons_raced: Metric<number>;
    career_podiums: Metric<number>;
    career_wins: Metric<number>;
    career_poles: Metric<number>;
  };
  /** @deprecated Use driver.id */
  driver_id: string;
  /** @deprecated Use metrics.championships.value */
  championships: number;
  /** @deprecated Use metrics.seasons_raced.value */
  seasons_raced: number;
  /** @deprecated Use metrics.career_podiums.value */
  career_podiums: number;
  /** @deprecated Use metrics.career_wins.value */
  career_wins: number;
  /** @deprecated Use metrics.career_poles.value */
  career_poles: number;
  pace_trend_start_season: number | null;
  pace_trend_start_value: number | null;
  pace_trend_end_season: number | null;
  pace_trend_end_value: number | null;
  pace_trend_per_season: number | null;
}

/**
 * Driver career pole count result payload
 *
 * Career pole position statistics from F1DB driver table.
 */
export interface DriverCareerPoleCountPayload {
  type: 'driver_career_pole_count';
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** Full driver name */
  driver_name: string;
  /** Career pole positions */
  total_poles: number;
  /** Career race starts */
  total_race_starts: number;
  /** Career race wins */
  total_wins: number;
  /** Career podiums */
  total_podiums: number;
  /** World championships */
  championships: number;
  /** Career pole rate (poles/races as percentage) */
  pole_rate_percent: number | null;
  /** First F1 season */
  first_season: number | null;
  /** Most recent F1 season */
  last_season: number | null;
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverProfileSummaryPayload {
  type: 'driver_profile_summary';
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** @deprecated Use driver.name */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverTrendSummaryPayload {
  type: 'driver_trend_summary';
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  /** @deprecated Use driver.name */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverHeadToHeadCountPayload {
  type: 'driver_head_to_head_count';
  season: number;
  metric: 'qualifying_position' | 'race_finish_position';
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;
  /** Self-describing metrics */
  metrics: {
    primary_wins: Metric<number>;
    secondary_wins: Metric<number>;
    ties: Metric<number>;
    shared_events: Metric<number>;
  };
  /** Coverage information */
  coverage: Coverage;
  /** @deprecated Use drivers.drivers[0].id */
  driver_primary_id: string;
  /** @deprecated Use drivers.drivers[1].id */
  driver_secondary_id: string;
  /** @deprecated Use metrics.shared_events.value */
  shared_events: number;
  /** @deprecated Use metrics.primary_wins.value */
  primary_wins: number;
  /** @deprecated Use metrics.secondary_wins.value */
  secondary_wins: number;
  /** @deprecated Use metrics.ties.value */
  ties: number;
  /** @deprecated Use coverage.status */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverPerformanceVectorPayload {
  type: 'driver_performance_vector';
  season: number;
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
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
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverMultiComparisonEntry {
  /** Driver with resolved name */
  driver: DriverRef;
  /** @deprecated Use driver.id */
  driver_id: string;
  rank: number;
  /** Self-describing metric value */
  metric: Metric<number>;
  /** @deprecated Use metric.value */
  metric_value: number;
  /** Laps analyzed */
  laps: Metric<number>;
  /** @deprecated Use laps.value */
  laps_considered: number;
}

/**
 * PART 5: Driver multi-comparison result payload
 *
 * Compares 2-6 drivers on a single metric.
 * comparison_type indicates if this is a multi-driver or head-to-head comparison.
 *
 * Updated with semantic types for self-describing presentation.
 */
export interface DriverMultiComparisonPayload {
  type: 'driver_multi_comparison';
  season: number;
  metric: string;
  comparison_type: 'multi_driver' | 'head_to_head';
  entries: DriverMultiComparisonEntry[];
  total_drivers: number;
  ranked_drivers: number;
  /** Coverage information */
  coverage: Coverage;
  /** @deprecated Use coverage.status */
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
}

/**
 * PART 6: Driver matchup lookup result payload
 *
 * Precomputed head-to-head results from driver_matchup_matrix_2025.
 * Driver primary is always lexicographically first.
 *
 * @deprecated This query kind is being consolidated into driver_head_to_head_count.
 * Kept for backwards compatibility during migration.
 */
export interface DriverMatchupLookupPayload {
  type: 'driver_matchup_lookup';
  season: number;
  metric: 'qualifying_position' | 'race_finish_position';
  /** Ordered driver pair */
  drivers: OrderedDriverPair;
  /** Self-describing metrics */
  metrics: {
    primary_wins: Metric<number>;
    secondary_wins: Metric<number>;
    ties: Metric<number>;
    shared_events: Metric<number>;
  };
  /** Coverage information */
  coverage: Coverage;
  /** @deprecated Use drivers.drivers[0].id */
  driver_primary_id: string;
  /** @deprecated Use drivers.drivers[1].id */
  driver_secondary_id: string;
  /** @deprecated Use metrics.primary_wins.value */
  primary_wins: number;
  /** @deprecated Use metrics.secondary_wins.value */
  secondary_wins: number;
  /** @deprecated Use metrics.ties.value */
  ties: number;
  /** @deprecated Use metrics.shared_events.value */
  shared_events: number;
  /** @deprecated Use coverage.status */
  coverage_status: 'valid' | 'low_coverage' | 'insufficient';
  computed_at: string;  // ISO 8601 timestamp
}

/**
 * Driver vs Driver Comprehensive Comparison Payload
 *
 * Combines pace data with achievement stats for a full comparison.
 * Used for queries like "Verstappen vs Norris full comparison 2024".
 */
export interface DriverVsDriverComprehensivePayload {
  type: 'driver_vs_driver_comprehensive';
  season: number;
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;

  /** Pace comparison - normalized % relative to session median
   *  Negative = faster than field, Positive = slower
   *  May be null if lap data unavailable */
  pace: {
    driver_a_avg_pace_pct: Metric<number> | null;
    driver_b_avg_pace_pct: Metric<number> | null;
    pace_delta_pct: Metric<number> | null;
    shared_races: number;
  };

  /** Qualifying gap - average gap between drivers in qualifying
   *  Positive = driver A slower, Negative = driver A faster */
  qualifying_gap: {
    gap_pct: Metric<number> | null;
    gap_ms: number | null;
    shared_sessions: number;
  };

  /** Head-to-head positional counts */
  head_to_head: {
    qualifying: { a_wins: number; b_wins: number; ties: number };
    race_finish: { a_wins: number; b_wins: number; ties: number };
  };

  /** Season statistics for each driver */
  stats: {
    driver_a: {
      wins: Metric<number>;
      podiums: Metric<number>;
      poles: Metric<number>;
      dnfs: Metric<number>;
      points: Metric<number>;
      race_count: Metric<number>;
      fastest_laps: Metric<number>;
      sprint_points: Metric<number>;
    };
    driver_b: {
      wins: Metric<number>;
      podiums: Metric<number>;
      poles: Metric<number>;
      dnfs: Metric<number>;
      points: Metric<number>;
      race_count: Metric<number>;
      fastest_laps: Metric<number>;
      sprint_points: Metric<number>;
    };
  };

  /** Coverage information */
  coverage: Coverage;
}

/**
 * Driver Career Wins by Circuit Payload
 *
 * Shows breakdown of a driver's wins by circuit.
 * Used for queries like "Hamilton wins by circuit".
 */
export interface DriverCareerWinsByCircuitPayload {
  type: 'driver_career_wins_by_circuit';
  /** Driver with resolved name */
  driver: DriverRef;
  /** Total career wins */
  total_wins: number;
  /** Wins breakdown by circuit, ordered by win count */
  circuits: Array<{
    track: TrackRef;
    wins: number;
    last_win_year: number;
  }>;
}

/**
 * Teammate Comparison Career Payload
 *
 * Multi-season teammate comparison with per-season breakdown.
 * Auto-detects all seasons drivers were teammates.
 * Used for queries like "Hamilton vs Russell as teammates".
 */
export interface TeammateComparisonCareerPayload {
  type: 'teammate_comparison_career';
  /** Ordered driver pair preserving user query order */
  drivers: OrderedDriverPair;

  /** Per-season breakdown */
  seasons: Array<{
    season: number;
    team: TeamRef;
    /** @deprecated Use team.id */
    team_id: string;
    gap_seconds: number;
    gap_pct: number | null;
    shared_races: number;
    /** Count of races where primary driver was faster */
    faster_primary_count: number;
  }>;

  /** Aggregated statistics across all seasons */
  aggregate: {
    total_shared_races: number;
    avg_gap_seconds: number;
    seasons_together: number;
    overall_winner: 'primary' | 'secondary' | 'draw';
  };
}

/**
 * Union of all result payload types
 */
export type ResultPayload =
  | SeasonDriverSummaryPayload
  | SeasonDriverVsDriverPayload
  | DriverRankingPayload
  | RaceResultsSummaryPayload
  | QualifyingResultsSummaryPayload
  | CrossTeamTrackScopedDriverComparisonPayload
  | TeammateGapSummarySeasonPayload
  | TeammateGapDualComparisonPayload
  | DriverCareerSummaryPayload
  | DriverCareerPoleCountPayload
  | DriverProfileSummaryPayload
  | DriverTrendSummaryPayload
  | DriverHeadToHeadCountPayload
  | DriverPerformanceVectorPayload
  | DriverMultiComparisonPayload
  | DriverMatchupLookupPayload
  | DriverVsDriverComprehensivePayload
  | DriverCareerWinsByCircuitPayload
  | TeammateComparisonCareerPayload;

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
