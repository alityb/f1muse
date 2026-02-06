/**
 * APPROVED METRICS (STATMUSE REFACTOR)
 *
 * All performance metrics are either:
 * - Teammate-relative (teammate_gap_raw)
 * - Raw pace (avg_true_pace, clean_air_pace)
 *
 * NO CAR BASELINE METRICS EXIST.
 */
export type ApprovedMetric =
  | 'avg_true_pace'           // lower = faster (raw lap times)
  | 'clean_air_pace'          // ONLY when explicitly requested (raw lap times in clean air)
  | 'teammate_gap_raw'        // Season-level teammate gap (median shared-lap pace difference)
  | 'teammate_gap_dual';      // Dual comparison: qualifying vs race pace

/**
 * Normalization strategies
 *
 * STATMUSE REFACTOR: No car baseline normalization.
 * Only teammate-relative or none.
 */
export type NormalizationStrategy =
  | 'team_baseline'           // teammate-relative (only for teammate_gap_raw)
  | 'session_median_percent'  // session-median normalized percent pace (cross-team default)
  | 'none';                   // no normalization (raw pace)

/**
 * Compound context
 */
export type CompoundContext = 'mixed' | 'per_compound';

/**
 * Session scope
 */
export type SessionScope = 'race' | 'qualifying' | 'sprint' | 'all';

/**
 * Head-to-head metric type for position-based comparisons
 */
export type HeadToHeadMetric = 'qualifying_position' | 'race_finish_position';

/**
 * Scope for head-to-head comparisons
 */
export type HeadToHeadScope = 'field' | 'teammate';

/**
 * Qualifying session filter
 */
export type QualifyingSession = 'Q1' | 'Q2' | 'Q3' | 'BEST';

/**
 * Track type filter
 */
export type TrackType = 'street' | 'permanent';

/**
 * Weather condition filter
 */
export type WeatherCondition = 'dry' | 'wet' | 'mixed';

/**
 * Conditional filters for head-to-head queries
 *
 * All filters are optional. Omitted filters are not applied.
 */
export interface HeadToHeadFilters {
  /** Qualifying session filter (for qualifying_position metric) */
  session?: QualifyingSession;

  /** Track type filter */
  track_type?: TrackType;

  /** Weather condition filter */
  weather?: WeatherCondition;

  /** Specific rounds to include */
  rounds?: number[];

  /** Date range start (ISO 8601) */
  date_from?: string;

  /** Date range end (ISO 8601) */
  date_to?: string;

  /** Exclude DNF/DNS results */
  exclude_dnfs?: boolean;
}

/**
 * QueryIntent kinds (STATMUSE REFACTOR - AUTHORITATIVE)
 *
 * 19 query types are supported.
 *
 * TIER 2 ADDITIONS:
 * - driver_profile_summary: Comprehensive driver profile
 * - driver_trend_summary: Multi-season performance trend analysis
 * - driver_head_to_head_count: Position-based head-to-head comparison (any two drivers)
 *
 * PART 4 ADDITIONS:
 * - driver_performance_vector: Cross-metric performance profile
 *
 * PART 5 ADDITIONS:
 * - driver_multi_comparison: Compare 2-6 drivers on a single metric
 *
 * PART 6 ADDITIONS:
 * - driver_matchup_lookup: Fast head-to-head lookup from precomputed matrix
 *
 * QUALIFYING ADDITIONS:
 * - driver_pole_count: Count pole positions for a driver
 * - driver_q3_count: Count Q3 appearances for a driver
 * - season_q3_rankings: Rank drivers by Q3 appearances in a season
 * - qualifying_gap_teammates: Qualifying gap between teammates
 * - qualifying_gap_drivers: Qualifying gap between any two drivers
 */
export type QueryIntentKind =
  | 'driver_season_summary'                     // Single driver season stats (renamed from season_driver_summary)
  | 'driver_career_summary'                     // Career-spanning statistics
  | 'driver_profile_summary'                    // TIER 2: Comprehensive driver profile
  | 'driver_trend_summary'                      // TIER 2: Multi-season trend analysis
  | 'driver_head_to_head_count'                 // NEW: Position-based head-to-head count
  | 'driver_performance_vector'                 // PART 4: Cross-metric performance profile
  | 'driver_multi_comparison'                   // PART 5: Multi-driver comparison (2-6 drivers)
  | 'driver_matchup_lookup'                     // PART 6: Fast h2h lookup from precomputed matrix
  | 'season_driver_vs_driver'                   // Cross-team season comparison (raw pace only, no baseline)
  | 'cross_team_track_scoped_driver_comparison' // Track-scoped comparison (raw pace)
  | 'teammate_gap_summary_season'               // PRIMARY performance metric: teammate gap
  | 'teammate_gap_dual_comparison'              // Qualifying vs race pace comparison
  | 'track_fastest_drivers'                     // Rank drivers at track (renamed from driver_ranking_track)
  | 'race_results_summary'                      // Race results from F1DB
  | 'driver_pole_count'                         // QUALIFYING: Count pole positions
  | 'driver_q3_count'                           // QUALIFYING: Count Q3 appearances
  | 'season_q3_rankings'                        // QUALIFYING: Rank drivers by Q3 appearances
  | 'qualifying_gap_teammates'                  // QUALIFYING: Teammate qualifying gap
  | 'qualifying_gap_drivers';                   // QUALIFYING: Cross-team qualifying gap

