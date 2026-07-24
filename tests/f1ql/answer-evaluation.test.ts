import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AnswerEvaluationObservation, evaluateAnswerSelection, selectAnswerAction } from '../../src/f1ql/answer-evaluation';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';

describe('answer selective evaluation framework', () => {
  it('validates reviewed annotation coverage without claiming model observations', () => {
    expect(new Set(answerEvaluationManifest.map(item => item.split))).toEqual(new Set(['development', 'iid_holdout', 'temporal_entity_holdout', 'adversarial']));
    const tags = new Set(answerEvaluationManifest.flatMap(item => item.risk_tags));
    for (const required of ['prompt_injection', 'capability_escalation', 'alias_collision', 'oversized_request', 'ambiguity', 'null_result', 'tie', 'empty_result']) expect(tags.has(required)).toBe(true);
    expect(new Set(answerEvaluationManifest.map(item => item.id)).size).toBe(answerEvaluationManifest.length);
    expect(answerEvaluationManifest.filter(item => item.split === 'temporal_entity_holdout' && item.answerable).length).toBeGreaterThan(0);
  });

  it('scores independently supplied observations with explicit denominators', () => {
    const observations: AnswerEvaluationObservation[] = answerEvaluationManifest.map(item => ({ id: item.id, action: item.expected.action, reason: item.expected.reason, program: item.expected.acceptable_programs?.[0] }));
    const report = evaluateAnswerSelection(answerEvaluationManifest, observations);
    expect(report).toMatchObject({ total: 22, action_correct: 22, reason_correct: 22, normalized_program_exact: 9, normalized_program_total: 9, answers_emitted: 9, unsafe_answers: 0, false_abstentions: 0, false_clarifications: 0 });
  });

  it('counts a wrong program as unsafe and clarification of an answerable case separately', () => {
    const cases = answerEvaluationManifest.slice(0, 2);
    const wrong = cases[1].expected.acceptable_programs?.[0];
    const report = evaluateAnswerSelection(cases, [
      { id: cases[0].id, action: 'answer', reason: cases[0].expected.reason, program: wrong },
      { id: cases[1].id, action: 'clarify', reason: 'entity_ambiguous' }
    ]);
    expect(report).toMatchObject({ unsafe_answers: 1, false_clarifications: 1, normalized_program_exact: 0, normalized_program_total: 2 });
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
