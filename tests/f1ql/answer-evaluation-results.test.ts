import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { emitAnswerEvaluationResults } from '../../scripts/snapshot-answer-evaluation-results';
import { F1QLLinkingError, linkAnswerF1QLCandidateObserved } from '../../src/f1ql/translation-linking';
import { seedAnswerEvaluationFixture } from '../fixtures/f1ql-answer-evaluation-fixture';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../../src/identity/answer-identity-resolvers';
import { collectAnswerObservations, createAnswerObservationSigningHelper, verifyAnswerObservationArtifact } from '../../src/f1ql/answer-observations';
import { AnswerQuestionContract } from '../../src/f1ql/answer-question';
import { proveAnswerIntent } from '../../src/f1ql/answer-semantic-proof';
import { AnswerIntent } from '../../src/f1ql/answer-intent';
import { deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';
import { AnswerTranslationResult } from '../../src/f1ql/answer-translator';
import { getF1QLProgramHash } from '../../src/f1ql/verified-programs';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await seedAnswerEvaluationFixture(pool);
  await pool.query(readFileSync('migrations/20260729_f1ql_answer_identity_views.sql', 'utf8'));
});

afterAll(async () => {
  await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
  await pool.query('DROP TABLE IF EXISTS driver_aliases');
  await pool.end();
});

