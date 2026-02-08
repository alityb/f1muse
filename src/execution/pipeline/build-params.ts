import { QueryIntent, HeadToHeadFilters } from '../../types/query-intent';

export function buildParameters(intent: QueryIntent): any[] {
  switch (intent.kind) {
    case 'driver_season_summary':
      return [intent.driver_id, intent.season];

    case 'driver_career_summary':
      return [intent.driver_id];

    case 'season_driver_vs_driver':
      return [intent.driver_a_id, intent.driver_b_id, intent.season];

    case 'cross_team_track_scoped_driver_comparison':
      return [
        intent.driver_a_id,
        intent.driver_b_id,
        intent.season,
        intent.track_id,
        intent.metric,
        intent.normalization,
        intent.clean_air_only,
        intent.compound_context,
        intent.session_scope
      ];

    case 'teammate_gap_summary_season':
      return buildTeammateGapParams(intent.season, intent.driver_a_id, intent.driver_b_id);

    case 'teammate_gap_dual_comparison':
      return buildTeammateGapParams(intent.season, intent.driver_a_id, intent.driver_b_id);

    case 'track_fastest_drivers':
      return [
        intent.season,
        intent.track_id,
        intent.metric,
        intent.normalization,
        intent.clean_air_only,
        intent.compound_context,
        intent.session_scope
      ];

    case 'race_results_summary':
      return [intent.season, intent.track_id];

    case 'driver_head_to_head_count':
      return buildHeadToHeadParams(intent);

    case 'driver_performance_vector':
      return [intent.driver_id, intent.season];

    case 'driver_multi_comparison':
      return [intent.season, intent.comparison_metric, intent.driver_ids];

    case 'driver_matchup_lookup':
      return [intent.season, intent.driver_a_id, intent.driver_b_id, intent.h2h_metric];

    case 'driver_profile_summary':
      return [intent.driver_id, intent.season || new Date().getFullYear()];

    case 'driver_trend_summary':
      return buildTrendParams(intent);

    case 'driver_pole_count':
    case 'driver_q3_count':
      return [intent.season, intent.driver_id];

    case 'driver_career_pole_count':
      return [intent.driver_id];

    case 'season_q3_rankings':
      return [intent.season];

    case 'qualifying_gap_teammates':
      return buildTeammateGapParams(intent.season, intent.driver_a_id, intent.driver_b_id);

    case 'qualifying_gap_drivers':
      return [intent.season, intent.driver_a_id, intent.driver_b_id];

    case 'driver_vs_driver_comprehensive':
      return [intent.season, intent.driver_a_id, intent.driver_b_id];

    case 'driver_career_wins_by_circuit':
      return [intent.driver_id];

    case 'teammate_comparison_career':
      return [intent.driver_a_id, intent.driver_b_id];

    case 'qualifying_results_summary':
      return [intent.season, intent.track_id];

    default:
      throw new Error(`Cannot build parameters for intent kind: ${(intent as any).kind}`);
  }
}

function buildTeammateGapParams(
  season: number,
  driverAId: string | null | undefined,
  driverBId: string | null | undefined
): any[] {
  if (!driverAId || !driverBId) {
    throw new Error('Cannot resolve teammate gap parameters: driver IDs missing');
  }

  // normalize to primary/secondary order (lexicographically sorted)
  const [driverPrimaryId, driverSecondaryId] =
    driverAId < driverBId ? [driverAId, driverBId] : [driverBId, driverAId];

  return [season, driverPrimaryId, driverSecondaryId];
}

function buildHeadToHeadParams(
  intent: Extract<QueryIntent, { kind: 'driver_head_to_head_count' }>
): any[] {
  const [driverPrimaryId, driverSecondaryId] = [intent.driver_a_id, intent.driver_b_id].sort();

  if (intent.filters && hasActiveFilters(intent.filters)) {
    return [
      intent.season,
      driverPrimaryId,
      driverSecondaryId,
      intent.h2h_metric,
      intent.filters.session || null,
      intent.filters.track_type || null,
      intent.filters.weather || null,
      intent.filters.rounds?.length ? intent.filters.rounds : null,
      intent.filters.date_from || null,
      intent.filters.date_to || null,
      intent.filters.exclude_dnfs ?? false
    ];
  }

  return [intent.season, driverPrimaryId, driverSecondaryId, intent.h2h_metric];
}

function buildTrendParams(
  intent: Extract<QueryIntent, { kind: 'driver_trend_summary' }>
): any[] {
  const currentYear = new Date().getFullYear();
  return [
    intent.driver_id,
    intent.start_season || (currentYear - 3),
    intent.end_season || currentYear
  ];
}

export function hasActiveFilters(filters: HeadToHeadFilters): boolean {
  return !!(
    filters.session ||
    filters.track_type ||
    filters.weather ||
    (filters.rounds && filters.rounds.length > 0) ||
    filters.date_from ||
    filters.date_to ||
    filters.exclude_dnfs
  );
}
