import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { executeF1QL } from '../src/f1ql/executor';
import { goldenCorpus } from '../tests/fixtures/f1ql-golden-corpus';
import { seedGoldenCorpusFixture } from '../tests/fixtures/f1ql-golden-corpus-fixture';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  try {
  await setupTestDatabase(pool, { seed: false });
  await seedGoldenCorpusFixture(pool);
  const snapshots = [];
  for (const testCase of goldenCorpus) {
    if (testCase.expected?.rejection) continue;
    const result = await executeF1QL(pool, testCase.program);
    snapshots.push({ question: testCase.question, rows: result.rows });
  }
  writeFileSync('tests/fixtures/f1ql-golden-corpus-results.json', `${JSON.stringify(snapshots, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

void main();
