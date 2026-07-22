import 'dotenv/config';
import fs from 'fs';
import { Pool } from 'pg';
import { PaceV2FactRow } from '../src/etl/pace-v2-identity-repair';
import { fingerprintPaceV2FactRows, PaceV2NatReplacementArtifact, PaceV2NatReplacementManifest, parsePaceV2NatReplacementArtifact, parsePaceV2NatReplacementManifest, PACE_V2_NAT_REPLACEMENT_ID, replacementFactsByRound } from '../src/etl/pace-v2-nat-replacement';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

function asFacts(rows: Record<string, unknown>[]): PaceV2FactRow[] {
  return rows.map((row) => ({ ...row, season: Number(row.season), round: Number(row.round), lap_number: Number(row.lap_number), stint_id: Number(row.stint_id), stint_lap_index: Number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : Number(row.lap_time_seconds), is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap), is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound), tyre_age_laps: row.tyre_age_laps === null ? null : Number(row.tyre_age_laps), track_id: String(row.track_id), driver_id: String(row.driver_id), session_type: String(row.session_type), methodology_version: String(row.methodology_version) }));
}

export function requirePaceV2NatReplacementConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_NAT_REPLACEMENT_ENABLED !== 'true') throw new Error('Set PACE_V2_NAT_REPLACEMENT_ENABLED=true to write replacement facts.');
  if (environment.PACE_V2_NAT_REPLACEMENT_TARGET !== 'primary') throw new Error('Set PACE_V2_NAT_REPLACEMENT_TARGET=primary to confirm a primary-only replacement.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for pace replacement.');
  return environment.DATABASE_URL;
}

export function replacementRefusalReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const databaseCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (message.startsWith('Set PACE_V2_NAT_REPLACEMENT_ENABLED=')) return 'replacement_not_explicitly_enabled';
  if (message.startsWith('Set PACE_V2_NAT_REPLACEMENT_TARGET=')) return 'replacement_target_not_primary';
  if (message === 'DATABASE_URL is required for pace replacement.') return 'replacement_database_url_missing';
  if (message.startsWith('Usage: npm run replace:pace-v2:nat-pit-flags')) return 'replacement_arguments_invalid';
  if (message === 'FAIL_CLOSED: replacement manifest JSON is invalid') return 'manifest_json_invalid';
  if (message === 'FAIL_CLOSED: replacement facts JSON is invalid') return 'replacement_facts_json_invalid';
  if (message.startsWith('FAIL_CLOSED: replacement manifest')) return 'manifest_contract_invalid';
  if (message.startsWith('FAIL_CLOSED: replacement artifact')) return 'replacement_artifact_contract_invalid';
  if (message.includes('reviewed replacement migration is missing')) return 'replacement_migration_missing';
  if (message.includes('replacement immutability triggers are unavailable')) return 'replacement_immutability_unavailable';
  if (message.includes('no longer matches the reviewed poisoned facts')) return 'original_fact_contract_mismatch';
  if (message.includes('do not exactly cover original lap identities')) return 'lap_identity_mismatch';
  if (message.includes('retain the known NaT poison class')) return 'replacement_retains_poison_class';
  if (message.includes('replacement audit already exists')) return 'replacement_already_approved';
  if (databaseCode === '42501') return 'replacement_permission_denied';
  if (databaseCode === '40001') return 'replacement_serialization_failure';
  if (databaseCode === '57014') return 'replacement_statement_timeout';
  if (databaseCode === '23505') return 'replacement_duplicate_key';
  return 'replacement_runtime_failure';
}

export function parseReplacementJson(content: string, label: 'manifest' | 'facts'): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`FAIL_CLOSED: replacement ${label} JSON is invalid`);
  }
}

function assertSameFactKeys(original: PaceV2FactRow[], replacement: PaceV2FactRow[]): void {
  const key = (row: PaceV2FactRow) => `${row.track_id}/${row.driver_id}/${row.lap_number}`;
  if (original.length !== replacement.length || new Set(original.map(key)).size !== replacement.length || original.some((row) => !new Set(replacement.map(key)).has(key(row)))) throw new Error('FAIL_CLOSED: replacement facts do not exactly cover original lap identities');
  if (replacement.every((row) => row.is_pit_lap && row.is_in_lap && row.is_out_lap)) throw new Error('FAIL_CLOSED: replacement facts retain the known NaT poison class');
}

