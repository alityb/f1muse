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
  { round: 4, event: 'Bahrain Grand Prix', scenario_target: 'unclassified', source_url: 'https://livetiming.formula1.com/static/2026/2026-04-12_Bahrain_Grand_Prix/2026-04-12_Race/TimingData.jsonStream' },
  { round: 5, event: 'Saudi Arabian Grand Prix', scenario_target: 'unclassified', source_url: 'https://livetiming.formula1.com/static/2026/2026-04-19_Saudi_Arabian_Grand_Prix/2026-04-19_Race/TimingData.jsonStream' },
  { round: 6, event: 'Miami Grand Prix', scenario_target: 'pit_heavy', source_url: 'https://livetiming.formula1.com/static/2026/2026-05-03_Miami_Grand_Prix/2026-05-03_Race/TimingData.jsonStream' },
  { round: 7, event: 'Canadian Grand Prix', scenario_target: 'current_season', source_url: 'https://livetiming.formula1.com/static/2026/2026-05-24_Canadian_Grand_Prix/2026-05-24_Race/TimingData.jsonStream' },
  { round: 8, event: 'Monaco Grand Prix', scenario_target: 'unclassified', source_url: 'https://livetiming.formula1.com/static/2026/2026-06-07_Monaco_Grand_Prix/2026-06-07_Race/TimingData.jsonStream' },
  { round: 9, event: 'Spanish Grand Prix', scenario_target: 'unclassified', source_url: 'https://livetiming.formula1.com/static/2026/2026-06-14_Spanish_Grand_Prix/2026-06-14_Race/TimingData.jsonStream' },
  { round: 10, event: 'Austrian Grand Prix', scenario_target: 'unclassified', source_url: 'https://livetiming.formula1.com/static/2026/2026-06-28_Austrian_Grand_Prix/2026-06-28_Race/TimingData.jsonStream' }
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

type OfficialContextStream = 'WeatherData' | 'RaceControlMessages' | 'TimingAppData';

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

