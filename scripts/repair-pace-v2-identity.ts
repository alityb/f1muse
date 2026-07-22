import 'dotenv/config';
import fs from 'fs';
import { Pool } from 'pg';
import { PaceV2FactRow, PaceV2IdentityRepairManifest, fingerprintPaceV2FactRows, parsePaceV2IdentityRepairManifest } from '../src/etl/pace-v2-identity-repair';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

export function requirePaceV2IdentityRepairConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_IDENTITY_REPAIR_ENABLED !== 'true') throw new Error('Set PACE_V2_IDENTITY_REPAIR_ENABLED=true to enable an identity repair.');
  if (environment.PACE_V2_IDENTITY_REPAIR_TARGET !== 'primary') throw new Error('Set PACE_V2_IDENTITY_REPAIR_TARGET=primary to confirm a primary-only repair.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the identity repair.');
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

export async function runPaceV2IdentityRepair(pool: QueryPool, manifest: PaceV2IdentityRepairManifest): Promise<{ repaired_row_count: number; repair_audit_fingerprint: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const relation = await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_identity_repair_audit']);
    if (relation.rows[0]?.relation !== 'pace_v2_identity_repair_audit') throw new Error('FAIL_CLOSED: immutable identity-repair audit relation is missing');
    const previousAudit = await client.query('SELECT 1 FROM pace_v2_identity_repair_audit WHERE season = $1 AND round = $2 AND session_type = $3', [manifest.season, manifest.round, manifest.session_type]);
    if (previousAudit.rows.length !== 0) throw new Error('FAIL_CLOSED: identity repair was already audited for this round');
    const before = await client.query(`SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = $1 AND round = $2 AND session_type = $3 FOR UPDATE`, [manifest.season, manifest.round, manifest.session_type]);
    const sourceRows = asFactRows(before.rows);
    if (sourceRows.length !== manifest.fact_row_count || sourceRows.some((row) => row.track_id !== manifest.from_track_id || row.methodology_version !== manifest.methodology_version)) throw new Error('FAIL_CLOSED: persisted rows do not match the exact repair row contract');
    if (fingerprintPaceV2FactRows(sourceRows) !== manifest.source_fact_fingerprint) throw new Error('FAIL_CLOSED: persisted rows do not match the approved source fingerprint');
    const update = await client.query('UPDATE laps_normalized_v2 SET track_id = $1 WHERE season = $2 AND round = $3 AND session_type = $4 AND track_id = $5 AND methodology_version = $6', [manifest.to_track_id, manifest.season, manifest.round, manifest.session_type, manifest.from_track_id, manifest.methodology_version]);
    if (update.rowCount !== manifest.fact_row_count) throw new Error('FAIL_CLOSED: repaired row count does not match the approved contract');
    const after = await client.query(`SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = $1 AND round = $2 AND session_type = $3 FOR UPDATE`, [manifest.season, manifest.round, manifest.session_type]);
    if (fingerprintPaceV2FactRows(asFactRows(after.rows)) !== manifest.target_fact_fingerprint) throw new Error('FAIL_CLOSED: repaired rows do not match the approved target fingerprint');
    await client.query('INSERT INTO pace_v2_identity_repair_audit (season, round, session_type, repair_method, manifest_fingerprint, source_fact_fingerprint, target_fact_fingerprint, fact_row_count, methodology_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [manifest.season, manifest.round, manifest.session_type, 'track_identity_exact_alias_v1', manifest.manifest_fingerprint, manifest.source_fact_fingerprint, manifest.target_fact_fingerprint, manifest.fact_row_count, manifest.methodology_version]);
    await client.query('COMMIT');
    return { repaired_row_count: manifest.fact_row_count, repair_audit_fingerprint: manifest.manifest_fingerprint };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function main() {
  const connectionString = requirePaceV2IdentityRepairConfiguration();
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--manifest') throw new Error('Usage: npm run repair:pace-v2:identity -- --manifest <approved-repair.json>');
  const manifest = parsePaceV2IdentityRepairManifest(JSON.parse(fs.readFileSync(args[1], 'utf8')));
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await runPaceV2IdentityRepair(pool, manifest))}\n`); } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_identity_repair_failed"}\n'); process.exitCode = 1; });
