import 'dotenv/config';
import { Pool } from 'pg';
import {
  PACE_V2_IDENTITY_REPAIR_METHODOLOGY_VERSION,
  PACE_V2_IDENTITY_REPAIR_SEASON,
  PaceV2FactRow,
  PaceV2IdentityRepairManifest,
  createPaceV2IdentityRepairManifest,
  fingerprintPaceV2FactRows,
  parsePaceV2IdentityRepairManifest
} from '../src/etl/pace-v2-identity-repair';
import { PACE_V2_APPROVED_TRACK_ID_RECONCILIATION } from '../src/etl/pace-v2-manifest';

const STATEMENT_TIMEOUT_MS = 5_000;
const REPAIR_ROUND = 1;
const REPAIR_SESSION_TYPE = 'R';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

export function requirePaceV2IdentityRepairManifestConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_IDENTITY_REPAIR_MANIFEST_ENABLED !== 'true') throw new Error('Set PACE_V2_IDENTITY_REPAIR_MANIFEST_ENABLED=true to generate an identity repair manifest.');
  if (environment.PACE_V2_IDENTITY_REPAIR_MANIFEST_TARGET !== 'production') throw new Error('Set PACE_V2_IDENTITY_REPAIR_MANIFEST_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the identity repair manifest generator.');
  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new Error('Identity repair manifest generator refuses local database targets.');
  return environment.DATABASE_URL;
}

function asFactRows(rows: Record<string, unknown>[]): PaceV2FactRow[] {
  return rows.map((row) => ({
    season: Number(row.season), round: Number(row.round), track_id: String(row.track_id), driver_id: String(row.driver_id),
    session_type: String(row.session_type), lap_number: Number(row.lap_number), stint_id: Number(row.stint_id),
    stint_lap_index: Number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : Number(row.lap_time_seconds),
    is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap),
    is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound),
    tyre_age_laps: row.tyre_age_laps === null ? null : Number(row.tyre_age_laps), methodology_version: String(row.methodology_version)
  }));
}

export async function generatePaceV2IdentityRepairManifest(pool: QueryPool): Promise<PaceV2IdentityRepairManifest> {
  const fromTrackId = 'australian_grand_prix';
  const toTrackId = PACE_V2_APPROVED_TRACK_ID_RECONCILIATION[fromTrackId];
  if (toTrackId !== 'melbourne') throw new Error('FAIL_CLOSED: identity repair mapping is not exactly approved');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const result = await client.query(`SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = $1 AND round = $2 AND session_type = $3`, [PACE_V2_IDENTITY_REPAIR_SEASON, REPAIR_ROUND, REPAIR_SESSION_TYPE]);
    const sourceRows = asFactRows(result.rows);
    if (!sourceRows.length || sourceRows.some((row) => row.track_id !== fromTrackId || row.methodology_version !== PACE_V2_IDENTITY_REPAIR_METHODOLOGY_VERSION)) {
      throw new Error('FAIL_CLOSED: persisted rows do not match the exact approved source contract');
    }
    const manifest = createPaceV2IdentityRepairManifest({
      season: PACE_V2_IDENTITY_REPAIR_SEASON, round: REPAIR_ROUND, session_type: REPAIR_SESSION_TYPE,
      methodology_version: PACE_V2_IDENTITY_REPAIR_METHODOLOGY_VERSION, from_track_id: fromTrackId, to_track_id: toTrackId,
      fact_row_count: sourceRows.length, source_fact_fingerprint: fingerprintPaceV2FactRows(sourceRows),
      target_fact_fingerprint: fingerprintPaceV2FactRows(sourceRows.map((row) => ({ ...row, track_id: toTrackId })))
    });
    await client.query('ROLLBACK');
    return parsePaceV2IdentityRepairManifest(manifest);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function main() {
  const connectionString = requirePaceV2IdentityRepairManifestConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await generatePaceV2IdentityRepairManifest(pool))}\n`); } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_identity_repair_manifest_failed"}\n'); process.exitCode = 1; });
