import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const ROUND_2_F1_TIMING_DATA_URL = 'https://livetiming.formula1.com/static/2026/2026-03-15_Chinese_Grand_Prix/2026-03-15_Race/TimingData.jsonStream';

export const OFFICIAL_2026_PACE_TIMING_CASES = [
  { round: 1, event: 'Australian Grand Prix', scenario_target: 'normal_dry', source_url: 'https://livetiming.formula1.com/static/2026/2026-03-08_Australian_Grand_Prix/2026-03-08_Race/TimingData.jsonStream' },
  { round: 2, event: 'Chinese Grand Prix', scenario_target: 'retirement_limited', source_url: ROUND_2_F1_TIMING_DATA_URL },
  { round: 3, event: 'Japanese Grand Prix', scenario_target: 'wet_or_disrupted', source_url: 'https://livetiming.formula1.com/static/2026/2026-03-29_Japanese_Grand_Prix/2026-03-29_Race/TimingData.jsonStream' },
  { round: 6, event: 'Miami Grand Prix', scenario_target: 'pit_heavy', source_url: 'https://livetiming.formula1.com/static/2026/2026-05-03_Miami_Grand_Prix/2026-05-03_Race/TimingData.jsonStream' },
  { round: 7, event: 'Canadian Grand Prix', scenario_target: 'current_season', source_url: 'https://livetiming.formula1.com/static/2026/2026-05-24_Canadian_Grand_Prix/2026-05-24_Race/TimingData.jsonStream' }
] as const;

const REQUIRED_RACING_NUMBERS = ['1', '5', '23', '81'];

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface TimingLine {
  NumberOfLaps?: number;
  LastLapTime?: { Value?: string };
  Stints?: Record<string, { LapTime?: string; LapNumber?: number }>;
}

function fetchOfficialTimingData(url: string): Promise<FetchResponse> {
  const content = execFileSync('curl', [
    '--fail', '--silent', '--show-error', '--location',
    '--header', 'Accept: application/json, text/plain, */*',
    '--header', 'Origin: https://www.formula1.com',
    '--header', 'Referer: https://www.formula1.com/',
    '--header', 'User-Agent: f1muse-pace-evidence/1.0 (+https://www.formula1.com/)',
    url
  ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)
  });
}

