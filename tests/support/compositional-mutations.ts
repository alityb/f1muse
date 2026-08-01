import type { AnswerPlan } from '../../src/f1ql/semantic-planner';

export const ANSWER_PLAN_MUTATION_CATEGORIES = [
  'source',
  'scope/predicate',
  'relationship/join',
  'grain',
  'aggregate binding',
  'order',
  'limit',
  'work',
  'topology',
  'integrity',
  'authorization/extra-field'
] as const;

export type AnswerPlanMutationCategory = typeof ANSWER_PLAN_MUTATION_CATEGORIES[number];

export interface NamedAnswerPlanMutation {
  readonly name: string;
  readonly category: AnswerPlanMutationCategory;
  readonly corpus_case_id: string;
  readonly planned_validation_rejects: boolean;
  mutate(plan: AnswerPlan): void;
}

export const NAMED_ANSWER_PLAN_MUTATIONS: readonly NamedAnswerPlanMutation[] = [
  {
    name: 'substitute-source-graph-source', category: 'source',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => { (plan.source_graph.source_ids as string[])[0] = 'event_metadata'; }
  },
  {
    name: 'substitute-season-predicate', category: 'scope/predicate',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => { (plan.branches[0].predicates[0] as { value: unknown }).value = 2024; }
  },
  {
    name: 'substitute-row-join-relationship', category: 'relationship/join',
    corpus_case_id: 'promoted-safe-dimension-join', planned_validation_rejects: true,
    mutate: plan => {
      const input = plan.planned_f1ql.root.input.input.input;
      if (input.op !== 'join') {throw new Error('mutation requires a join plan');}
      input.relationship_id = 'driver_event_classification';
    }
  },
  {
    name: 'drop-output-grain', category: 'grain',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => { (plan as { output_grain: readonly string[] }).output_grain = []; }
  },
  {
    name: 'rebind-composed-aggregate-function', category: 'aggregate binding',
    corpus_case_id: 'promoted-aggregate-locality', planned_validation_rejects: true,
    mutate: plan => {
      const input = plan.planned_f1ql.root.input.input.input;
      if (input.op !== 'compose') {throw new Error('mutation requires a composition plan');}
      input.inputs[0].measures[0].function = 'max';
    }
  },
  {
    name: 'invert-primary-order', category: 'order',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => { plan.planned_f1ql.root.input.keys[0].direction = 'desc'; }
  },
  {
    name: 'reduce-row-limit', category: 'limit',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => { plan.planned_f1ql.root.count = 99; }
  },
  {
    name: 'understate-source-work', category: 'work',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => {
      (plan.work as { source_scan_units: number }).source_scan_units -= 1;
    }
  },
  {
    name: 'substitute-plan-topology', category: 'topology',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => {
      (plan as { topology: AnswerPlan['topology'] }).topology = 'scalar_aggregate_compose';
    }
  },
  {
    name: 'drop-required-integrity-check', category: 'integrity',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => {
      (plan as { integrity_checks: readonly string[] }).integrity_checks = plan.integrity_checks.slice(1);
    }
  },
  {
    name: 'inject-authorization-field', category: 'authorization/extra-field',
    corpus_case_id: 'promoted-single-source-rows', planned_validation_rejects: false,
    mutate: plan => { (plan as AnswerPlan & { authorization: boolean }).authorization = true; }
  }
] as const;

export const RESULT_MUTATION_CATEGORIES = [
  'malformed',
  'partial',
  'duplicate',
  'tie',
  'misorder',
  'schema',
  'type',
  'negative-count',
  'incomplete-join',
  'same-schema factual substitution',
  'unfiltered row omission'
] as const;

export type ResultMutationCategory = typeof RESULT_MUTATION_CATEGORIES[number];
export type ResultMutationDisposition = 'rejected_offline' | 'rejected_by_runtime_provenance';

export const RESULT_MUTATION_ACCOUNTING: ReadonlyArray<{
  readonly name: string;
  readonly category: ResultMutationCategory;
  readonly disposition: ResultMutationDisposition;
}> = [
  { name: 'non-array-result', category: 'malformed', disposition: 'rejected_offline' },
  { name: 'omit-scalar-result-row', category: 'partial', disposition: 'rejected_offline' },
  { name: 'repeat-identical-grain', category: 'duplicate', disposition: 'rejected_offline' },
  { name: 'tie-without-distinct-grain', category: 'tie', disposition: 'rejected_offline' },
  { name: 'reverse-proven-row-order', category: 'misorder', disposition: 'rejected_offline' },
  { name: 'add-unproven-column', category: 'schema', disposition: 'rejected_offline' },
  { name: 'replace-exact-decimal-with-number', category: 'type', disposition: 'rejected_offline' },
  { name: 'make-count-negative', category: 'negative-count', disposition: 'rejected_offline' },
  { name: 'null-required-joined-metadata', category: 'incomplete-join', disposition: 'rejected_offline' },
  {
    name: 'substitute-unscoped-fact-with-same-schema',
    category: 'same-schema factual substitution',
    disposition: 'rejected_by_runtime_provenance'
  },
  {
    name: 'omit-one-unfiltered-source-row',
    category: 'unfiltered row omission',
    disposition: 'rejected_by_runtime_provenance'
  }
] as const;
