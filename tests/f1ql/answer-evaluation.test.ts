import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnswerEvaluationObservation, evaluateAnswerSelection, evaluateMetamorphicConsistency, selectAnswerAction } from '../../src/f1ql/answer-evaluation';
import { ANSWER_TEMPLATE_IDS } from '../../src/f1ql/answer-templates';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../fixtures/f1ql-answer-evaluation-manifest';

const perfectObservations = (): AnswerEvaluationObservation[] => answerEvaluationManifest.map(item => ({
  id: item.id,
  action: item.expected.action,
  reason: item.expected.reason,
  program: item.expected.acceptable_programs?.[0],
  template_id: item.expected.template_id,
  proof_status: item.expected.proof_outcome === 'passed' ? 'passed' : 'not_applicable',
  entity_candidates: item.canonical_entities,
  linked_entities: item.expected.action === 'answer' ? item.canonical_entities : []
}));

describe('answer selective evaluation framework', () => {
  it('has reviewed hardened coverage and non-development evidence for every template', () => {
    expect(answerEvaluationManifest.length).toBeGreaterThanOrEqual(45);
    expect(new Set(answerEvaluationManifest.map(item => item.id)).size).toBe(answerEvaluationManifest.length);
    expect(new Set(answerEvaluationManifest.map(item => item.split))).toEqual(new Set(['development', 'iid_holdout', 'temporal_entity_holdout', 'adversarial']));
    for (const templateId of ANSWER_TEMPLATE_IDS) {
      expect(answerEvaluationManifest.filter(item => item.split !== 'development' && item.expected.template_id === templateId).length).toBeGreaterThanOrEqual(2);
    }
    const tags = new Set(answerEvaluationManifest.flatMap(item => item.risk_tags));
    for (const required of ['wrong_valid_season', 'wrong_valid_event', 'wrong_valid_round', 'wrong_valid_driver', 'wrong_valid_session', 'wrong_valid_status', 'wrong_valid_order', 'wrong_valid_limit', 'dropped_driver', 'added_driver', 'repeated_driver', 'alias_collision', 'event_ambiguity', 'interim', 'team_name', 'unicode_astral', 'homoglyph', 'control_character', 'prompt_injection', 'negation', 'multi_intent', 'null_result', 'tie', 'empty_result', 'truncation']) {
      expect(tags.has(required), required).toBe(true);
    }
    expect(answerMetamorphicGroups).toHaveLength(8);
    expect(new Set(answerMetamorphicGroups.map(group => group.transformation)).size).toBe(8);
  });

  it('scores a complete exact-template observation set', () => {
    const report = evaluateAnswerSelection(answerEvaluationManifest, perfectObservations());
    const answerCount = answerEvaluationManifest.filter(item => item.expected.action === 'answer').length;
    expect(report).toMatchObject({ total: answerEvaluationManifest.length, observations_supplied: answerEvaluationManifest.length, observations_missing: 0, action_correct: answerEvaluationManifest.length, reason_correct: answerEvaluationManifest.length, normalized_program_exact: answerCount, normalized_program_total: answerCount, answers_emitted: answerCount, unsafe_answers: 0 });
    expect(Object.values(report.by_component).every(count => count.correct === answerCount && count.total === answerCount)).toBe(true);
  });

  it('scores all eight metamorphic transformations and rejects divergence', () => {
    expect(evaluateMetamorphicConsistency(answerMetamorphicGroups, perfectObservations())).toMatchObject({ groups_total: 8, groups_complete: 8, groups_consistent: 8 });
    const observations = perfectObservations().filter(item => item.id !== 'meta-alias');
    const changed = observations.find(item => item.id === 'meta-pair-order')!;
    changed.program = answerEvaluationManifest.find(item => item.id === 'dev-leader')!.expected.acceptable_programs![0];
    expect(evaluateMetamorphicConsistency(answerMetamorphicGroups, observations)).toMatchObject({ groups_total: 8, groups_complete: 7, groups_consistent: 6 });
  });

  it('counts wrong valid programs as unsafe and missing observations as missing', () => {
    const leader = answerEvaluationManifest.find(item => item.id === 'iid-leader')!;
    const race = answerEvaluationManifest.find(item => item.id === 'iid-race-driver')!;
    const report = evaluateAnswerSelection([leader, race], [{ id: leader.id, action: 'answer', reason: leader.expected.reason, program: race.expected.acceptable_programs![0] }]);
    expect(report).toMatchObject({ unsafe_answers: 1, observations_missing: 1, normalized_program_exact: 0, normalized_program_total: 2 });
  });

  it('rejects malformed observation identities and forbidden policy tuples', () => {
    const item = answerEvaluationManifest[0];
    const observation: AnswerEvaluationObservation = { id: item.id, action: item.expected.action, reason: item.expected.reason };
    expect(() => evaluateAnswerSelection([item], [observation, observation])).toThrow('duplicate_evaluation_observation_id');
    expect(() => evaluateAnswerSelection([item], [{ ...observation, id: 'unknown' }])).toThrow('unknown_evaluation_observation_id');
    expect(selectAnswerAction({ type: 'program_candidate', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } } })).toEqual({ action: 'abstain', reason: 'pace_source_disabled' });
  });

  it('remains structurally offline and non-executing', () => {
    const source = readFileSync('src/f1ql/answer-evaluation.ts', 'utf8');
    expect(source).not.toContain('executeF1QL');
    expect(source).not.toMatch(/from ['"].*executor/);
    expect(source).not.toContain('Pool');
  });
});