export interface OfficialTimingLapSummary {
  racing_number: string;
  timed_laps: number;
  raw_timed_lap_median_seconds: number | null;
  individual_lap_fingerprint: string;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function lapTimeSeconds(value: string): number | null {
  const match = /^(\d+):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function validateRound2LapTimingArtifactUrl(sourceUrl: string): void {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'livetiming.formula1.com' || url.href !== ROUND_2_F1_TIMING_DATA_URL) {
    throw new Error('FAIL_CLOSED: only the reviewed official F1 2026 round-2 TimingData archive URL may be fetched');
  }
}

export function validateOfficial2026PaceTimingArtifactUrl(sourceUrl: string): void {
  const reviewed = OFFICIAL_2026_PACE_TIMING_CASES.some((testCase) => testCase.source_url === sourceUrl);
  const url = new URL(sourceUrl);
  if (!reviewed || url.protocol !== 'https:' || url.hostname !== 'livetiming.formula1.com') {
    throw new Error('FAIL_CLOSED: only an allowlisted official F1 2026 TimingData archive URL may be fetched');
  }
}

export function summarizeOfficialTimingLaps(content: string, racingNumbers = REQUIRED_RACING_NUMBERS): OfficialTimingLapSummary[] {
  const laps = new Map<string, Map<number, number>>();
  for (const rawLine of content.split('\n')) {
    const sourceLine = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const payload = /^\d{2}:\d{2}:\d{2}\.\d{3}(\{.*\})$/.exec(sourceLine)?.[1];
    if (!payload) continue;
    let record: { Lines?: Record<string, TimingLine> };
    try { record = JSON.parse(payload) as { Lines?: Record<string, TimingLine> }; } catch { continue; }
    for (const [racingNumber, line] of Object.entries(record.Lines ?? {})) {
      if (typeof line.NumberOfLaps === 'number' && typeof line.LastLapTime?.Value === 'string') {
        const seconds = lapTimeSeconds(line.LastLapTime.Value);
        if (seconds !== null) {
          const driverLaps = laps.get(racingNumber) ?? new Map<number, number>();
          driverLaps.set(line.NumberOfLaps, seconds);
          laps.set(racingNumber, driverLaps);
        }
      }
      for (const stint of Object.values(line.Stints ?? {})) {
        if (typeof stint.LapNumber !== 'number' || typeof stint.LapTime !== 'string') continue;
        const seconds = lapTimeSeconds(stint.LapTime);
        if (seconds === null) continue;
        const driverLaps = laps.get(racingNumber) ?? new Map<number, number>();
        driverLaps.set(stint.LapNumber, seconds);
        laps.set(racingNumber, driverLaps);
      }
    }
  }
  return racingNumbers.map((racingNumber) => {
    const entries = [...(laps.get(racingNumber) ?? new Map<number, number>()).entries()].sort(([left], [right]) => left - right);
    const values = entries.map(([, seconds]) => seconds);
    return {
      racing_number: racingNumber,
      timed_laps: values.length,
      raw_timed_lap_median_seconds: median(values),
      individual_lap_fingerprint: sha256(JSON.stringify(entries))
    };
  });
}

function observedRacingNumbers(content: string): string[] {
  const numbers = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const sourceLine = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const payload = /^\d{2}:\d{2}:\d{2}\.\d{3}(\{.*\})$/.exec(sourceLine)?.[1];
    if (!payload) continue;
    try {
      const record = JSON.parse(payload) as { Lines?: Record<string, TimingLine> };
      Object.keys(record.Lines ?? {}).forEach((racingNumber) => numbers.add(racingNumber));
    } catch { continue; }
  }
  return [...numbers].sort((left, right) => Number(left) - Number(right));
}

