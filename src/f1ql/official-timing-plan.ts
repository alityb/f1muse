import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
  OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID
} from './official-timing-question';
import { OfficialTimingResolution, verifyOfficialTimingResolution } from './official-timing-resolution';
import { OfficialTimingQuestionMatch } from './official-timing-question';
import { OfficialTimingSemanticEvidence } from './official-timing-semantic-query';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_PLANNER_VERSION = 'semantic-planner-v3' as const;
export const OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION = 'semantic-plan-work-v2' as const;
export const OFFICIAL_TIMING_PLANNED_F1QL_VERSION = 3 as const;
export const OFFICIAL_TIMING_PLANNED_F1QL_DIALECT = 'planned_f1ql_v3' as const;
export const OFFICIAL_TIMING_PLANNED_COST_VERSION = 'planned-cost-v2' as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const metricSchema = z.enum([OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID, OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID]);
const aggregationSchema = z.enum(['arithmetic_mean_integer_milliseconds', 'median_integer_milliseconds']);
const branchSchema = z.enum(['driver_a', 'driver_b']);
const measureAliasSchema = z.enum(['driver_a_metric', 'driver_b_metric']);

const driverIdValueSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const predicateSchema = z.union([
  z.object({ concept: z.literal('season'), operator: z.literal('eq'), value: z.literal(2022) }).strict(),
  z.object({ concept: z.literal('round'), operator: z.literal('eq'), value: z.literal(14) }).strict(),
  z.object({ concept: z.literal('session_type'), operator: z.literal('eq'), value: z.literal('R') }).strict(),
  z.object({ concept: z.literal('driver_id'), operator: z.literal('eq'), value: driverIdValueSchema }).strict(),
  z.object({ concept: z.literal('lap_number'), operator: z.literal('range'), min: z.number().int().min(1), max: z.number().int().min(1) }).strict()
    .refine(predicate => predicate.max >= predicate.min && predicate.max - predicate.min + 1 <= 50, {
      message: 'official timing lap window is malformed'
    })
]);
const branchFilterSchema = z.object({
  op: z.literal('filter'),
  input: z.object({
    op: z.literal('source'),
    source_id: z.literal('official_race_lap_timing'),
    view: z.literal('f1ql.official_race_lap_timing')
  }).strict(),
  predicates: z.array(predicateSchema).min(4).max(5)
}).strict();
const aggregateSchema = z.object({
  op: z.literal('aggregate'),
  branch: branchSchema,
  input: branchFilterSchema,
  group_by: z.tuple([]),
  measures: z.tuple([z.object({
    concept: z.literal('lap_time_seconds'),
    function: aggregationSchema,
    as: measureAliasSchema,
    exclude_predicates: z.tuple([
      z.object({ concept: z.literal('official_deleted_lap'), operator: z.literal('eq'), value: z.literal(false) }).strict(),
      z.object({ concept: z.literal('official_pit_marker'), operator: z.literal('eq'), value: z.literal(false) }).strict()
    ])
  }).strict()])
}).strict();
const compareSchema = z.object({
  op: z.literal('compare'),
  metric_id: metricSchema,
  left: aggregateSchema,
  right: aggregateSchema,
  relation: z.literal('lower'),
  delta: z.literal('absolute'),
  winner_on_equal: z.null(),
  decimal_scale: z.literal(4)
}).strict();
const projectSchema = z.object({
  op: z.literal('project'),
  input: compareSchema,
  outputs: z.array(z.object({ kind: z.literal('computed'), as: idSchema }).strict()).min(1).max(30)
}).strict();
const sortSchema = z.object({
  op: z.literal('sort'),
  input: projectSchema,
  keys: z.tuple([z.object({ output_id: z.literal('metric_id'), direction: z.literal('asc'), nulls: z.literal('last') }).strict()])
}).strict();
const plannedF1qlSchema = z.object({
  kind: z.literal('internal_planned_f1ql'),
  version: z.literal(OFFICIAL_TIMING_PLANNED_F1QL_VERSION),
  dialect: z.literal(OFFICIAL_TIMING_PLANNED_F1QL_DIALECT),
  catalog_hash: sha256Schema,
  root: z.object({ op: z.literal('limit'), input: sortSchema, count: z.literal(1) }).strict()
}).strict().superRefine((program, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const compare = program.root.input.input.input;
  const aggregates = [compare.left, compare.right];
  if (compare.left.branch !== 'driver_a' || compare.right.branch !== 'driver_b' ||
      compare.left.measures[0].as !== 'driver_a_metric' || compare.right.measures[0].as !== 'driver_b_metric') {
    issue('official timing plan branches are not driver ordered');
  }
  for (const aggregate of aggregates) {
    if (aggregate.measures[0].as !== `${aggregate.branch}_metric`) {
      issue('official timing measure alias does not match branch');
    }
  }
  refineMetricConsistency(compare, issue);
  for (const aggregate of aggregates) {
    refineBranchPredicates(aggregate, compare.metric_id, issue);
  }
  const leftDriver = compare.left.input.predicates.find(predicate => predicate.concept === 'driver_id');
  const rightDriver = compare.right.input.predicates.find(predicate => predicate.concept === 'driver_id');
  if (leftDriver?.operator === 'eq' && rightDriver?.operator === 'eq' && leftDriver.value === rightDriver.value) {
    issue('official timing plan drivers must be distinct');
  }
  refineProjectedOutputs(program, compare.metric_id, issue);
});

