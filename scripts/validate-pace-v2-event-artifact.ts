import 'dotenv/config';
import { Pool } from 'pg';
import { createHash } from 'crypto';

const ACTIVE_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

type PaceV2EventArtifactRefusalReason =
  | 'event_artifact_not_enabled'
  | 'event_artifact_target_not_production'
  | 'database_url_missing'
  | 'database_url_invalid'
  | 'local_database_target'
  | 'event_arguments_invalid'
  | 'event_median_query_failed'
  | 'event_artifact_runtime_failure';

interface PaceV2EventArtifactRefusal {
  status: 'refused';
  error: 'pace_v2_event_artifact_failed';
  reason: PaceV2EventArtifactRefusalReason;
  predicate?: 'eligible_lap_driver_median';
  database_code?: string;
}

class PaceV2EventArtifactConfigurationError extends Error {
  constructor(readonly reason: Extract<PaceV2EventArtifactRefusalReason, 'event_artifact_not_enabled' | 'event_artifact_target_not_production' | 'database_url_missing' | 'database_url_invalid' | 'local_database_target' | 'event_arguments_invalid'>, message: string) {
    super(message);
  }
}

class PaceV2EventArtifactQueryError extends Error {
  constructor(readonly databaseCode: string | undefined) {
    super('The eligible-lap driver-median query failed.');
  }
}

export function requirePaceV2EventArtifactConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_EVENT_ARTIFACT_ENABLED !== 'true') throw new PaceV2EventArtifactConfigurationError('event_artifact_not_enabled', 'Set PACE_V2_EVENT_ARTIFACT_ENABLED=true to emit a pace event artifact.');
  if (environment.PACE_V2_EVENT_ARTIFACT_TARGET !== 'production') throw new PaceV2EventArtifactConfigurationError('event_artifact_target_not_production', 'Set PACE_V2_EVENT_ARTIFACT_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new PaceV2EventArtifactConfigurationError('database_url_missing', 'DATABASE_URL is required for the pace event artifact.');
  let hostname: string;
  try { hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase(); } catch { throw new PaceV2EventArtifactConfigurationError('database_url_invalid', 'DATABASE_URL must be a valid connection URL.'); }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new PaceV2EventArtifactConfigurationError('local_database_target', 'Pace event artifact refuses local database targets.');
  return environment.DATABASE_URL;
}

function databaseCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function paceV2EventArtifactRefusal(error: unknown): PaceV2EventArtifactRefusal {
  if (error instanceof PaceV2EventArtifactConfigurationError) return { status: 'refused', error: 'pace_v2_event_artifact_failed', reason: error.reason };
  if (error instanceof PaceV2EventArtifactQueryError) return { status: 'refused', error: 'pace_v2_event_artifact_failed', reason: 'event_median_query_failed', predicate: 'eligible_lap_driver_median', ...(error.databaseCode ? { database_code: error.databaseCode } : {}) };
  return { status: 'refused', error: 'pace_v2_event_artifact_failed', reason: 'event_artifact_runtime_failure' };
}

export async function runPaceV2EventArtifact(pool: QueryPool, season: number, round: number) {
  if (!Number.isInteger(season) || !Number.isInteger(round) || round < 1) throw new Error('season and round must be positive integers');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    let rows: { rows: Array<{ track_id: string; driver_id: string; eligible_laps: string; median_lap_time_seconds: string }> };
    try {
      rows = await client.query(`
        WITH driver_medians AS (
          SELECT event_id AS track_id, driver_id, COUNT(*)::text AS eligible_laps,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY lap_time_seconds)::text AS median_lap_time_seconds
          FROM f1ql.lap_pace
          WHERE season = $1 AND round = $2 AND session_type = 'R' AND methodology_version = $3
            AND lap_time_seconds IS NOT NULL AND is_valid_lap = true AND is_pit_lap = false AND is_in_lap = false AND is_out_lap = false
          GROUP BY event_id, driver_id
          HAVING COUNT(*) >= 2
        )
        SELECT * FROM driver_medians
        ORDER BY median_lap_time_seconds::numeric ASC, driver_id ASC
        LIMIT 30
      `, [season, round, ACTIVE_METHODOLOGY_VERSION]);
    } catch (error) { throw new PaceV2EventArtifactQueryError(databaseCode(error)); }
    await client.query('ROLLBACK');
    const observations = rows.rows.map((row) => ({ track_id: row.track_id, driver_id: row.driver_id, eligible_laps: Number(row.eligible_laps), median_lap_time_seconds: Number(row.median_lap_time_seconds) }));
    return {
      status: observations.length ? 'observed' : 'no_eligible_samples', statement_timeout_ms: 5000,
      assertion_scope: 'database_observation_only', external_truth: 'unverified_without_authoritative_artifact',
      selected_event: { season, round, session_type: 'R', methodology_version: ACTIVE_METHODOLOGY_VERSION },
      observation_fingerprint: createHash('sha256').update(JSON.stringify(observations)).digest('hex'), observations
    };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main() {
  const [seasonRaw, roundRaw] = process.argv.slice(2);
  const result = await runPaceV2EventArtifactCli(process.env, seasonRaw, roundRaw, (connectionString) => new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 }), (line) => process.stdout.write(line));
  if (result.status === 'refused') process.exitCode = 1;
}

export async function runPaceV2EventArtifactCli(environment: NodeJS.ProcessEnv, seasonRaw: string | undefined, roundRaw: string | undefined, poolFactory: (connectionString: string) => QueryPool, write: (line: string) => void): Promise<ReturnType<typeof paceV2EventArtifactRefusal> | Awaited<ReturnType<typeof runPaceV2EventArtifact>>> {
  try {
    const season = Number(seasonRaw);
    const round = Number(roundRaw);
    if (!Number.isInteger(season) || !Number.isInteger(round) || round < 1) throw new PaceV2EventArtifactConfigurationError('event_arguments_invalid', 'season and round must be positive integers');
    const pool = poolFactory(requirePaceV2EventArtifactConfiguration(environment));
    let result: Awaited<ReturnType<typeof runPaceV2EventArtifact>>;
    try { result = await runPaceV2EventArtifact(pool, season, round); } finally { await pool.end(); }
    write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const refusal = paceV2EventArtifactRefusal(error);
    write(`${JSON.stringify(refusal)}\n`);
    return refusal;
  }
}

if (require.main === module) void main();
