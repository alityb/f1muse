export const CAPABILITIES_DATA = {
  supported_query_kinds: [
    {
      kind: 'driver_season_summary',
      status: 'supported',
      description: 'Single driver season statistics',
      tier: 'TIER 1',
      required_fields: ['season', 'driver_id'],
      optional_fields: ['metric', 'normalization', 'clean_air_only', 'compound_context', 'session_scope'],
      normalization: 'none',
      output_fields: ['wins', 'podiums', 'dnfs', 'race_count', 'avg_race_pace']
    },
    {
      kind: 'driver_career_summary',
      status: 'supported',
      description: 'Career-spanning statistics for a single driver',
      tier: 'TIER 1',
      required_fields: ['driver_id'],
      optional_fields: [],
      normalization: 'none',
      output_fields: ['championships', 'seasons_raced', 'career_podiums', 'career_wins', 'total_race_entries']
    },
    {
      kind: 'season_driver_vs_driver',
      status: 'supported',
      description: 'Cross-team season comparison (raw pace only)',
      tier: 'TIER 1',
      required_fields: ['season', 'driver_a_id', 'driver_b_id'],
      optional_fields: ['metric', 'normalization', 'clean_air_only', 'compound_context', 'session_scope'],
      normalization: 'none',
      constraints: ['Raw pace only', 'No baseline normalization', 'Cross-team comparison']
    },
    {
      kind: 'cross_team_track_scoped_driver_comparison',
      status: 'supported',
      description: 'Track-scoped comparison between two drivers (raw pace)',
      tier: 'TIER 1',
      required_fields: ['season', 'track_id', 'driver_a_id', 'driver_b_id'],
      optional_fields: ['metric', 'normalization', 'clean_air_only', 'compound_context', 'session_scope'],
      normalization: 'none',
      constraints: ['Raw pace only', 'Track-bounded']
    },
    {
      kind: 'teammate_gap_summary_season',
      status: 'supported',
      description: 'Full-season teammate gap analysis (PRIMARY performance metric)',
      tier: 'TIER 1',
      required_fields: ['season', 'driver_a_id', 'driver_b_id'],
      optional_fields: ['team_id'],
      supports_team_only_resolution: true,
      normalization: 'team_baseline',
      constraints: [
        'Requires valid teammate pair (same team, same season)',
        'Uses median lap-time gap',
        'Minimum 4 shared races for low_coverage, 8 for valid'
      ],
      output_fields: ['gap_percent', 'gap_seconds', 'shared_races', 'faster_driver_count', 'coverage_status']
    },
    {
      kind: 'teammate_gap_dual_comparison',
      status: 'supported',
      description: 'Qualifying vs race pace teammate gap comparison',
      tier: 'TIER 1',
      required_fields: ['season', 'driver_a_id', 'driver_b_id'],
      optional_fields: ['team_id'],
      supports_team_only_resolution: true,
      normalization: 'team_baseline',
      constraints: [
        'Qualifying gap uses highest shared session (Q3>Q2>Q1)',
        'Race pace gap uses median race lap times',
        'Partial results allowed when one metric available'
      ],
      output_fields: ['qualifying_gap_percent', 'qualifying_gap_seconds', 'race_gap_percent', 'race_gap_seconds', 'same_winner', 'advantage_area']
    },
    {
      kind: 'track_fastest_drivers',
      status: 'supported',
      description: 'Rank all drivers at a specific track',
      tier: 'TIER 1',
      required_fields: ['season', 'track_id'],
      optional_fields: ['metric', 'normalization', 'clean_air_only', 'compound_context', 'session_scope'],
      normalization: 'none'
    },
    {
      kind: 'race_results_summary',
      status: 'supported',
      description: 'Official F1 race results from F1DB (no pace metrics)',
      tier: 'TIER 1',
      required_fields: ['season', 'track_id'],
      optional_fields: [],
      normalization: 'none',
      output_fields: ['podium', 'top10', 'laps_completed', 'winner_time', 'fastest_lap']
    },
    {
      kind: 'driver_profile_summary',
      status: 'supported',
      description: 'Comprehensive driver profile with career stats, best/worst tracks, and trends',
      tier: 'TIER 2',
      required_fields: ['driver_id'],
      optional_fields: ['season'],
      normalization: 'none',
      output_fields: ['career', 'best_tracks', 'worst_tracks', 'latest_season_teammate', 'trend', 'percentiles'],
      notes: 'Available via POST /query or GET /driver/:driver_id/profile'
    },
    {
      kind: 'driver_trend_summary',
      status: 'supported',
      description: 'Multi-season performance trend analysis (improvement/decline)',
      tier: 'TIER 2',
      required_fields: ['driver_id'],
      optional_fields: ['start_season', 'end_season'],
      normalization: 'team_baseline',
      output_fields: ['seasons_analyzed', 'season_data', 'slope_per_season', 'volatility', 'r_squared', 'classification'],
      constraints: ['Default: 3 seasons back to current', 'Uses teammate gap as performance metric', 'Classification: improving | declining | stable'],
      notes: 'Available via POST /query or GET /driver/:driver_id/trend'
    },
    {
      kind: 'driver_head_to_head_count',
      status: 'supported',
      description: 'Position-based head-to-head comparison (qualifying or race finish)',
      tier: 'ADVANCED',
      required_fields: ['season', 'driver_a_id', 'driver_b_id', 'h2h_metric', 'h2h_scope'],
      optional_fields: ['filters'],
      supports_conditional_filters: true,
      available_filters: ['session (Q1, Q2, Q3, race)', 'track_type (street, permanent)', 'weather (dry, wet)', 'rounds (specific round numbers)', 'date_from / date_to', 'exclude_dnfs'],
      h2h_metrics: ['qualifying_position', 'race_finish_position'],
      h2h_scopes: ['field', 'teammate'],
      output_fields: ['driver_a_wins', 'driver_b_wins', 'ties', 'shared_events', 'win_percentage']
    },
    {
      kind: 'driver_performance_vector',
      status: 'supported',
      description: 'Cross-metric performance profile (qualifying, race pace, consistency)',
      tier: 'ADVANCED',
      required_fields: ['season', 'driver_id'],
      optional_fields: [],
      output_fields: ['qualifying_percentile', 'race_pace_percentile', 'consistency_score', 'street_delta', 'wet_delta'],
      constraints: ['Percentiles: 0-100 (100 = fastest)', 'Consistency: 100 = most consistent', 'Deltas: negative = faster than grid median']
    },
    {
      kind: 'driver_multi_comparison',
      status: 'supported',
      description: 'Compare 2-6 drivers on a single metric',
      tier: 'ADVANCED',
      required_fields: ['season', 'driver_ids', 'comparison_metric'],
      optional_fields: [],
      comparison_metrics: ['avg_true_pace', 'qualifying_pace', 'consistency'],
      constraints: ['Minimum 2 drivers', 'Maximum 6 drivers', 'Returns ranked comparison'],
      output_fields: ['ranked_drivers', 'metric_values', 'gaps_to_leader']
    },
    {
      kind: 'driver_matchup_lookup',
      status: 'supported',
      description: 'Fast head-to-head lookup from precomputed matrix',
      tier: 'ADVANCED',
      required_fields: ['season', 'driver_a_id', 'driver_b_id', 'h2h_metric'],
      optional_fields: [],
      h2h_metrics: ['qualifying_position', 'race_finish_position'],
      output_fields: ['driver_a_wins', 'driver_b_wins', 'ties', 'shared_events', 'coverage_status'],
      notes: 'Uses precomputed driver_matchup_matrix for faster response'
    },
    {
      kind: 'driver_pole_count',
      status: 'supported',
      description: 'Count pole positions for a driver in a season',
      tier: 'QUALIFYING',
      required_fields: ['season', 'driver_id'],
      optional_fields: [],
      output_fields: ['pole_count', 'total_sessions', 'pole_rate_percent', 'front_row_count', 'top_3_count', 'avg_qualifying_position', 'best_qualifying_position']
    },
    {
      kind: 'driver_q3_count',
      status: 'supported',
      description: 'Count Q3 appearances for a driver in a season',
      tier: 'QUALIFYING',
      required_fields: ['season', 'driver_id'],
      optional_fields: [],
      output_fields: ['q3_appearances', 'q2_eliminations', 'q1_eliminations', 'total_sessions', 'q3_rate_percent', 'avg_qualifying_position']
    },
    {
      kind: 'season_q3_rankings',
      status: 'supported',
      description: 'Rank all drivers by Q3 appearances in a season',
      tier: 'QUALIFYING',
      required_fields: ['season'],
      optional_fields: [],
      output_fields: ['rank', 'driver_id', 'team_id', 'q3_appearances', 'q3_rate_percent', 'pole_count', 'avg_qualifying_position']
    },
    {
      kind: 'qualifying_gap_teammates',
      status: 'supported',
      description: 'Qualifying time gap between teammates',
      tier: 'QUALIFYING',
      required_fields: ['season', 'driver_a_id', 'driver_b_id'],
      optional_fields: ['team_id'],
      normalization: 'team_baseline',
      constraints: ['Comparison uses deepest common round (Q3 > Q2 > Q1)', 'If times unavailable, uses 250ms per position proxy', 'Requires same-team constraint'],
      output_fields: ['gap_percent', 'gap_seconds', 'shared_races', 'primary_wins', 'secondary_wins', 'ties', 'coverage_status']
    },
    {
      kind: 'qualifying_gap_drivers',
      status: 'supported',
      description: 'Qualifying position gap between any two drivers',
      tier: 'QUALIFYING',
      required_fields: ['season', 'driver_a_id', 'driver_b_id'],
      optional_fields: [],
      normalization: 'none',
      constraints: ['Position-based comparison (not time-based)', 'Works for cross-team comparisons'],
      output_fields: ['avg_position_gap', 'shared_sessions', 'primary_wins', 'secondary_wins', 'ties', 'primary_avg_position', 'secondary_avg_position', 'coverage_status']
    }
  ],
  approved_metrics: [
    { metric: 'avg_true_pace', description: 'Average true pace in seconds (lower is faster)', ranking_basis: 'lower_is_faster', typical_context: 'track-scoped queries' },
    { metric: 'clean_air_pace', description: 'Average pace in clean air only', ranking_basis: 'lower_is_faster', requires: 'clean_air_only=true' },
    { metric: 'teammate_gap_raw', description: 'Season-level teammate gap (median lap-time difference)', ranking_basis: 'lower_is_faster', typical_context: 'teammate_gap_summary_season', constraints: ['Signed gap: primary - secondary (negative = primary faster)', 'Track-length invariant'] },
    { metric: 'teammate_gap_dual', description: 'Dual comparison: qualifying gap vs race pace gap', ranking_basis: 'contextual', typical_context: 'teammate_gap_dual_comparison' }
  ],
  normalization_strategies: [
    { normalization: 'team_baseline', description: 'Teammate-relative performance (gap to teammate)', used_by: ['teammate_gap_summary_season', 'teammate_gap_dual_comparison', 'driver_trend_summary'] },
    { normalization: 'none', description: 'No normalization (track-bounded raw pace)', used_by: ['driver_season_summary', 'driver_career_summary', 'season_driver_vs_driver', 'cross_team_track_scoped_driver_comparison', 'track_fastest_drivers', 'race_results_summary', 'driver_profile_summary'] }
  ],
  semantic_safety: {
    rejected_patterns: ['cross-season comparisons', 'latent multi-track aggregations (e.g., "all tracks", "street circuits")', 'inferred track groups without explicit track_ids'],
    guidance: 'All comparisons must be scoped to a single season with explicit identities'
  },
  system_info: { total_query_kinds: 19, supported_query_kinds: 19, partial_query_kinds: 0, api_version: '1.1.0' }
};

