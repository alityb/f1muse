import fs from 'fs';
import { Pool } from 'pg';
import { ingestHistoricalLapDataset } from '../src/etl/historical-lap-ingestion';
import { loadHistoricalLapPilot } from '../src/etl/historical-lap-window-pilot';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';

const EXPECTED_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const SOURCE_PATH = 'data/phase8-belgium-2022-pilot.json';
const IDENTITY_PATH = 'data/phase8-belgium-2022-identity-map.json';
const OUTPUT_PATH = 'data/phase8-belgium-2022-persistent-result.json';
const MIGRATION_PATH = 'migrations/20260801_official_timing_historical_laps.sql';

async function main(): Promise<void> {
  const databaseUrl = getTestDatabaseUrl();
  if (databaseUrl !== EXPECTED_TEST_DATABASE_URL) {
    throw new Error('FAIL_CLOSED: persistent Phase 8 snapshot requires the exact disposable localhost test database');
  }
  const pool = new Pool({ connectionString: EXPECTED_TEST_DATABASE_URL, max: 1 });
  try {
    await setupTestDatabase(pool);
    await pool.query('DROP SCHEMA IF EXISTS official_timing CASCADE');
    await pool.query(fs.readFileSync(MIGRATION_PATH, 'utf8'));
    const identityContent = fs.readFileSync(IDENTITY_PATH);
    const mappings = (JSON.parse(identityContent.toString('utf8')) as { mappings: Array<{ driver_id: string }> }).mappings;
    const canonical = await pool.query<{ driver_id: string; full_name: string }>(`
      SELECT id AS driver_id, full_name FROM driver WHERE id = ANY($1::text[]) ORDER BY id
    `, [mappings.map(mapping => mapping.driver_id)]);
    const dataset = loadHistoricalLapPilot(fs.readFileSync(SOURCE_PATH), identityContent, canonical.rows);
    const committed = await ingestHistoricalLapDataset(pool, dataset);
    const replay = await ingestHistoricalLapDataset(pool, dataset);
    const stored = await pool.query<{
      persistence: string;
      identity_count: number;
      fact_count: number;
      artifact_count: number;
      coverage_count: number;
      f1ql_view_count: number;
    }>(`
      SELECT
        (SELECT relpersistence::text FROM pg_class WHERE oid = 'official_timing.lap_fact'::regclass) AS persistence,
        (SELECT count(*)::integer FROM official_timing.driver_identity) AS identity_count,
        (SELECT count(*)::integer FROM official_timing.lap_fact) AS fact_count,
        (SELECT count(*)::integer FROM official_timing.artifact) AS artifact_count,
        (SELECT count(*)::integer FROM official_timing.coverage) AS coverage_count,
        (SELECT count(*)::integer FROM information_schema.views
          WHERE table_schema = 'f1ql' AND view_definition ILIKE '%official_timing%') AS f1ql_view_count
    `);
    const output = {
      version: 1,
      emitter: 'localhost_persistent_historical_lap_event_v1',
      dataset_sha256: dataset.dataset_sha256,
      source_manifest_sha256: dataset.source_manifest_sha256,
      identity_map_sha256: dataset.identity_map_sha256,
      identity_fingerprint: dataset.identity_fingerprint,
      fact_fingerprint: dataset.fact_fingerprint,
      committed,
      replay,
      stored: stored.rows[0],
      f1ql_operation: 'unsupported'
    };
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main();