function refineMetricConsistency(
  compare: { readonly metric_id: string; readonly left: { readonly measures: readonly { readonly function: string }[] }; readonly right: { readonly measures: readonly { readonly function: string }[] } },
  issue: (message: string) => void
): void {
  const expected = compare.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? 'arithmetic_mean_integer_milliseconds'
    : 'median_integer_milliseconds';
  for (const aggregate of [compare.left, compare.right]) {
    if (aggregate.measures[0].function !== expected) {
      issue('official timing aggregation does not match metric');
    }
  }
}

function refineBranchPredicates(
  aggregate: { readonly input: { readonly predicates: readonly { readonly concept: string }[] } },
  metricId: string,
  issue: (message: string) => void
): void {
  const concepts = aggregate.input.predicates.map(predicate => predicate.concept);
  const expected = ['season', 'round', 'session_type', 'driver_id'];
  const expectsWindow = metricId === OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID;
  if (concepts.length !== expected.length + (expectsWindow ? 1 : 0) ||
      !expected.every((concept, index) => concepts[index] === concept) ||
      (expectsWindow && concepts[4] !== 'lap_number')) {
    issue('official timing branch predicates do not match the sealed predicate order');
  }
}

function refineProjectedOutputs(
  program: { readonly root: { readonly input: { readonly input: { readonly outputs: readonly { readonly as: string }[] } } } },
  metricId: string,
  issue: (message: string) => void
): void {
  const output = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas.find(candidate => candidate.metric_id === metricId);
  const projected = program.root.input.input.outputs.map(field => field.as);
  if (!output || projected.length !== output.field_ids.length ||
      !output.field_ids.every((fieldId, index) => projected[index] === fieldId)) {
    issue('official timing projected outputs do not match the sealed output schema');
  }
}

export type OfficialTimingPlannedF1ql = z.infer<typeof plannedF1qlSchema>;

export interface OfficialTimingPlanWork {
  readonly model: typeof OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION;
  readonly sources: 1;
  readonly source_scans: 2;
  readonly joins: 0;
  readonly comparisons: 1;
  readonly compositions: 0;
  readonly requested_rows: 1;
  readonly operator_depth: 7;
  readonly resolver_reads: number;
  readonly coverage_reads: 1;
}

export interface OfficialTimingPlan {
  readonly kind: 'official_timing_plan';
  readonly planner_version: typeof OFFICIAL_TIMING_PLANNER_VERSION;
  readonly work_model_version: typeof OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION;
  readonly cost_version: typeof OFFICIAL_TIMING_PLANNED_COST_VERSION;
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly resolution_evidence_hash: string;
  readonly coverage_witness_hash: string;
  readonly metric_id: z.infer<typeof metricSchema>;
  readonly topology: 'same_source_scalar_comparison';
  readonly drivers: readonly [
    { readonly branch: 'driver_a'; readonly driver_id: string },
    { readonly branch: 'driver_b'; readonly driver_id: string }
  ];
  readonly window: { readonly lap_start: number; readonly lap_end: number } | null;
  readonly work: OfficialTimingPlanWork;
  readonly integrity_checks: readonly string[];
  readonly planned_f1ql: OfficialTimingPlannedF1ql;
  readonly planned_f1ql_hash: string;
  readonly answer_plan_hash: string;
}

export class OfficialTimingPlannerError extends Error {
  constructor(readonly reason: 'coverage_not_eligible' | 'planned_program_invalid' | 'work_mismatch') {
    super(reason);
    this.name = 'OfficialTimingPlannerError';
  }
}

