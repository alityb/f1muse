import {
  assertVerifiedHistoricalLapDataset,
  HISTORICAL_LAP_PILOT_IDENTITY_SHA256,
  HISTORICAL_LAP_PILOT_SOURCE_SHA256,
  type HistoricalLapDataset,
  type HistoricalLapFact
} from '../etl/historical-lap-window-pilot';
import {
  MAX_OFFICIAL_LAP_WINDOW_LAPS,
  MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS,
  OFFICIAL_LAP_WINDOW_METRIC_ID
} from './official-lap-window';
import {
  MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS,
  OFFICIAL_EVENT_MEAN_METRIC_ID
} from './official-event-mean';

export const OFFICIAL_HISTORICAL_LAP_DATASET_SHA256 =
  '81b7db4e84433ef879c1c6e0bfe08a1d7b36476d9d7f5a7b4cf414a5a0fbc37b';
export const OFFICIAL_HISTORICAL_LAP_IDENTITY_FINGERPRINT =
  'edc4d51451b2cd2cdaf87f9a0d8ee65a55cc10502345d7642731b389057682f3';
export const OFFICIAL_HISTORICAL_LAP_FACT_FINGERPRINT =
  'f31adb2eebb906017b9aaea2a63329e142012da7ed312cdfe26d19c7dce30d8f';
export const OFFICIAL_HISTORICAL_LAP_HISTORY_ARTIFACT_SHA256 =
  '30f7db339b437cea5fd73f0a7bf6a3a16783119b3b62d07c5793934e2b26d105';

export const OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE = deepFreeze({
  version: 1 as const,
  status: 'inactive' as const,
  family_id: 'official_historical_laps' as const,
  source_id: 'official_race_lap_timing' as const,
  view: 'f1ql.official_lap_timing' as const,
  authority: 'FIA official race timing documents' as const,
  classification: 'official_raw_lap_timing' as const,
  scope: {
    season: 2022 as const,
    round: 14 as const,
    event: '2022 Belgian Grand Prix' as const,
    session_type: 'R' as const,
    dataset_sha256: OFFICIAL_HISTORICAL_LAP_DATASET_SHA256,
    source_manifest_sha256: HISTORICAL_LAP_PILOT_SOURCE_SHA256,
    identity_map_sha256: HISTORICAL_LAP_PILOT_IDENTITY_SHA256,
    identity_fingerprint: OFFICIAL_HISTORICAL_LAP_IDENTITY_FINGERPRINT,
    fact_fingerprint: OFFICIAL_HISTORICAL_LAP_FACT_FINGERPRINT,
    race_history_artifact_sha256: OFFICIAL_HISTORICAL_LAP_HISTORY_ARTIFACT_SHA256
  },
  grain: ['season', 'round', 'driver_id', 'lap_number'] as const,
  dimensions: [
    'season', 'round', 'driver_id', 'lap_number', 'official_deleted_lap',
    'official_pit_marker', 'source_manifest_sha256', 'source_artifact_sha256'
  ] as const,
  measures: ['lap_time_seconds'] as const,
  metric: {
    id: OFFICIAL_LAP_WINDOW_METRIC_ID,
    aggregation: 'median' as const,
    comparison: 'lower_is_faster' as const,
    complete_requested_window_required: true as const,
    maximum_inclusive_window_laps: MAX_OFFICIAL_LAP_WINDOW_LAPS,
    minimum_eligible_laps_per_driver: MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS,
    exclusions: ['official_deleted_lap', 'official_pit_marker'] as const
  },
  prohibited_claims: [
    'clean_air', 'tyre', 'fuel', 'traffic', 'safety_car', 'weather', 'strategy',
    'causal_performance', 'generic_pace'
  ] as const
});

export const OFFICIAL_HISTORICAL_EVENT_MEAN_CANDIDATE = deepFreeze({
  version: 1 as const,
  status: 'inactive' as const,
  source_id: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.source_id,
  scope: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope,
  metric: {
    id: OFFICIAL_EVENT_MEAN_METRIC_ID,
    aggregation: 'arithmetic_mean' as const,
    comparison: 'lower_is_faster' as const,
    completed_lap_counts_may_differ: true as const,
    complete_classified_event_required: true as const,
    expected_lap_sequence: 'one_through_classified_laps' as const,
    minimum_eligible_laps_per_driver: MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS,
    exclusions: ['official_deleted_lap', 'official_pit_marker'] as const
  },
  prohibited_claims: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.prohibited_claims
});

export interface OfficialHistoricalLapCandidateRequest {
  metric: typeof OFFICIAL_LAP_WINDOW_METRIC_ID;
  season: 2022;
  round: 14;
  session_type: 'R';
  driver_ids: readonly [string, string];
  lap_start: number;
  lap_end: number;
}

export interface OfficialHistoricalEventMeanCandidateRequest {
  metric: typeof OFFICIAL_EVENT_MEAN_METRIC_ID;
  season: 2022;
  round: 14;
  session_type: 'R';
  driver_ids: readonly [string, string];
}

