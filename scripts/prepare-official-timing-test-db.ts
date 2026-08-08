import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { ingestHistoricalLapDataset } from '../src/etl/historical-lap-ingestion';
import { loadHistoricalLapPilot } from '../src/etl/historical-lap-window-pilot';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';

export async function prepareOfficialTimingTestDatabase(pool: Pool): Promise<void> {
  await setupTestDatabase(pool);
  await pool.query('CREATE TABLE IF NOT EXISTS driver_aliases (driver_id text, alias text, is_primary boolean)');
  const migrations = [
    'migrations/20260729_f1ql_answer_identity_views.sql',
    'migrations/20260730_normalize_f1ql_answer_identity_driver_ids.sql',
    'migrations/20260730_f1ql_answer_role_grants.sql',
    'migrations/20260801_official_timing_historical_laps.sql',
    'migrations/20260802_f1ql_official_lap_timing.sql',
    'migrations/20260807_f1ql_official_race_lap_timing_activation.sql'
  ];
  for (const migration of migrations) {
    try {
      await pool.query(fs.readFileSync(path.resolve(migration), 'utf8'));
    } catch (error) {
      throw new Error(`migration ${migration} failed: ${(error as Error).message}`);
    }
  }
  const sourceContent = fs.readFileSync('data/phase8-belgium-2022-pilot.json');
  const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');
  const mappings = (JSON.parse(identityContent.toString('utf8')) as { mappings: Array<{ driver_id: string }> }).mappings;
  const canonical = await pool.query<{ driver_id: string; full_name: string }>(
    'SELECT id AS driver_id, full_name FROM driver WHERE id = ANY($1::text[]) ORDER BY id',
    [mappings.map(mapping => mapping.driver_id)]
  );
  const dataset = loadHistoricalLapPilot(sourceContent, identityContent, canonical.rows);
  await ingestHistoricalLapDataset(pool, dataset);
  await pool.query(`
    INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation)
    VALUES ('belgian_gp_2022', 'Belgian Grand Prix', 'Formula 1 Belgian Grand Prix 2022', 'Belgian GP', 'BEL')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO race (id, year, round, grand_prix_id, official_name, date)
    VALUES (900202214, 2022, 14, 'belgian_gp_2022', 'Formula 1 Belgian Grand Prix 2022', '2022-08-28')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  try {
    await prepareOfficialTimingTestDatabase(pool);
    console.log('official timing test database prepared');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('prepare-official-timing-test-db.ts')) {
  void main();
}
