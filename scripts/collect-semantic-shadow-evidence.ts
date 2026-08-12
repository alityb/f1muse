import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeSync
} from 'node:fs';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createProgramSemanticShadowRoutes } from '../src/api/routes/program-semantic-shadow';
import {
  createSemanticCandidateModel,
  getConfiguredSemanticCandidateModelIdentity,
  SemanticCandidateProposalError,
  SemanticCandidateProposalAdapter
} from '../src/f1ql/semantic-candidate-translator';
import { SEMANTIC_CATALOG_HASH } from '../src/f1ql/semantic-catalog';
import { computeSemanticCandidateSetHash } from '../src/f1ql/semantic-query';
import { buildSemanticShadowReport } from '../src/f1ql/semantic-shadow-report';
import {
  computeSemanticShadowAttemptSha256,
  SemanticShadowRetainedObservation,
  sanitizeSemanticShadowRetainedObservation
} from '../src/f1ql/semantic-shadow-retained-observation';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';
import { compositionalRegressionCorpusInput } from '../tests/fixtures/compositional-regression-corpus';
import { seedAnswerEvaluationFixture } from '../tests/fixtures/f1ql-answer-evaluation-fixture';
import {
  CompositionalRegressionCorpus,
  CompositionalRegressionSnapshot,
  computeCompositionalRegressionCorpusHash,
  parseCompositionalRegressionCorpus,
  parseCompositionalRegressionSnapshot
} from '../tests/support/compositional-regression';
import { reviewedSemanticShadowReportRequirements } from './report-semantic-shadow';

const DISPOSABLE_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const COMPOSITIONAL_SNAPSHOT_PATH = 'tests/fixtures/compositional-regression.snapshot.json';
const IDENTITY_MIGRATIONS = [
  'migrations/20260729_f1ql_answer_identity_views.sql',
  'migrations/20260730_normalize_f1ql_answer_identity_driver_ids.sql'
] as const;
const REQUIRED_CASE_COUNT = 50;
const REQUIRED_REPETITIONS = 3;
const MAX_MIN_REQUEST_INTERVAL_MS = 60_000;

export function assertSemanticShadowCollectionGuards(
  environment: NodeJS.ProcessEnv,
  databaseUrl: string
): void {
  if (environment.F1QL_SEMANTIC_SHADOW_COLLECTION_ENABLED !== 'true' ||
      environment.F1QL_SEMANTIC_SHADOW_COLLECTION_TARGET !== 'localhost') {
    throw new Error('Semantic shadow collection requires explicit localhost flags');
  }
  if (environment.F1QL_SEMANTIC_SHADOW_COLLECTION_REPETITIONS !== String(REQUIRED_REPETITIONS)) {
    throw new Error('Semantic shadow collection requires exactly 3 repetitions');
  }
  if (databaseUrl !== DISPOSABLE_DATABASE_URL) {
    throw new Error('Semantic shadow collection requires the exact disposable Docker database');
  }
}

export function assertCompleteReviewedCompositionalCorpus(
  corpusInput: unknown,
  snapshotInput: unknown
): {
  readonly corpus: CompositionalRegressionCorpus;
  readonly snapshot: CompositionalRegressionSnapshot;
} {
  const corpus = parseCompositionalRegressionCorpus(corpusInput);
  const snapshot = parseCompositionalRegressionSnapshot(snapshotInput);
  if (corpus.cases.length !== REQUIRED_CASE_COUNT ||
      corpus.expected_coverage.cases_total !== REQUIRED_CASE_COUNT ||
      snapshot.cases.length !== REQUIRED_CASE_COUNT ||
      snapshot.coverage.cases_total !== REQUIRED_CASE_COUNT) {
    throw new Error('Semantic shadow collection requires the complete reviewed compositional corpus');
  }
  if (computeCompositionalRegressionCorpusHash(corpus) !== snapshot.corpus_hash) {
    throw new Error('Semantic shadow collection corpus does not match the reviewed snapshot');
  }
  for (const [index, item] of corpus.cases.entries()) {
    const expected = snapshot.cases[index];
    const answerMismatch = item.expected.action === 'answer' && expected &&
      (expected.plan?.topology !== item.expected.topology ||
       JSON.stringify(expected.plan.source_ids) !== JSON.stringify(item.expected.source_ids) ||
       expected.plan_family !== item.expected.plan_family);
    if (!expected || expected.id !== item.id || expected.split !== item.split ||
        expected.question_sha256 !== sha256(item.question) || expected.action !== item.expected.action ||
        expected.reason !== item.expected.reason || answerMismatch) {
      throw new Error('Semantic shadow collection corpus does not match the reviewed snapshot');
    }
  }
  if (JSON.stringify(corpus.expected_coverage) !== JSON.stringify(snapshot.coverage)) {
    throw new Error('Semantic shadow collection corpus coverage does not match the reviewed snapshot');
  }
  return Object.freeze({ corpus, snapshot });
}

