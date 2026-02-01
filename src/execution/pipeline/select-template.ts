import { QueryIntent } from '../../types/query-intent';
import { ApprovedSqlTemplateId } from '../../types/database';
import { hasActiveFilters } from './build-params';

const TEMPLATE_MAP: Record<string, ApprovedSqlTemplateId> = {
  driver_season_summary: 'driver_season_summary_v1',
  driver_career_summary: 'driver_career_summary_v1',
  season_driver_vs_driver: 'season_driver_vs_driver_v1',
  cross_team_track_scoped_driver_comparison: 'cross_team_track_scoped_driver_comparison_v1',
  teammate_gap_summary_season: 'teammate_gap_summary_season_v1',
  teammate_gap_dual_comparison: 'teammate_gap_dual_comparison_v1',
  track_fastest_drivers: 'track_fastest_drivers_v1',
  race_results_summary: 'race_results_summary_v1',
  driver_performance_vector: 'driver_performance_vector_v1',
  driver_multi_comparison: 'driver_multi_comparison_v1',
  driver_matchup_lookup: 'driver_matchup_lookup_v1',
  driver_profile_summary: 'driver_profile_summary_v1',
  driver_trend_summary: 'driver_trend_summary_v1',
  driver_pole_count: 'driver_pole_count_v1',
  driver_q3_count: 'driver_q3_count_v1',
  season_q3_rankings: 'season_q3_rankings_v1',
  qualifying_gap_teammates: 'qualifying_gap_teammates_v1',
  qualifying_gap_drivers: 'qualifying_gap_drivers_v1'
};

export function selectTemplate(intent: QueryIntent): ApprovedSqlTemplateId {
  if (intent.kind === 'driver_head_to_head_count') {
    return selectHeadToHeadTemplate(intent);
  }

  const template = TEMPLATE_MAP[intent.kind];
  if (!template) {
    throw new Error(`No template mapping for intent kind: ${intent.kind}`);
  }

  return template;
}

function selectHeadToHeadTemplate(
  intent: Extract<QueryIntent, { kind: 'driver_head_to_head_count' }>
): ApprovedSqlTemplateId {
  if (intent.filters && hasActiveFilters(intent.filters)) {
    return 'driver_head_to_head_count_conditional_v1';
  }
  return 'driver_head_to_head_count_v1';
}
