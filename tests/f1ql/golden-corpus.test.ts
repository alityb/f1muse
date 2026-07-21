import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeF1QL } from '../../src/f1ql/executor';
import { lowerF1QL } from '../../src/f1ql/lower';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { validateF1QLProgram } from '../../src/f1ql/validation';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { goldenCorpus } from '../fixtures/f1ql-golden-corpus';
import { seedGoldenCorpusFixture } from '../fixtures/f1ql-golden-corpus-fixture';

const corpus = goldenCorpus;
const golden = JSON.parse(readFileSync('tests/fixtures/f1ql-golden-corpus-programs.json', 'utf8')) as Array<{ question: string; core_program: unknown }>;
const results = JSON.parse(readFileSync('tests/fixtures/f1ql-golden-corpus-results.json', 'utf8')) as Array<{ question: string; rows: Array<Record<string, unknown>> }>;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await seedGoldenCorpusFixture(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('F1QL golden corpus', () => {
  it('matches real-emitter core program snapshots for every schema-valid case', () => {
    const emitted = corpus.flatMap(({ question, program }) => {
      try {
        return [{ question, core_program: lowerF1QL(parseF1QLProgram(program)) }];
      } catch {
        return [];
      }
    });
    expect(emitted).toEqual(golden);
  });

  for (const testCase of corpus) {
    it(testCase.question, async () => {
      const rejection = testCase.expected?.rejection;
      if (rejection?.stage === 'schema') {
        expect(() => parseF1QLProgram(testCase.program)).toThrow(rejection.message);
        return;
      }
      if (rejection) {
        if (rejection.stage === 'validation') {
          expect(() => validateF1QLProgram(testCase.program as never, rejection.options)).toThrow(expect.objectContaining({ code: rejection.code }));
          return;
        }
        await expect(executeF1QL(pool, testCase.program)).rejects.toMatchObject({
          ...(rejection.code ? { code: rejection.code } : {}),
          ...(rejection.message ? { message: expect.stringContaining(rejection.message) } : {})
        });
        return;
      }
      const expected = results.find(result => result.question === testCase.question);
      expect(expected, `missing generated rows for ${testCase.question}`).toBeDefined();
      await expect(executeF1QL(pool, testCase.program)).resolves.toMatchObject({ rows: expected?.rows });
    });
  }
});
