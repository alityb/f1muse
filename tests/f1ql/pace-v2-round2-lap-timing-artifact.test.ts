import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_2026_PACE_TIMING_CASES, ROUND_2_F1_TIMING_DATA_URL, createOfficial2026PaceCoverageMatrix, fetchOfficial2026PaceContextArtifacts, fetchOfficial2026PaceTimingArtifact, fetchRound2LapTimingArtifact, summarizeOfficialTimingLaps, validateOfficial2026PaceTimingArtifactUrl, validateRound2LapTimingArtifactUrl, writeOfficial2026PaceTimingArtifact, writeRound2LapTimingArtifact } from '../../scripts/fetch-pace-v2-round2-lap-timing-artifact';

const stream = [
  '00:00:01.000{"Lines":{"1":{"NumberOfLaps":2,"LastLapTime":{"Value":"1:30.000"}},"5":{"NumberOfLaps":2,"LastLapTime":{"Value":"1:31.000"}},"23":{"NumberOfLaps":2,"LastLapTime":{"Value":"1:32.000"}},"81":{"NumberOfLaps":2,"LastLapTime":{"Value":"1:33.000"}}}}',
  '00:01:01.000{"Lines":{"1":{"NumberOfLaps":3,"LastLapTime":{"Value":"1:32.000"}},"5":{"NumberOfLaps":3,"LastLapTime":{"Value":"1:33.000"}},"23":{"NumberOfLaps":3,"LastLapTime":{"Value":"1:34.000"}},"81":{"NumberOfLaps":3,"LastLapTime":{"Value":"1:35.000"}}}}'
].join('\r\n');