export async function fetchOfficial2026PaceTimingArtifact(
  sourceUrl: string,
  fetcher: (url: string) => Promise<FetchResponse> = fetchOfficialTimingData,
  now: () => Date = () => new Date()
): Promise<{ content: Buffer; content_type: string | null; retrieved_at: string }> {
  validateOfficial2026PaceTimingArtifactUrl(sourceUrl);
  const response = await fetcher(sourceUrl);
  if (!response.ok) throw new Error(`FAIL_CLOSED: official F1 timing artifact request failed with status ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || !/^\uFEFF?\d{2}:\d{2}:\d{2}\.\d{3}\{/.test(content.toString('utf8', 0, 35))) {
    throw new Error('FAIL_CLOSED: official F1 timing artifact is not a TimingData JSON stream');
  }
  return { content, content_type: response.headers.get('content-type'), retrieved_at: now().toISOString() };
}

export function writeOfficial2026PaceTimingArtifact(
  testCase: typeof OFFICIAL_2026_PACE_TIMING_CASES[number],
  artifact: { content: Buffer; content_type: string | null; retrieved_at: string },
  temporaryDirectory = os.tmpdir()
) {
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, `pace-v2-2026-r${testCase.round}-f1-timing-`), { encoding: 'utf8' });
  const output = path.join(directory, 'TimingData.jsonStream');
  fs.writeFileSync(output, artifact.content, { flag: 'wx', mode: 0o600 });
  const observedNumbers = observedRacingNumbers(artifact.content.toString('utf8'));
  const laps = summarizeOfficialTimingLaps(artifact.content.toString('utf8'), observedNumbers);
  return {
    version: 1 as const,
    authority: 'Formula 1' as const,
    round: testCase.round,
    event: testCase.event,
    scenario_target: testCase.scenario_target,
    scenario_validation: 'not_established_by_timing_data_fields' as const,
    source_url: testCase.source_url,
    retrieved_at: artifact.retrieved_at,
    output,
    artifact_sha256: sha256(artifact.content),
    bytes: artifact.content.length,
    content_type: artifact.content_type,
    comparison_scope: 'individual_laps_and_raw_timed_lap_medians_only' as const,
    eligibility_limitation: 'not_a_clean_air_or_pit_filtered_pace_median' as const,
    observed_driver_timing_coverage: laps.some((lap) => lap.timed_laps > 0) ? 'present' as const : 'absent' as const,
    laps
  };
}

export async function fetchRound2LapTimingArtifact(
  fetcher: (url: string) => Promise<FetchResponse> = fetchOfficialTimingData,
  now: () => Date = () => new Date(),
  sourceUrl = ROUND_2_F1_TIMING_DATA_URL
): Promise<{ content: Buffer; content_type: string | null; retrieved_at: string }> {
  validateRound2LapTimingArtifactUrl(sourceUrl);
  const response = await fetcher(sourceUrl);
  if (!response.ok) throw new Error(`FAIL_CLOSED: official F1 timing artifact request failed with status ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || !/^\uFEFF?\d{2}:\d{2}:\d{2}\.\d{3}\{/.test(content.toString('utf8', 0, 35))) {
    throw new Error('FAIL_CLOSED: official F1 timing artifact is not a TimingData JSON stream');
  }
  return { content, content_type: response.headers.get('content-type'), retrieved_at: now().toISOString() };
}

export function writeRound2LapTimingArtifact(
  artifact: { content: Buffer; content_type: string | null; retrieved_at: string },
  temporaryDirectory = os.tmpdir()
): { version: 1; authority: 'Formula 1'; source_url: string; retrieved_at: string; output: string; artifact_sha256: string; bytes: number; content_type: string | null; comparison_scope: 'individual_laps_and_raw_timed_lap_medians_only'; required_driver_timing_coverage: 'complete' | 'incomplete'; eligibility_limitation: 'not_a_clean_air_or_pit_filtered_pace_median'; laps: OfficialTimingLapSummary[] } {
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, 'pace-v2-round2-f1-timing-'), { encoding: 'utf8' });
  const output = path.join(directory, 'TimingData.jsonStream');
  fs.writeFileSync(output, artifact.content, { flag: 'wx', mode: 0o600 });
  const laps = summarizeOfficialTimingLaps(artifact.content.toString('utf8'));
  return {
    version: 1,
    authority: 'Formula 1',
    source_url: ROUND_2_F1_TIMING_DATA_URL,
    retrieved_at: artifact.retrieved_at,
    output,
    artifact_sha256: sha256(artifact.content),
    bytes: artifact.content.length,
    content_type: artifact.content_type,
    comparison_scope: 'individual_laps_and_raw_timed_lap_medians_only',
    required_driver_timing_coverage: laps.every((lap) => lap.timed_laps > 0) ? 'complete' : 'incomplete',
    eligibility_limitation: 'not_a_clean_air_or_pit_filtered_pace_median',
    laps
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === '--all-2026') {
    const reports = [];
    for (const testCase of OFFICIAL_2026_PACE_TIMING_CASES) {
      reports.push(writeOfficial2026PaceTimingArtifact(testCase, await fetchOfficial2026PaceTimingArtifact(testCase.source_url)));
    }
    process.stdout.write(`${JSON.stringify({ status: 'collected', assertion_scope: 'official_raw_timing_only', f1ql_clean_air_comparison: 'unsupported_without_shared_eligibility_fields', reports })}\n`);
    return;
  }
  const artifact = await fetchRound2LapTimingArtifact();
  process.stdout.write(`${JSON.stringify(writeRound2LapTimingArtifact(artifact))}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'pace_v2_round2_lap_timing_artifact_failed' })}\n`);
  process.exitCode = 1;
});
