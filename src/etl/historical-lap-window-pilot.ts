import { createHash } from 'crypto';

export const HISTORICAL_LAP_PILOT_SOURCE_SHA256 = '491c7a7b01c9aa32742cfbf5b1b2cf3704e2ec7b48b84fbc08cdf2ea4df4caab';
export const HISTORICAL_LAP_PILOT_IDENTITY_SHA256 = '1b177167217c5ead145bbfb2669dde66e0c39296c09051a9d514a3ad1cc75cbd';
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
  readonly leader_gap_seconds: number | null;
  readonly official_deleted_lap: boolean;
  readonly official_pit_marker: boolean;
  readonly source_manifest_sha256: string;
  readonly source_artifact_sha256: string;
}

export interface HistoricalLapDataset {
  readonly version: 2;
  readonly ingestion_contract: 'immutable_official_lap_event_v1';
  readonly dataset_sha256: string;
  readonly source_manifest_sha256: string;
  readonly identity_map_sha256: string;
  readonly identity_fingerprint: string;
  readonly fact_fingerprint: string;
  readonly artifacts: readonly HistoricalLapArtifact[];
  readonly coverage: readonly HistoricalLapCoverage[];
  readonly identities: readonly HistoricalLapIdentity[];
  readonly facts: readonly HistoricalLapFact[];
}

export type HistoricalLapArtifact = {
  artifact_name: string;
  source_url: string;
  artifact_sha256: string;
  bytes: number;
};

export type HistoricalLapCoverage = {
  coverage_kind: string;
  expected_count: number;
  actual_count: number;
  missing_keys: readonly string[];
  unexpected_keys: readonly string[];
};

export type HistoricalLapIdentity = {
  racing_number: string;
  official_name: string;
  driver_id: string;
  canonical_full_name: string;
  classified_laps: number;
};

type IdentityMapping = Omit<HistoricalLapIdentity, 'classified_laps'>;

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
  if (manifest.version !== 2 || manifest.season !== 2022 || manifest.round !== 14 ||
      manifest.source_manifest_sha256 !== HISTORICAL_LAP_PILOT_SOURCE_SHA256) {
    throw new Error('FAIL_CLOSED: historical identity map has an unsupported scope');
  }
  exactString(manifest.mapping, 'fia_official_identity_to_canonical_driver_v2', 'identity mapping method');
  exactString(manifest.event, EVENT, 'identity event');
  if (!Array.isArray(manifest.mappings) || manifest.mappings.length !== 20) {
    throw new Error('FAIL_CLOSED: historical identity map must contain all 20 official identities');
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
    if (candidates.length !== 1 || candidates[0].full_name !== mapping.canonical_full_name) {
      throw new Error(`FAIL_CLOSED: canonical identity mismatch for racing number ${mapping.racing_number}`);
    }
  }
}

