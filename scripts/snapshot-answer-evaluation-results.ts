import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { enforceAnswerRows, enforceAnswerWorkBudget, serializeAnswerResponse } from '../src/f1ql/answer-bounds';
import { buildAnswerEnvelope } from '../src/f1ql/answer-format';
import { authorizeAnswerProgram } from '../src/f1ql/answer-policy';
import { executeF1QL } from '../src/f1ql/executor';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';
import { seedAnswerEvaluationFixture } from '../tests/fixtures/f1ql-answer-evaluation-fixture';
import { answerEvaluationManifest } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

export async function emitAnswerEvaluationResults(pool: Pool) {
  const emitted = [];
  for (const item of answerEvaluationManifest.filter(testCase => testCase.expected.action === 'answer')) {
    const program = item.expected.acceptable_programs?.[0];
    if (!program) throw new Error(`missing reviewed program for ${item.id}`);
    const decision = authorizeAnswerProgram(program);
    if (decision.type !== 'approved') throw new Error(`reviewed program denied for ${item.id}`);
    enforceAnswerWorkBudget(program, decision.capability, 200, 100);
    const result = await executeF1QL(pool, program, { statementTimeoutMs: 1000, maxRows: 100 });
    enforceAnswerRows(result.rows, 100);
    const envelope = buildAnswerEnvelope(result.program, decision.capability, result.rows);
    serializeAnswerResponse(envelope, 65_536);
    emitted.push({ id: item.id, envelope });
  }
  return emitted;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  try {
    await setupTestDatabase(pool, { seed: false });
    await seedAnswerEvaluationFixture(pool);
    const emitted = await emitAnswerEvaluationResults(pool);
    writeFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', `${JSON.stringify(emitted, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main();