type DriverCoverage = {
  driver_id: string;
  requested_laps: number;
  eligible_laps: number;
  excluded_deleted_laps: number;
  excluded_pit_marker_laps: number;
};

export type OfficialHistoricalLapCandidateDecision =
  | {
    type: 'eligible';
    source_id: typeof OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.source_id;
    metric: typeof OFFICIAL_LAP_WINDOW_METRIC_ID;
    driver_coverage: readonly [DriverCoverage, DriverCoverage];
  }
  | { type: 'abstain'; reason: 'source_coverage_missing' };

type EventMeanDriverCoverage = {
  driver_id: string;
  completed_laps: number;
  eligible_laps: number;
  excluded_deleted_laps: number;
  excluded_pit_marker_laps: number;
};

export type OfficialHistoricalEventMeanCandidateDecision =
  | {
    type: 'eligible';
    source_id: typeof OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.source_id;
    metric: typeof OFFICIAL_EVENT_MEAN_METRIC_ID;
    driver_coverage: readonly [EventMeanDriverCoverage, EventMeanDriverCoverage];
  }
  | { type: 'abstain'; reason: 'source_coverage_missing' };

const CANDIDATE_REQUEST_KEYS = [
  'driver_ids', 'lap_end', 'lap_start', 'metric', 'round', 'season', 'session_type'
] as const;
const EVENT_MEAN_REQUEST_KEYS = ['driver_ids', 'metric', 'round', 'season', 'session_type'] as const;

export function assessOfficialHistoricalLapWindowCandidate(
  dataset: HistoricalLapDataset,
  request: OfficialHistoricalLapCandidateRequest
): OfficialHistoricalLapCandidateDecision {
  assertVerifiedHistoricalLapDataset(dataset);
  assertCandidateRequest(request);
  if (!matchesPinnedDataset(dataset)) {
    throw new Error('FAIL_CLOSED: historical lap dataset differs from the inactive candidate contract');
  }

  const identityIds = new Set(dataset.identities.map(identity => governedDriverId(identity.driver_id)));
  if (request.driver_ids.some(driverId => !identityIds.has(driverId))) {
    return deepFreeze({ type: 'abstain', reason: 'source_coverage_missing' });
  }

  const requestedLaps = Array.from(
    { length: request.lap_end - request.lap_start + 1 },
    (_, index) => request.lap_start + index
  );
  const coverage = request.driver_ids.map(driverId => assessDriverCoverage(dataset.facts, driverId, requestedLaps));
  if (coverage.some(decision => decision === null)) {
    return deepFreeze({ type: 'abstain', reason: 'source_coverage_missing' });
  }
  return deepFreeze({
    type: 'eligible',
    source_id: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.source_id,
    metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
    driver_coverage: coverage as [DriverCoverage, DriverCoverage]
  });
}

export function assessOfficialHistoricalEventMeanCandidate(
  dataset: HistoricalLapDataset,
  request: OfficialHistoricalEventMeanCandidateRequest
): OfficialHistoricalEventMeanCandidateDecision {
  assertVerifiedHistoricalLapDataset(dataset);
  assertEventMeanCandidateRequest(request);
  if (!matchesPinnedDataset(dataset)) {
    throw new Error('FAIL_CLOSED: historical lap dataset differs from the inactive candidate contract');
  }

  const identityById = new Map(dataset.identities.map(identity => [governedDriverId(identity.driver_id), identity]));
  if (request.driver_ids.some(driverId => !identityById.has(driverId))) {
    return deepFreeze({ type: 'abstain', reason: 'source_coverage_missing' });
  }
  const coverage = request.driver_ids.map(driverId => assessEventMeanDriverCoverage(
    dataset.facts,
    driverId,
    identityById.get(driverId)!.classified_laps
  ));
  if (coverage.some(decision => decision === null)) {
    return deepFreeze({ type: 'abstain', reason: 'source_coverage_missing' });
  }
  return deepFreeze({
    type: 'eligible',
    source_id: OFFICIAL_HISTORICAL_EVENT_MEAN_CANDIDATE.source_id,
    metric: OFFICIAL_EVENT_MEAN_METRIC_ID,
    driver_coverage: coverage as [EventMeanDriverCoverage, EventMeanDriverCoverage]
  });
}

function assertCandidateRequest(request: OfficialHistoricalLapCandidateRequest): void {
  if (Object.keys(request).sort().join(',') !== CANDIDATE_REQUEST_KEYS.join(',') ||
      !matchesCandidateRequestScope(request) || !hasValidDriverPair(request.driver_ids) ||
      !hasValidLapWindow(request.lap_start, request.lap_end)) {
    throw new Error('FAIL_CLOSED: request is outside the inactive official timing candidate contract');
  }
}

