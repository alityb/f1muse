import { createHash } from 'crypto';

export const HISTORICAL_LAP_PILOT_SOURCE_SHA256 = '616470e9948d8377f55c95ffc41c705fa6f6bb9a5cf4d36aa592fa675dfd9c0f';
export const HISTORICAL_LAP_PILOT_IDENTITY_SHA256 = 'f318c49df004111de3f75404147b1b92c55a36a2f3ee791256df3137776b07f3';
export const HISTORICAL_LAP_WINDOW_METRIC_ID = 'official_non_deleted_non_pit_window_median_v1';

const EVENT = '2022 Belgian Grand Prix';
const HISTORY_ARTIFACT_SHA256 = '30f7db339b437cea5fd73f0a7bf6a3a16783119b3b62d07c5793934e2b26d105';
const EXPECTED_DRIVER_IDS = ['max_verstappen', 'fernando_alonso'] as const;
const MAX_WINDOW_LAPS = 50;
const verifiedDatasets = new WeakSet<object>();

export interface CanonicalDriverIdentity {
  driver_id: string;
  full_name: string;
}

export interface HistoricalLapFact {
  readonly season: 2022;
  readonly round: 14;
  readonly session_type: 'R';
  readonly event: typeof EVENT;
  readonly driver_id: string;
  readonly racing_number: string;
  readonly official_name: string;
  readonly lap_number: number;
  readonly lap_time_seconds: number;
  readonly official_deleted_lap: boolean;
  readonly official_pit_marker: boolean;
  readonly source_manifest_sha256: string;
  readonly source_artifact_sha256: string;
}

export interface HistoricalLapDataset {
  readonly version: 1;
  readonly ingestion_contract: 'immutable_official_lap_pilot_v1';
  readonly facts: readonly HistoricalLapFact[];
}

