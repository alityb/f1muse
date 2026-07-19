import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

interface SnapshotColumn {
  table_name: string;
  column_name: string;
}

interface ProductionSchemaSnapshot {
  columns: SnapshotColumn[];
}

const snapshotPath = resolve(process.cwd(), 'tests/schema/snapshots/production-schema.json');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ProductionSchemaSnapshot;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool, { seed: false });
});

afterAll(async () => {
  await pool.end();
});

describe('canonical test schema production snapshot compatibility', () => {
  it('uses only tables and columns present in the captured production schema', async () => {
    const productionColumns = new Set(
      snapshot.columns.map((column) => `${column.table_name}.${column.column_name}`)
    );
    const testColumns = await pool.query<SnapshotColumn>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const missing = testColumns.rows
      .map((column) => `${column.table_name}.${column.column_name}`)
      .filter((column) => !productionColumns.has(column));

    expect(missing).toEqual([]);
  });
});
