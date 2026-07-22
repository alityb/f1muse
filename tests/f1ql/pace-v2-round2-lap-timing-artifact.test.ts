import { createHash } from 'crypto';
import { mkdtempSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ROUND_2_F1_TIMING_DATA_URL, fetchRound2LapTimingArtifact, summarizeOfficialTimingLaps, validateRound2LapTimingArtifactUrl, writeRound2LapTimingArtifact } from '../../scripts/fetch-pace-v2-round2-lap-timing-artifact';

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
});
