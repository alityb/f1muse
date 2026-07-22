import 'dotenv/config';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { observedOfficialRacingNumbers, parseOfficialTimingLaps } from './fetch-pace-v2-round2-lap-timing-artifact';

const ACTIVE_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';
const COVERAGE_MATRIX_PATH = path.join(process.cwd(), 'data/pace-v2-official-2026-coverage-matrix.json');

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

type V2Lap = { driver_id: string; lap_number: number; lap_time_seconds: number | null; is_valid_lap: boolean; is_pit_lap: boolean; is_in_lap: boolean; is_out_lap: boolean; clean_air_flag: boolean };
type CanonicalDriver = { driver_id: string; driver_code: string; racing_number: string };
type OfficialDriver = { racing_number: string; tla: string };

function sha256(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }

export function requireOfficialLayersConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_OFFICIAL_LAYERS_ENABLED !== 'true') throw new Error('PACE_V2_OFFICIAL_LAYERS_ENABLED=true is required');
  if (environment.PACE_V2_OFFICIAL_LAYERS_TARGET !== 'production') throw new Error('PACE_V2_OFFICIAL_LAYERS_TARGET=production is required');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let hostname: string;
  try { hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase(); } catch { throw new Error('DATABASE_URL must be a valid connection URL'); }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new Error('official layers validation refuses local database targets');
  return environment.DATABASE_URL;
}

function retainedOfficialArtifacts(round: number): { timing: { url: string; sha256: string }; driverList: { url: string; sha256: string } } {
  const matrix = JSON.parse(fs.readFileSync(COVERAGE_MATRIX_PATH, 'utf8')) as { rounds: Array<{ round: number; timing: { url: string; sha256?: string }; driver_list?: { url: string; sha256?: string } }> };
  const entry = matrix.rounds.find((candidate) => candidate.round === round);
  if (!entry?.timing.sha256) throw new Error(`no retained official timing provenance is available for 2026 round ${round}`);
  if (!entry.driver_list?.sha256) throw new Error(`no retained official DriverList provenance is available for 2026 round ${round}`);
  return { timing: { url: entry.timing.url, sha256: entry.timing.sha256 }, driverList: { url: entry.driver_list.url, sha256: entry.driver_list.sha256 } };
}

export function parseOfficialDriverList(content: string): OfficialDriver[] {
  const drivers = new Map<string, OfficialDriver>();
  for (const rawLine of content.split('\n')) {
    const sourceLine = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const payload = /^\d{2}:\d{2}:\d{2}\.\d{3}(\{.*\})$/.exec(sourceLine)?.[1];
    if (!payload) continue;
    try {
      const record = JSON.parse(payload) as Record<string, { RacingNumber?: string; Tla?: string }>;
      for (const [key, driver] of Object.entries(record)) {
        const racingNumber = driver.RacingNumber?.trim() || key.trim();
        const tla = driver.Tla?.trim().toUpperCase();
        if (racingNumber && tla) drivers.set(racingNumber, { racing_number: racingNumber, tla });
      }
    } catch { continue; }
  }
  return [...drivers.values()].sort((left, right) => Number(left.racing_number) - Number(right.racing_number));
}

export function exclusionReasons(lap: V2Lap): string[] {
  const reasons: string[] = [];
  if (lap.lap_time_seconds === null) reasons.push('v2_lap_time_missing');
  if (!lap.is_valid_lap) reasons.push('v2_lap_marked_invalid');
  if (lap.is_pit_lap) reasons.push('v2_lap_marked_pit');
  if (lap.is_in_lap) reasons.push('v2_lap_marked_in_lap');
  if (lap.is_out_lap) reasons.push('v2_lap_marked_out_lap');
  return reasons;
}

