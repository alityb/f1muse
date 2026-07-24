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
  acceptable_linked_entities?: string[][];
  risk_tags: string[];
  expected_fixture_rows?: Array<Record<string, unknown>>;
  expected: { action: AnswerEvaluationAction; reason: string; acceptable_programs?: F1QLProgram[] };
}

export interface AnswerEvaluationObservation {
  id: string;
  action: AnswerEvaluationAction;
  reason: string;
  program?: F1QLProgram;
  entity_candidates?: string[];
  linked_entities?: string[];
}

export type AnswerProgramComponent = 'source' | 'scope' | 'entities' | 'filters' | 'operation' | 'ordering' | 'limits';

interface EvaluationCount {
  correct: number;
  total: number;
}

export interface AnswerEvaluationReport {
  total: number;
  observations_supplied: number;
  observations_missing: number;
  action_correct: number;
  reason_correct: number;
  normalized_program_exact: number;
  normalized_program_total: number;
  answers_emitted: number;
  unsafe_answers: number;
  false_abstentions: number;
  false_clarifications: number;
  by_split: Record<AnswerEvaluationSplit, { total: number; correct: number }>;
  by_component: Record<AnswerProgramComponent, EvaluationCount>;
  candidate_entities_recalled: number;
  candidate_entities_total: number;
  complete_links_correct: number;
  complete_links_total: number;
  by_risk: Record<string, EvaluationCount & { unsafe_answers: number }>;
  worst_risk_selection_accuracy: (EvaluationCount & { risk_tag: string }) | null;
}

