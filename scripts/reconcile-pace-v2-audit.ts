import 'dotenv/config';
import fs from 'fs';
import { Pool } from 'pg';
import { PaceV2FactRow, fingerprintPaceV2FactRows } from '../src/etl/pace-v2-identity-repair';
import { PACE_V2_AUDIT_RECONCILIATION_METHOD, PaceV2AuditReconciliationManifest, parsePaceV2AuditReconciliationManifest } from '../src/etl/pace-v2-audit-reconciliation';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

function asFactRows(rows: Record<string, unknown>[]): PaceV2FactRow[] {
  return rows.map((row) => ({
    season: Number(row.season), round: Number(row.round), track_id: String(row.track_id), driver_id: String(row.driver_id), session_type: String(row.session_type), lap_number: Number(row.lap_number), stint_id: Number(row.stint_id), stint_lap_index: Number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : Number(row.lap_time_seconds), is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap), is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound), tyre_age_laps: row.tyre_age_laps === null ? null : Number(row.tyre_age_laps), methodology_version: String(row.methodology_version)
  }));
}

export function requirePaceV2AuditReconciliationConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_AUDIT_RECONCILIATION_ENABLED !== 'true') throw new Error('Set PACE_V2_AUDIT_RECONCILIATION_ENABLED=true to reconcile a pace audit.');
  if (environment.PACE_V2_AUDIT_RECONCILIATION_TARGET !== 'primary') throw new Error('Set PACE_V2_AUDIT_RECONCILIATION_TARGET=primary to confirm a primary-only reconciliation.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for pace audit reconciliation.');
  return environment.DATABASE_URL;
}

export async function runPaceV2AuditReconciliation(pool: QueryPool, manifest: PaceV2AuditReconciliationManifest): Promise<{ reconciled_row_count: number; reconciliation_manifest_fingerprint: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const relation = await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_round_audit_reconciliation']);
    if (relation.rows[0]?.relation !== 'pace_v2_round_audit_reconciliation') throw new Error('FAIL_CLOSED: immutable pace audit reconciliation relation is missing');
    const immutable = await client.query<{ immutable: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'pace_v2_round_audit_reconciliation'::regclass AND tgname = 'pace_v2_round_audit_reconciliation_immutable' AND tgenabled <> 'D') AS immutable");
    if (!immutable.rows[0]?.immutable) throw new Error('FAIL_CLOSED: pace audit reconciliation relation is not immutable');
    const existing = await client.query('SELECT 1 FROM pace_v2_round_audit_reconciliation WHERE season = $1 AND round = $2 AND session_type = $3', [manifest.season, manifest.round, manifest.session_type]);
    if (existing.rows.length) throw new Error('FAIL_CLOSED: reconciliation evidence already exists for this round');
    const audit = await client.query<{ session_type: string; fact_fingerprint: string; fact_row_count: number; methodology_version: string }>('SELECT session_type, fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_round_audit WHERE season = $1 AND round = $2 AND session_type = $3 FOR SHARE', [manifest.season, manifest.round, manifest.session_type]);
    const facts = await client.query('SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = $1 AND round = $2 AND session_type = $3 FOR SHARE', [manifest.season, manifest.round, manifest.session_type]);
    const rows = asFactRows(facts.rows);
    const original = audit.rows[0];
    const currentFactFingerprint = fingerprintPaceV2FactRows(rows);
    if (audit.rows.length !== 1 || !rows.length || !original || original.session_type !== manifest.session_type || Number(original.fact_row_count) !== manifest.fact_row_count || original.methodology_version !== manifest.methodology_version || rows.length !== manifest.fact_row_count || rows.some((row) => row.methodology_version !== manifest.methodology_version) || original.fact_fingerprint !== manifest.original_manifest_fact_fingerprint || currentFactFingerprint !== manifest.current_fact_fingerprint || original.fact_fingerprint === currentFactFingerprint) throw new Error('FAIL_CLOSED: persisted audit differs by more than the approved fingerprint mismatch class');
    await client.query('INSERT INTO pace_v2_round_audit_reconciliation (season, round, session_type, reconciliation_method, reconciliation_manifest_fingerprint, original_manifest_fact_fingerprint, reconciled_fact_fingerprint, fact_row_count, methodology_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [manifest.season, manifest.round, manifest.session_type, PACE_V2_AUDIT_RECONCILIATION_METHOD, manifest.manifest_fingerprint, manifest.original_manifest_fact_fingerprint, manifest.current_fact_fingerprint, manifest.fact_row_count, manifest.methodology_version]);
    await client.query('COMMIT');
    return { reconciled_row_count: manifest.fact_row_count, reconciliation_manifest_fingerprint: manifest.manifest_fingerprint };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main() {
  const connectionString = requirePaceV2AuditReconciliationConfiguration();
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--manifest') throw new Error('Usage: npm run reconcile:pace-v2:audit -- --manifest <approved-reconciliation.json>');
  const manifest = parsePaceV2AuditReconciliationManifest(JSON.parse(fs.readFileSync(args[1], 'utf8')));
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await runPaceV2AuditReconciliation(pool, manifest))}\n`); } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_audit_reconciliation_failed"}\n'); process.exitCode = 1; });
