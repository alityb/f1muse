import { AggregateNode, F1QLProgram } from './ast';
import { ANSWER_FINAL_STANDINGS_SEASONS } from './answer-templates';
import { RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID } from './race-season-finishing-position-h2h';
import { QUALIFYING_SEASON_POSITION_H2H_METRIC_ID } from './qualifying-season-position-h2h';
import { DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID, DRIVER_CAREER_WIN_SEASONS } from './driver-career-wins-by-circuit';

export const MAX_ANSWER_DRIVERS = 4;
export const FINAL_STANDINGS_THROUGH_SEASON = 2025;

export type AnswerCapabilitySource =
  | 'final_driver_standings'
  | 'current_driver_standings'
  | 'race_classification'
  | 'race_classification_event_metadata'
  | 'qualifying_classification'
  | 'race_date_metadata';

export type AnswerPolicyReason =
  | 'pace_source_disabled'
  | 'interim_standings_unsupported'
  | 'temporal_scope_unsupported'
  | 'team_filter_unsupported'
  | 'session_scope_unsupported'
  | 'entity_set_too_large'
  | 'classification_filter_combination_unsupported'
  | 'capability_unsupported';

export interface AnswerCapability {
  source: AnswerCapabilitySource;
  operation: F1QLProgram['root']['op'];
  season: number | readonly number[];
  round?: number;
  filters: Array<'driver' | 'classification_status' | 'position'>;
}

export type AnswerPolicyDecision =
  | { type: 'approved'; capability: AnswerCapability }
  | { type: 'rejected'; reason: AnswerPolicyReason };

export function authorizeAnswerProgram(program: F1QLProgram): AnswerPolicyDecision {
  const root = program.root;
  if (root.op === 'pace_summary' || root.op === 'pace_delta') {
    return { type: 'rejected', reason: 'pace_source_disabled' };
  }
  if (root.op === 'official_lap_window_median_compare' || root.op === 'official_event_mean_compare') {
    return { type: 'rejected', reason: 'capability_unsupported' };
  }
  if (root.op === 'driver_career_wins_by_circuit') {
    const valid = Object.keys(root).sort().join(',') === 'driver_id,metric,op,seasons' && root.metric === DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID &&
      JSON.stringify(root.seasons) === JSON.stringify(DRIVER_CAREER_WIN_SEASONS) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(root.driver_id) && root.driver_id.length <= 100;
    return valid ? { type: 'approved', capability: { source: 'race_classification_event_metadata', operation: root.op, season: root.seasons, filters: ['driver'] } }
      : { type: 'rejected', reason: 'capability_unsupported' };
  }
  if (root.op === 'race_season_finishing_position_h2h') {
    return authorizeRaceSeasonH2H(root);
  }
  if (root.op === 'qualifying_season_position_h2h') {
    return authorizeQualifyingSeasonH2H(root);
  }
  if (root.op === 'event_classification') {
    return authorizeClassification(root, 'race_classification');
  }
  if (root.op === 'qualifying_classification') {
    return authorizeClassification(root, 'qualifying_classification');
  }
  if (root.op === 'event_metadata') {
    if (root.session_scope !== undefined && root.session_scope !== 'race') {
      return { type: 'rejected', reason: 'session_scope_unsupported' };
    }
    return {
      type: 'approved',
      capability: { source: 'race_date_metadata', operation: root.op, season: root.season, round: root.round, filters: [] }
    };
  }
  if (root.op === 'aggregate') {
    return authorizeStandings(root, root.op);
  }
  if (root.op === 'rank') {
    return authorizeStandings(root.input, root.op, root);
  }
  return { type: 'rejected', reason: 'capability_unsupported' };
}

function authorizeQualifyingSeasonH2H(root: Extract<F1QLProgram['root'], { op: 'qualifying_season_position_h2h' }>): AnswerPolicyDecision {
  if (!validSeasonH2HRoot(root, QUALIFYING_SEASON_POSITION_H2H_METRIC_ID)) {
    return { type: 'rejected', reason: 'capability_unsupported' };
  }
  return {
    type: 'approved',
    capability: { source: 'qualifying_classification', operation: root.op, season: root.season, filters: ['driver'] }
  };
}

function authorizeRaceSeasonH2H(root: Extract<F1QLProgram['root'], { op: 'race_season_finishing_position_h2h' }>): AnswerPolicyDecision {
  if (!validSeasonH2HRoot(root, RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID)) {
    return { type: 'rejected', reason: 'capability_unsupported' };
  }
  return {
    type: 'approved',
    capability: { source: 'race_classification', operation: root.op, season: root.season, filters: ['driver'] }
  };
}

