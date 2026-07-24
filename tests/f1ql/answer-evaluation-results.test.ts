import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { emitAnswerEvaluationResults } from '../../scripts/snapshot-answer-evaluation-results';
import { seedAnswerEvaluationFixture } from '../fixtures/f1ql-answer-evaluation-fixture';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await seedAnswerEvaluationFixture(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('answer evaluation generated results', () => {
  it('matches the real bounded canonical-program emitter', async () => {
    const expected = JSON.parse(readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', 'utf8'));
    await expect(emitAnswerEvaluationResults(pool)).resolves.toEqual(expected);
  });
});