export async function validateOfficialPaceLayers(pool: QueryPool, round: number, timingArtifact: Buffer, driverListArtifact: Buffer, retained = retainedOfficialArtifacts(round)) {
  if (sha256(timingArtifact) !== retained.timing.sha256) throw new Error('official timing artifact SHA-256 does not match the retained provenance matrix');
  if (sha256(driverListArtifact) !== retained.driverList.sha256) throw new Error('official DriverList artifact SHA-256 does not match the retained provenance matrix');
  const officialLaps = parseOfficialTimingLaps(timingArtifact.toString('utf8'));
  const officialDrivers = parseOfficialDriverList(driverListArtifact.toString('utf8'));
  if (!officialDrivers.length) throw new Error('official DriverList artifact contains no racing-number/TLA mappings');
  const officialObservedDrivers = observedOfficialRacingNumbers(timingArtifact.toString('utf8')).length;
  const officialTimedDrivers = [...officialLaps.values()].filter((laps) => laps.size > 0).length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const [lapsResult, canonicalDriversResult] = await Promise.all([
      client.query<V2Lap>(`
      SELECT driver_id, lap_number, lap_time_seconds::text::numeric AS lap_time_seconds,
             is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag
      FROM laps_normalized_v2
      WHERE season = 2026 AND round = $1 AND session_type = 'R' AND methodology_version = $2
      ORDER BY driver_id, lap_number
      LIMIT 5000
    `, [round, ACTIVE_METHODOLOGY_VERSION]),
      client.query<CanonicalDriver>(`
        SELECT DISTINCT rd.driver_id, d.abbreviation AS driver_code, BTRIM(rd.driver_number) AS racing_number
        FROM race r
        JOIN race_data rd ON rd.race_id = r.id AND LOWER(rd.type) IN ('race', 'race_result')
        JOIN driver d ON d.id = rd.driver_id
        WHERE r.year = 2026 AND r.round = $1 AND BTRIM(COALESCE(rd.driver_number, '')) <> ''
        ORDER BY rd.driver_id
      `, [round])
    ]);
    await client.query('ROLLBACK');
    const v2Laps = lapsResult.rows.map((lap) => ({ ...lap, lap_number: Number(lap.lap_number), lap_time_seconds: lap.lap_time_seconds === null ? null : Number(lap.lap_time_seconds) }));
    const v2Drivers = new Set(v2Laps.map((lap) => lap.driver_id));
    const officialByNumber = new Map(officialDrivers.map((driver) => [driver.racing_number, driver]));
    const canonicalByNumber = new Map<string, CanonicalDriver>();
    for (const driver of canonicalDriversResult.rows) {
      if (canonicalByNumber.has(driver.racing_number)) throw new Error(`canonical racing number is ambiguous: ${driver.racing_number}`);
      const official = officialByNumber.get(driver.racing_number);
      if (!official || official.tla !== driver.driver_code.trim().toUpperCase()) throw new Error(`canonical racing-number mapping is not an exact official DriverList match: ${driver.racing_number}`);
      canonicalByNumber.set(driver.racing_number, driver);
    }
    if (canonicalByNumber.size !== officialByNumber.size || [...officialByNumber.keys()].some((number) => !canonicalByNumber.has(number))) throw new Error('canonical racing-number mapping does not cover the official DriverList exactly');
    const canonicalByDriverId = new Map([...canonicalByNumber.values()].map((driver) => [driver.driver_id, driver]));
    if ([...v2Drivers].some((driverId) => !canonicalByDriverId.has(driverId))) throw new Error('v2 driver is missing from the exact official racing-number mapping');
    const officialLapKeys = new Set([...officialLaps.entries()].flatMap(([racingNumber, laps]) => [...laps.keys()].map((lapNumber) => `${racingNumber}:${lapNumber}`)));
    const comparedOfficialLapKeys = new Set<string>();
    const evidence = v2Laps.map((lap) => {
      const exclusions = exclusionReasons(lap);
      const racingNumber = canonicalByDriverId.get(lap.driver_id)!.racing_number;
      const officialLapTimeSeconds = officialLaps.get(racingNumber)?.get(lap.lap_number);
      const comparison = lap.lap_time_seconds === null ? 'not_comparable_v2_lap_time_missing' : officialLapTimeSeconds === undefined ? 'official_lap_unavailable' : lap.lap_time_seconds === officialLapTimeSeconds ? 'equal' : 'not_equal';
      if (officialLapTimeSeconds !== undefined) comparedOfficialLapKeys.add(`${racingNumber}:${lap.lap_number}`);
      return {
        driver_id: lap.driver_id,
        racing_number: racingNumber,
        lap_number: lap.lap_number,
        v2_raw_lap_time_seconds: lap.lap_time_seconds,
        official_raw_lap_time_seconds: officialLapTimeSeconds ?? null,
        official_raw_lap_comparison: comparison,
        v2_eligibility: exclusions.length ? 'excluded' as const : 'eligible' as const,
        exclusion_reasons: exclusions,
        official_clean_air_pit_metadata: 'unavailable_not_inferred' as const
      };
    });
    const equal = evidence.filter((entry) => entry.official_raw_lap_comparison === 'equal').length;
    const notEqual = evidence.filter((entry) => entry.official_raw_lap_comparison === 'not_equal').length;
    const unavailable = evidence.length - equal - notEqual;
    return {
      status: 'completed', assertion_scope: 'official_raw_timing_provenance_and_read_only_v2_observation', statement_timeout_ms: 5000,
      official_artifacts: { timing: { source_url: retained.timing.url, sha256: retained.timing.sha256, bytes: timingArtifact.length, observed_racing_numbers: officialObservedDrivers, timed_racing_numbers: officialTimedDrivers }, driver_list: { source_url: retained.driverList.url, sha256: retained.driverList.sha256, bytes: driverListArtifact.length, racing_number_mappings: officialDrivers.length } },
      layer_1_driver_coverage: { status: 'mapped_exactly', official_racing_number_count: officialObservedDrivers, official_driver_list_count: officialDrivers.length, canonical_driver_count: canonicalByNumber.size, v2_driver_count: v2Drivers.size, v2_drivers_without_raw_timing: officialDrivers.length - v2Drivers.size },
      layer_2_raw_lap_times: { status: notEqual === 0 && unavailable === 0 ? 'equal_for_all_v2_laps' : 'completed_with_coverage_or_equality_gaps', official_completed_laps: officialLapKeys.size, v2_laps: v2Laps.length, equal_v2_laps: equal, non_equal_v2_laps: notEqual, v2_laps_without_official_time: unavailable, official_laps_without_v2: officialLapKeys.size - comparedOfficialLapKeys.size, comparison: 'exact_numeric_seconds_no_tolerance' },
      layer_3_eligibility_evidence: { status: 'unverified_against_official_source', evidence, reason: 'official_timing_artifact_lacks_reviewed_clean_air_pit_in_lap_and_out_lap_fields' }
    };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main(): Promise<void> {
  const [roundRaw, timingArtifactPath, driverListArtifactPath] = process.argv.slice(2);
  const round = Number(roundRaw);
  if (!Number.isInteger(round) || round < 1 || !timingArtifactPath || !driverListArtifactPath) throw new Error('usage: validate:pace-v2:official-layers:production -- <round> <retained TimingData.jsonStream path> <retained DriverList.jsonStream path>');
  const connectionString = requireOfficialLayersConfiguration();
  const result = await validateOfficialPaceLayers(new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 }), round, fs.readFileSync(timingArtifactPath), fs.readFileSync(driverListArtifactPath));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main().catch((error) => { process.stdout.write(`${JSON.stringify({ status: 'refused', reason: error instanceof Error ? error.message : 'official_layers_validation_failed' })}\n`); process.exitCode = 1; });
