import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareHistoricalLapWindow,
  HISTORICAL_LAP_PILOT_IDENTITY_SHA256,
  HISTORICAL_LAP_PILOT_SOURCE_SHA256,
  loadHistoricalLapPilot,
  type HistoricalLapDataset
} from '../../src/etl/historical-lap-window-pilot';
import {
  assessOfficialHistoricalEventMeanCandidate,
  assessOfficialHistoricalLapWindowCandidate,
  hasOfficialHistoricalEventMeanMinimumCoverage,
  OFFICIAL_HISTORICAL_EVENT_MEAN_CANDIDATE,
  OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE,
  OFFICIAL_HISTORICAL_LAP_DATASET_SHA256,
  OFFICIAL_HISTORICAL_LAP_FACT_FINGERPRINT,
  OFFICIAL_HISTORICAL_LAP_HISTORY_ARTIFACT_SHA256,
  OFFICIAL_HISTORICAL_LAP_IDENTITY_FINGERPRINT
} from '../../src/f1ql/official-historical-lap-candidate';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from '../../src/f1ql/official-event-mean';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from '../../src/f1ql/official-lap-window';
import { SEMANTIC_CATALOG, SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';

const sourceContent = fs.readFileSync('data/phase8-belgium-2022-pilot.json');
const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');
const identityMap = JSON.parse(identityContent.toString('utf8')) as {
  mappings: Array<{ driver_id: string; canonical_full_name: string }>;
};
const dataset = loadHistoricalLapPilot(sourceContent, identityContent, identityMap.mappings.map(mapping => ({
  driver_id: mapping.driver_id,
  full_name: mapping.canonical_full_name
})));

function request(driverIds: readonly [string, string], lapStart = 3, lapEnd = 10) {
  return {
    metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
    season: 2022 as const,
    round: 14 as const,
    session_type: 'R' as const,
    driver_ids: driverIds,
    lap_start: lapStart,
    lap_end: lapEnd
  };
}

function eventMeanRequest(driverIds: readonly [string, string]) {
  return {
    metric: OFFICIAL_EVENT_MEAN_METRIC_ID,
    season: 2022 as const,
    round: 14 as const,
    session_type: 'R' as const,
    driver_ids: driverIds
  };
}

describe('inactive official historical lap catalog candidate', () => {
  it('pins one immutable raw-timing source without activating the semantic catalog', () => {
    expect(OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE).toMatchObject({
      status: 'inactive',
      family_id: 'official_historical_laps',
      view: 'f1ql.official_lap_timing',
      classification: 'official_raw_lap_timing',
      scope: {
        season: 2022,
        round: 14,
        dataset_sha256: '81b7db4e84433ef879c1c6e0bfe08a1d7b36476d9d7f5a7b4cf414a5a0fbc37b',
        source_manifest_sha256: '491c7a7b01c9aa32742cfbf5b1b2cf3704e2ec7b48b84fbc08cdf2ea4df4caab',
        identity_map_sha256: '1b177167217c5ead145bbfb2669dde66e0c39296c09051a9d514a3ad1cc75cbd',
        identity_fingerprint: 'edc4d51451b2cd2cdaf87f9a0d8ee65a55cc10502345d7642731b389057682f3',
        fact_fingerprint: 'f31adb2eebb906017b9aaea2a63329e142012da7ed312cdfe26d19c7dce30d8f',
        race_history_artifact_sha256: '30f7db339b437cea5fd73f0a7bf6a3a16783119b3b62d07c5793934e2b26d105'
      },
      grain: ['season', 'round', 'driver_id', 'lap_number'],
      measures: ['lap_time_seconds'],
      metric: {
        id: OFFICIAL_LAP_WINDOW_METRIC_ID,
        complete_requested_window_required: true,
        maximum_inclusive_window_laps: 50,
        minimum_eligible_laps_per_driver: 2,
        exclusions: ['official_deleted_lap', 'official_pit_marker']
      }
    });
    expect(OFFICIAL_HISTORICAL_LAP_DATASET_SHA256).toBe(dataset.dataset_sha256);
    expect(HISTORICAL_LAP_PILOT_SOURCE_SHA256).toBe(dataset.source_manifest_sha256);
    expect(HISTORICAL_LAP_PILOT_IDENTITY_SHA256).toBe(dataset.identity_map_sha256);
    expect(OFFICIAL_HISTORICAL_LAP_IDENTITY_FINGERPRINT).toBe(dataset.identity_fingerprint);
    expect(OFFICIAL_HISTORICAL_LAP_FACT_FINGERPRINT).toBe(dataset.fact_fingerprint);
    expect(OFFICIAL_HISTORICAL_LAP_HISTORY_ARTIFACT_SHA256).toBe(dataset.facts[0].source_artifact_sha256);
    expect(dataset.facts).toHaveLength(790);
    expect(dataset.identities).toHaveLength(20);
    expect(new Set(dataset.facts.map(fact => fact.driver_id)).size).toBe(19);
    expect(OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.dimensions).not.toContain('leader_gap_seconds');
    expect(OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.prohibited_claims).toContain('generic_pace');
    expect(Object.isFrozen(OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope)).toBe(true);
    expect(SEMANTIC_CATALOG.excluded_families).toContain('official_historical_laps');
    expect(SEMANTIC_CATALOG.sources.some(source => source.view === 'f1ql.official_lap_timing')).toBe(false);
    expect(SEMANTIC_CATALOG_HASH).toBe('19312969ef88cd85533fbe92d17835c6525ad10c4d6ebe1b34b49fa4c4b3e3f8');
  });

  it('marks the complete Verstappen-Alonso window eligible and matches the closed reference coverage', () => {
    const decision = assessOfficialHistoricalLapWindowCandidate(
      dataset,
      request(['max-verstappen', 'fernando-alonso'])
    );
    const reference = compareHistoricalLapWindow(dataset, {
      driver_ids: ['max_verstappen', 'fernando_alonso'],
      lap_start: 3,
      lap_end: 10
    });
    expect(decision).toEqual({
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
      driver_coverage: reference.drivers.map(driver => ({
        driver_id: driver.driver_id.replaceAll('_', '-'),
        requested_laps: driver.requested_laps,
        eligible_laps: driver.eligible_laps,
        excluded_deleted_laps: driver.excluded_deleted_laps,
        excluded_pit_marker_laps: driver.excluded_pit_marker_laps
      }))
    });
  });

  it('returns typed missing coverage for a retained zero-lap identity', () => {
    expect(dataset.identities.find(identity => identity.driver_id === 'lewis_hamilton')).toMatchObject({ classified_laps: 0 });
    expect(assessOfficialHistoricalLapWindowCandidate(
      dataset,
      request(['fernando-alonso', 'lewis-hamilton'], 2, 10)
    )).toEqual({ type: 'abstain', reason: 'source_coverage_missing' });
  });

  it('returns typed missing coverage for an identity outside the sealed dataset', () => {
    expect(assessOfficialHistoricalLapWindowCandidate(
      dataset,
      request(['fernando-alonso', 'unsupported-driver'], 2, 10)
    )).toEqual({ type: 'abstain', reason: 'source_coverage_missing' });
  });

  it('accepts exactly two eligible laps after an explicit PIT exclusion', () => {
    expect(assessOfficialHistoricalLapWindowCandidate(
      dataset,
      request(['max-verstappen', 'fernando-alonso'], 14, 16)
    )).toMatchObject({
      type: 'eligible',
      driver_coverage: [
        { driver_id: 'max-verstappen', eligible_laps: 2, excluded_pit_marker_laps: 1 },
        { driver_id: 'fernando-alonso', eligible_laps: 3, excluded_pit_marker_laps: 0 }
      ]
    });
  });

  it('applies official deleted-lap exclusion independently', () => {
    expect(assessOfficialHistoricalLapWindowCandidate(
      dataset,
      request(['sebastian-vettel', 'max-verstappen'], 38, 40)
    )).toMatchObject({
      type: 'eligible',
      driver_coverage: [
        { driver_id: 'sebastian-vettel', eligible_laps: 2, excluded_deleted_laps: 1 },
        { driver_id: 'max-verstappen', eligible_laps: 3, excluded_deleted_laps: 0 }
      ]
    });
  });

  it('returns typed missing coverage when exclusions leave fewer than two eligible laps', () => {
    expect(assessOfficialHistoricalLapWindowCandidate(
      dataset,
      request(['max-verstappen', 'fernando-alonso'], 14, 15)
    )).toEqual({ type: 'abstain', reason: 'source_coverage_missing' });
  });

  it.each([
    ['wrong metric', { metric: 'generic_median' }],
    ['wrong season', { season: 2021 }],
    ['wrong round', { round: 13 }],
    ['wrong session', { session_type: 'Q' }],
    ['same driver', { driver_ids: ['max-verstappen', 'max-verstappen'] }],
    ['storage driver namespace', { driver_ids: ['max_verstappen', 'fernando_alonso'] }],
    ['reversed window', { lap_start: 10, lap_end: 3 }],
    ['oversized window', { lap_start: 1, lap_end: 51 }]
  ])('fails closed for an unsupported %s request', (_name, mutation) => {
    const mutated = { ...request(['max-verstappen', 'fernando-alonso']), ...mutation };
    expect(() => assessOfficialHistoricalLapWindowCandidate(dataset, mutated as never)).toThrow(
      'outside the inactive official timing candidate contract'
    );
  });

  it('rejects unexpected request fields rather than ignoring contradictory semantics', () => {
    const mutated = { ...request(['max-verstappen', 'fernando-alonso']), clean_air_only: true };
    expect(() => assessOfficialHistoricalLapWindowCandidate(dataset, mutated as never)).toThrow(
      'outside the inactive official timing candidate contract'
    );
  });

  it('rejects unverified dataset objects before assessing coverage', () => {
    const unverified = structuredClone(dataset) as HistoricalLapDataset;
    expect(() => assessOfficialHistoricalLapWindowCandidate(
      unverified,
      request(['max-verstappen', 'fernando-alonso'])
    )).toThrow('dataset is not verified immutable input');
  });
});

describe('inactive official historical event-mean candidate', () => {
  it('declares one metric-specific all-event mean without broadening the source', () => {
    expect(OFFICIAL_HISTORICAL_EVENT_MEAN_CANDIDATE).toMatchObject({
      status: 'inactive',
      source_id: 'official_race_lap_timing',
      scope: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.scope,
      metric: {
        id: OFFICIAL_EVENT_MEAN_METRIC_ID,
        aggregation: 'arithmetic_mean',
        comparison: 'lower_is_faster',
        completed_lap_counts_may_differ: true,
        complete_classified_event_required: true,
        expected_lap_sequence: 'one_through_classified_laps',
        minimum_eligible_laps_per_driver: 2,
        exclusions: ['official_deleted_lap', 'official_pit_marker']
      },
      prohibited_claims: OFFICIAL_HISTORICAL_LAP_CATALOG_CANDIDATE.prohibited_claims
    });
    expect(SEMANTIC_CATALOG.excluded_families).toContain('official_historical_laps');
    expect(SEMANTIC_CATALOG_HASH).toBe('19312969ef88cd85533fbe92d17835c6525ad10c4d6ebe1b34b49fa4c4b3e3f8');
  });

  it('matches the real closed event-mean result coverage for Verstappen and Alonso', () => {
    const emitted = JSON.parse(fs.readFileSync('data/phase9-belgium-2022-event-mean-result.json', 'utf8')) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = emitted.rows[0];
    expect(assessOfficialHistoricalEventMeanCandidate(
      dataset,
      eventMeanRequest(['max-verstappen', 'fernando-alonso'])
    )).toEqual({
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric: OFFICIAL_EVENT_MEAN_METRIC_ID,
      driver_coverage: [
        {
          driver_id: 'max-verstappen',
          completed_laps: row.driver_a_completed_laps,
          eligible_laps: row.driver_a_eligible_laps,
          excluded_deleted_laps: row.driver_a_excluded_deleted_laps,
          excluded_pit_marker_laps: row.driver_a_excluded_pit_marker_laps
        },
        {
          driver_id: 'fernando-alonso',
          completed_laps: row.driver_b_completed_laps,
          eligible_laps: row.driver_b_eligible_laps,
          excluded_deleted_laps: row.driver_b_excluded_deleted_laps,
          excluded_pit_marker_laps: row.driver_b_excluded_pit_marker_laps
        }
      ]
    });
  });

  it('preserves and discloses asymmetric completed-lap coverage', () => {
    expect(assessOfficialHistoricalEventMeanCandidate(
      dataset,
      eventMeanRequest(['nicholas-latifi', 'max-verstappen'])
    )).toMatchObject({
      type: 'eligible',
      driver_coverage: [
        { driver_id: 'nicholas-latifi', completed_laps: 43, eligible_laps: 39 },
        { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 42 }
      ]
    });
  });

  it('applies official deletion and PIT exclusions independently', () => {
    expect(assessOfficialHistoricalEventMeanCandidate(
      dataset,
      eventMeanRequest(['sebastian-vettel', 'max-verstappen'])
    )).toMatchObject({
      type: 'eligible',
      driver_coverage: [
        { driver_id: 'sebastian-vettel', excluded_deleted_laps: 1, excluded_pit_marker_laps: 2 },
        { driver_id: 'max-verstappen', excluded_deleted_laps: 0, excluded_pit_marker_laps: 2 }
      ]
    });
  });

  it('accepts the exact two-lap eligibility minimum and rejects one', () => {
    expect(hasOfficialHistoricalEventMeanMinimumCoverage(1)).toBe(false);
    expect(hasOfficialHistoricalEventMeanMinimumCoverage(2)).toBe(true);
  });

  it.each(['lewis-hamilton', 'valtteri-bottas'])('returns typed missing coverage for insufficient event facts: %s', driverId => {
    expect(dataset.identities.find(identity => identity.driver_id === driverId.replaceAll('-', '_'))?.classified_laps)
      .toBe(driverId === 'lewis-hamilton' ? 0 : 1);
    expect(assessOfficialHistoricalEventMeanCandidate(
      dataset,
      eventMeanRequest(['fernando-alonso', driverId])
    )).toEqual({ type: 'abstain', reason: 'source_coverage_missing' });
  });

  it.each([
    ['wrong metric', { metric: OFFICIAL_LAP_WINDOW_METRIC_ID }],
    ['wrong season', { season: 2021 }],
    ['wrong round', { round: 13 }],
    ['wrong session', { session_type: 'Q' }],
    ['same driver', { driver_ids: ['max-verstappen', 'max-verstappen'] }],
    ['storage driver namespace', { driver_ids: ['max_verstappen', 'fernando_alonso'] }],
    ['unexpected window', { lap_start: 3, lap_end: 10 }],
    ['generic pace claim', { generic_pace: true }]
  ])('fails closed for unsupported %s semantics', (_name, mutation) => {
    const mutated = { ...eventMeanRequest(['max-verstappen', 'fernando-alonso']), ...mutation };
    expect(() => assessOfficialHistoricalEventMeanCandidate(dataset, mutated as never)).toThrow(
      'outside the inactive official event-mean candidate contract'
    );
  });
});