export const SUGGESTIONS_DATA = {
  categories: [
    {
      id: 'teammate_comparisons',
      display_name: 'Teammate Comparisons',
      description: 'Compare drivers on the same team',
      suggestions: [
        { query_kind: 'teammate_gap_summary_season', text: 'Verstappen vs Perez 2024 teammate gap', description: 'Full season teammate gap analysis' },
        { query_kind: 'teammate_gap_dual_comparison', text: 'Norris vs Piastri 2024 qualifying and race pace', description: 'Qualifying and race pace comparison' },
        { query_kind: 'teammate_gap_summary_season', text: 'Hamilton vs Russell 2024 season comparison', description: 'Season-long performance gap' },
        { query_kind: 'teammate_gap_dual_comparison', text: 'Leclerc vs Sainz 2023 qualifying vs race', description: 'Dual comparison across sessions' }
      ]
    },
    {
      id: 'driver_vs_driver',
      display_name: 'Driver vs Driver',
      description: 'Compare any two drivers head-to-head',
      suggestions: [
        { query_kind: 'season_driver_vs_driver', text: 'Verstappen vs Norris 2024 season pace', description: 'Cross-team season comparison' },
        { query_kind: 'cross_team_track_scoped_driver_comparison', text: 'Hamilton vs Alonso at Silverstone 2024', description: 'Track-specific driver comparison' },
        { query_kind: 'driver_head_to_head_count', text: 'Norris vs Leclerc 2024 qualifying head-to-head', description: 'Position-based head-to-head count' },
        { query_kind: 'driver_head_to_head_count', text: 'Verstappen vs Hamilton 2024 race finishes on street circuits', description: 'Filtered head-to-head with track type' },
        { query_kind: 'driver_matchup_lookup', text: 'Verstappen vs Hamilton 2024 head-to-head', description: 'Fast precomputed matchup lookup' }
      ]
    },
    {
      id: 'driver_performance',
      display_name: 'Driver Performance',
      description: 'Individual driver statistics and trends',
      suggestions: [
        { query_kind: 'driver_season_summary', text: 'Verstappen 2024 season statistics', description: 'Single season performance summary' },
        { query_kind: 'driver_career_summary', text: 'Hamilton career statistics', description: 'Career-spanning achievements' },
        { query_kind: 'driver_profile_summary', text: 'Norris driver profile 2024', description: 'Comprehensive driver profile' },
        { query_kind: 'driver_trend_summary', text: 'Leclerc performance trend 2021-2024', description: 'Multi-season performance trends' },
        { query_kind: 'driver_performance_vector', text: 'Piastri 2024 performance metrics', description: 'Cross-metric performance profile' },
        { query_kind: 'driver_performance_vector', text: 'Alonso 2024 qualifying and race percentiles', description: 'Percentile rankings across metrics' }
      ]
    },
    {
      id: 'track_analysis',
      display_name: 'Track Performance',
      description: 'Track-specific driver rankings and comparisons',
      suggestions: [
        { query_kind: 'track_fastest_drivers', text: 'Fastest drivers at Monaco 2024', description: 'Rank all drivers at a specific track' },
        { query_kind: 'cross_team_track_scoped_driver_comparison', text: 'Verstappen vs Norris at Spa 2024', description: 'Head-to-head at specific track' }
      ]
    },
    {
      id: 'multi_driver_rankings',
      display_name: 'Multi-Driver Rankings',
      description: 'Compare and rank 3-6 drivers simultaneously',
      suggestions: [
        { query_kind: 'driver_multi_comparison', text: 'Compare Verstappen, Norris, and Leclerc 2024', description: 'Three-way driver comparison' },
        { query_kind: 'driver_multi_comparison', text: 'Rank Hamilton, Russell, Sainz, and Alonso 2024 by race pace', description: 'Four-driver ranking by metric' }
      ]
    },
    {
      id: 'race_results',
      display_name: 'Race Results',
      description: 'Official F1 race results and standings',
      suggestions: [
        { query_kind: 'race_results_summary', text: 'Monaco 2024 race results', description: 'Official race results' },
        { query_kind: 'race_results_summary', text: 'Silverstone 2024 race winner and podium', description: 'Race winner and podium' },
        { query_kind: 'race_results_summary', text: 'Abu Dhabi 2024 race classification', description: 'Complete race classification' }
      ]
    },
    {
      id: 'advanced_analysis',
      display_name: 'Advanced Analysis',
      description: 'Complex head-to-head and matchup queries',
      suggestions: [
        { query_kind: 'driver_head_to_head_count', text: 'Russell vs Sainz 2024 race finishes excluding DNFs', description: 'Head-to-head with DNF exclusion' },
        { query_kind: 'driver_matchup_lookup', text: 'Norris vs Piastri 2024 qualifying matchup', description: 'Precomputed qualifying head-to-head' },
        { query_kind: 'driver_performance_vector', text: 'Leclerc 2024 street circuit performance', description: 'Context-specific performance analysis' }
      ]
    },
    {
      id: 'qualifying',
      display_name: 'Qualifying Analysis',
      description: 'Qualifying statistics, poles, and Q3 appearances',
      suggestions: [
        { query_kind: 'driver_pole_count', text: 'How many poles did Verstappen get in 2024?', description: 'Pole position count for a driver' },
        { query_kind: 'driver_pole_count', text: 'Norris pole positions 2025', description: 'Season pole count with details' },
        { query_kind: 'driver_q3_count', text: 'How many times did Sainz make Q3 in 2024?', description: 'Q3 appearance count' },
        { query_kind: 'season_q3_rankings', text: 'Q3 rankings 2024', description: 'Rank all drivers by Q3 appearances' },
        { query_kind: 'qualifying_gap_teammates', text: 'Qualifying gap between Norris and Piastri 2024', description: 'Teammate qualifying comparison' },
        { query_kind: 'qualifying_gap_teammates', text: 'Who outqualified whom, Verstappen or Perez 2024?', description: 'Teammate qualifying head-to-head' },
        { query_kind: 'qualifying_gap_drivers', text: 'Qualifying positions Verstappen vs Leclerc 2024', description: 'Cross-team qualifying comparison' },
        { query_kind: 'qualifying_gap_drivers', text: 'Who qualifies higher, Norris or Hamilton 2024?', description: 'Cross-team qualifying head-to-head' }
      ]
    }
  ],
  metadata: { total_categories: 8, total_suggestions: 36, supported_query_kinds: 19 }
};
