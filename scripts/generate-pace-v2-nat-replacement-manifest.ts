import 'dotenv/config';
import { Pool } from 'pg';
import { PaceV2FactRow } from '../src/etl/pace-v2-identity-repair';
import { createPaceV2NatReplacementManifest, PACE_V2_NAT_REPLACEMENT_ROUNDS } from '../src/etl/pace-v2-nat-replacement';

function requireConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_NAT_REPLACEMENT_MANIFEST_ENABLED !== 'true') throw new Error('Set PACE_V2_NAT_REPLACEMENT_MANIFEST_ENABLED=true to generate replacement evidence.');
  if (environment.PACE_V2_NAT_REPLACEMENT_MANIFEST_TARGET !== 'production') throw new Error('Set PACE_V2_NAT_REPLACEMENT_MANIFEST_TARGET=production to confirm a production evidence read.');
  if (!environment.DATABASE_URL || /(?:localhost|127\.0\.0\.1|\[::1\])/.test(environment.DATABASE_URL)) throw new Error('FAIL_CLOSED: a non-loopback DATABASE_URL is required.');
  return environment.DATABASE_URL;
}

function asFacts(rows: Record<string, unknown>[]): PaceV2FactRow[] {
  return rows.map((row) => ({ ...row, season: Number(row.season), round: Number(row.round), lap_number: Number(row.lap_number), stint_id: Number(row.stint_id), stint_lap_index: Number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : Number(row.lap_time_seconds), is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap), is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound), tyre_age_laps: row.tyre_age_laps === null ? null : Number(row.tyre_age_laps), track_id: String(row.track_id), driver_id: String(row.driver_id), session_type: String(row.session_type), methodology_version: String(row.methodology_version) }));
}

export async function generatePaceV2NatReplacementManifest(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const rows = await client.query(`SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE season = 2026 AND round BETWEEN 2 AND 10 AND session_type = 'R' ORDER BY round, driver_id, lap_number`);
    const facts = asFacts(rows.rows);
    const { fingerprintPaceV2FactRows } = await import('../src/etl/pace-v2-nat-replacement');
    const rounds = PACE_V2_NAT_REPLACEMENT_ROUNDS.map((round) => {
      const roundFacts = facts.filter((fact) => fact.round === round);
      if (!roundFacts.length || roundFacts.some((fact) => fact.methodology_version !== 'clean_air_gap_2_0s_v1' || !fact.is_pit_lap || !fact.is_in_lap || !fact.is_out_lap)) throw new Error(`FAIL_CLOSED: round ${round} is not the complete known NaT pit-flag poison class`);
      return { round, fact_row_count: roundFacts.length, original_fact_fingerprint: fingerprintPaceV2FactRows(roundFacts) };
    });
    await client.query('ROLLBACK');
    return createPaceV2NatReplacementManifest(rounds);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

async function main() {
  const pool = new Pool({ connectionString: requireConfiguration(), ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await generatePaceV2NatReplacementManifest(pool))}\n`); } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_nat_replacement_manifest_failed"}\n'); process.exitCode = 1; });
