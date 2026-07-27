import fs from 'fs';
import { Pool } from 'pg';
import { ingestHistoricalLapDataset } from '../src/etl/historical-lap-ingestion';
import { loadHistoricalLapPilot } from '../src/etl/historical-lap-window-pilot';
import { authorizeAnswerProgram } from '../src/f1ql/answer-policy';
import { executeF1QL } from '../src/f1ql/executor';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from '../src/f1ql/official-lap-window';
import { F1QL_DEFINITIONS_VERSION } from '../src/f1ql/validation';
import { F1QL_COMPILER_VERSION, F1QL_FACT_SPACE_VERSION } from '../src/f1ql/verified-programs';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';

const EXPECTED_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const OUTPUT_PATH = 'data/phase8-belgium-2022-f1ql-result.json';

export async function emitOfficialLapWindowF1QL(databaseUrl: string) {
  if (databaseUrl !== EXPECTED_TEST_DATABASE_URL) {
    throw new Error('FAIL_CLOSED: F1QL Phase 8 snapshot requires the exact disposable localhost test database');
  }
  const pool = new Pool({ connectionString: EXPECTED_TEST_DATABASE_URL, max: 1 });
  try {
    await setupTestDatabase(pool);
    await pool.query(fs.readFileSync('migrations/20260801_official_timing_historical_laps.sql', 'utf8'));
    await pool.query(fs.readFileSync('migrations/20260802_f1ql_official_lap_timing.sql', 'utf8'));
    const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');
    const mappings = (JSON.parse(identityContent.toString('utf8')) as { mappings: Array<{ driver_id: string }> }).mappings;
    const canonical = await pool.query<{ driver_id: string; full_name: string }>(
      'SELECT id AS driver_id, full_name FROM driver WHERE id = ANY($1::text[]) ORDER BY id',
      [mappings.map(mapping => mapping.driver_id)]
    );
    const dataset = loadHistoricalLapPilot(fs.readFileSync('data/phase8-belgium-2022-pilot.json'), identityContent, canonical.rows);
    await ingestHistoricalLapDataset(pool, dataset);
    await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
      (2022, 'phase8-red-bull', 'RBR', 'max_verstappen', false),
      (2022, 'phase8-alpine', 'ALP', 'fernando_alonso', false)
      ON CONFLICT DO NOTHING`);
    const program = {
      version: 1 as const,
      root: {
        op: 'official_lap_window_median_compare' as const,
        metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
        season: 2022,
        round: 14,
        driver_a_id: 'max-verstappen',
        driver_b_id: 'fernando-alonso',
        lap_start: 3,
        lap_end: 10
      }
    };
    const executed = await executeF1QL(pool, program, { statementTimeoutMs: 1000, maxRows: 1 });
    return {
      version: 1,
      emitter: 'localhost_sealed_official_lap_f1ql_v1',
      definitions_version: F1QL_DEFINITIONS_VERSION,
      compiler_version: F1QL_COMPILER_VERSION,
      fact_space_version: F1QL_FACT_SPACE_VERSION,
      answer_policy: authorizeAnswerProgram(executed.program),
      program: executed.program,
      core_program: executed.core_program,
      rendering: executed.rendering,
      rows: executed.rows
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const output = await emitOfficialLapWindowF1QL(getTestDatabaseUrl());
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) void main();
