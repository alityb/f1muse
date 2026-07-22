import 'dotenv/config';
import { Pool } from 'pg';
import { PaceV2FactRow, fingerprintPaceV2FactRows } from '../src/etl/pace-v2-identity-repair';
import { approvedIncompleteRebuildRounds, createPaceV2IncompleteRebuildManifest, fingerprintDriverIds } from '../src/etl/pace-v2-incomplete-rebuild';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }
export class PaceV2IncompleteRebuildManifestError extends Error {
  constructor(readonly code: 'incomplete_rebuild_candidate_invalid', readonly round: number, readonly predicates: Record<string, boolean>) {
    super(`FAIL_CLOSED: round ${round} is not an approved incomplete canonical-coverage rebuild candidate`);
  }
}
const fact = (row: Record<string, unknown>): PaceV2FactRow => ({ ...row, season: Number(row.season), round: Number(row.round), track_id: String(row.track_id), driver_id: String(row.driver_id), session_type: String(row.session_type), lap_number: Number(row.lap_number), stint_id: Number(row.stint_id), stint_lap_index: Number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : Number(row.lap_time_seconds), is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap), is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound), tyre_age_laps: row.tyre_age_laps === null ? null : Number(row.tyre_age_laps), methodology_version: String(row.methodology_version) });

export function parsePaceV2IncompleteRebuildRoundSelection(value: string): number[] {
  if (!/^\d+(?:,\d+)*$/.test(value)) throw new Error('FAIL_CLOSED: --rounds must be a comma-separated approved round subset');
  return approvedIncompleteRebuildRounds(value.split(',').map(Number));
}
export async function generatePaceV2IncompleteRebuildManifest(pool: QueryPool, selectedRounds: readonly number[]) {
  const approvedRounds = approvedIncompleteRebuildRounds(selectedRounds);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const [persisted, canonical] = await Promise.all([
      client.query('SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = 2026 AND round = ANY($1::int[]) AND session_type = \'R\' ORDER BY round, driver_id, lap_number', [approvedRounds]),
      client.query(`SELECT DISTINCT r.round, rd.driver_id
        FROM race r JOIN race_data rd ON rd.race_id = r.id AND LOWER(rd.type) IN ('race', 'race_result')
        WHERE r.year = 2026 AND r.round = ANY($1::int[])
          AND NOT (rd.race_laps IS NOT DISTINCT FROM 0 AND (
            UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('W', 'WD', 'WITHDRAWN', 'DNS', 'DID NOT START')
            OR UPPER(BTRIM(COALESCE(rd.race_reason_retired, ''))) IN ('W', 'WD', 'WITHDRAWN', 'DNS', 'DID NOT START')
          ))
        ORDER BY r.round, rd.driver_id`, [approvedRounds])
    ]);
    const rows = persisted.rows.map(fact);
    const rounds = approvedRounds.map((round) => {
      const original = rows.filter((row) => row.round === round);
      const driverIds = canonical.rows.filter((row) => Number(row.round) === round).map((row) => String(row.driver_id));
      const persistedIds = new Set(original.map((row) => row.driver_id));
      const predicates = {
        original_fact_rows_nonempty: original.length > 0,
        canonical_driver_rows_nonempty: driverIds.length > 0,
        canonical_coverage_incomplete: driverIds.length > persistedIds.size,
        persisted_drivers_are_canonical: [...persistedIds].every((id) => driverIds.includes(id)),
        methodology_version_active: original.every((row) => row.methodology_version === 'clean_air_gap_2_0s_v1')
      };
      if (Object.values(predicates).some((passed) => !passed)) throw new PaceV2IncompleteRebuildManifestError('incomplete_rebuild_candidate_invalid', round, predicates);
      return { round, original_fact_row_count: original.length, original_fact_fingerprint: fingerprintPaceV2FactRows(original), canonical_driver_count: driverIds.length, canonical_driver_fingerprint: fingerprintDriverIds(driverIds) };
    });
    await client.query('ROLLBACK');
    return createPaceV2IncompleteRebuildManifest(rounds);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}
function configuration(env: NodeJS.ProcessEnv = process.env): string { if (env.PACE_V2_INCOMPLETE_REBUILD_MANIFEST_ENABLED !== 'true' || env.PACE_V2_INCOMPLETE_REBUILD_MANIFEST_TARGET !== 'production' || !env.DATABASE_URL || /(?:localhost|127\.0\.0\.1|\[::1\])/.test(env.DATABASE_URL)) throw new Error('FAIL_CLOSED: explicit non-loopback production manifest configuration is required'); return env.DATABASE_URL; }
export function incompleteRebuildManifestRefusal(error: unknown): Record<string, unknown> {
  if (error instanceof PaceV2IncompleteRebuildManifestError) return { status: 'refused', error: error.code, round: error.round, predicates: error.predicates };
  return { status: 'refused', error: 'pace_v2_incomplete_rebuild_manifest_failed' };
}
if (require.main === module) { const args = process.argv.slice(2); try { if (args.length !== 2 || args[0] !== '--rounds') throw new Error('Usage: --rounds <2-10[,2-10...]>'); const pool = new Pool({ connectionString: configuration(), ssl: { rejectUnauthorized: false }, max: 1 }); generatePaceV2IncompleteRebuildManifest(pool, parsePaceV2IncompleteRebuildRoundSelection(args[1])).then((value) => process.stdout.write(`${JSON.stringify(value)}\n`)).catch((error) => { process.stdout.write(`${JSON.stringify(incompleteRebuildManifestRefusal(error))}\n`); process.exitCode = 1; }).finally(() => pool.end()); } catch (error) { process.stdout.write(`${JSON.stringify(incompleteRebuildManifestRefusal(error))}\n`); process.exitCode = 1; } }
