import { AggregateNode, F1QLProgram } from './ast';

export const MAX_ANSWER_DRIVERS = 4;
export const FINAL_STANDINGS_THROUGH_SEASON = 2025;

export type AnswerCapabilitySource =
  | 'final_driver_standings'
  | 'race_classification'
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
  season: number;
  round?: number;
  filters: Array<'driver' | 'classification_status'>;
}

export type AnswerPolicyDecision =
  | { type: 'approved'; capability: AnswerCapability }
  | { type: 'rejected'; reason: AnswerPolicyReason };

export function authorizeAnswerProgram(program: F1QLProgram): AnswerPolicyDecision {
  const root = program.root;
  if (root.op === 'pace_summary' || root.op === 'pace_delta') {
    return { type: 'rejected', reason: 'pace_source_disabled' };
  }
  if (root.op === 'official_lap_window_median_compare') {
    return { type: 'rejected', reason: 'capability_unsupported' };
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
    return authorizeStandings(root.input, root.op);
  }
  return { type: 'rejected', reason: 'capability_unsupported' };
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
  if ((hasDriver && statuses !== undefined) || (statuses?.length ?? 0) > 1) {
    return { type: 'rejected', reason: 'classification_filter_combination_unsupported' };
  }
  const filters: AnswerCapability['filters'] = [];
  if (hasDriver) {
    filters.push('driver');
  }
  if (root.filters?.classification_status !== undefined) {
    filters.push('classification_status');
  }
  return {
    type: 'approved',
    capability: { source, operation: root.op, season: root.season, round: root.round, filters }
  };
}

function authorizeStandings(aggregate: AggregateNode, operation: 'aggregate' | 'rank'): AnswerPolicyDecision {
  if (aggregate.input.op !== 'filter' || typeof aggregate.input.where.season !== 'number') {
    return { type: 'rejected', reason: 'temporal_scope_unsupported' };
  }
  if (aggregate.input.where.season > FINAL_STANDINGS_THROUGH_SEASON) {
    return { type: 'rejected', reason: 'interim_standings_unsupported' };
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
