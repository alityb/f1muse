/**
 * Database schema types (READ-ONLY)
 * - F1DB reference layer (authoritative)
 * - FastF1 ingestion/analytics layer
 */

export interface Driver {
  id: string;        // F1DB driver.id
  full_name: string;
  first_name?: string;
  last_name?: string;
  abbreviation: string;
}

export interface Team {
  team_id: string;          // e.g., "RBR", "FER"
  team_name: string;
  season: number;
}

export interface Season {
  season: number;
  year: number;
}

export interface Track {
  id: string;         // F1DB circuit.id
  name: string;
  full_name: string;
}

export interface Event {
  event_id: string;
  season: number;
  track_id: string;
  event_name: string;
  round_number: number;
}

export interface Session {
  session_id: string;
  event_id: string;
  session_type: 'race' | 'qualifying' | 'sprint' | 'practice';
  session_name: string;
}

/**
 * Pace metric summary - driver x season
 */
export interface PaceMetricSummaryDriverSeason {
  driver_id: string;
  season: number;
  metric_name: string;        // 'driver_above_baseline', 'avg_true_pace', etc.
  metric_value: number;
  normalization: string;      // 'team_baseline', 'car_baseline_adjusted', 'none'
  laps_considered: number;
  clean_air_only: boolean;
  compound_context: string;   // 'mixed' | 'per_compound'
  session_scope: string;      // 'race' | 'qualifying' | 'sprint' | 'all'
}

/**
 * Pace metric summary - driver x track
 */
export interface PaceMetricSummaryDriverTrack {
  driver_id: string;
  season: number;
  track_id: string;
  metric_name: string;
  metric_value: number;
  normalization: string;
  laps_considered: number;
  clean_air_only: boolean;
  compound_context: string;
  session_scope: string;
}

/**
 * SQL template metadata
 */
export interface SqlTemplate {
  template_id: string;
  template_name: string;
  sql_text: string;
  parameters: string[];     // parameter names expected
  description: string;
}

/**
 * Approved SQL template IDs (20 TEMPLATES)
 *
 * Maps 1:1 to the 19 supported QueryIntent kinds (some kinds have multiple templates).
 *
 * TIER 2 ADDITIONS:
 * - driver_profile_summary_v1: Comprehensive driver profile
 * - driver_trend_summary_v1: Multi-season trend analysis
 * - driver_head_to_head_count_v1: Position-based head-to-head comparison
 *
 * PART 4 ADDITIONS:
 * - driver_performance_vector_v1: Cross-metric performance profile
 *
 * PART 5 ADDITIONS:
 * - driver_multi_comparison_v1: Compare 2-6 drivers on a single metric
 *
 * PART 6 ADDITIONS:
 * - driver_matchup_lookup_v1: Fast h2h lookup from precomputed matrix
 *
 * QUALIFYING ADDITIONS:
 * - driver_pole_count_v1: Count pole positions
 * - driver_q3_count_v1: Count Q3 appearances
 * - season_q3_rankings_v1: Rank drivers by Q3 appearances
 * - qualifying_gap_teammates_v1: Teammate qualifying gap
 * - qualifying_gap_drivers_v1: Cross-team qualifying gap
 */
export const APPROVED_SQL_TEMPLATES = [
  'driver_season_summary_v1',                    // driver_season_summary
  'driver_career_summary_v1',                    // driver_career_summary
  'driver_profile_summary_v1',                   // driver_profile_summary (TIER 2)
  'driver_trend_summary_v1',                     // driver_trend_summary (TIER 2)
  'driver_head_to_head_count_v1',                // driver_head_to_head_count (basic)
  'driver_head_to_head_count_conditional_v1',    // driver_head_to_head_count (with filters)
  'driver_performance_vector_v1',                // driver_performance_vector (PART 4)
  'driver_multi_comparison_v1',                  // driver_multi_comparison (PART 5)
  'season_driver_vs_driver_v1',                  // season_driver_vs_driver (raw pace)
  'season_driver_vs_driver_normalized_v1',       // season_driver_vs_driver (normalized %)
  'cross_team_track_scoped_driver_comparison_v1', // cross_team_track_scoped_driver_comparison
  'teammate_gap_summary_season_v1',              // teammate_gap_summary_season
  'teammate_gap_dual_comparison_v1',             // teammate_gap_dual_comparison
  'track_fastest_drivers_v1',                    // track_fastest_drivers
  'race_results_summary_v1',                     // race_results_summary
  'driver_matchup_lookup_v1',                    // driver_matchup_lookup (PART 6)
  'driver_pole_count_v1',                        // driver_pole_count (QUALIFYING)
  'driver_q3_count_v1',                          // driver_q3_count (QUALIFYING)
  'season_q3_rankings_v1',                       // season_q3_rankings (QUALIFYING)
  'qualifying_gap_teammates_v1',                 // qualifying_gap_teammates (QUALIFYING)
  'qualifying_gap_drivers_v1'                    // qualifying_gap_drivers (QUALIFYING)
] as const;

export type ApprovedSqlTemplateId = typeof APPROVED_SQL_TEMPLATES[number];