const activeOfficialTimingPlans = new WeakSet<object>();

export function planOfficialTimingAnswer(input: {
  readonly question: OfficialTimingQuestionMatch;
  readonly evidence: OfficialTimingSemanticEvidence;
  readonly resolution: OfficialTimingResolution;
}): OfficialTimingPlan {
  const resolution = verifyResolution(input);
  const query = input.evidence.candidates[0];
  const topology = requireTopology(query.metric_id);
  const window = query.metric_id === OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID
    ? requireWindow(query.filters)
    : null;
  const planned = buildPlannedF1ql(input, resolution, query.metric_id, window);
  const work: OfficialTimingPlanWork = {
    model: OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION,
    sources: 1,
    source_scans: 2,
    joins: 0,
    comparisons: 1,
    compositions: 0,
    requested_rows: 1,
    operator_depth: 7,
    resolver_reads: 3,
    coverage_reads: 1
  };
  const unsigned = {
    kind: 'official_timing_plan' as const,
    planner_version: OFFICIAL_TIMING_PLANNER_VERSION,
    work_model_version: OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION,
    cost_version: OFFICIAL_TIMING_PLANNED_COST_VERSION,
    question_sha256: input.question.question_sha256,
    catalog_hash: input.evidence.catalog_hash,
    semantic_evidence_hash: input.resolution.semantic_evidence_hash,
    candidate_set_hash: input.evidence.candidate_set_hash,
    semantic_query_hash: input.resolution.semantic_query_hash,
    resolution_evidence_hash: input.resolution.resolution_hash,
    coverage_witness_hash: hash(resolution.coverage),
    metric_id: query.metric_id,
    topology: 'same_source_scalar_comparison' as const,
    drivers: [
      { branch: 'driver_a' as const, driver_id: resolution.drivers[0].driver_id },
      { branch: 'driver_b' as const, driver_id: resolution.drivers[1].driver_id }
    ] as OfficialTimingPlan['drivers'],
    window,
    work,
    integrity_checks: topology.integrity_checks,
    planned_f1ql: planned,
    planned_f1ql_hash: hash(planned)
  };
  const plan: OfficialTimingPlan = deepFreeze({ ...unsigned, answer_plan_hash: hash(unsigned) });
  costOfficialTimingPlan(plan);
  activeOfficialTimingPlans.add(plan);
  return plan;
}