/**
 * Base QueryIntent fields (common to most kinds)
 *
 * Note: race_results_summary does not include metric/normalization fields.
 */
interface BaseQueryIntent {
  kind: QueryIntentKind;
  season: number;
  metric: ApprovedMetric;
  normalization: NormalizationStrategy;
  clean_air_only: boolean;
  compound_context: CompoundContext;
  session_scope: SessionScope;
  raw_query: string;
}

// =====================================================
// STATMUSE REFACTOR: 8 SUPPORTED QUERY TYPES
// =====================================================

/**
 * 1. Driver season summary - Single driver season statistics
 */
export interface DriverSeasonSummaryIntent extends BaseQueryIntent {
  kind: 'driver_season_summary';
  driver_id: string;  // F1DB driver.id
}

/**
 * 2. Driver career summary - Career-spanning statistics
 */
export interface DriverCareerSummaryIntent extends BaseQueryIntent {
  kind: 'driver_career_summary';
  driver_id: string;  // F1DB driver.id
}

/**
 * 3. Season driver vs driver - Cross-team season comparison (raw pace only, NO baseline)
 */
export interface SeasonDriverVsDriverIntent extends BaseQueryIntent {
  kind: 'season_driver_vs_driver';
  driver_a_id: string;  // F1DB driver.id
  driver_b_id: string;  // F1DB driver.id
}

/**
 * 4. Cross-team track-scoped driver comparison - Raw pace at specific track
 */
export interface CrossTeamTrackScopedDriverComparisonIntent extends BaseQueryIntent {
  kind: 'cross_team_track_scoped_driver_comparison';
  track_id: string;      // F1DB circuit.id or grand_prix.id
  driver_a_id: string;   // F1DB driver.id
  driver_b_id: string;   // F1DB driver.id
}

/**
 * 5. Teammate gap summary season - PRIMARY performance metric
 *
 * This is the ONLY way to express teammate-relative performance.
 * Uses median lap-time gap between teammates on shared laps.
 */
export interface TeammateGapSummarySeasonIntent extends BaseQueryIntent {
  kind: 'teammate_gap_summary_season';
  driver_a_id: string | null;  // F1DB driver.id (null for team-only queries)
  driver_b_id: string | null;  // F1DB driver.id (null for team-only queries)
  team_id?: string | null;     // F1DB constructor.id (team-only queries)
}

/**
 * 5b. Teammate gap dual comparison - Qualifying vs Race pace
 *
 * New intent: teammate_gap_dual_comparison
 *
 * Compares qualifying gap to race pace gap for the same teammate pair.
 * Shows where each driver has the advantage.
 * Triggered by: "Compare qualifying vs race pace between X and Y"
 *
 * Note: Extends BaseQueryIntent for type compatibility; uses 'teammate_gap_dual' metric.
 */
export interface TeammateGapDualComparisonIntent extends BaseQueryIntent {
  kind: 'teammate_gap_dual_comparison';
  driver_a_id: string | null;  // F1DB driver.id (null for team-only queries)
  driver_b_id: string | null;  // F1DB driver.id (null for team-only queries)
  team_id?: string | null;     // F1DB constructor.id (team-only queries)
}

/**
 * 6. Track fastest drivers - Rank all drivers at a specific track
 */
export interface TrackFastestDriversIntent extends BaseQueryIntent {
  kind: 'track_fastest_drivers';
  track_id: string;      // F1DB circuit.id or grand_prix.id
}

/**
 * 7. Race results summary - F1DB race results (NEW)
 *
 * Pure race results from F1DB. No pace metrics, no extrapolation.
 * Triggered by: "Results of [track] [season]", "Who won [track] [season]"
 *
 * Note: Extends BaseQueryIntent for type compatibility; uses 'none' normalization
 * and 'avg_true_pace' as placeholder metric (not actually used for results).
 */
