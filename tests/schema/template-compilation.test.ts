import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { TemplateLoader } from '../../src/execution/template-loader';
import { APPROVED_SQL_TEMPLATES } from '../../src/types/database';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;
const loader = new TemplateLoader();

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool, { seed: false });
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
});

describe('approved SQL template schema compatibility', () => {
  for (const [index, templateId] of APPROVED_SQL_TEMPLATES.entries()) {
    it(`prepares ${templateId} against the canonical test schema`, async () => {
      const statementName = `template_contract_${index}`;
      const sql = loader.load(templateId).replace(/;\s*$/, '');

      await pool.query(`PREPARE ${statementName} AS ${sql}`);
      await pool.query(`DEALLOCATE ${statementName}`);

      expect(true).toBe(true);
    });
  }
});
