import { QueryIntent } from '../types/query-intent';
import {
  ConversationContext,
  ContextResolutionInput,
  ContextResolutionOutput
} from './context-types';

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;
const PRONOUN_PATTERN = /\b(he|him|his|she|her|them|their)\b/i;
const TEAMMATE_PATTERN = /\bteammate\b/i;

const TEAMMATE_CONTEXT_KINDS = new Set<string>([
  'teammate_gap_summary_season',
  'season_driver_vs_driver',
  'driver_season_summary'
]);

const TRACK_CONTEXT_KINDS = new Set<string>([
  'cross_team_track_scoped_driver_comparison',
  'track_fastest_drivers'
]);

const DRIVER_CONTEXT_KINDS = new Set<string>([
  'driver_season_summary',
  'driver_career_summary',
  'season_driver_vs_driver',
  'cross_team_track_scoped_driver_comparison',
  'teammate_gap_summary_season'
]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function hasExplicitYear(question: string): boolean {
  return YEAR_PATTERN.test(question);
}

function extractDriverIds(intent: QueryIntent): string[] {
  switch (intent.kind) {
    case 'season_driver_vs_driver':
    case 'cross_team_track_scoped_driver_comparison':
      return [intent.driver_a_id, intent.driver_b_id].filter(isNonEmptyString);
    case 'driver_season_summary':
    case 'driver_career_summary':
      return isNonEmptyString(intent.driver_id) ? [intent.driver_id] : [];
    case 'teammate_gap_summary_season':
    case 'teammate_gap_dual_comparison': {
      const drivers = [intent.driver_a_id, intent.driver_b_id].filter(isNonEmptyString);
      return drivers;
    }
    case 'driver_profile_summary':
    case 'driver_trend_summary':
      return isNonEmptyString(intent.driver_id) ? [intent.driver_id] : [];
    case 'driver_head_to_head_count':
      return [intent.driver_a_id, intent.driver_b_id].filter(isNonEmptyString);
    case 'driver_performance_vector':
      return isNonEmptyString(intent.driver_id) ? [intent.driver_id] : [];
    case 'driver_multi_comparison':
      return intent.driver_ids.filter(isNonEmptyString);
    case 'driver_matchup_lookup':
      return [intent.driver_a_id, intent.driver_b_id].filter(isNonEmptyString);
    case 'track_fastest_drivers':
    case 'race_results_summary':
      return [];
    default:
      return [];
  }
}

function resolveTeammateReference(
  resolved: any,
  previous: ConversationContext | undefined
): void {
  if (!previous?.last_driver_ids || previous.last_driver_ids.length < 2) {
    return;
  }

  const [primary, teammate] = previous.last_driver_ids;
  const hasDriverA = isNonEmptyString(resolved.driver_a_id) || isNonEmptyString(resolved.driver_a_surface);
  const hasDriverB = isNonEmptyString(resolved.driver_b_id) || isNonEmptyString(resolved.driver_b_surface);
  const hasDriver = isNonEmptyString(resolved.driver_id) || isNonEmptyString(resolved.driver_surface);

  if (hasDriverA && !hasDriverB) {
    if (!isNonEmptyString(resolved.driver_a_id)) {
      return;
    }
    resolved.driver_b_id = resolved.driver_a_id === primary ? teammate : primary;
    return;
  }

  if (!hasDriverA && hasDriverB) {
    if (!isNonEmptyString(resolved.driver_b_id)) {
      return;
    }
    resolved.driver_a_id = resolved.driver_b_id === primary ? teammate : primary;
    return;
  }

  if (!hasDriverA && !hasDriverB) {
    resolved.driver_a_id = primary;
    resolved.driver_b_id = teammate;
    return;
  }

  if (!hasDriver) {
    resolved.driver_id = teammate;
  }
}

export function applyConversationContext(
  input: ContextResolutionInput
): ContextResolutionOutput {
  const { raw_question, draft_intent, previous } = input;
  const resolved: any = { ...draft_intent };

  if (resolved.kind === 'race_results_summary') {
    return {
      resolved_intent: resolved as QueryIntent,
      updated_context: previous ?? { last_query_kind: resolved.kind }
    };
  }

  const question = raw_question || '';
  const hasYear = hasExplicitYear(question);
  const hasPronoun = PRONOUN_PATTERN.test(question);
  const hasTeammate = TEAMMATE_PATTERN.test(question);

  const seasonValue = resolved.season;
  const seasonMissing =
    seasonValue === undefined ||
    seasonValue === null ||
    (typeof seasonValue === 'number' && Number.isNaN(seasonValue));

  if (seasonMissing && previous?.last_season !== null && previous?.last_season !== undefined && !hasYear) {
    resolved.season = previous.last_season;
  }

  if (hasPronoun && previous?.last_driver_ids?.[0] && DRIVER_CONTEXT_KINDS.has(resolved.kind)) {
    if (!isNonEmptyString(resolved.driver_a_id) && !isNonEmptyString(resolved.driver_a_surface)) {
      resolved.driver_a_id = previous.last_driver_ids[0];
    }
    if (!isNonEmptyString(resolved.driver_id) && !isNonEmptyString(resolved.driver_surface)) {
      resolved.driver_id = previous.last_driver_ids[0];
    }
  }

  if (hasTeammate &&
      TEAMMATE_CONTEXT_KINDS.has(previous?.last_query_kind || '') &&
      DRIVER_CONTEXT_KINDS.has(resolved.kind)) {
    resolveTeammateReference(resolved, previous);
  }

  const trackMissing =
    !isNonEmptyString(resolved.track_id) && !isNonEmptyString(resolved.track_surface);

  if (trackMissing && previous?.last_track_id && TRACK_CONTEXT_KINDS.has(resolved.kind)) {
    resolved.track_id = previous.last_track_id;
  }

  const resolvedDriverIds = extractDriverIds(resolved as QueryIntent);

  const updated_context: ConversationContext = {
    last_driver_ids: resolvedDriverIds.length > 0
      ? resolvedDriverIds.slice(0, 2)
      : previous?.last_driver_ids,
    last_track_id: isNonEmptyString(resolved.track_id) && TRACK_CONTEXT_KINDS.has(resolved.kind)
      ? resolved.track_id
      : previous?.last_track_id,
    last_season: resolved.season !== null && resolved.season !== undefined
      ? resolved.season
      : previous?.last_season,
    last_query_kind: resolved.kind
  };

  return {
    resolved_intent: resolved as QueryIntent,
    updated_context
  };
}