export interface RaceResultsSummaryIntent extends BaseQueryIntent {
  kind: 'race_results_summary';
  track_id: string;      // F1DB circuit.id or grand_prix.id
}

/**
 * 8. Driver profile summary - Comprehensive driver profile (TIER 2)
 *
 * Returns:
 * - Career stats
 * - Best/worst tracks
 * - Latest season teammate gap (qualifying vs race)
 * - Performance trend (last 3 seasons)
 *
 * Triggered by: GET /driver/:driver_id/profile
 *
 * Note: Extends BaseQueryIntent for type compatibility; uses 'none' normalization
 * and 'teammate_gap_dual' metric as the profile includes teammate comparisons.
 */
export interface DriverProfileSummaryIntent extends BaseQueryIntent {
  kind: 'driver_profile_summary';
  driver_id: string;  // F1DB driver.id
}

/**
 * 9. Driver trend summary - Multi-season performance trend (TIER 2)
 *
 * Returns:
 * - Slope per season (improvement/decline rate)
 * - Volatility measure
 * - Classification: improving | declining | stable
 *
 * Triggered by: "trend for [driver]", "is [driver] improving?"
 *
 * Note: Extends BaseQueryIntent for type compatibility; uses 'team_baseline' normalization
 * and 'teammate_gap_raw' metric as trend is computed from teammate gaps.
 */
export interface DriverTrendSummaryIntent extends BaseQueryIntent {
  kind: 'driver_trend_summary';
  driver_id: string;  // F1DB driver.id
  start_season?: number;  // Optional: analyze from this season (default: 3 seasons back)
  end_season?: number;    // Optional: analyze to this season (default: current)
}

/**
 * 10. Driver head-to-head count - Position-based comparison (any two drivers)
 *
 * Compares finishing positions or qualifying positions between ANY two drivers.
 * NOT pace-based - purely based on who finished/qualified ahead.
 *
 * Examples:
 * - "How many times did Lando outqualify Oscar Piastri in 2025?"
 * - "Who finished ahead more often, Verstappen or Hamilton?"
 * - "Head to head Norris vs Leclerc qualifying 2024"
 * - "How many times did Lando outqualify Oscar in Q3?"
 * - "Who finished ahead more often in wet races?"
 *
 * Supports both cross-team (scope=field) and same-team (scope=teammate) comparisons.
 * Supports optional conditional filters for refined analysis.
 */
export interface DriverHeadToHeadCountIntent extends BaseQueryIntent {
  kind: 'driver_head_to_head_count';
  driver_a_id: string;           // F1DB driver.id
  driver_b_id: string;           // F1DB driver.id
  h2h_metric: HeadToHeadMetric;  // qualifying_position or race_finish_position
  h2h_scope: HeadToHeadScope;    // field (any drivers) or teammate (same team only)
  filters?: HeadToHeadFilters;   // Optional conditional filters
}

/**
 * 11. Driver performance vector - Cross-metric performance profile (PART 4)
 *
 * Returns multi-dimensional performance profile:
 * - qualifying_percentile: Percentile rank for avg qualifying pace (0-100, 100=fastest)
 * - race_pace_percentile: Percentile rank for avg race pace (0-100, 100=fastest)
 * - consistency_score: Derived from lap time stddev (100=most consistent)
 * - street_delta: Gap to grid median on street circuits (negative=faster)
 * - wet_delta: Gap to grid median in wet races (negative=faster)
 *
 * Examples:
 * - "What is Norris's performance profile in 2025?"
 * - "Show me Verstappen's strengths and weaknesses"
 * - "How consistent is Leclerc compared to the grid?"
 */
export interface DriverPerformanceVectorIntent extends BaseQueryIntent {
  kind: 'driver_performance_vector';
  driver_id: string;  // F1DB driver.id
}

/**
 * Multi-comparison metric types
 */
export type MultiComparisonMetric = 'avg_true_pace' | 'qualifying_pace' | 'consistency';

/**
 * 12. Driver multi-comparison - Compare 2-6 drivers (PART 5)
 *
 * Compares multiple drivers (2-6) on a single metric within a season.
 * Returns ranked comparison showing relative performance.
 *
 * Examples:
 * - "Compare Verstappen, Norris, and Leclerc race pace in 2025"
 * - "Who is faster between Hamilton, Russell, Sainz, and Alonso?"
 * - "Rank the top 4 drivers by qualifying pace"
 */
export interface DriverMultiComparisonIntent extends BaseQueryIntent {
  kind: 'driver_multi_comparison';
  driver_ids: string[];  // 2-6 F1DB driver.ids
  comparison_metric: MultiComparisonMetric;  // Metric to compare on
}

