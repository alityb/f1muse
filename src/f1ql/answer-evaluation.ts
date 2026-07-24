import { authorizeAnswerProgram } from './answer-policy';
import { F1QLProgram } from './ast';
import { parseF1QLProgram } from './schema';
import { F1QLTranslationResult } from './translator';
import { normalizeF1QLProgram } from './verified-programs';

export type AnswerEvaluationAction = 'answer' | 'clarify' | 'abstain';
export type AnswerEvaluationSplit = 'development' | 'iid_holdout' | 'temporal_entity_holdout' | 'adversarial';

export interface AnswerEvaluationCase {
  id: string;
  split: AnswerEvaluationSplit;
  question: string;
  answerable: boolean;
  defensible_interpretations: string[];
  canonical_entities: string[];
  risk_tags: string[];
  expected_fixture_rows?: Array<Record<string, unknown>>;
  expected: { action: AnswerEvaluationAction; reason: string; acceptable_programs?: F1QLProgram[] };
}

export interface AnswerEvaluationObservation {
  id: string;
  action: AnswerEvaluationAction;
  reason: string;
  program?: F1QLProgram;
}

export interface AnswerEvaluationReport {
  total: number;
  action_correct: number;
  reason_correct: number;
  normalized_program_exact: number;
  normalized_program_total: number;
  answers_emitted: number;
  unsafe_answers: number;
  false_abstentions: number;
  false_clarifications: number;
  by_split: Record<AnswerEvaluationSplit, { total: number; correct: number }>;
}

export function evaluateAnswerSelection(cases: readonly AnswerEvaluationCase[], observations: readonly AnswerEvaluationObservation[]): AnswerEvaluationReport {
  const observedById = new Map(observations.map(observation => [observation.id, observation]));
  const bySplit: AnswerEvaluationReport['by_split'] = {
    development: { total: 0, correct: 0 },
    iid_holdout: { total: 0, correct: 0 },
    temporal_entity_holdout: { total: 0, correct: 0 },
    adversarial: { total: 0, correct: 0 }
  };
  let actionCorrect = 0;
  let reasonCorrect = 0;
  let programExact = 0;
  let programTotal = 0;
  let answersEmitted = 0;
  let unsafeAnswers = 0;
  let falseAbstentions = 0;
  let falseClarifications = 0;

  for (const item of cases) {
    const observed = observedById.get(item.id) ?? { id: item.id, action: 'abstain' as const, reason: 'observation_missing' };
    const actionMatches = observed.action === item.expected.action;
    bySplit[item.split].total++;
    if (actionMatches) {
      actionCorrect++;
      bySplit[item.split].correct++;
    }
    if (observed.reason === item.expected.reason) {
      reasonCorrect++;
    }
    const acceptablePrograms = item.expected.acceptable_programs ?? [];
    const exactProgram = observed.program !== undefined && acceptablePrograms.some(program => JSON.stringify(normalizeF1QLProgram(observed.program)) === JSON.stringify(normalizeF1QLProgram(program)));
    if (acceptablePrograms.length > 0) {
      programTotal++;
      if (exactProgram) {
        programExact++;
      }
    }
    if (observed.action === 'answer') {
      answersEmitted++;
      if (item.expected.action !== 'answer' || !exactProgram) {
        unsafeAnswers++;
      }
    }
    if (observed.action === 'abstain' && item.expected.action === 'answer') {
      falseAbstentions++;
    }
    if (observed.action === 'clarify' && item.expected.action === 'answer') {
      falseClarifications++;
    }
  }
  return { total: cases.length, action_correct: actionCorrect, reason_correct: reasonCorrect, normalized_program_exact: programExact, normalized_program_total: programTotal, answers_emitted: answersEmitted, unsafe_answers: unsafeAnswers, false_abstentions: falseAbstentions, false_clarifications: falseClarifications, by_split: bySplit };
}

export function selectAnswerAction(translation: F1QLTranslationResult, linkedProgram?: unknown): { action: AnswerEvaluationAction; reason: string; program?: F1QLProgram } {
  if (translation.type === 'clarification_required') {
    return { action: 'clarify', reason: translation.reason };
  }
  if (translation.type === 'unsupported' || translation.type === 'provider_unavailable') {
    return { action: 'abstain', reason: translation.reason };
  }
  let program: F1QLProgram;
  try {
    program = parseF1QLProgram(linkedProgram ?? translation.program);
  } catch {
    return { action: 'abstain', reason: 'program_invalid' };
  }
  const decision = authorizeAnswerProgram(program);
  return decision.type === 'approved'
    ? { action: 'answer', reason: decision.capability.source, program }
    : { action: 'abstain', reason: decision.reason };
}