describe('round-2 official F1 lap timing artifact', () => {
  it('preserves the official stream and deterministically recomputes raw timed-lap medians', async () => {
    const content = Buffer.from(`\uFEFF${stream}`);
    const artifact = await fetchRound2LapTimingArtifact(async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }), () => new Date('2026-07-22T00:00:00.000Z'));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pace-v2-round2-lap-test-'));
    try {
      const report = writeRound2LapTimingArtifact(artifact, directory);
      expect(report.source_url).toBe(ROUND_2_F1_TIMING_DATA_URL);
      expect(report.artifact_sha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect(statSync(report.output).mode & 0o777).toBe(0o600);
      expect(report.laps.map(({ racing_number, raw_timed_lap_median_seconds }) => [racing_number, raw_timed_lap_median_seconds])).toEqual([['1', 91], ['5', 92], ['23', 93], ['81', 94]]);
      expect(report.eligibility_limitation).toBe('not_a_clean_air_or_pit_filtered_pace_median');
      expect(report.required_driver_timing_coverage).toBe('complete');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed for an unreviewed endpoint or malformed stream', async () => {
    expect(() => validateRound2LapTimingArtifactUrl('https://livetiming.formula1.com/static/other')).toThrow('only the reviewed official F1');
    await expect(fetchRound2LapTimingArtifact(async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>').buffer }))).rejects.toThrow('not a TimingData JSON stream');
    expect(summarizeOfficialTimingLaps('bad input')).toEqual(expect.arrayContaining([expect.objectContaining({ racing_number: '1', timed_laps: 0, raw_timed_lap_median_seconds: null })]));
  });

  it('does not invoke a fetcher until the exact official URL has passed validation', async () => {
    let calls = 0;
    await expect(fetchRound2LapTimingArtifact(async () => {
      calls += 1;
      throw new Error('must not fetch');
    }, () => new Date(), 'https://livetiming.formula1.com/other')).rejects.toThrow('only the reviewed official F1');
    expect(calls).toBe(0);
  });

  it('collects only allowlisted multi-round timing artifacts and labels scenario targets as unvalidated', async () => {
    const content = Buffer.from(stream);
    const testCase = OFFICIAL_2026_PACE_TIMING_CASES[0];
    const artifact = await fetchOfficial2026PaceTimingArtifact(testCase.source_url, async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }), () => new Date('2026-07-22T00:00:00.000Z'));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pace-v2-official-timing-test-'));
    try {
      const report = writeOfficial2026PaceTimingArtifact(testCase, artifact, directory);
      expect(report).toMatchObject({ round: 1, scenario_target: 'normal_dry', scenario_validation: 'not_established_by_timing_data_fields', comparison_scope: 'individual_laps_and_raw_timed_lap_medians_only', eligibility_limitation: 'not_a_clean_air_or_pit_filtered_pace_median', observed_driver_timing_coverage: 'present' });
      expect(report.laps).toHaveLength(4);
      expect(report.laps.map((lap) => lap.racing_number)).toEqual(['1', '5', '23', '81']);
      expect(statSync(report.output).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(() => validateOfficial2026PaceTimingArtifactUrl('https://livetiming.formula1.com/static/2026/unreviewed/TimingData.jsonStream')).toThrow('allowlisted');
  });

  it('retains independent official context streams without treating them as F1QL eligibility evidence', async () => {
    const contextStream = (payload: string) => Buffer.from(`00:00:01.000${payload}`);
    const weather = contextStream('{"WeatherData":{"Rainfall":"1"}}');
    const raceControl = contextStream('{"Messages":{"0":{"Message":"SAFETY CAR DEPLOYED"}}}');
    const timingApp = contextStream('{"Lines":{"1":{"Stints":{"0":{},"1":{}}}}}');
    const responses = [weather, raceControl, timingApp];
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pace-v2-official-context-test-'));
    try {
      const report = await fetchOfficial2026PaceContextArtifacts(OFFICIAL_2026_PACE_TIMING_CASES[0], async () => {
        const content = responses.shift()!;
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) };
      }, () => new Date('2026-07-22T00:00:00.000Z'), directory);
      expect(report).toMatchObject({ assertion_scope: 'official_event_context_fields_only', context: { rainfall_observed: true, safety_car_deployed: true, stint_record_updates: 2 }, f1ql_pace_comparison: 'unsupported_without_shared_clean_air_and_pit_eligibility_fields' });
      expect(statSync(report.artifacts.WeatherData.output).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed before fetching context streams for an unallowlisted case', async () => {
    let calls = 0;
    await expect(fetchOfficial2026PaceContextArtifacts({ ...OFFICIAL_2026_PACE_TIMING_CASES[0], source_url: 'https://livetiming.formula1.com/static/2026/unreviewed/TimingData.jsonStream' }, async () => {
      calls += 1;
      throw new Error('must not fetch');
    })).rejects.toThrow('allowlisted');
    expect(calls).toBe(0);
  });

  it('builds a complete round-1-to-10 matrix with literal context classifications only', async () => {
    const timing = OFFICIAL_2026_PACE_TIMING_CASES.map((testCase) => writeOfficial2026PaceTimingArtifact(testCase, { content: Buffer.from(stream), content_type: 'application/json', retrieved_at: '2026-07-22T00:00:00.000Z' }));
    const context = await Promise.all(OFFICIAL_2026_PACE_TIMING_CASES.map((testCase) => fetchOfficial2026PaceContextArtifacts(testCase, async (url) => {
      const payload = url.includes('WeatherData') ? '{"WeatherData":{"Rainfall":"0"}}' : url.includes('RaceControlMessages') ? '{"Messages":{"0":{"Message":"CAR 1 RETIRED"}}}' : '{"Lines":{"1":{"Stints":{"0":{}}}}}';
      const content = Buffer.from(`00:00:01.000${payload}`);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) };
    }, () => new Date('2026-07-22T00:00:00.000Z'))));
    const matrix = createOfficial2026PaceCoverageMatrix(timing, context);
    expect(matrix).toHaveLength(10);
    expect(matrix[0]).toMatchObject({ round: 1, official_timing: { completeness: 'complete', timed_drivers: 4 }, context_classification: { dry: 'no_rainfall_observed', retirement: 'retirement_messages_observed', pit_heavy: 'not_established_from_incremental_stint_updates' }, v2_eligible_driver_coverage: { status: 'not_assessed' } });
    expect(matrix[9].official_timing.source_url).toContain('2026-06-28_Austrian_Grand_Prix');
  });

  it('records an unavailable reviewed URL without inventing artifact completeness or context', () => {
    const matrix = createOfficial2026PaceCoverageMatrix([], [], new Map([[4, 'official_timing_artifact_unavailable_from_reviewed_url'], [1, 'unavailable'], [2, 'unavailable'], [3, 'unavailable'], [5, 'unavailable'], [6, 'unavailable'], [7, 'unavailable'], [8, 'unavailable'], [9, 'unavailable'], [10, 'unavailable']]));
    expect(matrix[3]).toMatchObject({ round: 4, official_timing: { availability: 'unavailable' }, context_classification: { dry: 'unavailable', pit_heavy: 'unavailable' } });
  });

  it('commits the emitted rounds-1-to-10 URL and hash coverage matrix', () => {
    const matrix = JSON.parse(readFileSync(path.join(process.cwd(), 'data/pace-v2-official-2026-coverage-matrix.json'), 'utf8')) as { rounds: Array<{ round: number; timing: { sha256?: string; availability?: string; timed_drivers?: number; observed_drivers?: number } }> };
    expect(matrix.rounds).toHaveLength(10);
    expect(matrix.rounds.find((round) => round.round === 2)?.timing).toMatchObject({ sha256: '380259ce59c9e7b5b81aa4872106e2a3ba9e476fd7129d31f27fcc45aa2b747d', timed_drivers: 18, observed_drivers: 22 });
    expect(matrix.rounds.filter((round) => round.timing.availability === 'unavailable').map((round) => round.round)).toEqual([4, 5, 9]);
  });
});