describe('answer evaluation generated results', () => {
  it('matches the real bounded canonical-program emitter', async () => {
    const expected = JSON.parse(readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', 'utf8'));
    expect(expected).toHaveLength(answerEvaluationManifest.filter(item => item.expected.action === 'answer').length);
    await expect(emitAnswerEvaluationResults(pool)).resolves.toEqual(expected);
  });

  it('observes resolver candidates and the reviewed ambiguous event', async () => {
    await expect(linkAnswerF1QLCandidateObserved(pool, {
      version: 1,
      root: { op: 'event_classification', season: 2025, event_name: 'Ambiguous Grand Prix', limit: 30 }
    })).rejects.toMatchObject<F1QLLinkingError>({
      code: 'event_ambiguous',
      entityCandidates: ['event:2025:8', 'event:2025:9']
    });

    await expect(linkAnswerF1QLCandidateObserved(pool, {
      version: 1,
      root: { op: 'event_classification', season: 2025, event_name: 'Australian Grand Prix', limit: 30, filters: { driver_id: 'Max Verstappen' } }
    })).resolves.toMatchObject({
      entityCandidates: ['driver:max-verstappen', 'event:2025:1']
    });

    await expect(linkAnswerF1QLCandidateObserved(pool, {
      version: 1,
      root: { op: 'event_classification', season: 2025, round: 1, limit: 30, filters: { driver_id: 'Alex Smith' } }
    })).rejects.toMatchObject<F1QLLinkingError>({
      code: 'entity_ambiguous',
      entityCandidates: ['driver:alex-one', 'driver:alex-two', 'event:2025:1']
    });
  });

  it('runs every reviewed question through deterministic admission, translation, real resolvers, proof, templates, policy, and bounds', async () => {
    const eventResolver = new AnswerEventIdentityResolver(pool);
    const driverResolver = new AnswerDriverIdentityResolver(pool);
    expect(await driverResolver.inventoryMentions('Where did Max Verstappen finish?', 2025)).toEqual([
      expect.objectContaining({ text: 'Max Verstappen', candidates: ['max_verstappen'], active_candidates: ['max_verstappen'] })
    ]);
    expect(await driverResolver.inventoryMentions('Where did Max Verstappen finish in the 2025 Australian Grand Prix race result?', 2025)).toEqual([
      expect.objectContaining({ text: 'Max Verstappen', candidates: ['max_verstappen'], active_candidates: ['max_verstappen'] })
    ]);
    await expect(eventResolver.resolve(2025, 'Australian Grand Prix')).resolves.toEqual({ type: 'resolved', season: 2025, round: 1 });
    const byQuestionHash = new Map(answerEvaluationManifest.map(item => [createHash('sha256').update(item.question.normalize('NFKC').trim()).digest('hex'), item]));
    const keys = generateKeyPairSync('ed25519');
    const keyId = 'candidate-recall-test';
    const signer = createAnswerObservationSigningHelper(keyId, keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    const artifact = await collectAnswerObservations(answerEvaluationManifest, {
      type: 'groq', model: 'openai/gpt-oss-20b', endpoint_sha256: '1'.repeat(64),
      reasoning_effort: 'disabled', collected_at: '2026-07-24T00:00:00.000Z'
    }, {
      translate: async contract => ({ result: await deterministicTranslation(contract, byQuestionHash, driverResolver), timedOut: false }),
      prove: (contract, intent) => proveAnswerIntent(contract, intent, eventResolver, driverResolver),
      now: (() => { let value = 0; return () => value += 1; })()
    }, signer);
    for (const item of answerEvaluationManifest) {
      const observed = artifact.observations.filter(observation => observation.id === item.id);
      expect.soft(observed, item.id).toHaveLength(item.answerable ? 3 : 1);
      for (const observation of observed) {
        expect.soft({ action: observation.action, reason: observation.reason }, item.id).toEqual({ action: item.expected.action, reason: item.expected.reason });
        if (item.expected.action === 'answer') {
          expect.soft(observation.template_id, item.id).toBe(item.expected.template_id);
          expect.soft(observation.program_hash, item.id).toBe(getF1QLProgramHash(item.expected.acceptable_programs![0]));
        }
      }
    }
    expect(artifact.observations.find(observation => observation.id === 'ambiguous-driver')).toMatchObject({
      action: 'clarify',
      reason: 'entity_ambiguous',
      entity_candidates: ['driver:alex-one', 'driver:alex-two', 'event:2025:1']
    });
    const verified = verifyAnswerObservationArtifact(answerEvaluationManifest, artifact, {
      key_id: keyId,
      public_key_base64: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    });
    expect(verified.version).toBe(4);
    expect(verified.observations).toHaveLength(answerEvaluationManifest.reduce((count, item) => count + (item.answerable ? 3 : 1), 0));
  });
});

async function deterministicTranslation(
  contract: AnswerQuestionContract,
  cases: Map<string, (typeof answerEvaluationManifest)[number]>,
  driverResolver: AnswerDriverIdentityResolver
): Promise<AnswerTranslationResult> {
  const item = cases.get(contract.sha256);
  if (!item) throw new Error('reviewed question missing');
  if (item.id.startsWith('launch-')) {
    const intent = await deriveAnswerIntent(contract, driverResolver);
    if (intent.type === 'clarification') return { type: 'clarification_required', reason: intent.reason };
    if (intent.type === 'unsupported') return { type: 'unsupported', reason: intent.reason };
    return { type: 'intent_candidate', intent };
  }
  if (item.id === 'dev-ambiguous') return { type: 'clarification_required', reason: 'metric_ambiguous' };
  if (item.id === 'ambiguous-event') return { type: 'intent_candidate', intent: executableIntent(contract, 'race_classification_all', []) };
  if (item.id === 'ambiguous-driver') {
    const inventory = await driverResolver.inventoryMentions(contract.normalized_question, 2025);
    return { type: 'intent_candidate', intent: executableIntent(contract, 'race_classification_driver', inventory) };
  }
  if (item.id === 'iid-empty') return { type: 'intent_candidate', intent: executableIntent(contract, 'race_date', []) };
  const proofAttackIds = new Set(['attack-session', 'attack-repeated-driver']);
  if (proofAttackIds.has(item.id)) {
    const inventory = await driverResolver.inventoryMentions(contract.normalized_question, 2025);
    const template = item.id === 'attack-session' ? 'race_classification_all'
      : item.id === 'attack-status' ? 'race_classification_status'
        : item.id === 'attack-event' || item.id === 'attack-round' ? 'race_classification_all' : 'final_standings_points';
    let selected = inventory;
    if (['attack-driver', 'attack-dropped-driver', 'attack-added-driver'].includes(item.id)) selected = inventory.slice(0, 1);
    if (item.id === 'unicode-homoglyph') selected = [{ text: 'Mаx Verstappen', start: contract.normalized_question.indexOf('M'), end: contract.normalized_question.indexOf('M') + Array.from('Mаx Verstappen').length, candidates: [], active_candidates: [] }];
    return { type: 'intent_candidate', intent: executableIntent(contract, template, selected) };
  }
  if (item.expected.action !== 'answer') {
    return item.expected.action === 'clarify'
      ? { type: 'clarification_required', reason: item.expected.reason as 'metric_ambiguous' }
      : { type: 'unsupported', reason: item.expected.reason as Extract<AnswerIntent, { type: 'unsupported' }>['reason'] };
  }
  const root = item.expected.acceptable_programs![0].root;
  const scopedSeason = root.op === 'rank' && root.input.input.op === 'filter' ? root.input.input.where.season
    : root.op === 'aggregate' && root.input.op === 'filter' ? root.input.where.season
      : 'season' in root ? root.season : undefined;
  const season = typeof scopedSeason === 'number' ? scopedSeason : contract.years[0]?.value;
  const inventory = await driverResolver.inventoryMentions(contract.normalized_question, season);
  return { type: 'intent_candidate', intent: executableIntent(contract, item.expected.template_id!, inventory) };
}

function executableIntent(contract: AnswerQuestionContract, template: string, inventory: readonly { text: string; start: number; end: number }[]): Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }> {
  const references = inventory.map(mention => ({ text: mention.text, start: mention.start, end: mention.end }));
  if (template === 'driver_career_official_summary') return { type: template, driver_reference: references[0] };
  const seasonMention = contract.years[0];
  const season = seasonMention.value;
  const season_reference = { text: seasonMention.text, start: seasonMention.start, end: seasonMention.end };
  const event = contract.event_cues[0] ?? contract.rounds[0];
  const event_reference = event ? { text: event.text, start: event.start, end: event.end } : undefined;
  if (template === 'final_standings_points') return { type: template, season, season_reference, driver_references: references };
  if (template === 'final_standings_leader') return { type: template, season, season_reference };
  if (template === 'current_standings') return { type: template, season, season_reference };
  if (template === 'driver_season_official_summary') return { type: template, season, season_reference, driver_reference: references[0] };
  if (template === 'race_date') return { type: template, season, season_reference, event_reference: event_reference! };
  if (template === 'race_classification_all' || template === 'qualifying_classification_all') return { type: template, season, season_reference, event_reference: event_reference! };
  if (template === 'race_classification_driver' || template === 'qualifying_classification_driver') return { type: template, season, season_reference, event_reference: event_reference!, driver_reference: references[0] };
  const status = contract.status_cues[0];
  if (template === 'race_classification_status') return { type: template, season, season_reference, event_reference: event_reference!, status: status.value, status_reference: { text: status.text, start: status.start, end: status.end } };
  if (template === 'qualifying_classification_status') return { type: template, season, season_reference, event_reference: event_reference!, status: status.value as 'classified' | 'dnf' | 'dns', status_reference: { text: status.text, start: status.start, end: status.end } };
  if (template === 'race_classification_position' || template === 'qualifying_classification_position') {
    const selection = contract.result_cues[0];
    const base = { season, season_reference, event_reference: event_reference!, selection_reference: { text: selection.text, start: selection.start, end: selection.end } };
    return selection.position === undefined ? { type: selection.value, ...base } as Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>
      : { type: selection.value, ...base, position: selection.position } as Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }>;
  }
  throw new Error(`unsupported deterministic template ${template}`);
}
