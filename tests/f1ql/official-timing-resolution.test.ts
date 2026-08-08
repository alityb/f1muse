import { describe, expect, it } from 'vitest';
import { parseOfficialTimingQuestion, OfficialTimingQuestionMatch } from '../../src/f1ql/official-timing-question';
import { enumerateOfficialTimingEvidence } from '../../src/f1ql/official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  computeResolutionHash,
  OFFICIAL_TIMING_RESOLUTION_VERSION,
  OfficialTimingResolutionDependencies,
  OfficialTimingResolutionError,
  verifyOfficialTimingResolution
} from '../../src/f1ql/official-timing-resolution';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const DRIVERS: Readonly<Record<string, string>> = {
  'Max Verstappen': 'max-verstappen',
  'Fernando Alonso': 'fernando-alonso'
};

const ELIGIBLE_COVERAGE = {
  type: 'eligible',
  source_id: 'official_race_lap_timing',
  metric: 'official_non_deleted_non_pit_event_mean_v1',
  coverage_query_id: 'official_event_coverage_v1',
  coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[0].statement_sha256,
  query_calls: 1,
  driver_coverage: [
    { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 40, excluded_deleted_laps: 2, excluded_pit_marker_laps: 2 },
    { driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 41, excluded_deleted_laps: 1, excluded_pit_marker_laps: 2 }
  ]
} as const;

function matched(question: string): OfficialTimingQuestionMatch {
  const result = parseOfficialTimingQuestion(question);
  if (result.type !== 'matched') {
    throw new Error(`expected match, got ${result.reason}`);
  }
  return result;
}

const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';
const WINDOW_MEDIAN_QUESTION = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 10 to 20 at the 2022 Belgian Grand Prix';

function dependencies(overrides: Partial<OfficialTimingResolutionDependencies> = {}): OfficialTimingResolutionDependencies {
  return {
    database: { connect: () => { throw new Error('no database in unit tests'); } } as never,
    catalog: CATALOG_V2,
    driver_resolver: {
      resolveUnambiguous: async (alias: string) => {
        const id = DRIVERS[alias];
        return id
          ? { success: true, f1db_driver_id: id, candidates: [id], match_mode: 'literal' }
          : { success: false, error: 'unknown_driver' };
      }
    },
    event_resolver: {
      resolveRound: async (season: number, round: number) =>
        season === 2022 && round === 14 ? { type: 'resolved', season, round } : { type: 'missing' }
    },
    coverage_reader: async () => structuredClone(ELIGIBLE_COVERAGE) as never,
    ...overrides
  };
}