function validSeasonH2HRoot(
  root: Extract<F1QLProgram['root'], { op: 'race_season_finishing_position_h2h' | 'qualifying_season_position_h2h' }>,
  metric: string
): boolean {
  return Object.keys(root).sort().join(',') === 'driver_a_id,driver_b_id,metric,op,season' &&
      root.metric === metric && Number.isSafeInteger(root.season) &&
      root.season >= 1950 && root.season <= FINAL_STANDINGS_THROUGH_SEASON &&
      typeof root.driver_a_id === 'string' && typeof root.driver_b_id === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(root.driver_a_id) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(root.driver_b_id) &&
      root.driver_a_id.length <= 100 && root.driver_b_id.length <= 100 && root.driver_a_id !== root.driver_b_id;
}

function authorizeClassification(
  root: Extract<F1QLProgram['root'], { op: 'event_classification' | 'qualifying_classification' }>,
  source: 'race_classification' | 'qualifying_classification'
): AnswerPolicyDecision {
  if (root.filters?.team_id !== undefined) {
    return { type: 'rejected', reason: 'team_filter_unsupported' };
  }
  const hasDriver = root.filters?.driver_id !== undefined;
  const statuses = root.filters?.classification_status;
  const hasPosition = root.op === 'event_classification'
    ? root.filters?.finishing_position !== undefined
    : root.filters?.qualifying_position !== undefined;
  const positions = root.op === 'event_classification'
    ? root.filters?.finishing_position
    : root.filters?.qualifying_position;
  if ([hasDriver, statuses !== undefined, hasPosition].filter(Boolean).length > 1 || (statuses?.length ?? 0) > 1) {
    return { type: 'rejected', reason: 'classification_filter_combination_unsupported' };
  }
  if (positions !== undefined && positions.length !== root.limit) {
    return { type: 'rejected', reason: 'classification_filter_combination_unsupported' };
  }
  const filters: AnswerCapability['filters'] = [];
  if (hasDriver) {
    filters.push('driver');
  }
  if (root.filters?.classification_status !== undefined) {
    filters.push('classification_status');
  }
  if (hasPosition) {
    filters.push('position');
  }
  return {
    type: 'approved',
    capability: { source, operation: root.op, season: root.season, round: root.round, filters }
  };
}

function authorizeStandings(aggregate: AggregateNode, operation: 'aggregate' | 'rank', rank?: Extract<F1QLProgram['root'], { op: 'rank' }>): AnswerPolicyDecision {
  if (aggregate.input.op !== 'filter') {
    return { type: 'rejected', reason: 'temporal_scope_unsupported' };
  }
  if (isDriverCareerOfficialSummary(aggregate, operation)) {
    return {
      type: 'approved',
      capability: { source: 'final_driver_standings', operation, season: ANSWER_FINAL_STANDINGS_SEASONS, filters: ['driver'] }
    };
  }
  if (typeof aggregate.input.where.season !== 'number') {
    return { type: 'rejected', reason: 'temporal_scope_unsupported' };
  }
  if (isFinalDriverRanking(aggregate, operation, rank)) {
    return {
      type: 'approved',
      capability: { source: 'final_driver_standings', operation, season: aggregate.input.where.season, filters: ['driver'] }
    };
  }
  if (aggregate.input.where.season > FINAL_STANDINGS_THROUGH_SEASON) {
    if (isCurrentStandings(aggregate, rank)) {
      return {
        type: 'approved',
        capability: { source: 'current_driver_standings', operation, season: aggregate.input.where.season, filters: [] }
      };
    }
    return { type: 'rejected', reason: 'interim_standings_unsupported' };
  }
  const summaryLike = aggregate.input.where.driver_id !== undefined
    && aggregate.measures.some(measure => measure.as === 'championship_position' || measure.as === 'standing_rows' || measure.function === 'count');
  if (summaryLike && !isDriverSeasonOfficialSummary(aggregate, operation)) {
    return { type: 'rejected', reason: 'capability_unsupported' };
  }
  const driverId = aggregate.input.where.driver_id;
  let driverCount = 0;
  if (driverId !== undefined) {
    driverCount = Array.isArray(driverId) ? driverId.length : 1;
  }
  if (driverCount > MAX_ANSWER_DRIVERS) {
    return { type: 'rejected', reason: 'entity_set_too_large' };
  }
  return {
    type: 'approved',
    capability: {
      source: 'final_driver_standings',
      operation,
      season: aggregate.input.where.season,
      filters: driverCount === 0 ? [] : ['driver']
    }
  };
}