/**
 * 13. Driver matchup lookup - Fast h2h from precomputed matrix (PART 6)
 *
 * Looks up precomputed head-to-head results from driver_matchup_matrix_2025.
 * Much faster than runtime computation for common queries.
 *
 * Examples:
 * - "Head to head Verstappen vs Norris 2025"
 * - "Who beats whom more often, Hamilton or Russell?"
 */
export interface DriverMatchupLookupIntent extends BaseQueryIntent {
  kind: 'driver_matchup_lookup';
  driver_a_id: string;           // F1DB driver.id
  driver_b_id: string;           // F1DB driver.id
  h2h_metric: HeadToHeadMetric;  // qualifying_position or race_finish_position
}

// =====================================================
// QUALIFYING QUERY TYPES (5 NEW TYPES)
// =====================================================

/**
 * 14. Driver pole count - Count pole positions for a driver (QUALIFYING)
 *
 * Returns the number of pole positions achieved by a driver in a season.
 *
 * Examples:
 * - "How many poles did Verstappen get in 2024?"
 * - "Norris pole positions 2025"
 * - "Who has the most poles in 2023?"
 */
export interface DriverPoleCountIntent extends BaseQueryIntent {
  kind: 'driver_pole_count';
  driver_id: string;  // F1DB driver.id
}

/**
 * 15. Driver Q3 count - Count Q3 appearances for a driver (QUALIFYING)
 *
 * Returns the number of Q3 appearances for a driver in a season.
 * Q3 = top 10 in qualifying.
 *
 * Examples:
 * - "How many times did Sainz make Q3 in 2025?"
 * - "Q3 appearances for Hamilton 2024"
 */
export interface DriverQ3CountIntent extends BaseQueryIntent {
  kind: 'driver_q3_count';
  driver_id: string;  // F1DB driver.id
}

/**
 * 16. Season Q3 rankings - Rank drivers by Q3 appearances (QUALIFYING)
 *
 * Returns all drivers ranked by their Q3 appearance count in a season.
 *
 * Examples:
 * - "Q3 rankings 2025"
 * - "Who made Q3 the most in 2024?"
 * - "Rank drivers by Q3 appearances"
 */
export interface SeasonQ3RankingsIntent extends BaseQueryIntent {
  kind: 'season_q3_rankings';
  // No additional fields - season is in base
}

/**
 * 17. Qualifying gap teammates - Qualifying gap between teammates (QUALIFYING)
 *
 * Returns the qualifying time gap between two teammates over a season.
 * Comparison uses deepest common round (Q3 > Q2 > Q1).
 * If times unavailable, uses 250ms per grid position as proxy.
 *
 * Examples:
 * - "Qualifying gap between Norris and Piastri 2025"
 * - "Who outqualified whom, Verstappen or Perez?"
 * - "Hamilton vs Russell qualifying gap 2024"
 */
export interface QualifyingGapTeammatesIntent extends BaseQueryIntent {
  kind: 'qualifying_gap_teammates';
  driver_a_id: string | null;  // F1DB driver.id (null for team-only queries)
  driver_b_id: string | null;  // F1DB driver.id (null for team-only queries)
  team_id?: string | null;     // F1DB constructor.id (team-only queries)
}

/**
 * 18. Qualifying gap drivers - Qualifying gap between any two drivers (QUALIFYING)
 *
 * Returns the qualifying position gap between any two drivers over a season.
 * Uses position-based comparison (not time-based for cross-team).
 *
 * Examples:
 * - "Qualifying positions Verstappen vs Leclerc 2025"
 * - "Who qualifies higher, Norris or Hamilton?"
 */
export interface QualifyingGapDriversIntent extends BaseQueryIntent {
  kind: 'qualifying_gap_drivers';
  driver_a_id: string;  // F1DB driver.id
  driver_b_id: string;  // F1DB driver.id
}

/**
 * Union type of all QueryIntent variants (19 TYPES)
 */
export type QueryIntent =
  | DriverSeasonSummaryIntent
  | DriverCareerSummaryIntent
  | DriverProfileSummaryIntent
  | DriverTrendSummaryIntent
  | DriverHeadToHeadCountIntent
  | DriverPerformanceVectorIntent
  | DriverMultiComparisonIntent
  | DriverMatchupLookupIntent
  | SeasonDriverVsDriverIntent
  | CrossTeamTrackScopedDriverComparisonIntent
  | TeammateGapSummarySeasonIntent
  | TeammateGapDualComparisonIntent
  | TrackFastestDriversIntent
  | RaceResultsSummaryIntent
  | DriverPoleCountIntent
  | DriverQ3CountIntent
  | SeasonQ3RankingsIntent
  | QualifyingGapTeammatesIntent
  | QualifyingGapDriversIntent;