// One strict boundary validates every retained source field before facts become trusted.
// eslint-disable-next-line max-lines-per-function
// eslint-disable-next-line complexity
function parseSourceRows(content: Buffer): {
  identities: Array<{ racing_number: string; official_name: string; classified_laps: number }>;
  artifacts: HistoricalLapArtifact[];
  coverage: HistoricalLapCoverage[];
  rows: Array<{
  racing_number: string;
  official_name: string;
  lap_number: number;
  lap_time_seconds: number;
  leader_gap_seconds: number | null;
  pit_marker: boolean;
  deleted_lap: boolean;
}> } {
  if (sha256(content) !== HISTORICAL_LAP_PILOT_SOURCE_SHA256) {
    throw new Error('FAIL_CLOSED: historical source-manifest hash mismatch');
  }
  const manifest = objectValue(JSON.parse(content.toString('utf8')), 'source manifest');
  if (manifest.version !== 2 || manifest.authority !== 'FIA' || manifest.event !== EVENT || manifest.season !== 2022 ||
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
  const parsedArtifacts = ['race_history_chart', 'final_race_classification', 'deleted_race_lap_times'].map((artifactName) => {
    const artifact = objectValue(artifacts[artifactName], `${artifactName} artifact`);
    if (typeof artifact.source_url !== 'string' || !artifact.source_url.startsWith('https://www.fia.com/') ||
        typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isInteger(artifact.bytes) || Number(artifact.bytes) <= 0) {
      throw new Error(`FAIL_CLOSED: historical ${artifactName} artifact has an unsupported shape`);
    }
    return {
      artifact_name: artifactName,
      source_url: artifact.source_url,
      artifact_sha256: artifact.sha256,
      bytes: Number(artifact.bytes)
    };
  });
  if (!Array.isArray(manifest.identities) || manifest.identities.length !== 20) {
    throw new Error('FAIL_CLOSED: historical source identity coverage is incomplete');
  }
  const identities = manifest.identities.map((value) => {
    const identity = objectValue(value, 'official identity');
    if (typeof identity.racing_number !== 'string' || !identity.racing_number || typeof identity.official_name !== 'string' ||
        !identity.official_name || !Number.isInteger(identity.classified_laps) || Number(identity.classified_laps) < 0) {
      throw new Error('FAIL_CLOSED: historical official identity has an unsupported shape');
    }
    return identity as { racing_number: string; official_name: string; classified_laps: number };
  });
  const completedLaps = objectValue(manifest.completed_laps, 'completed laps');
  if (completedLaps.row_count !== 790 || !Array.isArray(completedLaps.rows) || completedLaps.rows.length !== 790 ||
      typeof completedLaps.row_fingerprint !== 'string' || sha256(JSON.stringify(completedLaps.rows)) !== completedLaps.row_fingerprint) {
    throw new Error('FAIL_CLOSED: historical completed-lap coverage or fingerprint is invalid');
  }
  // eslint-disable-next-line complexity
  const rows = completedLaps.rows.map((value) => {
    const row = objectValue(value, 'completed lap');
    if (typeof row.racing_number !== 'string' || typeof row.official_name !== 'string' || !Number.isInteger(row.lap_number) ||
        typeof row.lap_time_seconds !== 'number' || !Number.isFinite(row.lap_time_seconds) || row.lap_time_seconds <= 0 ||
        !(row.leader_gap_seconds === null || (typeof row.leader_gap_seconds === 'number' && Number.isFinite(row.leader_gap_seconds) && row.leader_gap_seconds >= 0)) ||
        typeof row.pit_marker !== 'boolean' || typeof row.deleted_lap !== 'boolean') {
      throw new Error('FAIL_CLOSED: historical completed lap has an unsupported shape');
    }
    const milliseconds = row.lap_time_seconds * 1000;
    if (Math.abs(milliseconds - Math.round(milliseconds)) > 1e-6) {
      throw new Error('FAIL_CLOSED: historical lap time is not millisecond-exact');
    }
    return row as { racing_number: string; official_name: string; lap_number: number; lap_time_seconds: number; leader_gap_seconds: number | null; pit_marker: boolean; deleted_lap: boolean };
  });
  const identityByNumber = new Map(identities.map(identity => [identity.racing_number, identity]));
  if (identityByNumber.size !== identities.length || rows.filter(row => row.deleted_lap).length !== 5) {
    throw new Error('FAIL_CLOSED: historical official identities or deleted laps are inconsistent');
  }
  for (const identity of identities) {
    const identityRows = rows.filter(row => row.racing_number === identity.racing_number && row.official_name === identity.official_name);
    if (identityRows.length !== identity.classified_laps) {
      throw new Error(`FAIL_CLOSED: historical completed-lap count differs for racing number ${identity.racing_number}`);
    }
  }
  if (rows.some(row => !identityByNumber.has(row.racing_number))) {
    throw new Error('FAIL_CLOSED: historical completed lap has no official identity');
  }
  return {
    identities,
    artifacts: parsedArtifacts,
    coverage: [
      {
        coverage_kind: 'final_classification_to_race_history',
        expected_count: 790,
        actual_count: 790,
        missing_keys: coverage.final_classification_without_race_history as string[],
        unexpected_keys: []
      },
      {
        coverage_kind: 'race_history_to_final_classification',
        expected_count: 790,
        actual_count: 790,
        missing_keys: [],
        unexpected_keys: coverage.race_history_without_final_classification as string[]
      }
    ],
    rows
  };
}

// eslint-disable-next-line max-lines-per-function
export function loadHistoricalLapPilot(
  sourceContent: Buffer,
  identityContent: Buffer,
  canonicalDrivers: CanonicalDriverIdentity[]
): HistoricalLapDataset {
  const mappings = parseIdentityMap(identityContent);
  validateCanonicalIdentities(mappings, canonicalDrivers);
  const source = parseSourceRows(sourceContent);
  const sourceIdentities = new Map(source.identities.map(identity => [identity.racing_number, identity]));
  if (mappings.length !== source.identities.length || mappings.some(mapping => {
    const sourceIdentity = sourceIdentities.get(mapping.racing_number);
    return !sourceIdentity || sourceIdentity.official_name !== mapping.official_name;
  })) {
    throw new Error('FAIL_CLOSED: historical identity map does not exactly cover official identities');
  }
  const mappingsByNumber = new Map(mappings.map(mapping => [mapping.racing_number, mapping]));
  const identities = mappings.map((mapping): HistoricalLapIdentity => ({
    ...mapping,
    classified_laps: sourceIdentities.get(mapping.racing_number)!.classified_laps
  })).sort((left, right) => Number(left.racing_number) - Number(right.racing_number));
  const facts = source.rows.map((row): HistoricalLapFact => {
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
      leader_gap_seconds: row.leader_gap_seconds,
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
  const identityFingerprint = sha256(JSON.stringify(identities));
  const factFingerprint = sha256(JSON.stringify(facts));
  const coverage = [...source.coverage, {
    coverage_kind: 'official_identity_to_canonical_driver',
    expected_count: source.identities.length,
    actual_count: identities.length,
    missing_keys: [],
    unexpected_keys: []
  }].sort((left, right) => left.coverage_kind.localeCompare(right.coverage_kind));
  const datasetSha256 = sha256(JSON.stringify({
    version: 2,
    ingestion_contract: 'immutable_official_lap_event_v1',
    season: 2022,
    round: 14,
    session_type: 'R',
    event: EVENT,
    source_manifest_sha256: HISTORICAL_LAP_PILOT_SOURCE_SHA256,
    identity_map_sha256: HISTORICAL_LAP_PILOT_IDENTITY_SHA256,
    identity_fingerprint: identityFingerprint,
    fact_fingerprint: factFingerprint,
    artifacts: source.artifacts,
    coverage
  }));
  const dataset = deepFreeze({
    version: 2 as const,
    ingestion_contract: 'immutable_official_lap_event_v1' as const,
    dataset_sha256: datasetSha256,
    source_manifest_sha256: HISTORICAL_LAP_PILOT_SOURCE_SHA256,
    identity_map_sha256: HISTORICAL_LAP_PILOT_IDENTITY_SHA256,
    identity_fingerprint: identityFingerprint,
    fact_fingerprint: factFingerprint,
    artifacts: source.artifacts,
    coverage,
    identities,
    facts
  });
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

export function assertVerifiedHistoricalLapDataset(dataset: HistoricalLapDataset): void {
  if (!verifiedDatasets.has(dataset as object) || !Object.isFrozen(dataset) || !Object.isFrozen(dataset.facts) ||
      !Object.isFrozen(dataset.identities) || dataset.facts.some(fact => !Object.isFrozen(fact)) ||
      dataset.identities.some(identity => !Object.isFrozen(identity))) {
    throw new Error('FAIL_CLOSED: historical lap dataset is not verified immutable input');
  }
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
      leader_gap_seconds: row.leader_gap_seconds === null ? null : Number(row.leader_gap_seconds),
      official_deleted_lap: row.official_deleted_lap,
      official_pit_marker: row.official_pit_marker,
      source_manifest_sha256: row.source_manifest_sha256,
      source_artifact_sha256: row.source_artifact_sha256
    };
    if (fact.season !== 2022 || fact.round !== 14 || fact.session_type !== 'R' || fact.event !== EVENT || typeof fact.driver_id !== 'string' ||
        typeof fact.racing_number !== 'string' || typeof fact.official_name !== 'string' || !Number.isInteger(fact.lap_number) ||
        !Number.isFinite(fact.lap_time_seconds) || fact.lap_time_seconds <= 0 || !(fact.leader_gap_seconds === null ||
        (Number.isFinite(fact.leader_gap_seconds) && fact.leader_gap_seconds >= 0)) || typeof fact.official_deleted_lap !== 'boolean' ||
        typeof fact.official_pit_marker !== 'boolean' || typeof fact.source_manifest_sha256 !== 'string' ||
        typeof fact.source_artifact_sha256 !== 'string') {
      throw new Error('FAIL_CLOSED: staged historical lap has an unsupported shape');
    }
    return fact as HistoricalLapFact;
  }).sort((left, right) => left.driver_id.localeCompare(right.driver_id) || left.lap_number - right.lap_number);
  if (JSON.stringify(facts) !== JSON.stringify(dataset.facts)) {
    throw new Error('FAIL_CLOSED: staged historical facts differ from verified immutable input');
  }
  const rehydrated = deepFreeze({ ...dataset, facts });
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
