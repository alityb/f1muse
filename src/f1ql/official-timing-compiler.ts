import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
  OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID
} from './official-timing-question';
import {
  costOfficialTimingPlan,
  OfficialTimingPlan,
  verifyOfficialTimingPlan
} from './official-timing-plan';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_PLANNED_COMPILER_VERSION = 'planned-compiler-v3' as const;
export const OFFICIAL_TIMING_PLANNED_PIPELINE_VERSION = 'planned-pipeline-v2' as const;

const CERTIFIED_SCOPE = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;

export const OFFICIAL_TIMING_EVENT_MEAN_STATEMENT = `WITH driver_a AS (
  SELECT COUNT(*)::integer AS eligible_laps,
         COALESCE(SUM((lap_time_seconds * 1000)::bigint), 0)::text AS total_ms
  FROM f1ql.official_race_lap_timing
  WHERE season = $1
    AND round = $2
    AND session_type = $3
    AND driver_id = $4
    AND NOT official_deleted_lap
    AND NOT official_pit_marker
),
driver_b AS (
  SELECT COUNT(*)::integer AS eligible_laps,
         COALESCE(SUM((lap_time_seconds * 1000)::bigint), 0)::text AS total_ms
  FROM f1ql.official_race_lap_timing
  WHERE season = $1
    AND round = $2
    AND session_type = $3
    AND driver_id = $5
    AND NOT official_deleted_lap
    AND NOT official_pit_marker
)
SELECT driver_a.eligible_laps AS driver_a_eligible_laps,
       driver_a.total_ms AS driver_a_total_ms,
       driver_b.eligible_laps AS driver_b_eligible_laps,
       driver_b.total_ms AS driver_b_total_ms
FROM driver_a
CROSS JOIN driver_b`;

export const OFFICIAL_TIMING_WINDOW_MEDIAN_STATEMENT = `WITH driver_a AS (
  SELECT COUNT(*)::integer AS eligible_laps,
         ARRAY_AGG((lap_time_seconds * 1000)::bigint ORDER BY (lap_time_seconds * 1000)::bigint)::text[] AS ms_values
  FROM f1ql.official_race_lap_timing
  WHERE season = $1
    AND round = $2
    AND session_type = $3
    AND driver_id = $4
    AND lap_number BETWEEN $6 AND $7
    AND NOT official_deleted_lap
    AND NOT official_pit_marker
),
driver_b AS (
  SELECT COUNT(*)::integer AS eligible_laps,
         ARRAY_AGG((lap_time_seconds * 1000)::bigint ORDER BY (lap_time_seconds * 1000)::bigint)::text[] AS ms_values
  FROM f1ql.official_race_lap_timing
  WHERE season = $1
    AND round = $2
    AND session_type = $3
    AND driver_id = $5
    AND lap_number BETWEEN $6 AND $7
    AND NOT official_deleted_lap
    AND NOT official_pit_marker
)
SELECT driver_a.eligible_laps AS driver_a_eligible_laps,
       driver_a.ms_values AS driver_a_ms_values,
       driver_b.eligible_laps AS driver_b_eligible_laps,
       driver_b.ms_values AS driver_b_ms_values
FROM driver_a
CROSS JOIN driver_b`;

const parameterOrderEventMean = ['season', 'round', 'session_type', 'driver_a_id', 'driver_b_id'] as const;
const parameterOrderWindowMedian = ['season', 'round', 'session_type', 'driver_a_id', 'driver_b_id', 'lap_start', 'lap_end'] as const;

