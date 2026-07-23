import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;

describe('verified program fact-space migration', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool, { seed: false });
    const migration = readFileSync(path.resolve(process.cwd(), 'migrations/20260728_f1ql_verified_program_fact_space.sql'), 'utf8');
    await pool.query(migration);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS f1ql.verified_program, f1ql.fact_space_revision');
    await pool.end();
  });

  it('creates only versioned review registries', async () => {
    const result = await pool.query<{ verified_program: string | null; fact_space_revision: string | null }>(
      "SELECT to_regclass('f1ql.verified_program')::text AS verified_program, to_regclass('f1ql.fact_space_revision')::text AS fact_space_revision"
    );
    expect(result.rows).toEqual([{ verified_program: 'f1ql.verified_program', fact_space_revision: 'f1ql.fact_space_revision' }]);
  });
});
