import 'dotenv/config';
import { Pool } from 'pg';
import {
  createPaceV2Expansion2025Manifest,
  fingerprintPaceV2CanonicalStarters,
  PACE_V2_2025_EXPANSION_METHODOLOGY,
  PACE_V2_2025_EXPANSION_SEASON,
  PACE_V2_2025_EXPANSION_STABILIZATION_HOURS,
  PaceV2Expansion2025Manifest
} from '../src/etl/pace-v2-2025-expansion-manifest';

interface Client { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void }
interface QueryPool { connect(): Promise<Client>; end(): Promise<void> }

export class PaceV22025ExpansionPreparationError extends Error {
  constructor(readonly code: 'no_safe_pilot_candidate' | 'required_contract_relation_missing') {
    super(`FAIL_CLOSED: ${code}`);
  }
}

interface CandidateRow {
  round: number;
  race_id: number;
  track_id: string | null;
  race_date: string;
  canonical_driver_ids: string[];
  existing_v2_fact_count: number;
  existing_manifest_audit_count: number;
}

export async function preparePaceV22025Expansion(pool: QueryPool, now = new Date()): Promise<PaceV2Expansion2025Manifest> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const relations = await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['laps_normalized_v2']);
    const audits = await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_round_audit']);
    const trigger = await client.query<{ immutable: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'pace_v2_round_audit'::regclass AND tgname = 'pace_v2_round_audit_immutable' AND tgenabled <> 'D') AS immutable");
    if (relations.rows[0]?.relation !== 'laps_normalized_v2' || audits.rows[0]?.relation !== 'pace_v2_round_audit' || !trigger.rows[0]?.immutable) {
      throw new PaceV22025ExpansionPreparationError('required_contract_relation_missing');
    }
    const candidates = await client.query<CandidateRow>(`
      SELECT r.round, r.id AS race_id, r.circuit_id AS track_id, r.date::text AS race_date,
        ARRAY_AGG(DISTINCT rd.driver_id ORDER BY rd.driver_id) AS canonical_driver_ids,
        COUNT(DISTINCT l.lap_number) FILTER (WHERE l.driver_id IS NOT NULL)::int AS existing_v2_fact_count,
        COUNT(DISTINCT a.round) FILTER (WHERE a.round IS NOT NULL)::int AS existing_manifest_audit_count
      FROM race r
      JOIN race_data rd ON rd.race_id = r.id AND LOWER(rd.type) IN ('race', 'race_result')
        AND NOT (
          UPPER(BTRIM(COALESCE(rd.position_text, ''))) IN ('W', 'WD', 'WITHDRAWN', 'DNS', 'DID NOT START')
          OR UPPER(BTRIM(COALESCE(rd.race_reason_retired, ''))) IN ('W', 'WD', 'WITHDRAWN', 'DNS', 'DID NOT START')
        )
      LEFT JOIN laps_normalized_v2 l ON l.season = r.year AND l.round = r.round AND l.session_type = 'R'
      LEFT JOIN pace_v2_round_audit a ON a.season = r.year AND a.round = r.round AND a.session_type = 'R'
      WHERE r.year = $1 AND r.date IS NOT NULL
        AND r.date::timestamptz <= $2::timestamptz - ($3::text || ' hours')::interval
      GROUP BY r.round, r.id, r.circuit_id, r.date
      HAVING COUNT(DISTINCT rd.driver_id) >= 10
        AND COUNT(DISTINCT l.lap_number) FILTER (WHERE l.driver_id IS NOT NULL) = 0
        AND COUNT(DISTINCT a.round) FILTER (WHERE a.round IS NOT NULL) = 0
      ORDER BY r.round
      LIMIT 1
    `, [PACE_V2_2025_EXPANSION_SEASON, now.toISOString(), String(PACE_V2_2025_EXPANSION_STABILIZATION_HOURS)]);
    const candidate = candidates.rows[0];
    if (!candidate || !candidate.track_id) throw new PaceV22025ExpansionPreparationError('no_safe_pilot_candidate');
    const pilot = {
      round: Number(candidate.round), race_id: Number(candidate.race_id), track_id: candidate.track_id, race_date: candidate.race_date,
      canonical_starter_count: candidate.canonical_driver_ids.length,
      canonical_starter_fingerprint: fingerprintPaceV2CanonicalStarters(candidate.canonical_driver_ids),
      existing_v2_fact_count: Number(candidate.existing_v2_fact_count),
      existing_manifest_audit_count: Number(candidate.existing_manifest_audit_count)
    };
    await client.query('ROLLBACK');
    return createPaceV2Expansion2025Manifest(pilot);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function configuration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_2025_EXPANSION_PREPARE_ENABLED !== 'true' || environment.PACE_V2_2025_EXPANSION_PREPARE_TARGET !== 'production' || !environment.DATABASE_URL || /(?:localhost|127\.0\.0\.1|\[::1\])/.test(environment.DATABASE_URL)) {
    throw new Error('FAIL_CLOSED: explicit non-loopback production preparation configuration is required');
  }
  return environment.DATABASE_URL;
}

export function paceV22025ExpansionPreparationRefusal(error: unknown): Record<string, unknown> {
  return error instanceof PaceV22025ExpansionPreparationError
    ? { status: 'refused', error: error.code }
    : { status: 'refused', error: 'pace_v2_2025_expansion_preparation_failed' };
}

if (require.main === module) {
  let pool: QueryPool | undefined;
  try {
    pool = new Pool({ connectionString: configuration(), ssl: { rejectUnauthorized: false }, max: 1 });
    preparePaceV22025Expansion(pool).then((manifest) => process.stdout.write(`${JSON.stringify(manifest)}\n`)).catch((error) => {
      process.stdout.write(`${JSON.stringify(paceV22025ExpansionPreparationRefusal(error))}\n`);
      process.exitCode = 1;
    }).finally(() => pool?.end());
  } catch (error) {
    process.stdout.write(`${JSON.stringify(paceV22025ExpansionPreparationRefusal(error))}\n`);
    process.exitCode = 1;
  }
}