const compiledSchema = z.object({
  kind: z.literal('official_timing_compiled_statement'),
  compiler_version: z.literal(OFFICIAL_TIMING_PLANNED_COMPILER_VERSION),
  metric_id: z.enum([OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID, OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID]),
  statement: z.string().min(1),
  statement_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  statement_class: z.literal('one_read_only_parameterized_select'),
  target_relation: z.literal('f1ql.official_race_lap_timing'),
  parameters: z.array(z.union([z.string(), z.number().int()])).min(5).max(7),
  parameter_order: z.array(z.string().min(1)).min(5).max(7),
  maximum_rows: z.literal(1),
  transaction: z.literal('repeatable_read_read_only'),
  statement_timeout_ms_required: z.literal(true),
  metric_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  output_schema_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  planned_f1ql_hash: z.string().regex(/^[a-f0-9]{64}$/),
  answer_plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
  compiled_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type OfficialTimingCompiledStatement = z.infer<typeof compiledSchema>;

export interface OfficialTimingPipelineResult {
  readonly pipeline_version: typeof OFFICIAL_TIMING_PLANNED_PIPELINE_VERSION;
  readonly gates: readonly [
    'parse', 'catalog_bind', 'coverage_witness', 'cost', 'participation',
    'lower', 'core_validate', 'compile', 'hash_bind'
  ];
  readonly compiled: OfficialTimingCompiledStatement;
  readonly planned_core_hash: string;
  readonly pipeline_hash: string;
}

export class OfficialTimingCompilerError extends Error {
  constructor(readonly reason: 'catalog_mismatch' | 'coverage_witness_missing' | 'plan_invalid' | 'participation_invalid') {
    super(reason);
    this.name = 'OfficialTimingCompilerError';
  }
}

const activeCompiledStatements = new WeakSet<object>();
const activePipelines = new WeakSet<object>();

export function runOfficialTimingPlannedPipeline(planInput: unknown): OfficialTimingPipelineResult {
  let plan: OfficialTimingPlan;
  try {
    plan = verifyOfficialTimingPlan(planInput);
  } catch {
    throw new OfficialTimingCompilerError('plan_invalid');
  }
  // Gate 2: catalog bind.
  if (plan.planned_f1ql.catalog_hash !== plan.catalog_hash) {
    throw new OfficialTimingCompilerError('catalog_mismatch');
  }
  // Gate 3: coverage witness presence is structural to the branded plan.
  if (!/^[a-f0-9]{64}$/.test(plan.coverage_witness_hash)) {
    throw new OfficialTimingCompilerError('coverage_witness_missing');
  }
  // Gate 4: cost (re-parses the IR and enforces exact work accounting).
  costOfficialTimingPlan(plan);
  // Gate 5: participation — both drivers must be certified-scope identities.
  const certified = new Set(CERTIFIED_SCOPE.classified_laps_by_driver.map(driver => driver.driver_id));
  if (plan.drivers.some(driver => !certified.has(driver.driver_id))) {
    throw new OfficialTimingCompilerError('participation_invalid');
  }
  // Gate 6-7: lower + core validate — the closed IR is lowered to the exact physical contract.
  const plannedCore = lowerToPhysicalContract(plan);
  // Gate 8: compile.
  const compiled = compileOfficialTimingPlan(plan);
  // Gate 9: hash bind.
  const pipeline: OfficialTimingPipelineResult = deepFreeze({
    pipeline_version: OFFICIAL_TIMING_PLANNED_PIPELINE_VERSION,
    gates: ['parse', 'catalog_bind', 'coverage_witness', 'cost', 'participation', 'lower', 'core_validate', 'compile', 'hash_bind'],
    compiled,
    planned_core_hash: hash(plannedCore),
    pipeline_hash: hash({ plan: plan.answer_plan_hash, compiled: compiled.compiled_sha256, planned_core: hash(plannedCore) })
  });
  activePipelines.add(pipeline);
  return pipeline;
}

export function verifyOfficialTimingPipeline(input: unknown): OfficialTimingPipelineResult {
  if (!input || typeof input !== 'object' || !activePipelines.has(input)) {
    throw new OfficialTimingCompilerError('plan_invalid');
  }
  return input as OfficialTimingPipelineResult;
}

export function verifyOfficialTimingCompiledStatement(input: unknown): OfficialTimingCompiledStatement {
  if (!input || typeof input !== 'object' || !activeCompiledStatements.has(input)) {
    throw new OfficialTimingCompilerError('plan_invalid');
  }
  return input as OfficialTimingCompiledStatement;
}

export function compileOfficialTimingPlan(plan: OfficialTimingPlan): OfficialTimingCompiledStatement {
  const verified = verifyOfficialTimingPlan(plan);
  const isEventMean = verified.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID;
  const statement = isEventMean ? OFFICIAL_TIMING_EVENT_MEAN_STATEMENT : OFFICIAL_TIMING_WINDOW_MEDIAN_STATEMENT;
  const parameters: (string | number)[] = [
    CERTIFIED_SCOPE.season,
    CERTIFIED_SCOPE.round,
    CERTIFIED_SCOPE.session_type,
    verified.drivers[0].driver_id,
    verified.drivers[1].driver_id,
    ...(verified.window === null ? [] : [verified.window.lap_start, verified.window.lap_end])
  ];
  const metricContract = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics
    .find(metric => metric.metric_id === verified.metric_id);
  const outputSchema = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas
    .find(output => output.metric_id === verified.metric_id);
  if (!metricContract || !outputSchema) {
    throw new OfficialTimingCompilerError('plan_invalid');
  }
  const unsigned = {
    kind: 'official_timing_compiled_statement' as const,
    compiler_version: OFFICIAL_TIMING_PLANNED_COMPILER_VERSION,
    metric_id: verified.metric_id,
    statement,
    // Raw-byte statement hash, matching the activation bundle's coverage query convention.
    statement_sha256: createHash('sha256').update(statement, 'utf8').digest('hex'),
    statement_class: 'one_read_only_parameterized_select' as const,
    target_relation: 'f1ql.official_race_lap_timing' as const,
    parameters,
    parameter_order: [...(isEventMean ? parameterOrderEventMean : parameterOrderWindowMedian)],
    maximum_rows: 1 as const,
    transaction: 'repeatable_read_read_only' as const,
    statement_timeout_ms_required: true as const,
    metric_contract_sha256: hash(metricContract),
    output_schema_sha256: hash(outputSchema),
    planned_f1ql_hash: verified.planned_f1ql_hash,
    answer_plan_hash: verified.answer_plan_hash
  };
  const compiled = deepFreeze(compiledSchema.parse({ ...unsigned, compiled_sha256: hash(unsigned) }));
  activeCompiledStatements.add(compiled);
  return compiled;
}

function lowerToPhysicalContract(plan: OfficialTimingPlan) {
  const compare = plan.planned_f1ql.root.input.input.input;
  return {
    dialect: 'planned_core_official_timing_v1',
    target_relation: 'f1ql.official_race_lap_timing',
    metric_id: plan.metric_id,
    branches: [compare.left, compare.right].map(aggregate => ({
      branch: aggregate.branch,
      physical_predicates: aggregate.input.predicates.map(predicate => ({
        physical_field: predicate.concept,
        operator: predicate.operator,
        ...(predicate.operator === 'range'
          ? { min: predicate.min, max: predicate.max }
          : { value: predicate.value })
      })),
      measure: {
        physical_field: aggregate.measures[0].concept,
        function: aggregate.measures[0].function,
        physical_type: 'numeric',
        semantic_type: 'duration_seconds_exact',
        exclude_predicates: aggregate.measures[0].exclude_predicates
      }
    })),
    comparison: {
      relation: compare.relation,
      delta: compare.delta,
      winner_on_equal: compare.winner_on_equal,
      decimal_scale: compare.decimal_scale
    }
  };
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
    throw new Error('FAIL_CLOSED: official timing compiler value is not canonically serializable');
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