function assertEventMeanCandidateRequest(request: OfficialHistoricalEventMeanCandidateRequest): void {
  if (Object.keys(request).sort().join(',') !== EVENT_MEAN_REQUEST_KEYS.join(',') ||
      request.metric !== OFFICIAL_EVENT_MEAN_METRIC_ID || request.season !== 2022 || request.round !== 14 ||
      request.session_type !== 'R' || !hasValidDriverPair(request.driver_ids)) {
    throw new Error('FAIL_CLOSED: request is outside the inactive official event-mean candidate contract');
  }
}

function matchesCandidateRequestScope(request: OfficialHistoricalLapCandidateRequest): boolean {
  return request.metric === OFFICIAL_LAP_WINDOW_METRIC_ID && request.season === 2022 &&
    request.round === 14 && request.session_type === 'R';
}

function hasValidDriverPair(driverIds: readonly [string, string]): boolean {
  return Array.isArray(driverIds) && driverIds.length === 2 &&
    driverIds.every(driverId => typeof driverId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(driverId)) &&
    driverIds[0] !== driverIds[1];
}

function hasValidLapWindow(lapStart: number, lapEnd: number): boolean {
  return Number.isInteger(lapStart) && Number.isInteger(lapEnd) && lapStart >= 1 && lapEnd >= lapStart &&
    lapEnd - lapStart + 1 <= MAX_OFFICIAL_LAP_WINDOW_LAPS;
}

function matchesPinnedDataset(dataset: HistoricalLapDataset): boolean {
  const scope = OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope;
  const governedIdentityIds = dataset.identities.map(identity => governedDriverId(identity.driver_id));
  return dataset.dataset_sha256 === scope.dataset_sha256 &&
    dataset.source_manifest_sha256 === scope.source_manifest_sha256 &&
    dataset.identity_map_sha256 === scope.identity_map_sha256 &&
    dataset.identity_fingerprint === scope.identity_fingerprint &&
    dataset.fact_fingerprint === scope.fact_fingerprint &&
    dataset.identities.length === 20 && new Set(governedIdentityIds).size === dataset.identities.length &&
    dataset.facts.length === 790 &&
    dataset.coverage.length === 3 && dataset.coverage.every(item =>
      item.expected_count === item.actual_count && item.missing_keys.length === 0 && item.unexpected_keys.length === 0
    ) && dataset.facts.every(fact => fact.season === scope.season && fact.round === scope.round &&
      fact.session_type === scope.session_type && fact.event === scope.event &&
      fact.source_manifest_sha256 === scope.source_manifest_sha256 &&
      fact.source_artifact_sha256 === scope.race_history_artifact_sha256);
}

function assessDriverCoverage(
  facts: readonly HistoricalLapFact[],
  driverId: string,
  requestedLaps: readonly number[]
): DriverCoverage | null {
  const storageDriverId = driverId.replaceAll('-', '_');
  const rows = facts.filter(fact => fact.driver_id === storageDriverId && requestedLaps.includes(fact.lap_number));
  const observedLaps = new Set(rows.map(row => row.lap_number));
  if (rows.length !== requestedLaps.length || observedLaps.size !== requestedLaps.length ||
      requestedLaps.some(lap => !observedLaps.has(lap))) {
    return null;
  }
  const eligible = rows.filter(row => !row.official_deleted_lap && !row.official_pit_marker);
  if (eligible.length < MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS) {
    return null;
  }
  return {
    driver_id: driverId,
    requested_laps: requestedLaps.length,
    eligible_laps: eligible.length,
    excluded_deleted_laps: rows.filter(row => row.official_deleted_lap).length,
    excluded_pit_marker_laps: rows.filter(row => row.official_pit_marker).length
  };
}

function assessEventMeanDriverCoverage(
  facts: readonly HistoricalLapFact[],
  driverId: string,
  classifiedLaps: number
): EventMeanDriverCoverage | null {
  const storageDriverId = driverId.replaceAll('-', '_');
  const rows = facts.filter(fact => fact.driver_id === storageDriverId);
  const observedLaps = new Set(rows.map(row => row.lap_number));
  if (rows.length !== classifiedLaps || observedLaps.size !== classifiedLaps ||
      Array.from({ length: classifiedLaps }, (_, index) => index + 1).some(lap => !observedLaps.has(lap))) {
    return null;
  }
  const eligible = rows.filter(row => !row.official_deleted_lap && !row.official_pit_marker);
  if (!hasOfficialHistoricalEventMeanMinimumCoverage(eligible.length)) {
    return null;
  }
  return {
    driver_id: driverId,
    completed_laps: rows.length,
    eligible_laps: eligible.length,
    excluded_deleted_laps: rows.filter(row => row.official_deleted_lap).length,
    excluded_pit_marker_laps: rows.filter(row => row.official_pit_marker).length
  };
}

export function hasOfficialHistoricalEventMeanMinimumCoverage(eligibleLaps: number): boolean {
  return Number.isInteger(eligibleLaps) && eligibleLaps >= MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS;
}

function governedDriverId(storageDriverId: string): string {
  return storageDriverId.replaceAll('_', '-');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
