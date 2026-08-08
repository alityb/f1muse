import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../src/identity/answer-identity-resolvers';
import { parseOfficialTimingQuestion } from '../src/f1ql/official-timing-question';
import { enumerateOfficialTimingEvidence } from '../src/f1ql/official-timing-semantic-query';
import { collectOfficialTimingResolution } from '../src/f1ql/official-timing-resolution';
import { planOfficialTimingAnswer } from '../src/f1ql/official-timing-plan';
import { runOfficialTimingPlannedPipeline } from '../src/f1ql/official-timing-compiler';
import { proveOfficialTimingPlan } from '../src/f1ql/official-timing-proof';
import { authorizeOfficialTimingCapability } from '../src/f1ql/official-timing-authorization';
import { OFFICIAL_TIMING_CAPABILITY_PROFILE_ID, OFFICIAL_TIMING_CATALOG_V2_SHA256 } from '../src/f1ql/official-timing-capability';
import { executeOfficialTimingPlan } from '../src/f1ql/official-timing-execution';
import { formatOfficialTimingResult } from '../src/f1ql/official-timing-format';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../src/f1ql/wp12-official-timing-catalog-target';

export const OFFICIAL_TIMING_SEMANTIC_RESULTS_EMITTER = 'localhost_sealed_official_timing_semantic_v32_v1' as const;

const REFERENCE_QUESTIONS = [
  {
    id: 'official_event_mean_verstappen_alonso',
    question: 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?'
  },
  {
    id: 'official_window_median_verstappen_alonso_laps_3_10',
    question: 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 3 to 10 at the 2022 Belgian Grand Prix'
  }
] as const;

export async function emitOfficialTimingSemanticResults(answerPool: Pool) {
  const emitted = [];
  for (const reference of REFERENCE_QUESTIONS) {
    const question = parseOfficialTimingQuestion(reference.question);
    if (question.type !== 'matched') {
      throw new Error(`reference question refused: ${reference.id}`);
    }
    const evidence = enumerateOfficialTimingEvidence(question, WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog);
    const resolution = await collectOfficialTimingResolution(question, evidence, {
      database: answerPool,
      catalog: WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog,
      driver_resolver: new AnswerDriverIdentityResolver(answerPool),
      event_resolver: new AnswerEventIdentityResolver(answerPool)
    });
    if (resolution.type !== 'resolved') {
      throw new Error(`reference question did not resolve: ${reference.id} (${resolution.coverage.reason})`);
    }
    const plan = planOfficialTimingAnswer({ question, evidence, resolution });
    const pipeline = runOfficialTimingPlannedPipeline(plan);
    const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
    const now = Date.now();
    const authorization = authorizeOfficialTimingCapability({
      question, evidence, resolution, plan, pipeline, proof,
      request_id: `emitter-${reference.id}`,
      principal_class: 'internal',
      canary: { stage: 100, subject_id: 'emitter' },
      release: {
        release_version: 9,
        release_id: 'emitter-local-release',
        commit_sha: '0'.repeat(40),
        audience: 'f1muse-answer',
        deployment_id: 'emitter-local',
        expires_at: new Date(now + 300_000).toISOString(),
        routing_mode: 'compositional_profiles',
        allowed_capability_profile_ids: [OFFICIAL_TIMING_CAPABILITY_PROFILE_ID],
        allowed_principal_classes: ['internal'],
        catalog_hash: OFFICIAL_TIMING_CATALOG_V2_SHA256,
        release_attestation_sha256: '0'.repeat(64)
      },
      now_ms: now
    });
    const execution = await executeOfficialTimingPlan(
      answerPool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash,
      {
        request_id: `emitter-${reference.id}`,
        principal_class: 'internal',
        statement_timeout_ms: 2000,
        deadline_ms: now + 10_000,
        is_kill_switch_active: () => false,
        now_ms: now
      }
    );
    const envelope = formatOfficialTimingResult(execution, { question, resolution, plan, pipeline, proof });
    emitted.push({
      id: reference.id,
      question: reference.question,
      envelope
    });
  }
  return emitted;
}

const EXPECTED_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl !== EXPECTED_TEST_DATABASE_URL) {
    throw new Error('FAIL_CLOSED: official timing semantic snapshot requires the exact disposable localhost test database');
  }
  const answerPool = new Pool({
    connectionString: EXPECTED_TEST_DATABASE_URL,
    options: '-c role=f1ql_answer',
    max: 1
  });
  try {
    const emitted = await emitOfficialTimingSemanticResults(answerPool);
    const output = {
      emitter: OFFICIAL_TIMING_SEMANTIC_RESULTS_EMITTER,
      generated_at: null,
      results: emitted
    };
    writeFileSync(
      'tests/fixtures/f1ql-official-timing-semantic-results.json',
      `${JSON.stringify(output, null, 2)}\n`
    );
    console.log(`emitted ${emitted.length} official timing semantic v32 results`);
  } finally {
    await answerPool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('snapshot-official-timing-semantic-results.ts')) {
  void main();
}