export function verifyOfficialTimingPlan(input: unknown): OfficialTimingPlan {
  if (!input || typeof input !== 'object' || !activeOfficialTimingPlans.has(input)) {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
  return input as OfficialTimingPlan;
}

export function costOfficialTimingPlan(plan: OfficialTimingPlan): OfficialTimingPlanWork {
  let parsed: OfficialTimingPlannedF1ql;
  try {
    parsed = plannedF1qlSchema.parse(plan.planned_f1ql);
  } catch {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
  assertSealedOperators(parsed);
  assertExactWork(plan.work);
  assertPlanConsistentWithProgram(plan, parsed);
  return plan.work;
}

function assertPlanConsistentWithProgram(plan: OfficialTimingPlan, parsed: OfficialTimingPlannedF1ql): void {
  const compare = parsed.root.input.input.input;
  if (compare.metric_id !== plan.metric_id) {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
  const range = compare.left.input.predicates.find(predicate => predicate.concept === 'lap_number');
  if (plan.metric_id === OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID) {
    if (!plan.window || range?.operator !== 'range' ||
        range.min !== plan.window.lap_start || range.max !== plan.window.lap_end) {
      throw new OfficialTimingPlannerError('planned_program_invalid');
    }
  } else if (plan.window !== null || range !== undefined) {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
}

function assertSealedOperators(parsed: OfficialTimingPlannedF1ql): void {
  for (const operator of collectOperators(parsed.root)) {
    if (!['aggregate', 'compare', 'filter', 'limit', 'project', 'sort', 'source'].includes(operator)) {
      throw new OfficialTimingPlannerError('planned_program_invalid');
    }
  }
}

function assertExactWork(work: OfficialTimingPlanWork): void {
  if (work.model !== OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION ||
      work.sources !== 1 || work.source_scans !== 2 || work.joins !== 0 ||
      work.comparisons !== 1 || work.compositions !== 0 || work.requested_rows !== 1 ||
      work.operator_depth !== 7 || work.resolver_reads !== 3 || work.coverage_reads !== 1) {
    throw new OfficialTimingPlannerError('work_mismatch');
  }
}

function verifyResolution(input: {
  readonly question: OfficialTimingQuestionMatch;
  readonly evidence: OfficialTimingSemanticEvidence;
  readonly resolution: OfficialTimingResolution;
}): Extract<OfficialTimingResolution, { type: 'resolved' }> {
  const resolution = verifyOfficialTimingResolution(input.resolution, input.question, input.evidence);
  if (resolution.type !== 'resolved') {
    throw new OfficialTimingPlannerError('coverage_not_eligible');
  }
  return resolution;
}

function requireTopology(metricId: z.infer<typeof metricSchema>) {
  const topology = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies.find(candidate => candidate.metric_id === metricId);
  if (!topology) {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
  return topology;
}

function requireWindow(filters: OfficialTimingSemanticEvidence['candidates'][number]['filters']) {
  const window = filters.find(filter => filter.kind === 'literal_range');
  if (window?.kind !== 'literal_range') {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
  return { lap_start: window.min, lap_end: window.max };
}

interface BranchContext {
  readonly aggregation: z.infer<typeof aggregationSchema>;
  readonly window: { readonly lap_start: number; readonly lap_end: number } | null;
}

function buildPlannedF1ql(
  input: { readonly evidence: OfficialTimingSemanticEvidence },
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>,
  metricId: z.infer<typeof metricSchema>,
  window: { readonly lap_start: number; readonly lap_end: number } | null
): OfficialTimingPlannedF1ql {
  const aggregation = metricId === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? 'arithmetic_mean_integer_milliseconds' as const
    : 'median_integer_milliseconds' as const;
  const output = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas.find(candidate => candidate.metric_id === metricId);
  if (!output) {
    throw new OfficialTimingPlannerError('planned_program_invalid');
  }
  const context: BranchContext = { aggregation, window };
  return plannedF1qlSchema.parse(deepFreeze({
    kind: 'internal_planned_f1ql',
    version: OFFICIAL_TIMING_PLANNED_F1QL_VERSION,
    dialect: OFFICIAL_TIMING_PLANNED_F1QL_DIALECT,
    catalog_hash: input.evidence.catalog_hash,
    root: {
      op: 'limit',
      count: 1,
      input: {
        op: 'sort',
        keys: [{ output_id: 'metric_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          outputs: output.field_ids.map(fieldId => ({ kind: 'computed' as const, as: fieldId })),
          input: {
            op: 'compare',
            metric_id: metricId,
            left: branchAggregate(context, 'driver_a', resolution.drivers[0].driver_id),
            right: branchAggregate(context, 'driver_b', resolution.drivers[1].driver_id),
            relation: 'lower',
            delta: 'absolute',
            winner_on_equal: null,
            decimal_scale: 4
          }
        }
      }
    }
  }));
}

function branchAggregate(context: BranchContext, branch: 'driver_a' | 'driver_b', driverId: string) {
  return {
    op: 'aggregate' as const,
    branch,
    input: {
      op: 'filter' as const,
      input: { op: 'source' as const, source_id: 'official_race_lap_timing' as const, view: 'f1ql.official_race_lap_timing' as const },
      predicates: [
        { concept: 'season', operator: 'eq' as const, value: 2022 },
        { concept: 'round', operator: 'eq' as const, value: 14 },
        { concept: 'session_type', operator: 'eq' as const, value: 'R' },
        { concept: 'driver_id', operator: 'eq' as const, value: driverId },
        ...(context.window === null ? [] : [{
          concept: 'lap_number', operator: 'range' as const,
          min: context.window.lap_start, max: context.window.lap_end
        }])
      ]
    },
    group_by: [] as const,
    measures: [{
      concept: 'lap_time_seconds' as const,
      function: context.aggregation,
      as: `${branch}_metric` as 'driver_a_metric' | 'driver_b_metric',
      exclude_predicates: [
        { concept: 'official_deleted_lap' as const, operator: 'eq' as const, value: false as const },
        { concept: 'official_pit_marker' as const, operator: 'eq' as const, value: false as const }
      ]
    }]
  };
}

function collectOperators(node: unknown): string[] {
  if (!node || typeof node !== 'object') {
    return [];
  }
  const record = node as Record<string, unknown>;
  const own = typeof record.op === 'string' ? [record.op] : [];
  return [
    ...own,
    ...collectOperators(record.input),
    ...collectOperators(record.left),
    ...collectOperators(record.right)
  ];
}

export function hashOfficialTimingPlanValue(value: unknown): string {
  return hash(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing plan value is not canonically serializable');
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