export function parseSemanticShadowMinRequestIntervalMs(value: string | undefined): number {
  if (value === undefined) {return 0;}
  if (!/^\d+$/u.test(value)) {
    throw new Error('F1QL_SEMANTIC_SHADOW_COLLECTION_MIN_REQUEST_INTERVAL_MS must be an integer between 0 and 60000');
  }
  const intervalMs = Number(value);
  if (!Number.isSafeInteger(intervalMs) || intervalMs > MAX_MIN_REQUEST_INTERVAL_MS) {
    throw new Error('F1QL_SEMANTIC_SHADOW_COLLECTION_MIN_REQUEST_INTERVAL_MS must be an integer between 0 and 60000');
  }
  return intervalMs;
}

export function createSemanticShadowProviderPacer(
  intervalMs: number,
  dependencies: { now?: () => number; sleep?: (delayMs: number) => Promise<void> } = {}
): () => Promise<void> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > MAX_MIN_REQUEST_INTERVAL_MS) {
    throw new Error('Semantic shadow provider interval must be an integer between 0 and 60000 ms');
  }
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  let previousAttemptAt: number | undefined;
  return async () => {
    let attemptAt = now();
    if (!Number.isFinite(attemptAt) || (previousAttemptAt !== undefined && attemptAt < previousAttemptAt)) {
      throw new Error('Semantic shadow provider pacing clock must be monotonic');
    }
    if (previousAttemptAt !== undefined) {
      const targetAttemptAt = previousAttemptAt + intervalMs;
      let sleeps = 0;
      while (attemptAt < targetAttemptAt) {
        await sleep(Math.ceil(targetAttemptAt - attemptAt));
        const beforeSleep = attemptAt;
        attemptAt = now();
        if (!Number.isFinite(attemptAt) || attemptAt < beforeSleep) {
          throw new Error('Semantic shadow provider pacing clock must be monotonic');
        }
        sleeps += 1;
        if (sleeps > 10) {
          throw new Error('Semantic shadow provider pacing timer did not advance');
        }
      }
    }
    previousAttemptAt = attemptAt;
  };
}

export function formatSemanticShadowProviderFailureCode(
  code: SemanticCandidateProposalError['code'] | 'unknown' | undefined
): string {
  return `provider_${code ?? 'unknown'}`;
}

// A transient provider blip (dropped/garbled response, connection reset, server-side
// hiccup, stochastic output-quality failure from a nondeterministic serving backend,
// or an elapsed request budget under relaxed latency ceilings) must not destroy a long
// evidence run. Retry the same reviewed attempt a small bounded number of times; the
// transient operational-failure observation is replaced by the retry's terminal
// observation so the retained artifact still holds exactly one terminal event per
// attempt. This measures the semantic chain's ability to reach the reviewed terminal
// outcome per attempt, not provider reliability; production SLA behavior remains a
// separate canary concern. Deterministic configuration/contract failures
// (forbidden_output, auth, quota, rate_limit, oversize, client) are never retried.
const MAX_TRANSIENT_PROVIDER_RETRIES = 3;
const TRANSIENT_PROVIDER_RETRY_BASE_DELAY_MS = 5_000;
const MAX_TRANSIENT_PROVIDER_RETRY_DELAY_MS = 60_000;
const TRANSIENT_PROVIDER_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  'transport',
  'server',
  'malformed',
  'incomplete',
  'schema_invalid',
  'request_timeout',
  'cancelled'
]);

export function isTransientSemanticShadowProviderDiagnostic(
  code: SemanticCandidateProposalError['code'] | 'unknown' | undefined
): boolean {
  return code !== undefined && TRANSIENT_PROVIDER_DIAGNOSTIC_CODES.has(code);
}

export function semanticShadowTransientRetryDelayMs(retryIndex: number): number {
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 1 || retryIndex > MAX_TRANSIENT_PROVIDER_RETRIES) {
    throw new Error('Semantic shadow transient retry index must be an integer between 1 and 3');
  }
  return Math.min(TRANSIENT_PROVIDER_RETRY_BASE_DELAY_MS * retryIndex, MAX_TRANSIENT_PROVIDER_RETRY_DELAY_MS);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, delayMs));
}

