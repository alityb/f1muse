import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, mkdtempSync, openSync, readFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../src/identity/answer-identity-resolvers';
import { AnswerBoundError, enforceAnswerWorkBudget } from '../src/f1ql/answer-bounds';
import {
  AnswerDerivationEvidenceObservation,
  getAnswerDerivationManifestHash,
  signAnswerDerivationEvidence
} from '../src/f1ql/answer-derivation-evidence';
import { AnswerEvaluationCase } from '../src/f1ql/answer-evaluation';
import { AnswerIntent } from '../src/f1ql/answer-intent';
import { ANSWER_INTENT_DERIVATION_VERSION, deriveAnswerIntent } from '../src/f1ql/answer-intent-derivation';
import { ANSWER_INTENT_SCHEMA_VERSION } from '../src/f1ql/answer-intent';
import { ANSWER_QUESTION_CONTRACT_VERSION, createAnswerQuestionContract } from '../src/f1ql/answer-question';
import { authorizeAnswerProgram } from '../src/f1ql/answer-policy';
import { ANSWER_SEMANTIC_PROOF_VERSION, AnswerSemanticProofError, proveAnswerIntent } from '../src/f1ql/answer-semantic-proof';
import { ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from '../src/f1ql/answer-templates';
import { F1QLLinkingError } from '../src/f1ql/translation-linking';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';
import { seedAnswerEvaluationFixture } from '../tests/fixtures/f1ql-answer-evaluation-fixture';
import { answerEvaluationManifest } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

const DISPOSABLE_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';

export async function collectAnswerDerivationEvidence(
  cases: readonly AnswerEvaluationCase[],
  pool: Pool,
  collectedAt: string,
  signer: { key_id: string; private_key_base64: string }
) {
  const observations: AnswerDerivationEvidenceObservation[] = [];
  for (const item of cases) observations.push(await observeCase(item, pool));
  return signAnswerDerivationEvidence(cases, {
    version: 1,
    kind: 'f1ql_answer_derivation_evidence',
    collected_at: collectedAt,
    manifest: { case_count: cases.length, sha256: getAnswerDerivationManifestHash(cases) },
    contract: {
      question_version: ANSWER_QUESTION_CONTRACT_VERSION,
      derivation_version: ANSWER_INTENT_DERIVATION_VERSION,
      intent_schema_version: ANSWER_INTENT_SCHEMA_VERSION,
      template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
      template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
      proof_version: ANSWER_SEMANTIC_PROOF_VERSION
    },
    observations
  }, signer);
}

async function observeCase(item: AnswerEvaluationCase, pool: Pool): Promise<AnswerDerivationEvidenceObservation> {
  let contract;
  try {
    contract = createAnswerQuestionContract(item.question);
  } catch {
    return observation(item.id, 'abstain', 'question_invalid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout', '1000ms', true)");
    const intent = await deriveAnswerIntent(contract, new AnswerDriverIdentityResolver(client));
    if (intent.type === 'clarification') return observation(item.id, 'clarify', intent.reason);
    if (intent.type === 'unsupported') return observation(item.id, 'abstain', intent.reason);
    return await proveObservation(item.id, contract, intent, client);
  } catch (error) {
    return failedObservation(item.id, error);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function proveObservation(
  id: string,
  contract: ReturnType<typeof createAnswerQuestionContract>,
  intent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>,
  client: PoolClient
): Promise<AnswerDerivationEvidenceObservation> {
  const proof = await proveAnswerIntent(
    contract,
    intent,
    new AnswerEventIdentityResolver(client),
    new AnswerDriverIdentityResolver(client)
  );
  const candidates = proof.mentions.flatMap(mention => mention.candidates.map(candidate => mention.kind === 'driver' ? `driver:${candidate}` : candidate)).sort();
  const linked = proof.mentions.map(mention => mention.kind === 'driver' ? `driver:${mention.selected_id}` : mention.selected_id).sort();
  const decision = authorizeAnswerProgram(proof.program);
  if (decision.type === 'rejected') return observation(id, 'abstain', decision.reason, candidates, linked);
  try {
    enforceAnswerWorkBudget(proof.program, decision.capability, 200, 100);
  } catch (error) {
    return observation(id, 'abstain', error instanceof AnswerBoundError ? error.bound : 'program_invalid', candidates, linked);
  }
  return {
    id,
    action: 'answer',
    reason: decision.capability.source,
    template_id: proof.template_id,
    proof_hash: proof.proof_hash,
    program_hash: proof.program_hash,
    entity_candidates: candidates,
    linked_entities: linked
  };
}

function failedObservation(id: string, error: unknown): AnswerDerivationEvidenceObservation {
  if (error instanceof F1QLLinkingError) {
    const candidates = (error.entityCandidates ?? linkingErrorEntities(error)).sort();
    return observation(id, error.code === 'event_ambiguous' || error.code === 'entity_ambiguous' ? 'clarify' : 'abstain', error.code, candidates);
  }
  if (error instanceof AnswerSemanticProofError || error instanceof z.ZodError) {
    return observation(id, 'abstain', error instanceof AnswerSemanticProofError ? error.reason : 'program_invalid');
  }
  return observation(id, 'abstain', 'linking_unavailable');
}

function observation(
  id: string,
  action: 'clarify' | 'abstain',
  reason: AnswerDerivationEvidenceObservation['reason'],
  entityCandidates: string[] = [],
  linkedEntities: string[] = []
): AnswerDerivationEvidenceObservation {
  return { id, action, reason, entity_candidates: entityCandidates, linked_entities: linkedEntities };
}

function linkingErrorEntities(error: F1QLLinkingError): string[] {
  if (error.code === 'entity_ambiguous') return (error.options ?? []).map(id => `driver:${id}`);
  if (error.code === 'event_ambiguous') {
    return (error.options ?? []).flatMap(option => {
      const match = /^(\d{4}) round (\d+)$/.exec(option);
      return match ? [`event:${match[1]}:${match[2]}`] : [];
    });
  }
  return [];
}

export function assertDisposableDerivationDatabase(databaseUrl: string): void {
  if (databaseUrl !== DISPOSABLE_DATABASE_URL) throw new Error('Answer derivation evidence requires the exact disposable Docker database');
}

async function main(): Promise<void> {
  if (process.env.F1QL_ANSWER_DERIVATION_EVIDENCE_ENABLED !== 'true' || process.env.F1QL_ANSWER_DERIVATION_EVIDENCE_TARGET !== 'localhost') {
    throw new Error('Answer derivation evidence requires explicit localhost flags');
  }
  const databaseUrl = getTestDatabaseUrl();
  assertDisposableDerivationDatabase(databaseUrl);
  if (answerEvaluationManifest.length !== 94) throw new Error('Answer derivation evidence requires the complete manifest');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000, options: '-c statement_timeout=5000' });
  try {
    await setupTestDatabase(pool, { seed: false });
    await seedAnswerEvaluationFixture(pool);
    await pool.query(readFileSync('migrations/20260729_f1ql_answer_identity_views.sql', 'utf8'));
    const artifact = await collectAnswerDerivationEvidence(answerEvaluationManifest, pool, new Date().toISOString(), {
      key_id: requiredEnvironment('F1QL_ANSWER_EVALUATION_KEY_ID'),
      private_key_base64: requiredEnvironment('F1QL_ANSWER_EVALUATION_PRIVATE_KEY_BASE64')
    });
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    const directory = mkdtempSync(join(tmpdir(), 'f1ql-answer-derivation-'));
    const output = join(directory, 'derivation-evidence.json');
    writeExclusive(output, bytes);
    process.stdout.write(`${JSON.stringify({ path: output, sha256: createHash('sha256').update(bytes).digest('hex'), count: artifact.observations.length })}\n`);
  } finally {
    await pool.end();
  }
}

function writeExclusive(path: string, content: Buffer): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < content.byteLength) offset += writeSync(descriptor, content, offset, content.byteLength - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 10_000) throw new Error(`Missing required ${name}`);
  return value;
}

if (require.main === module) void main();
