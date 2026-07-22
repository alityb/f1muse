import 'dotenv/config';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { FastF1SessionPayload, fetchFastF1Session } from '../src/etl/season-ingestion';
import { PACE_V2_NAT_REPLACEMENT_ROUNDS } from '../src/etl/pace-v2-nat-replacement';

const SEASON = 2026;
const STATEMENT_TIMEOUT_MS = 5_000;
const DRIVER_CODE = /^[A-Z0-9]{3}$/;

export interface PaceV2NatIdentityMapRound {
  round: number;
  track_id: string;
  driver_ids: Record<string, string>;
}

export interface PaceV2NatIdentityMap {
  version: 2;
  source: 'canonical_race_results_fastf1_identity_map';
  season: 2026;
  rounds: PaceV2NatIdentityMapRound[];
}

interface Client {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}

interface QueryPool { connect(): Promise<Client>; end(): Promise<void>; }

interface DatabaseIdentityRow {
  round: number;
  race_track_id: string;
  driver_id: string;
  driver_code: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requirePaceV2NatIdentityMapConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_NAT_IDENTITY_MAP_ENABLED !== 'true') throw new Error('Set PACE_V2_NAT_IDENTITY_MAP_ENABLED=true to generate FastF1 identity evidence.');
  if (environment.PACE_V2_NAT_IDENTITY_MAP_TARGET !== 'production') throw new Error('Set PACE_V2_NAT_IDENTITY_MAP_TARGET=production to confirm a production evidence read.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the FastF1 identity-map generator.');
  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new Error('FastF1 identity-map generator refuses local database targets.');
  return environment.DATABASE_URL;
}

function exactFastF1Codes(session: FastF1SessionPayload, round: number): string[] {
  if (session.season !== SEASON || session.round !== round || session.session_name !== 'Race' || !session.event_name.trim()) {
    throw new Error(`FAIL_CLOSED: FastF1 metadata is not the requested race session for round ${round}`);
  }
  const codes = new Set<string>();
  for (const lap of session.laps) {
    const code = lap.driver_code?.trim().toUpperCase() ?? '';
    if (!DRIVER_CODE.test(code)) throw new Error(`FAIL_CLOSED: FastF1 returned an invalid driver code for round ${round}`);
    codes.add(code);
  }
  if (!codes.size) throw new Error(`FAIL_CLOSED: FastF1 returned no driver codes for round ${round}`);
  return [...codes].sort();
}

export function buildPaceV2NatIdentityMap(rows: DatabaseIdentityRow[], fetchSession: (season: number, round: number) => FastF1SessionPayload = fetchFastF1Session): PaceV2NatIdentityMap {
  const rounds: PaceV2NatIdentityMapRound[] = [];
  for (const round of PACE_V2_NAT_REPLACEMENT_ROUNDS) {
    const identities = rows.filter((row) => row.round === round);
    if (!identities.length) throw new Error(`FAIL_CLOSED: missing canonical race-result identity data for round ${round}`);
    const trackIds = new Set(identities.map((row) => row.race_track_id));
    if (trackIds.size !== 1) throw new Error(`FAIL_CLOSED: canonical race results have ambiguous track identity for round ${round}`);
    const driverIds = new Set<string>();
    const byCode = new Map<string, string>();
    for (const identity of identities) {
      const code = identity.driver_code?.trim().toUpperCase() ?? '';
      if (!identity.driver_id || !DRIVER_CODE.test(code)) throw new Error(`FAIL_CLOSED: canonical driver identity is invalid for round ${round}`);
      if (driverIds.has(identity.driver_id) || (byCode.has(code) && byCode.get(code) !== identity.driver_id)) {
        throw new Error(`FAIL_CLOSED: ambiguous canonical driver identity for round ${round}`);
      }
      driverIds.add(identity.driver_id);
      byCode.set(code, identity.driver_id);
    }
    const fastF1Codes = exactFastF1Codes(fetchSession(SEASON, round), round);
    if (fastF1Codes.length !== byCode.size || fastF1Codes.some((code) => !byCode.has(code))) {
      const missingDatabaseCodes = fastF1Codes.filter((code) => !byCode.has(code));
      const extraDatabaseIdentities = [...byCode.entries()]
        .filter(([code]) => !fastF1Codes.includes(code))
        .map(([code, driver_id]) => ({ code, driver_id }));
      throw new Error(`FAIL_CLOSED: FastF1 driver-code count or identity mismatch for round ${round}; fastf1_code_count=${fastF1Codes.length}; database_code_count=${byCode.size}; missing_database_codes=${JSON.stringify(missingDatabaseCodes)}; extra_database_identities=${JSON.stringify(extraDatabaseIdentities)}`);
    }
    rounds.push({ round, track_id: [...trackIds][0], driver_ids: Object.fromEntries([...byCode.entries()].sort(([left], [right]) => left.localeCompare(right))) });
  }
  if (rows.some((row) => !PACE_V2_NAT_REPLACEMENT_ROUNDS.includes(row.round as never))) {
    throw new Error('FAIL_CLOSED: database identity query returned an unreviewed round');
  }
  return { version: 2, source: 'canonical_race_results_fastf1_identity_map', season: SEASON, rounds };
}

export async function generatePaceV2NatIdentityMap(pool: QueryPool, fetchSession: (season: number, round: number) => FastF1SessionPayload = fetchFastF1Session): Promise<PaceV2NatIdentityMap> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const result = await client.query<DatabaseIdentityRow>(`
      SELECT DISTINCT r.round, r.circuit_id AS race_track_id, rd.driver_id, d.abbreviation AS driver_code
      FROM race r
      JOIN race_data rd ON rd.race_id = r.id AND LOWER(rd.type) IN ('race', 'race_result')
      JOIN driver d ON d.id = rd.driver_id
      WHERE r.year = $1 AND r.round = ANY($2::int[])
      ORDER BY r.round, rd.driver_id
    `, [SEASON, PACE_V2_NAT_REPLACEMENT_ROUNDS]);
    const rows = result.rows.map((row) => ({ ...row, round: Number(row.round), race_track_id: String(row.race_track_id), driver_id: String(row.driver_id), driver_code: row.driver_code === null ? null : String(row.driver_code) }));
    const artifact = buildPaceV2NatIdentityMap(rows, fetchSession);
    await client.query('ROLLBACK');
    return artifact;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function writePaceV2NatIdentityMapTemporary(artifact: PaceV2NatIdentityMap): { output: string; artifact_sha256: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-v2-nat-identity-map-'), { encoding: 'utf8' });
  const output = path.join(directory, 'identity-map.json');
  const serialized = `${JSON.stringify(artifact)}\n`;
  fs.writeFileSync(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { output, artifact_sha256: sha256(serialized) };
}

async function main(): Promise<void> {
  const connectionString = requirePaceV2NatIdentityMapConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const artifact = await generatePaceV2NatIdentityMap(pool);
    process.stdout.write(`${JSON.stringify({ status: 'generated', ...writePaceV2NatIdentityMapTemporary(artifact) })}\n`);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'pace_v2_nat_identity_map_failed' })}\n`); process.exitCode = 1; });
