import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE, ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS, collectAnswerObservations, createAnswerObservationSigningHelper, getAnswerEvaluationManifestHash, isVerifiedAnswerObservationArtifact, parseAnswerObservationArtifact, signAnswerObservationArtifact, validateAnswerObservationArtifact, verifyAnswerObservationArtifact } from '../../src/f1ql/answer-observations';
import { assertDisposableDatabase, createAnswerEvaluationProviderPacer, parseAnswerEvaluationMinRequestIntervalMs, translateBounded } from '../../scripts/collect-answer-evaluation-observations';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { proveAnswerIntent } from '../../src/f1ql/answer-semantic-proof';
import { AnswerIntentModel, AnswerTranslationResult } from '../../src/f1ql/answer-translator';
import { ANSWER_TRANSLATOR_PROMPT_SHA256, ANSWER_TRANSLATOR_SCHEMA_SHA256 } from '../../src/f1ql/answer-translator';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';

const provider = {
  type: 'groq' as const, model: 'openai/gpt-oss-20b', endpoint_sha256: '1'.repeat(64),
  reasoning_effort: 'disabled' as const, collected_at: '2026-07-24T00:00:00.000Z'
};
const legacyProvider = { type: 'openai-compatible' as const, model: 'fixture-model', collected_at: provider.collected_at };
const keys = generateKeyPairSync('ed25519');
const keyId = 'evaluation-test-key';
const signer = createAnswerObservationSigningHelper(keyId, keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
const trustedKey = { key_id: keyId, public_key_base64: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
const span = (question: string, text: string) => {
  const start = Array.from(question.slice(0, question.indexOf(text))).length;
  return { text, start, end: start + Array.from(text).length };
};

describe('answer observation artifacts', () => {
  it('rechecks the monotonic clock when a pacing timer completes fractionally early', async () => {
    let now = 0;
    const delays: number[] = [];
    const pace = createAnswerEvaluationProviderPacer(1_000, {
      now: () => now,
      sleep: async delayMs => {
        delays.push(delayMs);
        now += delays.length === 1 ? delayMs - 0.25 : delayMs;
      }
    });
    await pace();
    await pace();
    expect(delays).toEqual([1_000, 1]);
  });

  it('collects deterministic question outcomes and semantic proofs without execution', async () => {
    const cases = ['dev-leader', 'dev-pace', 'iid-points-all', 'unicode-control'].map(id => answerEvaluationManifest.find(item => item.id === id)!);
    const leaderQuestion = cases[0].question;
    const leaderResult: AnswerTranslationResult = { type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: span(leaderQuestion, '2025') } };
    let translated = 0;
    let paced = 0;
    let proved = 0;
    let now = 0;
    const pacingDelays: number[] = [];
    const pace = createAnswerEvaluationProviderPacer(1_000, {
      now: () => now,
      sleep: async delayMs => { pacingDelays.push(delayMs); now += delayMs; }
    });
    const artifact = await collectAnswerObservations(cases, provider, {
      beforeTranslate: async () => { paced++; await pace(); },
      translate: async () => { const result = translated++ < 3 ? leaderResult : { type: 'clarification_required' as const, reason: 'metric_ambiguous' as const }; now += 10; return { result, timedOut: false }; },
      prove: (contract, intent) => {
        proved++;
        return proveAnswerIntent(contract, intent,
          { resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' }) },
          { inventoryMentions: async () => [] });
      },
      now: () => now
    }, signer);
    expect(translated).toBe(6);
    expect(paced).toBe(6);
    expect(proved).toBe(3);
    expect(pacingDelays).toEqual(Array(5).fill(990));
    expect(artifact).toMatchObject({
      version: 4,
      provider,
      reliability: { answerable_observations_per_case: 3, non_answerable_observations_per_case: 1 },
      evaluation: { key_id: keyId, algorithm: 'Ed25519' },
      manifest: { case_count: 4, sha256: getAnswerEvaluationManifestHash(cases) }
    });
    expect(artifact.observations).toEqual([
      ...[0, 1, 2].map(observation_index => expect.objectContaining({ id: 'dev-leader', observation_index, action: 'answer', template_id: 'final_standings_leader', proof_status: 'passed', translation_attempted: true, translation_latency_ms: 10 })),
      expect.objectContaining({ id: 'dev-pace', observation_index: 0, action: 'abstain', reason: 'pace_source_disabled', proof_status: 'not_applicable', translation_attempted: false }),
      ...[0, 1, 2].map(observation_index => expect.objectContaining({ id: 'iid-points-all', observation_index, action: 'clarify', reason: 'metric_ambiguous', proof_status: 'not_applicable' })),
      expect.objectContaining({ id: 'unicode-control', observation_index: 0, action: 'abstain', reason: 'question_invalid', proof_status: 'not_applicable' })
    ]);
    expect(artifact.contract).toMatchObject({ translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256, translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256 });
    expect(artifact.observations[3]).not.toHaveProperty('translation_latency_ms');
    const parsed = parseAnswerObservationArtifact(artifact);
    expect(isVerifiedAnswerObservationArtifact(parsed)).toBe(false);
    const verified = verifyAnswerObservationArtifact(cases, parsed, trustedKey);
    expect(isVerifiedAnswerObservationArtifact(verified)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.observations[0])).toBe(true);
    expect(() => verifyAnswerObservationArtifact(cases, { ...artifact, contract: { ...artifact.contract, translator_prompt_hash: '0'.repeat(64) } }, trustedKey)).toThrow('contract_mismatch');
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(leaderQuestion);
    expect(serialized).not.toContain('normalized_question');
    expect(serialized).not.toContain('root');
  });

  it('continues independent answerable repetitions after an abstaining result', async () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'dev-leader')!];
    const question = cases[0].question;
    let translated = 0;
    let paced = 0;
    let proved = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      beforeTranslate: async () => { paced++; },
      translate: async () => ({
        result: translated++ === 0
          ? { type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'transport' }
          : { type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025') } },
        timedOut: false
      }),
      prove: (contract, intent) => {
        proved++;
        return proveAnswerIntent(contract, intent,
          { resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' }) },
          { inventoryMentions: async () => [] });
      },
      now: (() => { let value = 0; return () => ++value; })()
    }, signer);
    expect({ translated, paced, proved }).toEqual({ translated: 3, paced: 3, proved: 2 });
    expect(artifact.observations.map(observation => ({ index: observation.observation_index, action: observation.action }))).toEqual([
      { index: 0, action: 'abstain' }, { index: 1, action: 'answer' }, { index: 2, action: 'answer' }
    ]);
    const tampered = structuredClone(artifact);
    const first = tampered.observations[0];
    tampered.observations[0] = { ...tampered.observations[1], observation_index: 0 };
    tampered.observations[1] = { ...first, observation_index: 1 };
    expect(() => verifyAnswerObservationArtifact(cases, tampered, trustedKey)).toThrow('signature_invalid');
    expect(() => parseAnswerObservationArtifact({
      ...artifact,
      reliability: { ...artifact.reliability, answerable_observations_per_case: 2 }
    })).toThrow();
  });

  it('requires exact unique indexes, canonical order, and attempted answerable translations', async () => {
    const cases = ['dev-leader', 'dev-pace'].map(id => answerEvaluationManifest.find(item => item.id === id)!);
    const question = cases[0].question;
    const artifact = await collectAnswerObservations(cases, provider, {
      translate: async () => ({ result: { type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025') } }, timedOut: false }),
      prove: (contract, intent) => proveAnswerIntent(contract, intent,
        { resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' }) },
        { inventoryMentions: async () => [] }),
      now: (() => { let value = 0; return () => ++value; })()
    }, signer);
    expect(ANSWER_EVALUATION_REQUIRED_OBSERVATIONS_PER_ANSWERABLE_CASE).toBe(3);
    expect(artifact.observations.map(observation => [observation.id, observation.observation_index])).toEqual([
      ['dev-leader', 0], ['dev-leader', 1], ['dev-leader', 2], ['dev-pace', 0]
    ]);

    const observations = structuredClone(artifact.observations) as any[];
    const incomplete = validateAnswerObservationArtifact(cases, { ...artifact, observations: observations.filter(item => item.observation_index !== 2) });
    expect(incomplete.observations).toHaveLength(3);
    expect(() => validateAnswerObservationArtifact(cases, { ...artifact, observations: observations.filter(item => item.observation_index !== 1) })).toThrow('indexes_invalid');
    expect(() => parseAnswerObservationArtifact({ ...artifact, observations: [...observations, observations[0]] })).toThrow('duplicate_evaluation_observation_id_index');
    expect(() => parseAnswerObservationArtifact({ ...artifact, observations: [{ ...observations[0], observation_index: 3 }, ...observations.slice(1)] })).toThrow();
    expect(() => validateAnswerObservationArtifact(cases, { ...artifact, observations: [...observations, { ...observations[3], observation_index: 1 }] })).toThrow('indexes_invalid');
    expect(() => validateAnswerObservationArtifact(cases, { ...artifact, observations: [observations[1], observations[0], ...observations.slice(2)] })).toThrow('order_invalid');
    const notAttempted = { ...observations[0], translation_attempted: false };
    delete notAttempted.translation_latency_ms;
    expect(() => validateAnswerObservationArtifact(cases, { ...artifact, observations: [notAttempted, ...observations.slice(1)] })).toThrow('translation_required');
  });

  it('parses historical v1/v2 explicitly and rejects malformed v3 bindings', () => {
    const v1 = {
      version: 1, kind: 'f1ql_answer_observations', provider: legacyProvider,
      manifest: { case_count: 1, sha256: '0'.repeat(64) },
      observations: [{ id: 'one', action: 'abstain', reason: 'provider_error', entity_candidates: [], linked_entities: [] }]
    };
    expect(parseAnswerObservationArtifact(v1).version).toBe(1);
    expect(parseAnswerObservationArtifact({ ...v1, version: 2, observations: [{ ...v1.observations[0], provider_diagnostic_code: 'http_quota' }] }).version).toBe(2);
    expect(() => parseAnswerObservationArtifact({ ...v1, version: 2 })).toThrow('require a diagnostic code');
    expect(() => parseAnswerObservationArtifact({ ...v1, observations: [{ ...v1.observations[0], provider_diagnostic_code: 'http_quota' }] })).toThrow('Version 1');
    expect(() => parseAnswerObservationArtifact({ ...v1, observations: [v1.observations[0], v1.observations[0]] })).toThrow('duplicate_evaluation_observation_id');
    expect(() => validateAnswerObservationArtifact(answerEvaluationManifest.slice(0, 1), v1)).toThrow('answer_observation_manifest_mismatch');
  });

  it('continues to parse and verify historical signed v3 artifacts', async () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'dev-leader')!];
    const question = cases[0].question;
    const v4 = await collectAnswerObservations(cases, provider, {
      translate: async () => ({ result: { type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025') } }, timedOut: false }),
      prove: (contract, intent) => proveAnswerIntent(contract, intent,
        { resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' }) },
        { inventoryMentions: async () => [] }),
      now: (() => { let value = 0; return () => ++value; })()
    }, signer);
    const observation: any = structuredClone(v4.observations[0]);
    delete observation.observation_index;
    const v3 = signAnswerObservationArtifact(cases, {
      version: 3,
      kind: v4.kind,
      provider: v4.provider,
      manifest: v4.manifest,
      contract: v4.contract,
      observations: [observation]
    }, signer);
    expect(parseAnswerObservationArtifact(v3).version).toBe(3);
    expect(verifyAnswerObservationArtifact(cases, v3, trustedKey).version).toBe(3);
  });

  it('makes timeout evidence causal even when a provider ignores abort', async () => {
    const contract = createAnswerQuestionContract('Who was the 2025 standings leader?');
    const immediate: AnswerIntentModel = { complete: async () => JSON.stringify({ intent: { type: 'unsupported', reason: 'capability_unsupported' } }) };
    await expect(translateBounded(contract, immediate, 10)).resolves.toEqual({ result: { type: 'unsupported', reason: 'capability_unsupported' }, timedOut: false });
    const ignoresAbort: AnswerIntentModel = { complete: async () => new Promise(() => undefined) };
    await expect(translateBounded(contract, ignoresAbort, 1)).resolves.toEqual({ result: { type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'request_timeout' }, timedOut: true });
    await expect(translateBounded(contract, immediate, 15_001)).rejects.toThrow('between 1 and 15000');
  });

  it('retains only low-cardinality diagnostics and the exact model privately', async () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'dev-leader')!];
    let translated = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      translate: async () => { translated++; return { result: { type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'rate_limit' }, timedOut: false }; },
      prove: async () => { throw new Error('proof must not run'); },
      now: (() => { let value = 0; return () => value += 1; })()
    }, signer);
    expect(translated).toBe(3);
    expect(artifact.observations[0]).toMatchObject({ action: 'abstain', provider_diagnostic_code: 'rate_limit' });
    expect(artifact.provider.model).toBe(provider.model);
  });

  it('uses the manifest mixed-session decision without calling the model', async () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'multi-intent')!];
    let translated = 0;
    let paced = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      beforeTranslate: async () => { paced++; },
      translate: async () => { translated++; throw new Error('model must not run'); },
      prove: async () => { throw new Error('proof must not run'); }
    }, signer);
    expect(translated).toBe(0);
    expect(paced).toBe(0);
    expect(artifact.observations).toEqual([expect.objectContaining({
      id: 'multi-intent', action: 'clarify', reason: 'session_ambiguous', translation_attempted: false,
      translation_timed_out: false, proof_status: 'not_applicable', entity_candidates: [], linked_entities: []
    })]);
  });

  it('records deterministic unsupported capability cases without calling the model', async () => {
    const ids = ['attack-event', 'attack-order', 'attack-limit', 'attack-driver', 'attack-status', 'attack-dropped-driver', 'attack-added-driver'];
    const cases = ids.map(id => answerEvaluationManifest.find(item => item.id === id)!);
    let translated = 0;
    let paced = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      beforeTranslate: async () => { paced++; },
      translate: async () => { translated++; throw new Error('model must not run'); },
      prove: async () => { throw new Error('proof must not run'); }
    }, signer);
    expect({ translated, paced }).toEqual({ translated: 0, paced: 0 });
    expect(artifact.observations).toEqual(ids.map(id => expect.objectContaining({
      id, action: 'abstain', reason: 'capability_unsupported', translation_attempted: false, proof_status: 'not_applicable'
    })));
  });

  it('records exclusion and bounded-rank rejections without calling the model', async () => {
    const base = answerEvaluationManifest[0];
    const cases = [
      'Show all 2025 Monaco race results other than DNFs', 'Show 2025 Monaco qualifying apart from DNS',
      'Show 2025 Monaco race results save for DSQs', 'Show 2025 Monaco race results all but classified drivers',
      'Show all drivers except Max Verstappen in the final 2025 standings', 'Show the 2025 race results except Monaco',
      'Show 2025 Monaco race results without commentary', 'Show 2025 Monaco race results for non-DNFs',
      'Show the top-3 final 2025 standings points', 'Show the three highest final 2025 standings drivers',
      'Show the five best final 2025 standings drivers', 'Show the trailing 2 final 2025 standings drivers',
      'Who finished second-place in the 2025 Monaco race?', 'Who was in position 2 in the final 2025 standings?',
      'Who ranked third in the final 2025 standings?', 'Who was P2 in the final 2025 standings?',
      'Who was the runner-up in the 2025 championship?', 'Who had the highest final 2025 standings points?',
      'Show 2025 Monaco race results not Max Verstappen', 'not DNFs in the 2025 Monaco race results',
      'Show three drivers in the final 2025 standings', 'Show 3 race results from Monaco in 2025'
    ].map((question, index) => ({ ...base, id: `deterministic-rejection-${index}`, question, answerable: false }));
    let translated = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      translate: async () => { translated++; throw new Error('model must not run'); },
      prove: async () => { throw new Error('proof must not run'); }
    }, signer);
    expect(translated).toBe(0);
    expect(artifact.observations).toEqual(cases.map(item => expect.objectContaining({
      id: item.id, action: 'abstain', reason: 'capability_unsupported', translation_attempted: false
    })));
  });

  it.each([
    'Show the 2025 race results for round 2',
    'Show the 2025 race results for the second round',
    'Who was the final 2025 standings leader?',
    'Who was the final 2025 champion?'
  ])('sends round and exact leader/champion counterexamples to model inspection: %s', async question => {
    const base = answerEvaluationManifest[0];
    let translated = 0;
    await collectAnswerObservations([{ ...base, id: 'counterexample', question }], provider, {
      translate: async () => { translated++; return { result: { type: 'unsupported', reason: 'capability_unsupported' }, timedOut: false }; },
      prove: async () => { throw new Error('proof must not run'); }
    }, signer);
    expect(translated).toBe(3);
  });

  it('records deterministic metric ambiguity without calling the model', async () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'dev-ambiguous')!];
    let translated = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      translate: async () => { translated++; throw new Error('model must not run'); },
      prove: async () => { throw new Error('proof must not run'); }
    }, signer);
    expect(translated).toBe(0);
    expect(artifact.observations).toEqual([expect.objectContaining({
      id: 'dev-ambiguous', action: 'clarify', reason: 'metric_ambiguous', translation_attempted: false, proof_status: 'not_applicable'
    })]);
  });

  it('parses and monotonically paces evaluation provider attempts without real sleep', async () => {
    expect(parseAnswerEvaluationMinRequestIntervalMs(undefined)).toBe(0);
    expect(parseAnswerEvaluationMinRequestIntervalMs('0')).toBe(0);
    expect(parseAnswerEvaluationMinRequestIntervalMs('60000')).toBe(60_000);
    for (const value of ['', '-1', '1.5', ' 1', '60001']) {
      expect(() => parseAnswerEvaluationMinRequestIntervalMs(value)).toThrow('must be an integer between 0 and 60000');
    }

    let now = 100;
    const delays: number[] = [];
    const pace = createAnswerEvaluationProviderPacer(1_000, {
      now: () => now,
      sleep: async delayMs => { delays.push(delayMs); now += delayMs; }
    });
    await pace();
    expect(delays).toEqual([]);
    now += 250;
    await pace();
    expect(delays).toEqual([750]);
    now += 1_200;
    await pace();
    expect(delays).toEqual([750]);
  });

  it('accepts only signed hardened timeout abstentions with no proof or linker claims', () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'dev-ambiguous')!];
    const base = {
      version: 3 as const,
      kind: 'f1ql_answer_observations' as const,
      provider,
      manifest: { case_count: 1, sha256: getAnswerEvaluationManifestHash(cases) },
      contract: {
        question_version: createAnswerQuestionContract(cases[0].question).version,
        intent_version: 'answer-intent-v1',
        translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256,
        translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256,
        template_version: 'answer-template-registry-v1',
        template_registry_hash: '0'.repeat(64),
        proof_version: 'answer-semantic-proof-v1'
      },
      observations: [{
        id: cases[0].id, action: 'abstain' as const, reason: 'provider_error' as const,
        translation_attempted: true, translation_latency_ms: ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS,
        translation_timed_out: true, provider_diagnostic_code: 'request_timeout' as const,
        proof_status: 'not_applicable' as const, entity_candidates: [], linked_entities: []
      }]
    };
    // Signing validates the complete shape, so every rejected mutation is also cryptographically authored.
    expect(() => signAnswerObservationArtifact(cases, base as any, signer)).not.toThrow();
    const mutations = [
      { reason: 'invalid_response' },
      { entity_candidates: ['driver:max-verstappen'] },
      { linked_entities: ['driver:max-verstappen'], entity_candidates: ['driver:max-verstappen'] },
      { proof_status: 'passed', proof_hash: '1'.repeat(64), program_hash: '2'.repeat(64), template_id: 'final_standings_leader' },
      { provider_diagnostic_code: 'transport' },
      { translation_latency_ms: ANSWER_EVALUATION_TRANSLATION_TIMEOUT_MS - 1 }
    ];
    for (const mutation of mutations) {
      expect(() => signAnswerObservationArtifact(cases, { ...base, observations: [{ ...base.observations[0], ...mutation }] } as any, signer)).toThrow('Timeout evidence must be causal');
    }
  });

  it('rejects non-monotonic timing and binds the exact disposable database', async () => {
    const times = [100, 99.5];
    await expect(collectAnswerObservations([answerEvaluationManifest.find(item => item.id === 'dev-leader')!], provider, {
      translate: async () => ({ result: { type: 'unsupported', reason: 'capability_unsupported' }, timedOut: false }),
      prove: async () => { throw new Error('proof must not run'); }, now: () => times.shift()!
    }, signer)).rejects.toThrow('answer_observation_translation_latency_invalid');
    expect(() => assertDisposableDatabase('postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test')).not.toThrow();
    expect(() => assertDisposableDatabase('postgresql://postgres:postgres@localhost:5433/f1muse_test')).toThrow();
    const changed = structuredClone(answerEvaluationManifest); changed[0].expected.reason = 'changed';
    expect(getAnswerEvaluationManifestHash(changed)).not.toBe(getAnswerEvaluationManifestHash(answerEvaluationManifest));
  });

  it('rejects unsigned, tampered, forged-proof, and wrong-key v3 artifacts', async () => {
    const cases = [answerEvaluationManifest.find(item => item.id === 'dev-leader')!];
    const question = cases[0].question;
    const artifact = await collectAnswerObservations(cases, provider, {
      translate: async () => ({ result: { type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025') } }, timedOut: false }),
      prove: (contract, intent) => proveAnswerIntent(contract, intent, { resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' }) }, { inventoryMentions: async () => [] }),
      now: (() => { let value = 0; return () => ++value; })()
    }, signer);
    const unsigned = structuredClone(artifact) as any;
    delete unsigned.evaluation.signature;
    expect(() => parseAnswerObservationArtifact(unsigned)).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...artifact, provider: { type: artifact.provider.type, model: artifact.provider.model, collected_at: artifact.provider.collected_at } })).toThrow();

    const tampered = structuredClone(artifact);
    tampered.observations[0].proof_hash = 'f'.repeat(64);
    expect(() => verifyAnswerObservationArtifact(cases, tampered, trustedKey)).toThrow('signature_invalid');
    for (const providerMutation of [
      { endpoint_sha256: '2'.repeat(64) },
      { reasoning_effort: 'medium' as const }
    ]) {
      expect(() => verifyAnswerObservationArtifact(cases, {
        ...artifact, provider: { ...artifact.provider, ...providerMutation }
      }, trustedKey)).toThrow('signature_invalid');
    }
    const wrongKeys = generateKeyPairSync('ed25519');
    expect(() => verifyAnswerObservationArtifact(cases, artifact, {
      key_id: keyId,
      public_key_base64: wrongKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    })).toThrow('signature_invalid');
    expect(() => verifyAnswerObservationArtifact(cases, artifact, { ...trustedKey, key_id: 'wrong-key' })).toThrow('key_mismatch');
    expect(() => parseAnswerObservationArtifact({ ...artifact, evaluation: { ...artifact.evaluation, signature: nonCanonicalAlias(artifact.evaluation.signature) } })).toThrow('Invalid Ed25519 signature');
    expect(() => verifyAnswerObservationArtifact(cases, artifact, { ...trustedKey, public_key_base64: `${trustedKey.public_key_base64}\n` })).toThrow('public_key_invalid');
    expect(() => createAnswerObservationSigningHelper(keyId, `${keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')} `)).toThrow('private_key_invalid');
  });

  it('remains structurally non-executing and formatter-free', () => {
    const source = readFileSync('src/f1ql/answer-observations.ts', 'utf8');
    const command = readFileSync('scripts/collect-answer-evaluation-observations.ts', 'utf8');
    for (const text of [source, command]) {
      expect(text).not.toContain('executeF1QL');
      expect(text).not.toMatch(/from ['"].*executor/);
      expect(text).not.toContain('buildAnswerEnvelope');
    }
    expect(command).toContain("'BEGIN READ ONLY'");
    expect(command).toContain('proveAnswerIntent');
    expect(command).toContain('createAnswerIntentModel');
    expect(answerEvaluationManifest).toHaveLength(94);
    expect(command.match(/!== 94/g)).toHaveLength(2);
  });
});

function nonCanonicalAlias(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = alphabet.indexOf(value.at(-3)!);
  return `${value.slice(0, -3)}${alphabet[index + 1]}==`;
}
