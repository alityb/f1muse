import { createHash } from 'crypto';
import fs from 'fs';
import { Pool, type PoolClient } from 'pg';
import {
  compareHistoricalLapWindow,
  type HistoricalLapDataset,
  loadHistoricalLapPilot,
  rehydrateHistoricalLapPilot
} from '../src/etl/historical-lap-window-pilot';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';

const EXPECTED_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const SOURCE_PATH = 'data/phase8-belgium-2022-pilot.json';
const IDENTITY_PATH = 'data/phase8-belgium-2022-identity-map.json';
const OUTPUT_PATH = 'data/phase8-belgium-2022-window-result.json';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function stageHistoricalLapPilotInTemporaryTable(client: PoolClient, dataset: HistoricalLapDataset): Promise<void> {
  if (!Object.isFrozen(dataset) || !dataset.facts.length || dataset.facts.some(fact => !Object.isFrozen(fact))) {
    throw new Error('FAIL_CLOSED: only a nonempty immutable historical dataset may be staged');
  }
  await client.query(`
    CREATE TEMP TABLE phase8_historical_lap_pilot (
      season integer NOT NULL CHECK (season = 2022),
      round integer NOT NULL CHECK (round = 14),
      session_type text NOT NULL CHECK (session_type = 'R'),
      event text NOT NULL CHECK (event = '2022 Belgian Grand Prix'),
      driver_id text NOT NULL,
      racing_number text NOT NULL,
      official_name text NOT NULL,
      lap_number integer NOT NULL CHECK (lap_number > 0),
      lap_time_seconds numeric(10, 3) NOT NULL CHECK (lap_time_seconds > 0),
      official_deleted_lap boolean NOT NULL,
      official_pit_marker boolean NOT NULL,
      source_manifest_sha256 text NOT NULL,
      source_artifact_sha256 text NOT NULL,
      PRIMARY KEY (season, round, session_type, driver_id, lap_number)
    ) ON COMMIT DROP
  `);
  const values = dataset.facts.flatMap(fact => [
    fact.season, fact.round, fact.session_type, fact.event, fact.driver_id, fact.racing_number, fact.official_name,
    fact.lap_number, fact.lap_time_seconds, fact.official_deleted_lap, fact.official_pit_marker,
    fact.source_manifest_sha256, fact.source_artifact_sha256
  ]);
  const columns = 13;
  const placeholders = dataset.facts.map((_, row) => `(${Array.from({ length: columns }, (__, column) => `$${row * columns + column + 1}`).join(', ')})`);
  await client.query(`
    INSERT INTO phase8_historical_lap_pilot
      (season, round, session_type, event, driver_id, racing_number, official_name, lap_number,
       lap_time_seconds, official_deleted_lap, official_pit_marker, source_manifest_sha256, source_artifact_sha256)
    VALUES ${placeholders.join(', ')}
  `, values);
}

async function emitWithClient(client: PoolClient, sourceContent: Buffer, identityContent: Buffer) {
  await client.query("SET LOCAL statement_timeout = '1000ms'");
  await client.query("SET LOCAL lock_timeout = '1000ms'");
  const target = await client.query<{ database_name: string }>('SELECT current_database()::text AS database_name');
  if (target.rows.length !== 1 || target.rows[0].database_name !== 'f1muse_test') {
    throw new Error('FAIL_CLOSED: Phase 8 emitter connected to an unexpected database');
  }
  const canonical = await client.query<{ driver_id: string; full_name: string }>(`
    SELECT id AS driver_id, full_name
    FROM driver
    WHERE id = ANY($1::text[])
    ORDER BY id
  `, [['max_verstappen', 'fernando_alonso']]);
  const dataset = loadHistoricalLapPilot(sourceContent, identityContent, canonical.rows);
  await stageHistoricalLapPilotInTemporaryTable(client, dataset);
  const staged = await client.query<{
    season: number;
    round: number;
    session_type: string;
    event: string;
    driver_id: string;
    racing_number: string;
    official_name: string;
    lap_number: number;
    lap_time_seconds: string;
    official_deleted_lap: boolean;
    official_pit_marker: boolean;
    source_manifest_sha256: string;
    source_artifact_sha256: string;
  }>(`
    SELECT season, round, session_type, event, driver_id, racing_number, official_name, lap_number,
      lap_time_seconds::text, official_deleted_lap, official_pit_marker,
      source_manifest_sha256, source_artifact_sha256
    FROM phase8_historical_lap_pilot
    ORDER BY driver_id, lap_number
  `);
  const persistence = await client.query<{ persistence: string }>(`
    SELECT relpersistence::text AS persistence
    FROM pg_class
    WHERE oid = 'phase8_historical_lap_pilot'::regclass
  `);
  if (persistence.rows.length !== 1 || persistence.rows[0].persistence !== 't') {
    throw new Error('FAIL_CLOSED: historical staging relation is not temporary');
  }
  const stagedDataset = rehydrateHistoricalLapPilot(dataset, staged.rows);
  const comparison = compareHistoricalLapWindow(stagedDataset, {
    driver_ids: ['max_verstappen', 'fernando_alonso'],
    lap_start: 3,
    lap_end: 10
  });
  return {
    version: 1 as const,
    emitter: 'localhost_temporary_historical_lap_pilot_v1' as const,
    staged_fact_count: staged.rows.length,
    staged_fact_fingerprint: sha256(JSON.stringify(staged.rows)),
    comparison
  };
}

export async function emitHistoricalLapWindowPilot(databaseUrl: string, sourceContent: Buffer, identityContent: Buffer) {
  if (databaseUrl !== EXPECTED_TEST_DATABASE_URL) throw new Error('FAIL_CLOSED: Phase 8 emitter requires the exact disposable localhost test database');
  const pool = new Pool({ connectionString: EXPECTED_TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const output = await emitWithClient(client, sourceContent, identityContent);
    await client.query('ROLLBACK');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = getTestDatabaseUrl();
  if (databaseUrl !== EXPECTED_TEST_DATABASE_URL) throw new Error('FAIL_CLOSED: Phase 8 snapshot requires the exact disposable localhost test database');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await setupTestDatabase(pool);
  } finally {
    await pool.end();
  }
  const output = await emitHistoricalLapWindowPilot(databaseUrl, fs.readFileSync(SOURCE_PATH), fs.readFileSync(IDENTITY_PATH));
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) void main();