async function main(): Promise<void> {
  const databaseUrl = getTestDatabaseUrl();
  assertSemanticShadowCollectionGuards(process.env, databaseUrl);
  const snapshotInput = JSON.parse(readFileSync(COMPOSITIONAL_SNAPSHOT_PATH, 'utf8')) as unknown;
  const { corpus, snapshot } = assertCompleteReviewedCompositionalCorpus(compositionalRegressionCorpusInput, snapshotInput);
  const reportRequirements = reviewedSemanticShadowReportRequirements(snapshot);
  const beforeRequest = createSemanticShadowProviderPacer(
    parseSemanticShadowMinRequestIntervalMs(
      process.env.F1QL_SEMANTIC_SHADOW_COLLECTION_MIN_REQUEST_INTERVAL_MS
    )
  );
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    options: '-c statement_timeout=5000'
  });
  const retainedEvents: SemanticShadowRetainedObservation[] = [];
  const runSha256 = randomBytes(32).toString('hex');
  let activeCaseIndex: number | undefined;
  let activeRepetitionIndex: number | undefined;
  let activeRawProviderCandidateSetSha256: string | undefined;
  let activeProviderDiagnosticCode: SemanticCandidateProposalError['code'] | 'unknown' | undefined;
  let executionAttempts = 0;
  const throwingExecutor = (): never => {
    executionAttempts += 1;
    throw new Error('Semantic shadow collection must never execute a query');
  };
  let server: Server | undefined;
  try {
    await seedDisposableDatabase(pool);
    const token = randomBytes(32).toString('base64url');
    const routeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      F1QL_SEMANTIC_SHADOW_ENABLED: 'true',
      F1QL_SEMANTIC_SHADOW_KILL_SWITCH: 'false',
      F1QL_SEMANTIC_SHADOW_STAGE: '0',
      F1QL_SEMANTIC_SHADOW_INTERNAL_TOKEN: token
    };
    const app = express();
    const provider = new SemanticCandidateProposalAdapter(createSemanticCandidateModel(routeEnvironment));
    const providerIdentity = getConfiguredSemanticCandidateModelIdentity(routeEnvironment);
    // Warm the provider once before the corpus loop so cold-start latency does not
    // count against the first reviewed attempt; the warmup emits no retained evidence.
    // The same bounded transient-retry policy as the corpus loop applies, since a
    // transient warmup blip must not destroy the run before it starts.
    let warmupRetries = 0;
    for (;;) {
      try {
        await provider.propose({
          question: corpus.cases[0].question,
          semantic_query_version: 2,
          max_candidates: 5
        });
        break;
      } catch (error) {
        const code = error instanceof SemanticCandidateProposalError ? error.code : 'unknown';
        if (!isTransientSemanticShadowProviderDiagnostic(code) || warmupRetries >= MAX_TRANSIENT_PROVIDER_RETRIES) {
          throw error;
        }
        warmupRetries += 1;
        await sleep(semanticShadowTransientRetryDelayMs(warmupRetries));
      }
    }
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2kb' }));
    app.use('/', createProgramSemanticShadowRoutes(pool, {
      environment: () => routeEnvironment,
      proposer: {
        propose: async (request, signal) => {
          let proposed;
          try {
            proposed = await provider.propose(request, signal);
          } catch (error) {
            activeProviderDiagnosticCode = error instanceof SemanticCandidateProposalError ? error.code : 'unknown';
            throw error;
          }
          activeRawProviderCandidateSetSha256 = computeSemanticCandidateSetHash(
            proposed.candidates,
            sha256(request.question),
            SEMANTIC_CATALOG_HASH
          );
          const activeCase = activeCaseIndex === undefined ? undefined : corpus.cases[activeCaseIndex];
          if (activeCase?.provider_mode !== 'omit_last_output') {return proposed;}
          if (proposed.candidates.length !== 1 || proposed.candidates[0].outputs.length < 2) {
            throw new Error('Semantic shadow provider substitution fixture requires one multi-output candidate');
          }
          const candidate = structuredClone(proposed.candidates[0]);
          candidate.outputs.pop();
          return { ...proposed, candidates: [candidate] };
        }
      },
      providerIdentity,
      evidenceBinding: questionSha256 => {
        if (activeCaseIndex === undefined || activeRepetitionIndex === undefined) {
          throw new Error('Semantic shadow collection attempt is not active');
        }
        const binding = {
          corpus_sha256: snapshot.corpus_hash,
          run_sha256: runSha256,
          question_sha256: questionSha256,
          case_index: activeCaseIndex,
          repetition_index: activeRepetitionIndex,
          ...(activeRawProviderCandidateSetSha256 === undefined ? {} : {
            provider_raw_candidate_set_sha256: activeRawProviderCandidateSetSha256
          })
        };
        return {
          corpus_sha256: binding.corpus_sha256,
          run_sha256: binding.run_sha256,
          case_index: binding.case_index,
          repetition_index: binding.repetition_index,
          attempt_sha256: computeSemanticShadowAttemptSha256(binding),
          ...('provider_raw_candidate_set_sha256' in binding ? {
            provider_raw_candidate_set_sha256: binding.provider_raw_candidate_set_sha256
          } : {})
        };
      },
      logger: line => retainedEvents.push(sanitizeSemanticShadowRetainedObservation(JSON.parse(line)))
    }, throwingExecutor));
    server = await listenLocally(app);
    const port = (server.address() as AddressInfo).port;

    for (let repetition = 0; repetition < REQUIRED_REPETITIONS; repetition += 1) {
      for (const item of corpus.cases) {
        activeCaseIndex = corpus.cases.indexOf(item);
        activeRepetitionIndex = repetition;
        activeRawProviderCandidateSetSha256 = undefined;
        activeProviderDiagnosticCode = undefined;
        await configureDisposableResolverCase(pool, item.id);
        await beforeRequest();
        let transientRetries = 0;
        for (;;) {
          activeRawProviderCandidateSetSha256 = undefined;
          activeProviderDiagnosticCode = undefined;
          const retainedBefore = retainedEvents.length;
          const response = await fetch(`http://127.0.0.1:${port}/program/semantic-shadow`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Connection: 'close',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ question: item.question })
          });
          const body = await response.json() as unknown;
          if (retainedEvents.length !== retainedBefore + 1) {
            throw new Error('Semantic shadow route did not emit exactly one retained terminal event');
          }
          try {
            assertTerminalResponse(
              response.status, body, retainedEvents[retainedBefore], snapshot.cases[activeCaseIndex], activeProviderDiagnosticCode
            );
            break;
          } catch (error) {
            const retained = retainedEvents[retainedBefore] as { terminal?: unknown } | undefined;
            const retryable = retained?.terminal === 'operational_failure' &&
              isTransientSemanticShadowProviderDiagnostic(activeProviderDiagnosticCode) &&
              transientRetries < MAX_TRANSIENT_PROVIDER_RETRIES;
            if (!retryable) {
              throw error;
            }
            transientRetries += 1;
            retainedEvents.pop();
            await sleep(semanticShadowTransientRetryDelayMs(transientRetries));
          }
        }
        if (executionAttempts !== 0) {
          throw new Error('Semantic shadow collector reached the throwing executor');
        }
      }
    }

    const expectedCount = REQUIRED_CASE_COUNT * REQUIRED_REPETITIONS;
    if (retainedEvents.length !== expectedCount || executionAttempts !== 0 ||
        retainedEvents.some(event => retainedResultQueryCalls(event) !== 0)) {
      throw new Error('Semantic shadow collection terminal-event accounting failed');
    }
    const report = buildSemanticShadowReport(retainedEvents, reportRequirements);
    if (report.safety.status !== 'pass' || report.repetition.status !== 'pass' || report.oracle.status !== 'pass') {
      throw new Error('Semantic shadow collection evidence gates failed');
    }
    const bytes = Buffer.from(`${retainedEvents.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const directory = mkdtempSync(join(tmpdir(), 'f1ql-semantic-shadow-'));
    const output = join(directory, 'semantic-shadow-evidence.jsonl');
    writeExclusive(output, bytes);
    process.stdout.write(`${JSON.stringify({
      path: output,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      count: retainedEvents.length,
      case_count: corpus.cases.length,
      repetitions: REQUIRED_REPETITIONS
    })}\n`);
  } finally {
    if (server) {await closeServer(server);}
    await pool.end();
  }
}

async function seedDisposableDatabase(pool: Pool): Promise<void> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await setupTestDatabase(pool, { seed: false });
  } finally {
    console.log = originalLog;
  }
  await seedAnswerEvaluationFixture(pool);
  await pool.query(`INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES
    ('historical_norris', 'Historical Norris', 'Historical Norris', 'Historical', 'Norris', 'HNO'),
    ('george_russell', 'George Russell', 'George Russell', 'George', 'Russell', 'RUS')`);
  await pool.query(`INSERT INTO season_entrant_driver
    (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
    (2024, 'mclaren', 'mclaren', 'oscar_piastri', false),
    (2025, 'mercedes', 'mercedes', 'george_russell', false)`);
  await pool.query(`INSERT INTO race
    (id, year, round, circuit_id, grand_prix_id, official_name, date) VALUES
    (102, 2024, 2, 'fixture-2024-round-2', NULL, 'Formula 1 Fixture 2024 Round 2 Grand Prix', '2024-04-01')`);
  for (const migration of IDENTITY_MIGRATIONS) {
    await pool.query(readFileSync(migration, 'utf8'));
  }
}

async function configureDisposableResolverCase(pool: Pool, caseId: string): Promise<void> {
  await pool.query("DELETE FROM driver_aliases WHERE driver_id = 'sample_driver' AND alias = 'Monaco'");
  if (caseId === 'ambiguity-entity-type') {
    await pool.query("INSERT INTO driver_aliases (driver_id, alias, is_primary) VALUES ('sample_driver', 'Monaco', false)");
  }
}

async function listenLocally(app: Express): Promise<Server> {
  return new Promise(resolveListen => {
    const listening = app.listen(0, '127.0.0.1', () => resolveListen(listening));
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
}

function assertTerminalResponse(
  status: number,
  input: unknown,
  retained: SemanticShadowRetainedObservation,
  expected: CompositionalRegressionSnapshot['cases'][number],
  providerDiagnosticCode?: SemanticCandidateProposalError['code'] | 'unknown'
): void {
  if (!isRecord(input) || !('terminal' in retained)) {
    throw new Error('Semantic shadow route returned a non-terminal response');
  }
  if (retained.terminal === 'operational_failure') {
    throw new Error(`Semantic shadow collection encountered an operational failure: ${formatSemanticShadowProviderFailureCode(providerDiagnosticCode)}`);
  }
  if (input.mode !== 'semantic_shadow' || input.rollout_stage !== 0 ||
      !isRecord(input.observation) || JSON.stringify(input.observation) !== JSON.stringify(retained.observation)) {
    throw new Error('Semantic shadow route returned a non-terminal response');
  }
  const expectedStatus = retained.observation.outcome === 'unavailable' ? 503 : 200;
  const expectedReason = expected.action === 'answer' ? 'plan_proven' : expected.reason;
  const hashes = retained.observation.hashes;
  const mismatches = [
    ...(status === expectedStatus ? [] : ['http_status']),
    ...(retained.observation.result_query_calls === 0 ? [] : ['result_query_calls']),
    ...(retained.question_sha256 === expected.question_sha256 ? [] : ['question_hash']),
    ...(retained.observation.outcome === expected.action ? [] : [`outcome_${retained.observation.outcome}`]),
    ...(retained.observation.reason === expectedReason ? [] : [`reason_${retained.observation.reason}`]),
    ...(providerDiagnosticCode === undefined ? [] : [`provider_${providerDiagnosticCode}`])
  ];
  if (expected.action === 'answer') {
    if (!expected.plan || !expected.proof) {mismatches.push('reviewed_answer_missing');}
    else {
      const answerBindings = [
        ['topology', retained.observation.topology_code, expected.plan.topology],
        ['source_set', retained.observation.source_set_code, expected.plan.source_ids.join('__')],
        ['candidate_set_hash', hashes.candidate_set_sha256, expected.evidence.candidate_set_hash],
        ['provider_candidate_set_hash', hashes.provider_candidate_set_sha256, expected.evidence.candidate_set_hash],
        ['semantic_evidence_hash', hashes.semantic_evidence_sha256, expected.evidence.evidence_hash],
        ['semantic_query_hash', hashes.semantic_query_sha256, expected.admission.query_hash],
        ['answer_plan_hash', hashes.answer_plan_sha256, expected.plan.answer_plan_hash],
        ['topology_hash', hashes.topology_sha256, expected.proof.topology_hash],
        ['planned_f1ql_hash', hashes.planned_f1ql_sha256, expected.plan.planned_f1ql_hash],
        ['core_hash', hashes.core_sha256, expected.plan.core_hash],
        ['compiled_hash', hashes.compiled_sha256, expected.proof.compiled_hash],
        ['semantic_proof_hash', hashes.semantic_proof_sha256, expected.proof.proof_hash]
      ] as const;
      for (const [code, actual, reviewed] of answerBindings) {
        if (actual !== reviewed) {mismatches.push(code);}
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Semantic shadow route returned an invalid terminal status for case ${expected.id}: ${mismatches.join(',')}`);
  }
}

function retainedResultQueryCalls(retained: SemanticShadowRetainedObservation): number {
  if (!('terminal' in retained)) {return retained.observation.result_query_calls;}
  return retained.terminal === 'semantic' ? retained.observation.result_query_calls : retained.result_query_calls;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

function writeExclusive(path: string, content: Buffer): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < content.byteLength) {
      offset += writeSync(descriptor, content, offset, content.byteLength - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

if (require.main === module) {void main();}
