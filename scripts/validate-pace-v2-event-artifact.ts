import 'dotenv/config';
import { Pool } from 'pg';
import { createHash } from 'crypto';

const ACTIVE_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

export function requirePaceV2EventArtifactConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_EVENT_ARTIFACT_ENABLED !== 'true') throw new Error('Set PACE_V2_EVENT_ARTIFACT_ENABLED=true to emit a pace event artifact.');
  if (environment.PACE_V2_EVENT_ARTIFACT_TARGET !== 'production') throw new Error('Set PACE_V2_EVENT_ARTIFACT_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the pace event artifact.');
  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new Error('Pace event artifact refuses local database targets.');
  return environment.DATABASE_URL;
}

export async function runPaceV2EventArtifact(pool: QueryPool, season: number, round: number) {
  if (!Number.isInteger(season) || !Number.isInteger(round) || round < 1) throw new Error('season and round must be positive integers');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const rows = await client.query<{ track_id: string; driver_id: string; eligible_laps: string; median_lap_time_seconds: string }>(`
      SELECT track_id, driver_id, COUNT(*)::text AS eligible_laps,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lap_time_seconds)::text AS median_lap_time_seconds
      FROM laps_normalized_v2
      WHERE season = $1 AND round = $2 AND session_type = 'R' AND methodology_version = $3
        AND lap_time_seconds IS NOT NULL AND is_valid_lap = true AND is_pit_lap = false AND is_in_lap = false AND is_out_lap = false
      GROUP BY track_id, driver_id
      HAVING COUNT(*) >= 2
      ORDER BY median_lap_time_seconds::numeric ASC, driver_id ASC
      LIMIT 30
    `, [season, round, ACTIVE_METHODOLOGY_VERSION]);
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
  const connectionString = requirePaceV2EventArtifactConfiguration();
  const [seasonRaw, roundRaw] = process.argv.slice(2);
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await runPaceV2EventArtifact(pool, Number(seasonRaw), Number(roundRaw)))}\n`); } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_event_artifact_failed"}\n'); process.exitCode = 1; });