describe('official timing resolution v2', () => {
  it('resolves drivers and event, then attaches the eligible coverage witness', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const resolution = await collectOfficialTimingResolution(question, evidence, dependencies());
    expect(resolution.type).toBe('resolved');
    if (resolution.type !== 'resolved') {throw new Error('expected resolved');}
    expect(resolution.version).toBe(OFFICIAL_TIMING_RESOLUTION_VERSION);
    expect(resolution.drivers.map(driver => [driver.branch, driver.driver_id])).toEqual([
      ['driver_a', 'max-verstappen'],
      ['driver_b', 'fernando-alonso']
    ]);
    expect(resolution.season).toBe(2022);
    expect(resolution.round).toBe(14);
    expect(resolution.session_type).toBe('R');
    expect(resolution.event_name).toBe('2022 Belgian Grand Prix');
    expect(resolution.coverage.type).toBe('eligible');
    expect(resolution.coverage.query_calls).toBe(1);
    expect(resolution.coverage.coverage_query_id).toBe('official_event_coverage_v1');
    expect(resolution.coverage_reader_version).toBe('official-timing-coverage-v1');
    expect(resolution.resolution_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(resolution)).toBe(true);
  });

  it('passes the lap window to the coverage reader for window median', async () => {
    const question = matched(WINDOW_MEDIAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    let observed: unknown;
    const resolution = await collectOfficialTimingResolution(question, evidence, dependencies({
      coverage_reader: async (_database, request) => {
        observed = request;
        return {
          ...structuredClone(ELIGIBLE_COVERAGE),
          metric: 'official_non_deleted_non_pit_window_median_v1',
          coverage_query_id: 'official_window_coverage_v1',
          coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[1].statement_sha256
        } as never;
      }
    }));
    expect(resolution.type).toBe('resolved');
    expect(observed).toMatchObject({
      metric: 'official_non_deleted_non_pit_window_median_v1',
      season: 2022, round: 14, session_type: 'R',
      driver_ids: ['max-verstappen', 'fernando-alonso'],
      lap_start: 10, lap_end: 20
    });
    if (resolution.type === 'resolved') {
      expect(resolution.coverage.coverage_query_id).toBe('official_window_coverage_v1');
    }
  });

  it('propagates coverage abstention without drivers or plan-eligible payload', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const resolution = await collectOfficialTimingResolution(question, evidence, dependencies({
      coverage_reader: async () => ({
        type: 'abstain', reason: 'source_coverage_missing', stage: 'official_timing_coverage', query_calls: 1
      }) as never
    }));
    expect(resolution.type).toBe('abstained');
    if (resolution.type !== 'abstained') {throw new Error('expected abstained');}
    expect(resolution.coverage.reason).toBe('source_coverage_missing');
    expect(resolution).not.toHaveProperty('drivers');
    expect(resolution.resolution_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed for unknown, ambiguous, uncertified, or duplicate drivers', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const resolverWith = (impl: (alias: string) => unknown) => dependencies({
      driver_resolver: { resolveUnambiguous: async (alias: string) => impl(alias) }
    });
    await expect(collectOfficialTimingResolution(question, evidence, resolverWith(() => ({ success: false, error: 'unknown_driver' }))))
      .rejects.toThrowError(expect.objectContaining({ code: 'identity_unresolved' }));
    await expect(collectOfficialTimingResolution(question, evidence, resolverWith(() => ({ success: false, error: 'ambiguous_driver' }))))
      .rejects.toThrowError(expect.objectContaining({ code: 'entity_ambiguous' }));
    await expect(collectOfficialTimingResolution(question, evidence, resolverWith(() => ({ success: true, f1db_driver_id: 'nyck-de-vries' }))))
      .rejects.toThrowError(expect.objectContaining({ code: 'driver_not_certified' }));
    await expect(collectOfficialTimingResolution(question, evidence, resolverWith(() => ({ success: true, f1db_driver_id: 'max-verstappen' }))))
      .rejects.toThrowError(expect.objectContaining({ code: 'identity_unresolved' }));
  });

  it('fails closed when the event resolver disagrees with the certified scope', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const wrongRound = dependencies({
      event_resolver: { resolveRound: async () => ({ type: 'resolved', season: 2022, round: 13 }) }
    });
    await expect(collectOfficialTimingResolution(question, evidence, wrongRound))
      .rejects.toThrowError(expect.objectContaining({ code: 'event_mismatch' }));
    const missing = dependencies({ event_resolver: { resolveRound: async () => ({ type: 'missing' }) } });
    await expect(collectOfficialTimingResolution(question, evidence, missing))
      .rejects.toThrowError(expect.objectContaining({ code: 'event_mismatch' }));
  });

  it('rejects foreign or stale evidence and resolution objects', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const resolution = await collectOfficialTimingResolution(question, evidence, dependencies());
    expect(verifyOfficialTimingResolution(resolution, question, evidence)).toBe(resolution);
    expect(() => verifyOfficialTimingResolution(structuredClone(resolution), question, evidence))
      .toThrowError(expect.objectContaining({ code: 'evidence_invalid' }));
    const otherQuestion = matched(WINDOW_MEDIAN_QUESTION);
    const otherEvidence = enumerateOfficialTimingEvidence(otherQuestion, CATALOG_V2);
    expect(() => verifyOfficialTimingResolution(resolution, otherQuestion, otherEvidence))
      .toThrowError(expect.objectContaining({ code: 'evidence_invalid' }));
    await expect(collectOfficialTimingResolution(question, structuredClone(evidence), dependencies()))
      .rejects.toThrowError(expect.objectContaining({ code: 'evidence_invalid' }));
  });

  it('recomputes a stable resolution hash over the unsigned content', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const first = await collectOfficialTimingResolution(question, evidence, dependencies());
    const second = await collectOfficialTimingResolution(question, evidence, dependencies());
    expect(first.resolution_hash).toBe(second.resolution_hash);
    const { resolution_hash: _ignored, ...unsigned } = first;
    expect(computeResolutionHash(unsigned as never)).toBe(first.resolution_hash);
  });
});
