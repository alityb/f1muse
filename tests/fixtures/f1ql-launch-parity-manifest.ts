import type { LegacyQueryKind } from '../../src/f1ql/launch-capabilities';

export interface LaunchParityCase {
  id: string;
  legacy_kind: LegacyQueryKind;
  question: string;
  expected_decision: 'answer' | 'clarify' | 'abstain';
  target: string;
  implementation: 'pending' | 'contracted';
}

export const launchParityManifest: readonly LaunchParityCase[] = [
  contracted('season-summary', 'driver_season_summary', 'Show Max Verstappen official 2025 season summary.', 'driver_season_official_summary'),
  contracted('current-standings', 'driver_season_summary', 'Show the latest recorded 2026 driver standings.', 'current_standings'),
  contracted('career-summary', 'driver_career_summary', 'Show Lewis Hamilton official career summary.', 'driver_career_official_summary'),
  answer('profile-replacement', 'driver_profile_summary', 'Show Lando Norris official 2025 driver summary.', 'driver_official_summary'),
  abstain('trend-retired', 'driver_trend_summary', 'Is Charles Leclerc improving across recent seasons?', 'official_trend_source_required'),
  answer('race-h2h', 'driver_head_to_head_count', 'Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?', 'classification_head_to_head'),
  abstain('vector-retired', 'driver_performance_vector', 'Show Oscar Piastri performance vector in 2025.', 'performance_vector_source_required'),
  answer('multi-ranking-replacement', 'driver_multi_comparison', 'Rank Verstappen, Norris, and Piastri by final 2025 championship position.', 'official_multi_driver_ranking'),
  answer('matchup-replacement', 'driver_matchup_lookup', 'Who outqualified whom more often in 2025, Norris or Piastri?', 'classification_head_to_head'),
  answer('comprehensive-replacement', 'driver_vs_driver_comprehensive', 'Compare the official 2025 results of Norris and Piastri.', 'official_driver_comparison'),
  answer('career-wins', 'driver_career_wins_by_circuit', 'At which circuits has Lewis Hamilton won races?', 'driver_career_wins_by_circuit'),
  clarify('teammate-career-replacement', 'teammate_comparison_career', 'Compare Hamilton and Russell over their teammate seasons.', 'classification_head_to_head'),
  clarify('season-pace-replacement', 'season_driver_vs_driver', 'Compare Verstappen and Norris in 2025.', 'classification_head_to_head'),
  answer('event-pace-replacement', 'cross_team_track_scoped_driver_comparison', 'Who finished ahead, Verstappen or Norris, at Silverstone 2025?', 'explicit_event_classification_comparison'),
  abstain('teammate-gap-retired', 'teammate_gap_summary_season', 'Show the 2025 teammate pace gap for Norris and Piastri.', 'teammate_gap_source_required'),
  abstain('dual-gap-retired', 'teammate_gap_dual_comparison', 'Compare Norris and Piastri qualifying and race pace gaps.', 'dual_session_gap_source_required'),
  abstain('track-fastest-retired', 'track_fastest_drivers', 'Rank the fastest drivers at Monaco in 2025.', 'multi_driver_official_pace_source_required'),
  contracted('race-winner', 'race_results_summary', 'Who won the 2025 Australian Grand Prix?', 'race_result_selection'),
  contracted('race-podium', 'race_results_summary', 'Show the podium for the 2025 Australian Grand Prix.', 'race_result_selection'),
  contracted('race-top-five', 'race_results_summary', 'Show the top five finishers at the 2025 Australian Grand Prix.', 'race_result_selection'),
  contracted('race-second', 'race_results_summary', 'Who finished second at the 2025 Australian Grand Prix?', 'race_result_selection'),
  answer('season-poles', 'driver_pole_count', 'How many poles did Lando Norris take in 2025?', 'driver_season_poles'),
  answer('career-poles', 'driver_career_pole_count', 'How many career poles does Lewis Hamilton have?', 'driver_career_poles'),
  answer('season-q3', 'driver_q3_count', 'How many times did Lando Norris qualify in the top ten in 2025?', 'driver_season_top_ten_qualifying'),
  answer('q3-ranking', 'season_q3_rankings', 'Rank drivers by top-ten qualifying appearances in 2025.', 'season_top_ten_qualifying_ranking'),
  answer('qualifying-h2h-teammates', 'qualifying_gap_teammates', 'Who outqualified whom more often in 2025, Norris or Piastri?', 'qualifying_classification_head_to_head'),
  answer('qualifying-h2h-drivers', 'qualifying_gap_drivers', 'Who qualified ahead more often in 2025, Norris or Verstappen?', 'qualifying_classification_head_to_head'),
  contracted('qualifying-pole', 'qualifying_results_summary', 'Who took pole at the 2025 Australian Grand Prix?', 'qualifying_result_selection'),
  contracted('qualifying-top-five', 'qualifying_results_summary', 'Show the top five qualifiers at the 2025 Australian Grand Prix.', 'qualifying_result_selection'),
  contracted('qualifying-third', 'qualifying_results_summary', 'Who qualified third at the 2025 Australian Grand Prix?', 'qualifying_result_selection')
];

function answer(id: string, legacy_kind: LegacyQueryKind, question: string, target: string): LaunchParityCase {
  return { id, legacy_kind, question, expected_decision: 'answer', target, implementation: 'pending' };
}

function contracted(id: string, legacy_kind: LegacyQueryKind, question: string, target: string): LaunchParityCase {
  return { id, legacy_kind, question, expected_decision: 'answer', target, implementation: 'contracted' };
}

function clarify(id: string, legacy_kind: LegacyQueryKind, question: string, target: string): LaunchParityCase {
  return { id, legacy_kind, question, expected_decision: 'clarify', target, implementation: 'pending' };
}

function abstain(id: string, legacy_kind: LegacyQueryKind, question: string, target: string): LaunchParityCase {
  return { id, legacy_kind, question, expected_decision: 'abstain', target, implementation: 'pending' };
}
