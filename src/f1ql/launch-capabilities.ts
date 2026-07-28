import type { QueryIntentKind } from '../types/query-intent';

export const LEGACY_QUERY_KINDS = [
  'driver_season_summary',
  'driver_career_summary',
  'driver_profile_summary',
  'driver_trend_summary',
  'driver_head_to_head_count',
  'driver_performance_vector',
  'driver_multi_comparison',
  'driver_matchup_lookup',
  'driver_vs_driver_comprehensive',
  'driver_career_wins_by_circuit',
  'teammate_comparison_career',
  'season_driver_vs_driver',
  'cross_team_track_scoped_driver_comparison',
  'teammate_gap_summary_season',
  'teammate_gap_dual_comparison',
  'track_fastest_drivers',
  'race_results_summary',
  'driver_pole_count',
  'driver_career_pole_count',
  'driver_q3_count',
  'season_q3_rankings',
  'qualifying_gap_teammates',
  'qualifying_gap_drivers',
  'qualifying_results_summary'
] as const;

export type LegacyQueryKind = typeof LEGACY_QUERY_KINDS[number];
export type LaunchCapabilityDecision = 'port' | 'replace' | 'retire';
export const LEGACY_REMOVAL_ALLOWED = false as const;
export type LaunchAuthority = 'standings' | 'race_classification' | 'qualifying_classification' | 'event_metadata' | 'none';

export interface LaunchCapabilityDisposition {
  decision: LaunchCapabilityDecision;
  targets: readonly string[];
  authorities: readonly LaunchAuthority[];
  reason: string;
}

export const LAUNCH_CAPABILITY_DISPOSITIONS: Readonly<Record<LegacyQueryKind, LaunchCapabilityDisposition>> = Object.freeze({
  driver_season_summary: port(['driver_season_official_summary', 'current_standings'], 'standings', 'Use recorded final championship position and points or explicitly current recorded standings; do not include legacy pace proxies or partial cross-source composites.'),
  driver_career_summary: port('driver_career_official_summary', 'standings', 'Use best recorded final championship position and count of recorded final standings rows through 2025; do not imply race, qualifying, pace, or distinct-season totals.'),
  driver_profile_summary: replace('driver_season_official_summary', 'standings', 'Replace the mixed-authority profile composite with the recorded final-season championship position and points; do not imply broader profile, race, qualifying, pace, or career facts.'),
  driver_trend_summary: retire('official_trend_source_required', 'none', 'The legacy trend mixes teammate-gap products and has no reviewed longitudinal metric contract.'),
  driver_head_to_head_count: port('classification_head_to_head', ['race_classification', 'qualifying_classification'], 'Compare literal finishing or qualifying positions only over shared events where both drivers have recorded numeric positions.'),
  driver_performance_vector: retire('performance_vector_source_required', 'none', 'The vector mixes pace proxies, synthetic weather context, and percentile semantics without one authority.'),
  driver_multi_comparison: replace('official_multi_driver_ranking', 'standings', 'Replace pace-vector ranking with explicit official standings or result ranking.'),
  driver_matchup_lookup: replace('classification_head_to_head', ['race_classification', 'qualifying_classification'], 'Replace the precomputed compatibility lookup with the reviewed H2H contract.'),
  driver_vs_driver_comprehensive: replace('official_driver_comparison', ['standings', 'race_classification', 'qualifying_classification'], 'Compose official summaries and H2H without legacy pace or mixed-source claims.'),
  driver_career_wins_by_circuit: port('driver_career_wins_by_circuit', ['race_classification', 'event_metadata'], 'Count official race wins and group them by canonical circuit identity from event metadata.'),
  teammate_comparison_career: replace('classification_head_to_head', ['race_classification', 'qualifying_classification'], 'Use the same official H2H contract with an explicit shared-team filter only after team identity is reviewed.'),
  season_driver_vs_driver: replace('classification_head_to_head', ['race_classification', 'qualifying_classification'], 'Replace the ambiguous pace default with explicit race-finish or qualifying-position H2H for launch.'),
  cross_team_track_scoped_driver_comparison: replace('explicit_event_classification_comparison', ['race_classification', 'event_metadata'], 'Replace the ambiguous track pace default with one named-event official classification comparison.'),
  teammate_gap_summary_season: retire('teammate_gap_source_required', 'none', 'The legacy gap product is not equivalent to the reviewed official timing metrics.'),
  teammate_gap_dual_comparison: retire('dual_session_gap_source_required', 'none', 'Race and qualifying gap definitions do not share one reviewed factual contract.'),
  track_fastest_drivers: retire('multi_driver_official_pace_source_required', 'none', 'The legacy track ranking does not use the sealed official timing metric.'),
  race_results_summary: port('race_result_selection', ['race_classification', 'event_metadata'], 'Support full classification, winner, podium, top-N, exact position, driver, and status selection.'),
  driver_pole_count: port('driver_season_poles', 'qualifying_classification', 'Count official qualifying P1 classifications for one driver and season.'),
  driver_career_pole_count: port('driver_career_poles', 'qualifying_classification', 'Count official qualifying P1 classifications over covered career seasons.'),
  driver_q3_count: replace('driver_season_top_ten_qualifying', 'qualifying_classification', 'Replace the legacy eliminated-in-round proxy with explicit official top-ten qualifying classifications and era coverage.'),
  season_q3_rankings: replace('season_top_ten_qualifying_ranking', 'qualifying_classification', 'Replace the legacy Q3 proxy ranking with explicit official top-ten qualifying classifications and era coverage.'),
  qualifying_gap_teammates: replace('qualifying_classification_head_to_head', 'qualifying_classification', 'Replace position-to-time proxies with official qualifying-position H2H.'),
  qualifying_gap_drivers: replace('qualifying_classification_head_to_head', 'qualifying_classification', 'Use official qualifying-position H2H rather than a synthetic time gap.'),
  qualifying_results_summary: port('qualifying_result_selection', ['qualifying_classification', 'event_metadata'], 'Support full classification, pole, top-N, exact position, driver, and status selection.')
} satisfies Record<QueryIntentKind, LaunchCapabilityDisposition>);

type MissingLegacyKinds = Exclude<QueryIntentKind, LegacyQueryKind>;
type RemovedLegacyKinds = Exclude<LegacyQueryKind, QueryIntentKind>;
const exhaustiveLegacyKinds: [MissingLegacyKinds, RemovedLegacyKinds] extends [never, never] ? true : never = true;
void exhaustiveLegacyKinds;

function port(targets: string | readonly string[], authorities: LaunchAuthority | readonly LaunchAuthority[], reason: string): LaunchCapabilityDisposition {
  return { decision: 'port', targets: asTargets(targets), authorities: asAuthorities(authorities), reason };
}

function replace(targets: string | readonly string[], authorities: LaunchAuthority | readonly LaunchAuthority[], reason: string): LaunchCapabilityDisposition {
  return { decision: 'replace', targets: asTargets(targets), authorities: asAuthorities(authorities), reason };
}

function retire(targets: string | readonly string[], authorities: LaunchAuthority | readonly LaunchAuthority[], reason: string): LaunchCapabilityDisposition {
  return { decision: 'retire', targets: asTargets(targets), authorities: asAuthorities(authorities), reason };
}

function asTargets(targets: string | readonly string[]): readonly string[] {
  return Object.freeze(typeof targets === 'string' ? [targets] : [...targets]);
}

function asAuthorities(authorities: LaunchAuthority | readonly LaunchAuthority[]): readonly LaunchAuthority[] {
  return Object.freeze(typeof authorities === 'string' ? [authorities] : [...authorities]);
}
