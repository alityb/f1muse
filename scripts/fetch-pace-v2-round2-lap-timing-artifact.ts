import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const ROUND_2_F1_TIMING_DATA_URL = 'https://livetiming.formula1.com/static/2026/2026-03-15_Chinese_Grand_Prix/2026-03-15_Race/TimingData.jsonStream';

const REQUIRED_RACING_NUMBERS = ['1', '5', '23', '81'];

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface TimingLine {
  Stints?: Record<string, { LapTime?: string; LapNumber?: number }>;
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

export function summarizeOfficialTimingLaps(content: string): OfficialTimingLapSummary[] {
  const laps = new Map<string, Map<number, number>>();
  for (const sourceLine of content.split('\n')) {
    const payload = /^\d{2}:\d{2}:\d{2}\.\d{3}(\{.*\})$/.exec(sourceLine)?.[1];
    if (!payload) continue;
    let record: { Lines?: Record<string, TimingLine> };
    try { record = JSON.parse(payload) as { Lines?: Record<string, TimingLine> }; } catch { continue; }
    for (const [racingNumber, line] of Object.entries(record.Lines ?? {})) {
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
  return REQUIRED_RACING_NUMBERS.map((racingNumber) => {
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

export async function fetchRound2LapTimingArtifact(
  fetcher: (url: string) => Promise<FetchResponse> = (url) => fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.formula1.com',
      Referer: 'https://www.formula1.com/',
      'User-Agent': 'f1muse-pace-evidence/1.0 (+https://www.formula1.com/)'
    }
  }) as Promise<FetchResponse>,
  now: () => Date = () => new Date(),
  sourceUrl = ROUND_2_F1_TIMING_DATA_URL
): Promise<{ content: Buffer; content_type: string | null; retrieved_at: string }> {
  validateRound2LapTimingArtifactUrl(sourceUrl);
  const response = await fetcher(sourceUrl);
  if (!response.ok) throw new Error(`FAIL_CLOSED: official F1 timing artifact request failed with status ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || !/^\d{2}:\d{2}:\d{2}\.\d{3}\{/.test(content.toString('utf8', 0, 32))) {
    throw new Error('FAIL_CLOSED: official F1 timing artifact is not a TimingData JSON stream');
  }
  return { content, content_type: response.headers.get('content-type'), retrieved_at: now().toISOString() };
}

export function writeRound2LapTimingArtifact(
  artifact: { content: Buffer; content_type: string | null; retrieved_at: string },
  temporaryDirectory = os.tmpdir()
): { version: 1; authority: 'Formula 1'; source_url: string; retrieved_at: string; output: string; artifact_sha256: string; bytes: number; content_type: string | null; comparison_scope: 'individual_laps_and_raw_timed_lap_medians_only'; eligibility_limitation: 'not_a_clean_air_or_pit_filtered_pace_median'; laps: OfficialTimingLapSummary[] } {
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, 'pace-v2-round2-f1-timing-'), { encoding: 'utf8' });
  const output = path.join(directory, 'TimingData.jsonStream');
  fs.writeFileSync(output, artifact.content, { flag: 'wx', mode: 0o600 });
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
    eligibility_limitation: 'not_a_clean_air_or_pit_filtered_pace_median',
    laps: summarizeOfficialTimingLaps(artifact.content.toString('utf8'))
  };
}

async function main(): Promise<void> {
  const artifact = await fetchRound2LapTimingArtifact();
  process.stdout.write(`${JSON.stringify(writeRound2LapTimingArtifact(artifact))}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'pace_v2_round2_lap_timing_artifact_failed' })}\n`);
  process.exitCode = 1;
});