export function evaluateAnswerSelection(cases: readonly AnswerEvaluationCase[], observations: readonly AnswerEvaluationObservation[]): AnswerEvaluationReport {
  const caseIds = new Set(cases.map(item => item.id));
  if (caseIds.size !== cases.length) {
    throw new Error('duplicate_evaluation_case_id');
  }
  const observedById = new Map<string, AnswerEvaluationObservation>();
  for (const observation of observations) {
    if (!caseIds.has(observation.id)) {
      throw new Error('unknown_evaluation_observation_id');
    }
    if (observedById.has(observation.id)) {
      throw new Error('duplicate_evaluation_observation_id');
    }
    observedById.set(observation.id, observation);
  }
  const bySplit: AnswerEvaluationReport['by_split'] = {
    development: { total: 0, correct: 0 },
    iid_holdout: { total: 0, correct: 0 },
    temporal_entity_holdout: { total: 0, correct: 0 },
    adversarial: { total: 0, correct: 0 }
  };
  const byComponent = Object.fromEntries(['source', 'scope', 'entities', 'filters', 'operation', 'ordering', 'limits'].map(component => [component, { correct: 0, total: 0 }])) as AnswerEvaluationReport['by_component'];
  const byRisk: AnswerEvaluationReport['by_risk'] = {};
  let actionCorrect = 0;
  let reasonCorrect = 0;
  let programExact = 0;
  let programTotal = 0;
  let answersEmitted = 0;
  let unsafeAnswers = 0;
  let falseAbstentions = 0;
  let falseClarifications = 0;
  let observationsSupplied = 0;
  let candidateEntitiesRecalled = 0;
  let candidateEntitiesTotal = 0;
  let completeLinksCorrect = 0;
  let completeLinksTotal = 0;

  for (const item of cases) {
    const suppliedObservation = observedById.get(item.id);
    const observed = suppliedObservation ?? { id: item.id, action: 'abstain' as const, reason: 'observation_missing' };
    observationsSupplied += Number(suppliedObservation !== undefined);
    const actionMatches = suppliedObservation !== undefined && observed.action === item.expected.action;
    bySplit[item.split].total++;
    if (actionMatches) {
      actionCorrect++;
      bySplit[item.split].correct++;
    }
    if (suppliedObservation !== undefined && observed.reason === item.expected.reason) {
      reasonCorrect++;
    }
    const acceptablePrograms = item.expected.acceptable_programs ?? [];
    const exactProgram = observed.program !== undefined && acceptablePrograms.some(program => JSON.stringify(normalizeF1QLProgram(observed.program)) === JSON.stringify(normalizeF1QLProgram(program)));
    if (acceptablePrograms.length > 0) {
      programTotal++;
      const componentMatches = observed.program === undefined ? undefined : bestComponentMatches(observed.program, acceptablePrograms);
      for (const component of Object.keys(byComponent) as AnswerProgramComponent[]) {
        byComponent[component].total++;
        if (componentMatches?.[component]) {
          byComponent[component].correct++;
        }
      }
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
    if (suppliedObservation !== undefined && observed.action === 'abstain' && item.expected.action === 'answer') {
      falseAbstentions++;
    }
    if (suppliedObservation !== undefined && observed.action === 'clarify' && item.expected.action === 'answer') {
      falseClarifications++;
    }
    const expectedEntities = [...new Set(item.canonical_entities)].sort();
    candidateEntitiesTotal += expectedEntities.length;
    candidateEntitiesRecalled += expectedEntities.filter(entity => observed.entity_candidates?.includes(entity)).length;
    const acceptableLinks = item.acceptable_linked_entities ?? [];
    if (acceptableLinks.length > 0) {
      completeLinksTotal++;
      if (acceptableLinks.some(entities => sameStringSet(entities, observed.linked_entities ?? []))) {
        completeLinksCorrect++;
      }
    }
    const selectionMatches = actionMatches && (observed.action !== 'answer' || exactProgram);
    for (const risk of item.risk_tags) {
      const count = byRisk[risk] ?? { total: 0, correct: 0, unsafe_answers: 0 };
      count.total++;
      count.correct += Number(selectionMatches);
      count.unsafe_answers += Number(observed.action === 'answer' && (item.expected.action !== 'answer' || !exactProgram));
      byRisk[risk] = count;
    }
  }
  const worstRisk = Object.entries(byRisk).sort(([leftTag, left], [rightTag, right]) => (left.correct / left.total) - (right.correct / right.total) || leftTag.localeCompare(rightTag))[0];
  return { total: cases.length, observations_supplied: observationsSupplied, observations_missing: cases.length - observationsSupplied, action_correct: actionCorrect, reason_correct: reasonCorrect, normalized_program_exact: programExact, normalized_program_total: programTotal, answers_emitted: answersEmitted, unsafe_answers: unsafeAnswers, false_abstentions: falseAbstentions, false_clarifications: falseClarifications, by_split: bySplit, by_component: byComponent, candidate_entities_recalled: candidateEntitiesRecalled, candidate_entities_total: candidateEntitiesTotal, complete_links_correct: completeLinksCorrect, complete_links_total: completeLinksTotal, by_risk: byRisk, worst_risk_selection_accuracy: worstRisk ? { risk_tag: worstRisk[0], correct: worstRisk[1].correct, total: worstRisk[1].total } : null };
}

function bestComponentMatches(observed: F1QLProgram, expectedPrograms: readonly F1QLProgram[]): Record<AnswerProgramComponent, boolean> {
  const components = Object.keys(programComponents(observed)) as AnswerProgramComponent[];
  const observedComponents = programComponents(observed);
  return expectedPrograms.map(expected => {
    const expectedComponents = programComponents(expected);
    return Object.fromEntries(components.map(component => [component, JSON.stringify(observedComponents[component]) === JSON.stringify(expectedComponents[component])])) as Record<AnswerProgramComponent, boolean>;
  }).sort((left, right) => components.filter(component => right[component]).length - components.filter(component => left[component]).length)[0];
}

function programComponents(input: F1QLProgram): Record<AnswerProgramComponent, unknown> {
  const root = normalizeF1QLProgram(input).root;
  if (root.op === 'aggregate' || root.op === 'rank') {
    const aggregate = root.op === 'rank' ? root.input : root;
    const where = aggregate.input.op === 'filter' ? aggregate.input.where : {};
    return {
      source: 'standings',
      scope: { season: where.season },
      entities: { driver_id: where.driver_id },
      filters: {},
      operation: { op: root.op, group_by: aggregate.group_by, measures: aggregate.measures },
      ordering: root.op === 'rank' ? { by: root.by, direction: root.direction } : {},
      limits: root.op === 'rank' ? { limit: root.limit } : {}
    };
  }
  const rootRecord = root as unknown as Record<string, unknown>;
  const filters = (rootRecord.filters ?? {}) as Record<string, unknown>;
  return {
    source: programSource(root.op),
    scope: programScope(root),
    entities: programEntities(root, filters),
    filters: Object.fromEntries(Object.entries(filters).filter(([key]) => key !== 'driver_id')),
    operation: { op: root.op },
    ordering: {},
    limits: 'limit' in root ? { limit: root.limit } : {}
  };
}

function programSource(op: F1QLProgram['root']['op']): string {
  if (op === 'event_classification') {
    return 'race_classification';
  }
  if (op === 'qualifying_classification') {
    return 'qualifying_classification';
  }
  if (op === 'event_metadata') {
    return 'race_date_metadata';
  }
  return 'pace';
}

function programScope(root: Exclude<F1QLProgram['root'], { op: 'aggregate' | 'rank' }>): unknown {
  if (root.op === 'pace_delta' || root.op === 'pace_summary') {
    return root.scope;
  }
  return { season: root.season, round: root.round, session_scope: root.op === 'event_metadata' ? root.session_scope : undefined };
}

function programEntities(root: Exclude<F1QLProgram['root'], { op: 'aggregate' | 'rank' }>, filters: Record<string, unknown>): unknown {
  if (root.op === 'pace_delta') {
    return { driver_id: [root.driver_a_id, root.driver_b_id] };
  }
  if (root.op === 'pace_summary') {
    return { driver_id: root.driver_id };
  }
  return { driver_id: filters.driver_id };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
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