function isFinalDriverRanking(aggregate: AggregateNode, operation: 'aggregate' | 'rank', rank: Extract<F1QLProgram['root'], { op: 'rank' }> | undefined): boolean {
  const driverIds = aggregate.input.op === 'filter' ? aggregate.input.where.driver_id : undefined;
  const rankingSeason = aggregate.input.op === 'filter' ? aggregate.input.where.season : undefined;
  if (operation !== 'rank' || !rank || aggregate.input.op !== 'filter' || aggregate.input.input.op !== 'source' || aggregate.input.input.source !== 'standings' ||
      typeof rankingSeason !== 'number' || !ANSWER_FINAL_STANDINGS_SEASONS.includes(rankingSeason) ||
      !Array.isArray(driverIds) || driverIds.length !== 3 || new Set(driverIds).size !== 3 || driverIds.some(id => id.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) ||
      Object.keys(aggregate.input.where).length !== 2 ||
      aggregate.group_by.length !== 1 || aggregate.group_by[0] !== 'driver_id' || rank.by !== 'championship_position' || rank.direction !== 'asc' || rank.limit !== 3) {
    return false;
  }
  return aggregate.measures.length === 2
    && aggregate.measures[0].as === 'championship_position' && aggregate.measures[0].function === 'min' && aggregate.measures[0].field === 'championship_position'
    && aggregate.measures[1].as === 'standing_rows' && aggregate.measures[1].function === 'count' && aggregate.measures[1].field === undefined;
}

function isDriverCareerOfficialSummary(aggregate: AggregateNode, operation: 'aggregate' | 'rank'): boolean {
  if (operation !== 'aggregate' || aggregate.input.op !== 'filter' || typeof aggregate.input.where.driver_id !== 'string' ||
      aggregate.input.input.op !== 'source' || aggregate.input.input.source !== 'standings' ||
      Object.keys(aggregate.input.where).length !== 2 || !sameSeasons(aggregate.input.where.season, ANSWER_FINAL_STANDINGS_SEASONS) ||
      aggregate.group_by.length !== 1 || aggregate.group_by[0] !== 'driver_id') {
    return false;
  }
  return aggregate.measures.length === 2
    && aggregate.measures[0].as === 'best_championship_position' && aggregate.measures[0].function === 'min' && aggregate.measures[0].field === 'championship_position'
    && aggregate.measures[1].as === 'recorded_final_standings_rows' && aggregate.measures[1].function === 'count' && aggregate.measures[1].field === undefined;
}

function sameSeasons(value: number | number[] | undefined, expected: readonly number[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((season, index) => season === expected[index]);
}

function isDriverSeasonOfficialSummary(aggregate: AggregateNode, operation: 'aggregate' | 'rank'): boolean {
  if (operation !== 'aggregate' || aggregate.input.op !== 'filter' || typeof aggregate.input.where.driver_id !== 'string' ||
      Object.keys(aggregate.input.where).length !== 2 || aggregate.group_by.length !== 1 || aggregate.group_by[0] !== 'driver_id') {
    return false;
  }
  return aggregate.measures.length === 3
    && aggregate.measures[0].as === 'championship_position' && aggregate.measures[0].function === 'min' && aggregate.measures[0].field === 'championship_position'
    && aggregate.measures[1].as === 'points' && aggregate.measures[1].function === 'max' && aggregate.measures[1].field === 'points'
    && aggregate.measures[2].as === 'standing_rows' && aggregate.measures[2].function === 'count' && aggregate.measures[2].field === undefined;
}

function isCurrentStandings(aggregate: AggregateNode, rank: Extract<F1QLProgram['root'], { op: 'rank' }> | undefined): boolean {
  if (!rank || aggregate.input.op !== 'filter' || aggregate.input.where.season !== 2026 ||
      Object.keys(aggregate.input.where).length !== 1 || aggregate.group_by.length !== 1 || aggregate.group_by[0] !== 'driver_id' ||
      rank.by !== 'championship_position' || rank.direction !== 'asc' || rank.limit !== 30) {
    return false;
  }
  return aggregate.measures.length === 2
    && aggregate.measures[0].as === 'championship_position' && aggregate.measures[0].function === 'min' && aggregate.measures[0].field === 'championship_position'
    && aggregate.measures[1].as === 'points' && aggregate.measures[1].function === 'max' && aggregate.measures[1].field === 'points';
}
