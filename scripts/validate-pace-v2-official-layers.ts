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

function retainedTimingArtifact(round: number): { url: string; sha256: string } {
  const matrix = JSON.parse(fs.readFileSync(COVERAGE_MATRIX_PATH, 'utf8')) as { rounds: Array<{ round: number; timing: { url: string; sha256?: string } }> };
  const timing = matrix.rounds.find((entry) => entry.round === round)?.timing;
  if (!timing?.sha256) throw new Error(`no retained official timing provenance is available for 2026 round ${round}`);
  return { url: timing.url, sha256: timing.sha256 };
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

export async function validateOfficialPaceLayers(pool: QueryPool, round: number, artifact: Buffer, retained = retainedTimingArtifact(round)) {
  const artifactSha256 = sha256(artifact);
  if (artifactSha256 !== retained.sha256) throw new Error('official timing artifact SHA-256 does not match the retained provenance matrix');
  const officialLaps = parseOfficialTimingLaps(artifact.toString('utf8'));
  const officialObservedDrivers = observedOfficialRacingNumbers(artifact.toString('utf8')).length;
  const officialTimedDrivers = [...officialLaps.values()].filter((laps) => laps.size > 0).length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const result = await client.query<V2Lap>(`
      SELECT driver_id, lap_number, lap_time_seconds::text::numeric AS lap_time_seconds,
             is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag
      FROM laps_normalized_v2
      WHERE season = 2026 AND round = $1 AND session_type = 'R' AND methodology_version = $2
      ORDER BY driver_id, lap_number
      LIMIT 5000
    `, [round, ACTIVE_METHODOLOGY_VERSION]);
    await client.query('ROLLBACK');
    const v2Laps = result.rows.map((lap) => ({ ...lap, lap_number: Number(lap.lap_number), lap_time_seconds: lap.lap_time_seconds === null ? null : Number(lap.lap_time_seconds) }));
    const v2Drivers = new Set(v2Laps.map((lap) => lap.driver_id));
    const evidence = v2Laps.map((lap) => {
      const exclusions = exclusionReasons(lap);
      return {
        driver_id: lap.driver_id,
        lap_number: lap.lap_number,
        v2_eligibility: exclusions.length ? 'excluded' as const : 'eligible' as const,
        exclusion_reasons: exclusions,
        official_raw_lap_comparison: 'unverified' as const,
        official_raw_lap_comparison_reason: 'official_timing_uses_racing_numbers_and_no_reviewed_racing_number_to_v2_driver_mapping_is_retained',
        official_clean_air_pit_metadata: 'unavailable_not_inferred' as const
      };
    });
    return {
      status: 'completed', assertion_scope: 'official_raw_timing_provenance_and_read_only_v2_observation', statement_timeout_ms: 5000,
      official_artifact: { source_url: retained.url, sha256: retained.sha256, bytes: artifact.length, observed_racing_numbers: officialObservedDrivers, timed_racing_numbers: officialTimedDrivers },
      layer_1_driver_coverage: { status: 'unverified', official_racing_number_count: officialObservedDrivers, v2_driver_count: v2Drivers.size, reason: 'no_reviewed_racing_number_to_v2_driver_mapping_is_retained' },
      layer_2_raw_lap_times: { status: 'unverified', official_completed_laps: [...officialLaps.values()].reduce((count, laps) => count + laps.size, 0), v2_laps: v2Laps.length, reason: 'no_reviewed_racing_number_to_v2_driver_mapping_is_retained' },
      layer_3_eligibility_evidence: { status: 'unverified_against_official_source', evidence, reason: 'official_timing_artifact_lacks_reviewed_clean_air_pit_in_lap_and_out_lap_fields' }
    };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main(): Promise<void> {
  const [roundRaw, artifactPath] = process.argv.slice(2);
  const round = Number(roundRaw);
  if (!Number.isInteger(round) || round < 1 || !artifactPath) throw new Error('usage: validate:pace-v2:official-layers:production -- <round> <retained TimingData.jsonStream path>');
  const connectionString = requireOfficialLayersConfiguration();
  const result = await validateOfficialPaceLayers(new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 }), round, fs.readFileSync(artifactPath));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main().catch((error) => { process.stdout.write(`${JSON.stringify({ status: 'refused', reason: error instanceof Error ? error.message : 'official_layers_validation_failed' })}\n`); process.exitCode = 1; });