type IdentityMapping = {
  racing_number: string;
  official_name: string;
  driver_id: string;
  canonical_full_name: string;
};

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`FAIL_CLOSED: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, expected: string, label: string): string {
  if (value !== expected) {
    throw new Error(`FAIL_CLOSED: ${label} does not match the reviewed contract`);
  }
  return expected;
}

function parseIdentityMap(content: Buffer): IdentityMapping[] {
  if (sha256(content) !== HISTORICAL_LAP_PILOT_IDENTITY_SHA256) {
    throw new Error('FAIL_CLOSED: historical identity-map hash mismatch');
  }
  const manifest = objectValue(JSON.parse(content.toString('utf8')), 'identity map');
  if (manifest.version !== 1 || manifest.season !== 2022 || manifest.round !== 14 ||
      manifest.source_manifest_sha256 !== HISTORICAL_LAP_PILOT_SOURCE_SHA256) {
    throw new Error('FAIL_CLOSED: historical identity map has an unsupported scope');
  }
  exactString(manifest.mapping, 'fia_official_identity_to_canonical_driver_v1', 'identity mapping method');
  exactString(manifest.event, EVENT, 'identity event');
  if (!Array.isArray(manifest.mappings) || manifest.mappings.length !== 2) {
    throw new Error('FAIL_CLOSED: historical identity map must contain exactly two pilot mappings');
  }
  const mappings = manifest.mappings.map((value) => {
    const mapping = objectValue(value, 'identity mapping');
    for (const field of ['racing_number', 'official_name', 'driver_id', 'canonical_full_name'] as const) {
      if (typeof mapping[field] !== 'string' || !mapping[field]) {
        throw new Error(`FAIL_CLOSED: identity mapping ${field} is invalid`);
      }
    }
    return mapping as IdentityMapping;
  });
  if (new Set(mappings.map(mapping => mapping.racing_number)).size !== mappings.length ||
      new Set(mappings.map(mapping => mapping.driver_id)).size !== mappings.length ||
      EXPECTED_DRIVER_IDS.some(driverId => !mappings.some(mapping => mapping.driver_id === driverId))) {
    throw new Error('FAIL_CLOSED: historical identity mappings are duplicate or incomplete');
  }
  return mappings;
}

function validateCanonicalIdentities(mappings: IdentityMapping[], canonicalDrivers: CanonicalDriverIdentity[]): void {
  if (canonicalDrivers.length !== mappings.length) {
    throw new Error('FAIL_CLOSED: canonical identity coverage is incomplete');
  }
  for (const mapping of mappings) {
    const candidates = canonicalDrivers.filter(driver => driver.driver_id === mapping.driver_id);
    if (candidates.length !== 1 || candidates[0].full_name !== mapping.canonical_full_name ||
        candidates[0].full_name.toLowerCase() !== mapping.official_name.toLowerCase()) {
      throw new Error(`FAIL_CLOSED: canonical identity mismatch for racing number ${mapping.racing_number}`);
    }
  }
}

// One strict boundary validates every retained source field before facts become trusted.
// eslint-disable-next-line complexity
function parseSourceRows(content: Buffer): Array<{
  racing_number: string;
  official_name: string;
  lap_number: number;
  lap_time_seconds: number;
  pit_marker: boolean;
  deleted_lap: boolean;
}> {
  if (sha256(content) !== HISTORICAL_LAP_PILOT_SOURCE_SHA256) {
    throw new Error('FAIL_CLOSED: historical source-manifest hash mismatch');
  }
  const manifest = objectValue(JSON.parse(content.toString('utf8')), 'source manifest');
  if (manifest.version !== 1 || manifest.authority !== 'FIA' || manifest.event !== EVENT || manifest.season !== 2022 ||
      manifest.round !== 14 || manifest.session !== 'race' || manifest.promotion_status !== 'eligible_for_separate_review' ||
      manifest.canonical_raw_lap_window_operation !== 'unsupported') {
    throw new Error('FAIL_CLOSED: historical source manifest has an unsupported scope or status');
  }
  const coverage = objectValue(manifest.coverage, 'source coverage');
  if (coverage.final_classification_completed_lap_keys !== 790 || coverage.race_history_lap_keys !== 790 ||
      !Array.isArray(coverage.final_classification_without_race_history) || coverage.final_classification_without_race_history.length ||
      !Array.isArray(coverage.race_history_without_final_classification) || coverage.race_history_without_final_classification.length) {
    throw new Error('FAIL_CLOSED: historical source coverage is incomplete');
  }
  const artifacts = objectValue(manifest.artifacts, 'source artifacts');
  const historyArtifact = objectValue(artifacts.race_history_chart, 'race history artifact');
  exactString(historyArtifact.sha256, HISTORY_ARTIFACT_SHA256, 'race history artifact hash');
  const pilotWindow = objectValue(manifest.pilot_window, 'pilot window');
  if (pilotWindow.lap_start !== 3 || pilotWindow.lap_end !== 10 || !Array.isArray(pilotWindow.missing_lap_keys) ||
      pilotWindow.missing_lap_keys.length || !Array.isArray(pilotWindow.rows) || pilotWindow.rows.length !== 16) {
    throw new Error('FAIL_CLOSED: historical pilot window is incomplete');
  }
  return pilotWindow.rows.map((value) => {
    const row = objectValue(value, 'pilot lap');
    if (typeof row.racing_number !== 'string' || typeof row.official_name !== 'string' || !Number.isInteger(row.lap_number) ||
        typeof row.lap_time_seconds !== 'number' || !Number.isFinite(row.lap_time_seconds) || row.lap_time_seconds <= 0 ||
        typeof row.pit_marker !== 'boolean' || typeof row.deleted_lap !== 'boolean') {
      throw new Error('FAIL_CLOSED: historical pilot lap has an unsupported shape');
    }
    const milliseconds = row.lap_time_seconds * 1000;
    if (Math.abs(milliseconds - Math.round(milliseconds)) > 1e-6) {
      throw new Error('FAIL_CLOSED: historical lap time is not millisecond-exact');
    }
    return row as { racing_number: string; official_name: string; lap_number: number; lap_time_seconds: number; pit_marker: boolean; deleted_lap: boolean };
  });
}

export function loadHistoricalLapPilot(
  sourceContent: Buffer,
  identityContent: Buffer,
  canonicalDrivers: CanonicalDriverIdentity[]
): HistoricalLapDataset {
  const mappings = parseIdentityMap(identityContent);
  validateCanonicalIdentities(mappings, canonicalDrivers);
  const mappingsByNumber = new Map(mappings.map(mapping => [mapping.racing_number, mapping]));
  const facts = parseSourceRows(sourceContent).map((row): HistoricalLapFact => {
    const mapping = mappingsByNumber.get(row.racing_number);
    if (!mapping || mapping.official_name !== row.official_name) {
      throw new Error(`FAIL_CLOSED: source identity is not mapped for racing number ${row.racing_number}`);
    }
    return {
      season: 2022,
      round: 14,
      session_type: 'R',
      event: EVENT,
      driver_id: mapping.driver_id,
      racing_number: row.racing_number,
      official_name: row.official_name,
      lap_number: row.lap_number,
      lap_time_seconds: row.lap_time_seconds,
      official_deleted_lap: row.deleted_lap,
      official_pit_marker: row.pit_marker,
      source_manifest_sha256: HISTORICAL_LAP_PILOT_SOURCE_SHA256,
      source_artifact_sha256: HISTORY_ARTIFACT_SHA256
    };
  }).sort((left, right) => left.driver_id.localeCompare(right.driver_id) || left.lap_number - right.lap_number);
  const keys = facts.map(fact => `${fact.driver_id}:${fact.lap_number}`);
  if (new Set(keys).size !== facts.length) {
    throw new Error('FAIL_CLOSED: historical facts contain duplicate lap identity');
  }
  const dataset = deepFreeze({ version: 1 as const, ingestion_contract: 'immutable_official_lap_pilot_v1' as const, facts });
  verifiedDatasets.add(dataset);
  return dataset;
}

function medianMilliseconds(facts: readonly HistoricalLapFact[]): number {
  const values = facts.map(fact => Math.round(fact.lap_time_seconds * 1000)).sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export function compareHistoricalLapWindow(
  dataset: HistoricalLapDataset,
  request: { driver_ids: readonly [string, string]; lap_start: number; lap_end: number }
) {
  if (!verifiedDatasets.has(dataset as object)) {
    throw new Error('FAIL_CLOSED: historical lap dataset is not verified immutable input');
  }
  const drivers = summarizeHistoricalLapWindowFacts(dataset.facts, request);
  const deltaMilliseconds = Math.abs(drivers[0].median_lap_time_seconds * 1000 - drivers[1].median_lap_time_seconds * 1000);
  let winnerDriverId: string | null = null;
  if (drivers[0].median_lap_time_seconds < drivers[1].median_lap_time_seconds) {
    winnerDriverId = drivers[0].driver_id;
  } else if (drivers[1].median_lap_time_seconds < drivers[0].median_lap_time_seconds) {
    winnerDriverId = drivers[1].driver_id;
  }
  return deepFreeze({
    version: 1 as const,
    metric: {
      id: HISTORICAL_LAP_WINDOW_METRIC_ID,
      aggregation: 'median' as const,
      lower_is_faster: true as const,
      deleted_laps: 'excluded_when_officially_identified' as const,
      pit_laps: 'excluded_only_when_fia_history_chart_marks_pit' as const,
      safety_car_weather_and_other_context: 'included_not_inferred' as const,
      minimum_eligible_laps_per_driver: 2 as const,
      complete_requested_window_required: true as const
    },
    scope: { season: 2022, round: 14, event: EVENT, session_type: 'R' as const, lap_start: request.lap_start, lap_end: request.lap_end },
    drivers,
    winner_driver_id: winnerDriverId,
    median_delta_seconds: deltaMilliseconds / 1000,
    caveats: [
      'Safety-car, weather, traffic, tyre, fuel, and race-state effects are included because no per-lap context contract is retained.',
      'This is not clean-air pace and must not be compared with F1QL clean_air_gap_2_0s_v1 results.'
    ],
    provenance: {
      source_manifest_sha256: HISTORICAL_LAP_PILOT_SOURCE_SHA256,
      identity_map_sha256: HISTORICAL_LAP_PILOT_IDENTITY_SHA256,
      race_history_artifact_sha256: HISTORY_ARTIFACT_SHA256
    },
    f1ql_operation: 'unsupported' as const
  });
}

export function summarizeHistoricalLapWindowFacts(
  facts: readonly HistoricalLapFact[],
  request: { driver_ids: readonly [string, string]; lap_start: number; lap_end: number }
) {
  if (!Number.isInteger(request.lap_start) || !Number.isInteger(request.lap_end) || request.lap_start < 1 ||
      request.lap_end < request.lap_start || request.lap_end - request.lap_start + 1 > MAX_WINDOW_LAPS) {
    throw new Error('FAIL_CLOSED: historical lap window is invalid or over budget');
  }
  if (!Array.isArray(request.driver_ids) || request.driver_ids.length !== 2 || request.driver_ids.some(driverId => typeof driverId !== 'string') ||
      request.driver_ids[0] === request.driver_ids[1] || request.driver_ids.some(driverId => !EXPECTED_DRIVER_IDS.includes(driverId as typeof EXPECTED_DRIVER_IDS[number]))) {
    throw new Error('FAIL_CLOSED: historical comparison requires the two reviewed pilot drivers');
  }
  const requestedLaps = Array.from({ length: request.lap_end - request.lap_start + 1 }, (_, index) => request.lap_start + index);
  const drivers = request.driver_ids.map((driverId) => {
    const rows = facts.filter(fact => fact.driver_id === driverId && requestedLaps.includes(fact.lap_number));
    const observedLaps = new Set(rows.map(row => row.lap_number));
    const missingLaps = requestedLaps.filter(lap => !observedLaps.has(lap));
    if (rows.length !== requestedLaps.length || missingLaps.length) {
      throw new Error(`FAIL_CLOSED: incomplete historical lap window for ${driverId}`);
    }
    const eligible = rows.filter(row => !row.official_deleted_lap && !row.official_pit_marker);
    if (eligible.length < 2) {
      throw new Error(`FAIL_CLOSED: fewer than two eligible historical laps for ${driverId}`);
    }
    return {
      driver_id: driverId,
      racing_number: rows[0].racing_number,
      official_name: rows[0].official_name,
      requested_laps: requestedLaps.length,
      eligible_laps: eligible.length,
      excluded_deleted_laps: rows.filter(row => row.official_deleted_lap).length,
      excluded_pit_marker_laps: rows.filter(row => row.official_pit_marker).length,
      median_lap_time_seconds: medianMilliseconds(eligible) / 1000
    };
  });
  return deepFreeze(drivers);
}

export function rehydrateHistoricalLapPilot(dataset: HistoricalLapDataset, stagedRows: unknown[]): HistoricalLapDataset {
  if (!verifiedDatasets.has(dataset as object) || !Array.isArray(stagedRows) || stagedRows.length !== dataset.facts.length) {
    throw new Error('FAIL_CLOSED: staged historical lap coverage does not match verified input');
  }
  // Revalidate every PostgreSQL-coerced field before restoring verified status.
  // eslint-disable-next-line complexity
  const facts = stagedRows.map((value): HistoricalLapFact => {
    const row = objectValue(value, 'staged historical lap');
    const fact = {
      season: Number(row.season),
      round: Number(row.round),
      session_type: row.session_type,
      event: row.event,
      driver_id: row.driver_id,
      racing_number: row.racing_number,
      official_name: row.official_name,
      lap_number: Number(row.lap_number),
      lap_time_seconds: Number(row.lap_time_seconds),
      official_deleted_lap: row.official_deleted_lap,
      official_pit_marker: row.official_pit_marker,
      source_manifest_sha256: row.source_manifest_sha256,
      source_artifact_sha256: row.source_artifact_sha256
    };
    if (fact.season !== 2022 || fact.round !== 14 || fact.session_type !== 'R' || fact.event !== EVENT || typeof fact.driver_id !== 'string' ||
        typeof fact.racing_number !== 'string' || typeof fact.official_name !== 'string' || !Number.isInteger(fact.lap_number) ||
        !Number.isFinite(fact.lap_time_seconds) || fact.lap_time_seconds <= 0 || typeof fact.official_deleted_lap !== 'boolean' ||
        typeof fact.official_pit_marker !== 'boolean' || typeof fact.source_manifest_sha256 !== 'string' ||
        typeof fact.source_artifact_sha256 !== 'string') {
      throw new Error('FAIL_CLOSED: staged historical lap has an unsupported shape');
    }
    return fact as HistoricalLapFact;
  }).sort((left, right) => left.driver_id.localeCompare(right.driver_id) || left.lap_number - right.lap_number);
  if (JSON.stringify(facts) !== JSON.stringify(dataset.facts)) {
    throw new Error('FAIL_CLOSED: staged historical facts differ from verified immutable input');
  }
  const rehydrated = deepFreeze({ version: 1 as const, ingestion_contract: 'immutable_official_lap_pilot_v1' as const, facts });
  verifiedDatasets.add(rehydrated);
  return rehydrated;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(child => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}