export async function runPaceV2NatReplacement(pool: QueryPool, manifest: PaceV2NatReplacementManifest, artifact: PaceV2NatReplacementArtifact): Promise<{ replacement_version: string; replaced_rounds: number; replacement_fact_rows: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const relations = await client.query<{ relation: string | null }>("SELECT to_regclass('pace_v2_lap_replacement')::text AS relation UNION ALL SELECT to_regclass('pace_v2_replacement_audit')::text AS relation");
    if (relations.rows.length !== 2 || relations.rows.some((row) => !row.relation)) throw new Error('FAIL_CLOSED: reviewed replacement migration is missing');
    const triggers = await client.query<{ enabled: boolean }>("SELECT COUNT(*) = 3 AS enabled FROM pg_trigger WHERE tgrelid IN ('pace_v2_lap_replacement'::regclass, 'pace_v2_replacement_audit'::regclass) AND tgname IN ('pace_v2_lap_replacement_immutable', 'pace_v2_replacement_audit_immutable', 'pace_v2_lap_replacement_no_insert_after_approval') AND tgenabled <> 'D'");
    if (!triggers.rows[0]?.enabled) throw new Error('FAIL_CLOSED: replacement immutability triggers are unavailable');
    const replacements = replacementFactsByRound(artifact.facts);
    for (const entry of manifest.rounds) {
      const originalResult = await client.query('SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = $1 AND round = $2 AND session_type = $3 FOR SHARE', [manifest.season, entry.round, manifest.session_type]);
      const original = asFacts(originalResult.rows);
      const replacement = replacements.get(entry.round) ?? [];
      if (!original.length || original.some((row) => !row.is_pit_lap || !row.is_in_lap || !row.is_out_lap) || original.length !== entry.fact_row_count || fingerprintPaceV2FactRows(original) !== entry.original_fact_fingerprint) throw new Error(`FAIL_CLOSED: original round ${entry.round} no longer matches the reviewed poisoned facts`);
      assertSameFactKeys(original, replacement);
      const existing = await client.query('SELECT 1 FROM pace_v2_replacement_audit WHERE replacement_version = $1 AND season = $2 AND round = $3 AND session_type = $4', [PACE_V2_NAT_REPLACEMENT_ID, manifest.season, entry.round, manifest.session_type]);
      if (existing.rows.length) throw new Error(`FAIL_CLOSED: replacement audit already exists for round ${entry.round}`);
      const columns = 'replacement_version, season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version';
      const values = replacement.flatMap((row) => [PACE_V2_NAT_REPLACEMENT_ID, row.season, row.round, row.track_id, row.driver_id, row.session_type, row.lap_number, row.stint_id, row.stint_lap_index, row.lap_time_seconds, row.is_valid_lap, row.is_pit_lap, row.is_out_lap, row.is_in_lap, row.clean_air_flag, row.compound, row.tyre_age_laps, row.methodology_version]);
      const placeholders = replacement.map((_, index) => `(${Array.from({ length: 18 }, (_, column) => `$${index * 18 + column + 1}`).join(', ')})`).join(', ');
      await client.query(`INSERT INTO pace_v2_lap_replacement (${columns}) VALUES ${placeholders}`, values);
      await client.query('INSERT INTO pace_v2_replacement_audit (replacement_version, season, round, session_type, replacement_manifest_fingerprint, original_fact_fingerprint, replacement_fact_fingerprint, fact_row_count, methodology_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [PACE_V2_NAT_REPLACEMENT_ID, manifest.season, entry.round, manifest.session_type, manifest.manifest_fingerprint, entry.original_fact_fingerprint, fingerprintPaceV2FactRows(replacement), replacement.length, manifest.methodology_version]);
    }
    await client.query('COMMIT');
    return { replacement_version: PACE_V2_NAT_REPLACEMENT_ID, replaced_rounds: manifest.rounds.length, replacement_fact_rows: artifact.facts.length };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main() {
  const connectionString = requirePaceV2NatReplacementConfiguration();
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--facts') throw new Error('Usage: npm run replace:pace-v2:nat-pit-flags -- --manifest <approved.json> --facts <corrected-facts.json>');
  const manifest = parsePaceV2NatReplacementManifest(parseReplacementJson(fs.readFileSync(args[1], 'utf8'), 'manifest'));
  const artifact = parsePaceV2NatReplacementArtifact(parseReplacementJson(fs.readFileSync(args[3], 'utf8'), 'facts'));
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await runPaceV2NatReplacement(pool, manifest, artifact))}\n`); } finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: 'pace_v2_nat_replacement_failed', reason: replacementRefusalReason(error) })}\n`); process.exitCode = 1; });
