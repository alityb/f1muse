import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { collectAnswerObservations } from '../src/f1ql/answer-observations';
import { linkAnswerF1QLCandidateObserved } from '../src/f1ql/translation-linking';
import { createF1QLTextModel, translateF1QLQuestion } from '../src/f1ql/translator';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';
import { seedAnswerEvaluationFixture } from '../tests/fixtures/f1ql-answer-evaluation-fixture';
import { answerEvaluationManifest } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

const DISPOSABLE_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';

function providerMetadata() {
  if (process.env.LLM_PROVIDER === 'openai-compatible') {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.F1QL_MODEL) {
      throw new Error('OpenAI-compatible evaluation provider is not configured');
    }
    return { type: 'openai-compatible' as const, model: process.env.F1QL_MODEL, collected_at: new Date().toISOString() };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic evaluation provider is not configured');
  }
  return { type: 'anthropic' as const, model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307', collected_at: new Date().toISOString() };
}

async function linkReadOnly(pool: Pool, candidate: Parameters<typeof linkAnswerF1QLCandidateObserved>[1]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', '1000ms', true)");
    const observation = await linkAnswerF1QLCandidateObserved(client, candidate);
    await client.query('ROLLBACK');
    return observation;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function translateBounded(question: string, model: ReturnType<typeof createF1QLTextModel>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await translateF1QLQuestion(question, model, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  if (process.env.F1QL_ANSWER_EVALUATION_ENABLED !== 'true' || process.env.F1QL_ANSWER_EVALUATION_TARGET !== 'localhost') {
    throw new Error('Answer evaluation collection requires explicit localhost flags');
  }
  const databaseUrl = getTestDatabaseUrl();
  assertDisposableDatabase(databaseUrl);
  const provider = providerMetadata();
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000, options: '-c statement_timeout=5000' });
  try {
    await setupTestDatabase(pool, { seed: false });
    await seedAnswerEvaluationFixture(pool);
    await pool.query(readFileSync('migrations/20260729_f1ql_answer_identity_views.sql', 'utf8'));
    const model = createF1QLTextModel();
    const artifact = await collectAnswerObservations(answerEvaluationManifest, provider, {
      translate: question => translateBounded(question, model),
      link: candidate => linkReadOnly(pool, candidate)
    });
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    const directory = mkdtempSync(join(tmpdir(), 'f1ql-answer-observations-'));
    const output = join(directory, 'observations.json');
    writeFileSync(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: 'observed_non_executing', output, sha256: createHash('sha256').update(serialized).digest('hex'), cases: artifact.observations.length, provider: provider.type, model: provider.model })}\n`);
  } finally {
    await pool.end();
  }
}

export function assertDisposableDatabase(databaseUrl: string): void {
  if (databaseUrl !== DISPOSABLE_DATABASE_URL) {
    throw new Error('Answer evaluation collection requires the exact disposable Docker database');
  }
}

if (require.main === module) void main();
