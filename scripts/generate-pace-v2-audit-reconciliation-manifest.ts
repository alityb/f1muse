import 'dotenv/config';
import { Pool } from 'pg';
import { PaceV2FactRow, fingerprintPaceV2FactRows } from '../src/etl/pace-v2-identity-repair';
import { PACE_V2_AUDIT_RECONCILIATION_METHODOLOGY_VERSION, PaceV2AuditReconciliationManifest, createPaceV2AuditReconciliationManifest, parsePaceV2AuditReconciliationManifest } from '../src/etl/pace-v2-audit-reconciliation';

const STATEMENT_TIMEOUT_MS = 5_000;
interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

function asFactRows(rows: Record<string, unknown>[]): PaceV2FactRow[] {
  return rows.map((row) => ({
    season: Number(row.season), round: Number(row.round), track_id: String(row.track_id), driver_id: String(row.driver_id), session_type: String(row.session_type), lap_number: Number(row.lap_number), stint_id: Number(row.stint_id), stint_lap_index: Number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : Number(row.lap_time_seconds), is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap), is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound), tyre_age_laps: row.tyre_age_laps === null ? null : Number(row.tyre_age_laps), methodology_version: String(row.methodology_version)
  }));
}

export function requirePaceV2AuditReconciliationManifestConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_AUDIT_RECONCILIATION_MANIFEST_ENABLED !== 'true') throw new Error('Set PACE_V2_AUDIT_RECONCILIATION_MANIFEST_ENABLED=true to generate a reconciliation manifest.');
  if (environment.PACE_V2_AUDIT_RECONCILIATION_MANIFEST_TARGET !== 'production') throw new Error('Set PACE_V2_AUDIT_RECONCILIATION_MANIFEST_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the reconciliation manifest generator.');
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(environment.DATABASE_URL).hostname.toLowerCase())) throw new Error('Reconciliation manifest generator refuses local database targets.');
  return environment.DATABASE_URL;
}

export async function generatePaceV2AuditReconciliationManifest(pool: QueryPool, season: number, round: number): Promise<PaceV2AuditReconciliationManifest> {
  if (!Number.isInteger(season) || !Number.isInteger(round) || round < 1) throw new Error('FAIL_CLOSED: reconciliation requires one valid season and round');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const audit = await client.query<{ session_type: string; fact_fingerprint: string; fact_row_count: number; methodology_version: string }>('SELECT session_type, fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_round_audit WHERE season = $1 AND round = $2 AND session_type = $3', [season, round, 'R']);
    const facts = await client.query('SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = $1 AND round = $2 AND session_type = $3 ORDER BY driver_id, lap_number', [season, round, 'R']);
    const rows = asFactRows(facts.rows);
    const original = audit.rows[0];
    if (audit.rows.length !== 1 || !rows.length || !original || original.session_type !== 'R' || Number(original.fact_row_count) !== rows.length || original.methodology_version !== PACE_V2_AUDIT_RECONCILIATION_METHODOLOGY_VERSION || rows.some((row) => row.methodology_version !== PACE_V2_AUDIT_RECONCILIATION_METHODOLOGY_VERSION)) throw new Error('FAIL_CLOSED: original audit differs by more than the approved fingerprint mismatch class');
    const currentFactFingerprint = fingerprintPaceV2FactRows(rows);
    const manifest = createPaceV2AuditReconciliationManifest({ season, round, session_type: 'R', methodology_version: PACE_V2_AUDIT_RECONCILIATION_METHODOLOGY_VERSION, fact_row_count: rows.length, original_manifest_fact_fingerprint: original.fact_fingerprint, current_fact_fingerprint: currentFactFingerprint });
    await client.query('ROLLBACK');
    return parsePaceV2AuditReconciliationManifest(manifest);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main() {
  const connectionString = requirePaceV2AuditReconciliationManifestConfiguration();
  const [season, round] = process.argv.slice(2).map(Number);
  if (!Number.isInteger(season) || !Number.isInteger(round)) throw new Error('Usage: npm run generate:pace-v2:audit-reconciliation:production -- <season> <round>');
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await generatePaceV2AuditReconciliationManifest(pool, season, round))}\n`); } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_audit_reconciliation_manifest_failed"}\n'); process.exitCode = 1; });