function contextStreamUrl(sourceUrl: string, stream: OfficialContextStream): string {
  return sourceUrl.replace('TimingData.jsonStream', `${stream}.jsonStream`);
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

export function parseOfficialTimingLaps(content: string): Map<string, Map<number, number>> {
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
  return laps;
}

export function summarizeOfficialTimingLaps(content: string, racingNumbers = REQUIRED_RACING_NUMBERS): OfficialTimingLapSummary[] {
  const laps = parseOfficialTimingLaps(content);
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

export function observedOfficialRacingNumbers(content: string): string[] {
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

function parseJsonStream(content: string): unknown[] {
  const records: unknown[] = [];
  for (const rawLine of content.split('\n')) {
    const sourceLine = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const payload = /^\d{2}:\d{2}:\d{2}\.\d{3}(\{.*\})$/.exec(sourceLine)?.[1];
    if (!payload) continue;
    try { records.push(JSON.parse(payload)); } catch { continue; }
  }
  return records;
}

function valuesForKey(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([entryKey, entryValue]) => [
    ...(entryKey === key ? [entryValue] : []),
    ...valuesForKey(entryValue, key)
  ]);
}

function summarizeOfficialContext(weather: Buffer, raceControl: Buffer, timingApp: Buffer) {
  const rainfall = valuesForKey(parseJsonStream(weather.toString('utf8')), 'Rainfall');
  const messages = valuesForKey(parseJsonStream(raceControl.toString('utf8')), 'Message').filter((value): value is string => typeof value === 'string');
  const stints = valuesForKey(parseJsonStream(timingApp.toString('utf8')), 'Stints')
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object');
  return {
    rainfall_observed: rainfall.some((value) => value === '1' || value === 1),
    rainfall_samples: rainfall.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').length,
    safety_car_deployed: messages.some((message) => message === 'SAFETY CAR DEPLOYED'),
    safety_car_messages: messages.filter((message) => message === 'SAFETY CAR DEPLOYED').length,
    retirement_messages_observed: messages.filter((message) => /\bRETIRED\b/.test(message)).length,
    stint_record_updates: stints.reduce((count, stint) => count + Object.keys(stint).length, 0)
  };
}

type OfficialTimingReport = ReturnType<typeof writeOfficial2026PaceTimingArtifact>;
type OfficialContextReport = Awaited<ReturnType<typeof fetchOfficial2026PaceContextArtifacts>>;

export function createOfficial2026PaceCoverageMatrix(timingReports: OfficialTimingReport[], contextReports: OfficialContextReport[], unavailableRounds = new Map<number, string>()) {
  return OFFICIAL_2026_PACE_TIMING_CASES.map((testCase) => {
    const timing = timingReports.find((report) => report.round === testCase.round);
    const context = contextReports.find((report) => report.round === testCase.round);
    if (!timing) {
      if (!unavailableRounds.has(testCase.round)) throw new Error(`FAIL_CLOSED: missing official artifact report for 2026 round ${testCase.round}`);
      return {
        round: testCase.round,
        event: testCase.event,
        official_timing: { source_url: testCase.source_url, availability: 'unavailable' as const },
        official_context: ['WeatherData', 'RaceControlMessages', 'TimingAppData'].map((stream) => ({ stream, source_url: contextStreamUrl(testCase.source_url, stream), availability: 'not_fetched_after_timing_artifact_unavailable' as const })),
        context_classification: { dry: 'unavailable' as const, disrupted: 'unavailable' as const, retirement: 'unavailable' as const, pit_heavy: 'unavailable' as const },
        v2_eligible_driver_coverage: { status: 'not_assessed' as const, reason: unavailableRounds.get(testCase.round)! }
      };
    }
    if (!context) {
      if (!unavailableRounds.has(testCase.round)) throw new Error(`FAIL_CLOSED: missing official context report for 2026 round ${testCase.round}`);
      return {
        round: testCase.round,
        event: testCase.event,
        official_timing: { source_url: timing.source_url, sha256: timing.artifact_sha256, bytes: timing.bytes, availability: 'retained' as const },
        official_context: ['WeatherData', 'RaceControlMessages', 'TimingAppData'].map((stream) => ({ stream, source_url: contextStreamUrl(testCase.source_url, stream), availability: 'unavailable' as const })),
        context_classification: { dry: 'unavailable' as const, disrupted: 'unavailable' as const, retirement: 'unavailable' as const, pit_heavy: 'unavailable' as const },
        v2_eligible_driver_coverage: { status: 'not_assessed' as const, reason: unavailableRounds.get(testCase.round)! }
      };
    }
    const observedDrivers = timing.laps.length;
    const timedDrivers = timing.laps.filter((lap) => lap.timed_laps > 0).length;
    return {
      round: testCase.round,
      event: testCase.event,
      official_timing: {
        source_url: timing.source_url,
        sha256: timing.artifact_sha256,
        bytes: timing.bytes,
        observed_drivers: observedDrivers,
        timed_drivers: timedDrivers,
        completeness: timedDrivers === observedDrivers ? 'complete' as const : 'partial' as const
      },
      official_context: Object.fromEntries(Object.entries(context.artifacts).map(([stream, artifact]) => [stream, {
        source_url: artifact.source_url,
        sha256: artifact.artifact_sha256,
        bytes: artifact.bytes
      }])),
      context_classification: {
        dry: context.context.rainfall_samples > 0 && !context.context.rainfall_observed ? 'no_rainfall_observed' as const : context.context.rainfall_observed ? 'rainfall_observed' as const : 'unavailable' as const,
        disrupted: context.context.safety_car_deployed ? 'safety_car_deployed' as const : 'no_safety_car_deployment_observed' as const,
        retirement: context.context.retirement_messages_observed > 0 ? 'retirement_messages_observed' as const : 'no_retirement_message_observed' as const,
        pit_heavy: 'not_established_from_incremental_stint_updates' as const
      },
      v2_eligible_driver_coverage: {
        status: 'not_assessed' as const,
        reason: 'requires a separate read-only v2 observation and a reviewed racing-number-to-driver mapping; official artifacts do not provide the shared clean-air/pit/in-lap/out-lap eligibility fields'
      }
    };
  });
}

export async function fetchOfficial2026PaceContextArtifacts(
  testCase: typeof OFFICIAL_2026_PACE_TIMING_CASES[number],
  fetcher: (url: string) => Promise<FetchResponse> = fetchOfficialTimingData,
  now: () => Date = () => new Date(),
  temporaryDirectory = os.tmpdir()
) {
  validateOfficial2026PaceTimingArtifactUrl(testCase.source_url);
  const streams = {} as Record<OfficialContextStream, { content: Buffer; content_type: string | null; retrieved_at: string }>;
  for (const stream of ['WeatherData', 'RaceControlMessages', 'TimingAppData'] as const) {
    const sourceUrl = contextStreamUrl(testCase.source_url, stream);
    const response = await fetcher(sourceUrl);
    if (!response.ok) throw new Error(`FAIL_CLOSED: official F1 ${stream} artifact request failed with status ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (!content.length || !/^\uFEFF?\d{2}:\d{2}:\d{2}\.\d{3}\{/.test(content.toString('utf8', 0, 35))) {
      throw new Error(`FAIL_CLOSED: official F1 ${stream} artifact is not a JSON stream`);
    }
    streams[stream] = { content, content_type: response.headers.get('content-type'), retrieved_at: now().toISOString() };
  }
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, `pace-v2-2026-r${testCase.round}-f1-context-`), { encoding: 'utf8' });
  const artifacts = Object.fromEntries((['WeatherData', 'RaceControlMessages', 'TimingAppData'] as const).map((stream) => {
    const artifact = streams[stream];
    const output = path.join(directory, `${stream}.jsonStream`);
    fs.writeFileSync(output, artifact.content, { flag: 'wx', mode: 0o600 });
    return [stream, { source_url: contextStreamUrl(testCase.source_url, stream), output, artifact_sha256: sha256(artifact.content), bytes: artifact.content.length, retrieved_at: artifact.retrieved_at, content_type: artifact.content_type }];
  }));
  return {
    version: 1 as const,
    authority: 'Formula 1' as const,
    round: testCase.round,
    event: testCase.event,
    assertion_scope: 'official_event_context_fields_only' as const,
    context: summarizeOfficialContext(streams.WeatherData.content, streams.RaceControlMessages.content, streams.TimingAppData.content),
    artifacts,
    f1ql_pace_comparison: 'unsupported_without_shared_clean_air_and_pit_eligibility_fields' as const
  };
}

export function writeOfficial2026PaceTimingArtifact(
  testCase: typeof OFFICIAL_2026_PACE_TIMING_CASES[number],
  artifact: { content: Buffer; content_type: string | null; retrieved_at: string },
  temporaryDirectory = os.tmpdir()
) {
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, `pace-v2-2026-r${testCase.round}-f1-timing-`), { encoding: 'utf8' });
  const output = path.join(directory, 'TimingData.jsonStream');
  fs.writeFileSync(output, artifact.content, { flag: 'wx', mode: 0o600 });
  const observedNumbers = observedOfficialRacingNumbers(artifact.content.toString('utf8'));
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
  if (process.argv[2] === '--all-2026-context') {
    const reports = [];
    for (const testCase of OFFICIAL_2026_PACE_TIMING_CASES) reports.push(await fetchOfficial2026PaceContextArtifacts(testCase));
    process.stdout.write(`${JSON.stringify({ status: 'collected', assertion_scope: 'official_event_context_fields_only', reports })}\n`);
    return;
  }
  if (process.argv[2] === '--all-2026-inventory') {
    const timingReports: OfficialTimingReport[] = [];
    const contextReports: OfficialContextReport[] = [];
    const unavailableRounds = new Map<number, string>();
    for (const testCase of OFFICIAL_2026_PACE_TIMING_CASES) {
      try {
        timingReports.push(writeOfficial2026PaceTimingArtifact(testCase, await fetchOfficial2026PaceTimingArtifact(testCase.source_url)));
      } catch {
        unavailableRounds.set(testCase.round, 'official_timing_artifact_unavailable_from_reviewed_url');
        continue;
      }
      try {
        contextReports.push(await fetchOfficial2026PaceContextArtifacts(testCase));
      } catch {
        unavailableRounds.set(testCase.round, 'official_context_artifact_unavailable_from_reviewed_url');
      }
    }
    process.stdout.write(`${JSON.stringify({ version: 1, status: 'collected', assertion_scope: 'official_artifact_availability_and_literal_context_fields_only', coverage_matrix: createOfficial2026PaceCoverageMatrix(timingReports, contextReports, unavailableRounds), f1ql_clean_air_pace_comparison: 'unsupported_without_shared_eligibility_fields' })}\n`);
    return;
  }
  const artifact = await fetchRound2LapTimingArtifact();
  process.stdout.write(`${JSON.stringify(writeRound2LapTimingArtifact(artifact))}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'pace_v2_round2_lap_timing_artifact_failed' })}\n`);
  process.exitCode = 1;
});
