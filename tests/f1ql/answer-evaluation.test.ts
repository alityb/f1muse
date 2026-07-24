import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnswerEvaluationObservation, evaluateAnswerSelection, evaluateMetamorphicConsistency, selectAnswerAction } from '../../src/f1ql/answer-evaluation';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../fixtures/f1ql-answer-evaluation-manifest';

const perfectObservations = (): AnswerEvaluationObservation[] => answerEvaluationManifest.map(item => ({ id: item.id, action: item.expected.action, reason: item.expected.reason, program: item.expected.acceptable_programs?.[0], entity_candidates: item.canonical_entities, linked_entities: item.canonical_entities }));

describe('answer selective evaluation framework', () => {
  it('validates reviewed annotation coverage without claiming model observations', () => {
    expect(new Set(answerEvaluationManifest.map(item => item.split))).toEqual(new Set(['development', 'iid_holdout', 'temporal_entity_holdout', 'adversarial']));
    const tags = new Set(answerEvaluationManifest.flatMap(item => item.risk_tags));
    for (const required of ['prompt_injection', 'capability_escalation', 'alias_collision', 'oversized_request', 'ambiguity', 'null_result', 'tie', 'empty_result']) expect(tags.has(required)).toBe(true);
    expect(new Set(answerEvaluationManifest.map(item => item.id)).size).toBe(answerEvaluationManifest.length);
    expect(answerEvaluationManifest.filter(item => item.split === 'temporal_entity_holdout' && item.answerable).length).toBeGreaterThan(0);
    expect(new Set(answerMetamorphicGroups.map(group => group.transformation))).toEqual(new Set(['paraphrase', 'alias', 'filter_reordering']));
    const caseIds = new Set(answerEvaluationManifest.map(item => item.id));
    expect(answerMetamorphicGroups.every(group => group.case_ids.every(id => caseIds.has(id)))).toBe(true);
  });

  it('scores independently supplied observations with explicit denominators', () => {
    const report = evaluateAnswerSelection(answerEvaluationManifest, perfectObservations());
    expect(report).toMatchObject({ total: 26, observations_supplied: 26, observations_missing: 0, action_correct: 26, reason_correct: 26, normalized_program_exact: 13, normalized_program_total: 13, answers_emitted: 13, unsafe_answers: 0, false_abstentions: 0, false_clarifications: 0 });
    expect(report.by_component).toEqual(Object.fromEntries(['source', 'scope', 'entities', 'filters', 'operation', 'ordering', 'limits'].map(component => [component, { correct: 13, total: 13 }])));
    expect(report).toMatchObject({ candidate_entities_recalled: 22, candidate_entities_total: 22, complete_links_correct: 11, complete_links_total: 11 });
    expect(report.by_risk.prompt_injection).toEqual({ total: 1, correct: 1, unsafe_answers: 0 });
    expect(report.worst_risk_selection_accuracy).toEqual({ risk_tag: 'alias_collision', correct: 1, total: 1 });
  });

  it('scores complete equivalent metamorphic groups deterministically', () => {
    const report = evaluateMetamorphicConsistency(answerMetamorphicGroups, perfectObservations());
    expect(report).toEqual({
      groups_total: 3,
      groups_complete: 3,
      groups_consistent: 3,
      by_transformation: {
        paraphrase: { total: 1, complete: 1, consistent: 1 },
        alias: { total: 1, complete: 1, consistent: 1 },
        filter_reordering: { total: 1, complete: 1, consistent: 1 }
      }
    });
  });

  it('does not credit missing or divergent metamorphic observations', () => {
    const observations = perfectObservations().filter(observation => observation.id !== 'meta-race-alias');
    const changed = observations.find(observation => observation.id === 'meta-pair-filter-order')!;
    changed.program = answerEvaluationManifest.find(item => item.id === 'dev-race')!.expected.acceptable_programs![0];
    const report = evaluateMetamorphicConsistency(answerMetamorphicGroups, observations);
    expect(report).toMatchObject({ groups_total: 3, groups_complete: 2, groups_consistent: 1 });
    expect(report.by_transformation.alias).toEqual({ total: 1, complete: 0, consistent: 0 });
    expect(report.by_transformation.filter_reordering).toEqual({ total: 1, complete: 1, consistent: 0 });
  });

  it('does not credit malformed metamorphic observations as complete', () => {
    const observations = perfectObservations();
    delete observations.find(observation => observation.id === 'meta-standings-paraphrase')!.program;
    const malformed = observations.find(observation => observation.id === 'meta-race-alias')!;
    malformed.action = 'abstain';
    const report = evaluateMetamorphicConsistency(answerMetamorphicGroups, observations);
    expect(report).toMatchObject({ groups_total: 3, groups_complete: 1, groups_consistent: 1 });
  });

  it('counts a wrong program as unsafe and clarification of an answerable case separately', () => {
    const cases = answerEvaluationManifest.slice(0, 2);
    const wrong = cases[1].expected.acceptable_programs?.[0];
    const report = evaluateAnswerSelection(cases, [
      { id: cases[0].id, action: 'answer', reason: cases[0].expected.reason, program: wrong },
      { id: cases[1].id, action: 'clarify', reason: 'entity_ambiguous' }
    ]);
    expect(report).toMatchObject({ unsafe_answers: 1, false_clarifications: 1, normalized_program_exact: 0, normalized_program_total: 2 });
    expect(report.by_component.source).toEqual({ correct: 0, total: 2 });
    expect(report.by_risk.clean).toEqual({ total: 1, correct: 0, unsafe_answers: 1 });
    expect(report).toMatchObject({ candidate_entities_recalled: 0, candidate_entities_total: 2, complete_links_correct: 0, complete_links_total: 1 });
  });

  it('does not credit a missing observation as a correct abstention', () => {
    const adversarialCase = answerEvaluationManifest.find(item => item.id === 'adv-injection')!;
    const answerableCase = answerEvaluationManifest.find(item => item.id === 'dev-race')!;
    const report = evaluateAnswerSelection([adversarialCase, answerableCase], []);
    expect(report).toMatchObject({ total: 2, observations_supplied: 0, observations_missing: 2, action_correct: 0, reason_correct: 0, false_abstentions: 0 });
    expect(report.by_risk.prompt_injection).toEqual({ total: 1, correct: 0, unsafe_answers: 0 });
  });

  it('scores components against one coherent acceptable interpretation', () => {
    const base = answerEvaluationManifest.find(item => item.id === 'iid-pair')!;
    const first = base.expected.acceptable_programs![0];
    const second = structuredClone(first);
    const observed = structuredClone(first);
    if (second.root.op !== 'aggregate' || second.root.input.op !== 'filter' || observed.root.op !== 'aggregate' || observed.root.input.op !== 'filter') throw new Error('standings fixture expected');
    second.root.input.where = { season: 2024, driver_id: ['charles-leclerc'] };
    observed.root.input.where = { season: 2025, driver_id: ['charles-leclerc'] };
    const report = evaluateAnswerSelection([{ ...base, expected: { ...base.expected, acceptable_programs: [first, second] } }], [{ id: base.id, action: 'answer', reason: base.expected.reason, program: observed }]);
    expect(Object.values(report.by_component).filter(count => count.correct === 1).length).toBeLessThan(7);
    expect(report.normalized_program_exact).toBe(0);
  });

  it('rejects malformed observation identity sets', () => {
    const item = answerEvaluationManifest[0];
    const observation: AnswerEvaluationObservation = { id: item.id, action: item.expected.action, reason: item.expected.reason };
    expect(() => evaluateAnswerSelection([item], [observation, observation])).toThrow('duplicate_evaluation_observation_id');
    expect(() => evaluateAnswerSelection([item], [{ ...observation, id: 'unknown' }])).toThrow('unknown_evaluation_observation_id');
    expect(() => evaluateAnswerSelection([item, item], [])).toThrow('duplicate_evaluation_case_id');
  });

  it('deterministically rejects a forbidden policy tuple', () => {
    const result = selectAnswerAction({ type: 'program_candidate', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } } });
    expect(result).toEqual({ action: 'abstain', reason: 'pace_source_disabled' });
  });

  it('remains structurally offline and non-executing', () => {
    const source = readFileSync('src/f1ql/answer-evaluation.ts', 'utf8');
    expect(source).not.toContain('executeF1QL');
    expect(source).not.toMatch(/from ['"].*executor/);
    expect(source).not.toContain('Pool');
  });
});
