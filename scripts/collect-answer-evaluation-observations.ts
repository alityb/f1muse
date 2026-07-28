import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../src/identity/answer-identity-resolvers';
import { ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE, ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS, collectAnswerObservations, createAnswerObservationSigningHelper } from '../src/f1ql/answer-observations';
import { AnswerIntent } from '../src/f1ql/answer-intent';
import { AnswerQuestionContract } from '../src/f1ql/answer-question';
import { proveAnswerIntent } from '../src/f1ql/answer-semantic-proof';
import { AnswerIntentModel, AnswerTranslationResult, createAnswerIntentModel, getConfiguredAnswerModelIdentity, translateAnswerQuestion } from '../src/f1ql/answer-translator';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';
import { seedAnswerEvaluationFixture } from '../tests/fixtures/f1ql-answer-evaluation-fixture';
import { answerEvaluationManifest } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

const DISPOSABLE_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const MAX_MIN_REQUEST_INTERVAL_MS = 60_000;

export function parseAnswerEvaluationMinRequestIntervalMs(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error('F1QL_ANSWER_EVALUATION_MIN_REQUEST_INTERVAL_MS must be an integer between 0 and 60000');
  }
  const intervalMs = Number(value);
  if (!Number.isSafeInteger(intervalMs) || intervalMs > MAX_MIN_REQUEST_INTERVAL_MS) {
    throw new Error('F1QL_ANSWER_EVALUATION_MIN_REQUEST_INTERVAL_MS must be an integer between 0 and 60000');
  }
  return intervalMs;
}

export function createAnswerEvaluationProviderPacer(
  intervalMs: number,
  dependencies: { now?: () => number; sleep?: (delayMs: number) => Promise<void> } = {}
): () => Promise<void> {
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > MAX_MIN_REQUEST_INTERVAL_MS) {
    throw new Error('Answer evaluation provider interval must be an integer between 0 and 60000 ms');
  }
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  let previousAttemptAt: number | undefined;
  return async () => {
    let attemptAt = now();
    if (!Number.isFinite(attemptAt) || (previousAttemptAt !== undefined && attemptAt < previousAttemptAt)) {
      throw new Error('Answer evaluation provider pacing clock must be monotonic');
    }
    if (previousAttemptAt !== undefined) {
      const targetAttemptAt = previousAttemptAt + intervalMs;
      let sleeps = 0;
      while (attemptAt < targetAttemptAt) {
        await sleep(Math.ceil(targetAttemptAt - attemptAt));
        const beforeSleep = attemptAt;
        attemptAt = now();
        if (!Number.isFinite(attemptAt) || attemptAt < beforeSleep) {
          throw new Error('Answer evaluation provider pacing clock must be monotonic');
        }
        sleeps += 1;
        if (sleeps > 10) {
          throw new Error('Answer evaluation provider pacing timer did not advance');
        }
      }
    }
    previousAttemptAt = attemptAt;
  };
}

function providerMetadata() {
  const identity = getConfiguredAnswerModelIdentity();
  return {
    type: identity.provider,
    model: identity.model_id,
    endpoint_sha256: identity.endpoint_sha256,
    reasoning_effort: identity.reasoning_effort,
    collected_at: new Date().toISOString()
  };
}

async function proveReadOnly(pool: Pool, contract: AnswerQuestionContract, intent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', '1000ms', true)");
    const proof = await proveAnswerIntent(contract, intent, new AnswerEventIdentityResolver(client), new AnswerDriverIdentityResolver(client));
    await client.query('ROLLBACK');
    return proof;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function translateBounded(contract: AnswerQuestionContract, model: AnswerIntentModel, timeoutMs = ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS) {
    throw new Error('Answer evaluation translation timeout must be between 1 and 15000 ms');
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ result: AnswerTranslationResult; timedOut: true }>(resolve => {
    timeout = setTimeout(() => {
      resolve({ result: { type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'request_timeout' }, timedOut: true });
      setImmediate(() => controller.abort());
    }, timeoutMs);
  });
  const translation = translateAnswerQuestion(contract, model, controller.signal)
    .then(result => ({ result, timedOut: false as const }));
  try {
    return await Promise.race([translation, deadline]);
  } finally {
    clearTimeout(timeout!);
  }
}

async function main(): Promise<void> {
  if (process.env.F1QL_ANSWER_EVALUATION_ENABLED !== 'true' || process.env.F1QL_ANSWER_EVALUATION_TARGET !== 'localhost') {
    throw new Error('Answer evaluation collection requires explicit localhost flags');
  }
  const beforeTranslate = createAnswerEvaluationProviderPacer(
    parseAnswerEvaluationMinRequestIntervalMs(process.env.F1QL_ANSWER_EVALUATION_MIN_REQUEST_INTERVAL_MS)
  );
  const databaseUrl = getTestDatabaseUrl();
  assertDisposableDatabase(databaseUrl);
  const signer = createAnswerObservationSigningHelper(
    requiredEnvironment('F1QL_ANSWER_EVALUATION_KEY_ID'),
    requiredEnvironment('F1QL_ANSWER_EVALUATION_PRIVATE_KEY_BASE64')
  );
  if (answerEvaluationManifest.length !== 104) {
    throw new Error('Answer evaluation collection requires the complete reviewed corpus');
  }
  const provider = providerMetadata();
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000, options: '-c statement_timeout=5000' });
  try {
    await setupTestDatabase(pool, { seed: false });
    await seedAnswerEvaluationFixture(pool);
    await pool.query(readFileSync('migrations/20260729_f1ql_answer_identity_views.sql', 'utf8'));
    const model = createAnswerIntentModel();
    const artifact = await collectAnswerObservations(answerEvaluationManifest, provider, {
      beforeTranslate,
      translate: contract => translateBounded(contract, model),
      prove: (contract, intent) => proveReadOnly(pool, contract, intent)
    }, signer);
    const uniqueCaseCount = new Set(artifact.observations.map(observation => observation.id)).size;
    const expectedObservationCount = answerEvaluationManifest.reduce((count, item) =>
      count + (item.answerable ? ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE : 1), 0);
    if (uniqueCaseCount !== answerEvaluationManifest.length || uniqueCaseCount !== 104 || artifact.observations.length !== expectedObservationCount) {
      throw new Error('Answer evaluation collection did not complete the reviewed corpus');
    }
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    const directory = mkdtempSync(join(tmpdir(), 'f1ql-answer-observations-'));
    const output = join(directory, 'observations.json');
    writeFileSync(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ path: output, sha256: createHash('sha256').update(serialized).digest('hex'), count: artifact.observations.length, case_count: uniqueCaseCount, provider: provider.type })}\n`);
  } finally {
    await pool.end();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

export function assertDisposableDatabase(databaseUrl: string): void {
  if (databaseUrl !== DISPOSABLE_DATABASE_URL) {
    throw new Error('Answer evaluation collection requires the exact disposable Docker database');
  }
}

if (require.main === module) void main();
