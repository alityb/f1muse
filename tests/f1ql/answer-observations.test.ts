import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectAnswerObservations, getAnswerEvaluationManifestHash, parseAnswerObservationArtifact, validateAnswerObservationArtifact } from '../../src/f1ql/answer-observations';
import { assertDisposableDatabase } from '../../scripts/collect-answer-evaluation-observations';
import { F1QLLinkingError } from '../../src/f1ql/translation-linking';
import { F1QLTranslationResult } from '../../src/f1ql/translator';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';

const provider = { type: 'openai-compatible' as const, model: 'fixture-model', collected_at: '2026-07-24T00:00:00.000Z' };

describe('answer observation artifacts', () => {
  it('collects translation, linking, and policy outcomes without execution', async () => {
    const cases = [
      answerEvaluationManifest.find(item => item.id === 'dev-race')!,
      answerEvaluationManifest.find(item => item.id === 'dev-ambiguous')!,
      answerEvaluationManifest.find(item => item.id === 'dev-pace')!,
      answerEvaluationManifest.find(item => item.id === 'holdout-entity')!
    ];
    const translations: F1QLTranslationResult[] = [
      { type: 'program_candidate', program: cases[0].expected.acceptable_programs![0] },
      { type: 'clarification_required', reason: 'metric_ambiguous', question: 'Which metric?' },
      { type: 'program_candidate', program: { version: 1, root: { op: 'pace_delta', driver_a_id: 'max-verstappen', driver_b_id: 'lando-norris', scope: { season: 2025 } } } },
      { type: 'program_candidate', program: cases[0].expected.acceptable_programs![0] }
    ];
    let translated = 0;
    let linked = 0;
    let now = 0;
    const artifact = await collectAnswerObservations(cases, provider, {
      translate: async () => translations[translated++],
      link: async candidate => {
        linked++;
        if (linked === 3) throw new F1QLLinkingError('entity_ambiguous', ['alex-one', 'alex-two']);
        const program = candidate as never;
        return { program, entityCandidates: linked === 1 ? ['driver:max-verstappen', 'event:2025:1'] : ['driver:lando-norris', 'driver:max-verstappen'] };
      },
      now: () => now += 10
    });
    expect(artifact.manifest).toEqual({ case_count: 4, sha256: getAnswerEvaluationManifestHash(cases) });
    expect(artifact.observations).toEqual([
      expect.objectContaining({ id: 'dev-race', action: 'answer', reason: 'race_classification', translation_latency_ms: 10, entity_candidates: ['driver:max-verstappen', 'event:2025:1'] }),
      expect.objectContaining({ id: 'dev-ambiguous', action: 'clarify', reason: 'metric_ambiguous', translation_latency_ms: 10 }),
      expect.objectContaining({ id: 'dev-pace', action: 'abstain', reason: 'pace_source_disabled', translation_latency_ms: 10 }),
      expect.objectContaining({ id: 'holdout-entity', action: 'clarify', reason: 'entity_ambiguous', translation_latency_ms: 10, entity_candidates: ['driver:alex-one', 'driver:alex-two'] })
    ]);
  });

  it('rejects malformed and manifest-mismatched artifacts', () => {
    const valid = {
      version: 1,
      kind: 'f1ql_answer_observations',
      provider,
      manifest: { case_count: 1, sha256: '0'.repeat(64) },
      observations: [{ id: 'one', action: 'abstain', reason: 'provider_error', entity_candidates: [], linked_entities: [] }]
    };
    expect(parseAnswerObservationArtifact(valid).observations).toHaveLength(1);
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], extra: true }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], action: 'answer' }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], action: 'answer', reason: 'provider_error', program: answerEvaluationManifest[0].expected.acceptable_programs![0] }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ id: 'one', action: 'answer', reason: 'race_classification', program: answerEvaluationManifest[0].expected.acceptable_programs![0], entity_candidates: [], linked_entities: [] }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], action: 'clarify', reason: 'rows' }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], entity_candidates: ['driver:x', 'driver:x'] }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], entity_candidates: ['not-an-entity'] }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], linked_entities: ['driver:x'] }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], translation_latency_ms: -1 }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [{ ...valid.observations[0], translation_latency_ms: 60_001 }] })).toThrow();
    expect(() => parseAnswerObservationArtifact({ ...valid, observations: [valid.observations[0], valid.observations[0]] })).toThrow('duplicate_evaluation_observation_id');
    expect(() => validateAnswerObservationArtifact(answerEvaluationManifest.slice(0, 1), valid)).toThrow('answer_observation_manifest_mismatch');
  });

  it('rejects non-monotonic observation timing', async () => {
    const times = [100, 99.5];
    await expect(collectAnswerObservations(answerEvaluationManifest.slice(0, 1), provider, {
      translate: async () => ({ type: 'unsupported', reason: 'capability_unsupported' }),
      link: async () => { throw new Error('link must not run'); },
      now: () => times.shift()!
    })).rejects.toThrow('answer_observation_translation_latency_invalid');
  });

  it('binds the complete manifest and exact disposable database', () => {
    const changed = structuredClone(answerEvaluationManifest);
    changed[0].expected.reason = 'changed';
    expect(getAnswerEvaluationManifestHash(changed)).not.toBe(getAnswerEvaluationManifestHash(answerEvaluationManifest));
    expect(() => assertDisposableDatabase('postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test')).not.toThrow();
    expect(() => assertDisposableDatabase('postgresql://postgres:postgres@localhost:5433/f1muse_test')).toThrow();
    expect(() => assertDisposableDatabase('postgresql://postgres:postgres@127.0.0.1:5433/shared')).toThrow();
    expect(() => assertDisposableDatabase('postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test?host=remote.example')).toThrow();
  });

  it('remains structurally non-executing', () => {
    const source = readFileSync('src/f1ql/answer-observations.ts', 'utf8');
    const command = readFileSync('scripts/collect-answer-evaluation-observations.ts', 'utf8');
    expect(source).not.toContain('executeF1QL');
    expect(source).not.toMatch(/from ['"].*executor/);
    expect(source).not.toContain('buildAnswerEnvelope');
    expect(command).not.toContain('executeF1QL');
    expect(command).not.toMatch(/from ['"].*executor/);
    expect(command).toContain("F1QL_ANSWER_EVALUATION_TARGET !== 'localhost'");
    expect(command).toContain('getTestDatabaseUrl()');
    expect(command).toContain("'BEGIN READ ONLY'");
  });
});
