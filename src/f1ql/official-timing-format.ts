import { OfficialTimingPipelineResult } from './official-timing-compiler';
import {
  OfficialTimingExecutionResult,
  verifyOfficialTimingExecutionResult
} from './official-timing-execution';
import { OfficialTimingPlan } from './official-timing-plan';
import { OfficialTimingPlanProof } from './official-timing-proof';
import {
  OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID,
  OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID,
  OfficialTimingQuestionMatch
} from './official-timing-question';
import { OfficialTimingResolution } from './official-timing-resolution';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from './wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_RESULT_FORMAT_VERSION = 'semantic-result-format-v32' as const;
const CERTIFIED_SCOPE = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;

export interface OfficialTimingFormatterContext {
  readonly question: OfficialTimingQuestionMatch;
  readonly resolution: OfficialTimingResolution;
  readonly plan: OfficialTimingPlan;
  readonly pipeline: OfficialTimingPipelineResult;
  readonly proof: OfficialTimingPlanProof;
}

export interface OfficialTimingSemanticEnvelope {
  readonly mode: 'proven_semantic_result';
  readonly format_version: typeof OFFICIAL_TIMING_RESULT_FORMAT_VERSION;
  readonly proof_hash: string;
  readonly planned_f1ql_hash: string;
  readonly core_hash: string;
  readonly answer: { readonly headline: string; readonly facts: readonly { readonly subject: string; readonly values: Record<string, string | null> }[] };
  readonly rows: readonly [Readonly<Record<string, unknown>>];
  readonly metadata: {
    readonly catalog_hash: string;
    readonly columns: readonly { readonly id: string; readonly label: string }[];
    readonly scope: readonly { readonly source_id: string; readonly concept_id: string; readonly value: string | number }[];
    readonly sources: readonly { readonly id: string; readonly authority: string }[];
    readonly aggregations: readonly { readonly output_id: string; readonly function: string; readonly semantics: string }[];
    readonly ordering: readonly { readonly output_id: string; readonly direction: 'asc'; readonly nulls: 'last' }[];
    readonly coverage: { readonly status: 'sufficient'; readonly rows_returned: 1; readonly row_limit: 1 };
    readonly caveats: readonly string[];
  };
}

export class OfficialTimingFormatError extends Error {
  constructor(readonly reason: 'binding_mismatch' | 'coverage_arithmetic_invalid' | 'result_invalid' | 'row_invalid') {
    super(reason);
    this.name = 'OfficialTimingFormatError';
  }
}

export function formatOfficialTimingResult(
  executionInput: unknown,
  context: OfficialTimingFormatterContext
): OfficialTimingSemanticEnvelope {
  let execution: OfficialTimingExecutionResult;
  try {
    execution = verifyOfficialTimingExecutionResult(executionInput);
  } catch {
    throw new OfficialTimingFormatError('result_invalid');
  }
  assertFormatterBindings(execution, context);
  const { resolution, plan, pipeline, proof } = context;
  const row = execution.rows[0];
  const witness = resolution.coverage.driver_coverage;
  assertRowsMatchWitness(row, witness);
  const metrics = computeMetrics(execution.metric_id, row);
  const internalRow = buildInternalRow(plan, resolution, witness, metrics);
  assertCoverageArithmetic(resolution, witness, internalRow);
  const outputSchema = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas
    .find(output => output.metric_id === plan.metric_id);
  if (!outputSchema) {
    throw new OfficialTimingFormatError('binding_mismatch');
  }
  if (outputSchema.internal_only_fields.some(fieldId => outputSchema.field_ids.includes(fieldId))) {
    throw new OfficialTimingFormatError('binding_mismatch');
  }
  const publicRow: Record<string, unknown> = {};
  for (const fieldId of outputSchema.field_ids) {
    if (!Object.prototype.hasOwnProperty.call(internalRow, fieldId)) {
      throw new OfficialTimingFormatError('row_invalid');
    }
    publicRow[fieldId] = internalRow[fieldId];
  }
  assertPlainRow(publicRow, outputSchema.field_ids.length);
  const answer = buildAnswer(context.question, plan.metric_id, internalRow);
  return deepFreeze({
    mode: 'proven_semantic_result',
    format_version: OFFICIAL_TIMING_RESULT_FORMAT_VERSION,
    proof_hash: proof.proof_hash,
    planned_f1ql_hash: plan.planned_f1ql_hash,
    core_hash: pipeline.planned_core_hash,
    answer,
    rows: [publicRow],
    metadata: buildMetadata(plan, outputSchema)
  });
}

function buildMetadata(
  plan: OfficialTimingPlan,
  outputSchema: (typeof WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas)[number]
): OfficialTimingSemanticEnvelope['metadata'] {
  return {
    catalog_hash: plan.catalog_hash,
    columns: outputSchema.field_ids
      .map(fieldId => ({ id: fieldId, label: fieldId.replaceAll('_', ' ') })),
    scope: [
      { source_id: 'official_race_lap_timing', concept_id: 'season', value: CERTIFIED_SCOPE.season },
      { source_id: 'official_race_lap_timing', concept_id: 'round', value: CERTIFIED_SCOPE.round },
      { source_id: 'official_race_lap_timing', concept_id: 'session_type', value: CERTIFIED_SCOPE.session_type }
    ],
    sources: [{ id: 'official_race_lap_timing', authority: 'FIA official race timing documents' }],
    aggregations: [{
      output_id: plan.metric_id,
      function: plan.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
        ? 'arithmetic_mean_integer_milliseconds'
        : 'median_integer_milliseconds',
      semantics: 'official non-deleted non-pit race laps only'
    }],
    ordering: [{ output_id: 'metric_id', direction: 'asc', nulls: 'last' }],
    coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
    caveats: [...outputSchema.required_caveats]
  };
}

function assertFormatterBindings(
  execution: OfficialTimingExecutionResult,
  context: OfficialTimingFormatterContext
): asserts context is OfficialTimingFormatterContext & {
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>;
} {
  const { question, resolution, plan, pipeline, proof } = context;
  if (resolution.type !== 'resolved' ||
      question.question_sha256 !== plan.question_sha256 ||
      execution.compiled_hash !== pipeline.compiled.compiled_sha256 ||
      execution.planned_f1ql_hash !== plan.planned_f1ql_hash ||
      execution.planned_core_hash !== pipeline.planned_core_hash ||
      execution.semantic_plan_proof_hash !== proof.proof_hash ||
      execution.metric_id !== plan.metric_id) {
    throw new OfficialTimingFormatError('binding_mismatch');
  }
}

interface ComputedMetrics {
  readonly driver_a_metric: string;
  readonly driver_b_metric: string;
  readonly delta: string;
  readonly winner: 'driver_a' | 'driver_b' | null;
}

function assertRowsMatchWitness(
  row: Readonly<Record<string, unknown>>,
  witness: Extract<OfficialTimingResolution, { type: 'resolved' }>['coverage']['driver_coverage']
): void {
  if (row.driver_a_eligible_laps !== witness[0].eligible_laps ||
      row.driver_b_eligible_laps !== witness[1].eligible_laps) {
    throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
  }
}

function computeMetrics(
  metricId: OfficialTimingPlan['metric_id'],
  row: Readonly<Record<string, unknown>>
): ComputedMetrics {
  if (metricId === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID) {
    return computeMeanComparison(
      BigInt(row.driver_a_total_ms as string), BigInt(row.driver_a_eligible_laps as number),
      BigInt(row.driver_b_total_ms as string), BigInt(row.driver_b_eligible_laps as number)
    );
  }
  if (metricId === OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID) {
    const valuesA = row.driver_a_ms_values;
    const valuesB = row.driver_b_ms_values;
    if (!Array.isArray(valuesA) || !Array.isArray(valuesB)) {
      throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
    }
    return computeMedianComparison(valuesA.map(BigInt), valuesB.map(BigInt));
  }
  throw new OfficialTimingFormatError('result_invalid');
}

function computeMeanComparison(totalA: bigint, nA: bigint, totalB: bigint, nB: bigint): ComputedMetrics {
  if (nA < 2n || nB < 2n) {
    throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
  }
  // scale-4 seconds = total_ms * 10 / n, rounded half away from zero (all values positive)
  const scaledA = roundDiv(totalA * 10n, nA);
  const scaledB = roundDiv(totalB * 10n, nB);
  // exact winner comparison on unrounded rationals
  const crossA = totalA * nB;
  const crossB = totalB * nA;
  const winner = winnerBranch(crossA - crossB);
  const deltaScaled = roundDiv(abs(crossA - crossB) * 10n, nA * nB);
  return {
    driver_a_metric: scale4(scaledA),
    driver_b_metric: scale4(scaledB),
    delta: scale4(deltaScaled),
    winner
  };
}

function computeMedianComparison(valuesA: bigint[], valuesB: bigint[]): ComputedMetrics {
  if (valuesA.length < 2 || valuesB.length < 2) {
    throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
  }
  // scale-4 seconds = median_ms * 10 exactly (medians of integer ms are integer or x.5)
  const scaledA = medianScaled(valuesA);
  const scaledB = medianScaled(valuesB);
  const winner = winnerBranch(scaledA - scaledB);
  return {
    driver_a_metric: scale4(scaledA),
    driver_b_metric: scale4(scaledB),
    delta: scale4(abs(scaledA - scaledB)),
    winner
  };
}

function medianScaled(sorted: bigint[]): bigint {
  const n = sorted.length;
  const middle = Math.floor(n / 2);
  // median_ms = sorted[middle] (odd) or (sorted[middle-1]+sorted[middle])/2 (even); scaled by 10
  return n % 2 === 1 ? sorted[middle] * 10n : (sorted[middle - 1] + sorted[middle]) * 5n;
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator * 2n >= denominator ? quotient + 1n : quotient;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function winnerBranch(comparison: bigint): 'driver_a' | 'driver_b' | null {
  if (comparison === 0n) {
    return null;
  }
  return comparison < 0n ? 'driver_a' : 'driver_b';
}

function winnerDriverId(
  winner: 'driver_a' | 'driver_b' | null,
  drivers: Extract<OfficialTimingResolution, { type: 'resolved' }>['drivers']
): string | null {
  if (winner === null) {
    return null;
  }
  return winner === 'driver_a' ? drivers[0].driver_id : drivers[1].driver_id;
}

function scale4(scaled: bigint): string {
  const whole = scaled / 10000n;
  const fraction = (scaled % 10000n).toString().padStart(4, '0');
  return `${whole}.${fraction}`;
}

function buildInternalRow(
  plan: OfficialTimingPlan,
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>,
  witness: Extract<OfficialTimingResolution, { type: 'resolved' }>['coverage']['driver_coverage'],
  metrics: ComputedMetrics
): Record<string, unknown> {
  const [witnessA, witnessB] = witness;
  const row: Record<string, unknown> = {
    driver_a_id: resolution.drivers[0].driver_id,
    driver_b_id: resolution.drivers[1].driver_id,
    metric_id: plan.metric_id,
    season: CERTIFIED_SCOPE.season,
    round: CERTIFIED_SCOPE.round,
    session_type: CERTIFIED_SCOPE.session_type,
    event_name: CERTIFIED_SCOPE.event_name,
    dataset_sha256: CERTIFIED_SCOPE.dataset_sha256,
    source_manifest_sha256: CERTIFIED_SCOPE.source_manifest_sha256,
    identity_map_sha256: CERTIFIED_SCOPE.identity_map_sha256,
    fact_fingerprint: CERTIFIED_SCOPE.fact_fingerprint,
    winner_driver_id: winnerDriverId(metrics.winner, resolution.drivers),
    f1ql_integrity_ok: true
  };
  if (plan.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID) {
    row.driver_a_completed_laps = witnessA.completed_laps;
    row.driver_b_completed_laps = witnessB.completed_laps;
    row.driver_a_mean_lap_time_seconds = metrics.driver_a_metric;
    row.driver_b_mean_lap_time_seconds = metrics.driver_b_metric;
    row.mean_delta_seconds = metrics.delta;
  } else {
    row.lap_start = plan.window?.lap_start;
    row.lap_end = plan.window?.lap_end;
    row.requested_laps_per_driver = plan.window === null ? null : plan.window.lap_end - plan.window.lap_start + 1;
    row.driver_a_median_lap_time_seconds = metrics.driver_a_metric;
    row.driver_b_median_lap_time_seconds = metrics.driver_b_metric;
    row.median_delta_seconds = metrics.delta;
  }
  row.driver_a_eligible_laps = witnessA.eligible_laps;
  row.driver_b_eligible_laps = witnessB.eligible_laps;
  row.driver_a_excluded_deleted_laps = witnessA.excluded_deleted_laps;
  row.driver_b_excluded_deleted_laps = witnessB.excluded_deleted_laps;
  row.driver_a_excluded_pit_marker_laps = witnessA.excluded_pit_marker_laps;
  row.driver_b_excluded_pit_marker_laps = witnessB.excluded_pit_marker_laps;
  return row;
}

function assertCoverageArithmetic(
  resolution: Extract<OfficialTimingResolution, { type: 'resolved' }>,
  witness: Extract<OfficialTimingResolution, { type: 'resolved' }>['coverage']['driver_coverage'],
  row: Record<string, unknown>
): void {
  const expectedClassified = new Map(
    CERTIFIED_SCOPE.classified_laps_by_driver.map(driver => [driver.driver_id, driver.classified_laps] as const)
  );
  witness.forEach((driverWitness, index) => {
    const driverId = resolution.drivers[index].driver_id;
    if (driverWitness.driver_id !== driverId ||
        driverWitness.completed_laps !== driverWitness.eligible_laps + driverWitness.excluded_deleted_laps + driverWitness.excluded_pit_marker_laps ||
        driverWitness.eligible_laps < 2) {
      throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
    }
    if (resolution.coverage.metric === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID &&
        driverWitness.completed_laps !== expectedClassified.get(driverId)) {
      throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
    }
  });
  if (resolution.coverage.metric === OFFICIAL_TIMING_WINDOW_MEDIAN_METRIC_ID) {
    const requested = row.requested_laps_per_driver;
    if (typeof requested !== 'number' || requested < 1 || requested > 50 ||
        witness.some(driverWitness => driverWitness.completed_laps !== requested)) {
      throw new OfficialTimingFormatError('coverage_arithmetic_invalid');
    }
  }
}

function assertPlainRow(row: Record<string, unknown>, expectedFields: number): void {
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).length !== expectedFields ||
      Object.getOwnPropertySymbols(row).length > 0) {
    throw new OfficialTimingFormatError('row_invalid');
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(row))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new OfficialTimingFormatError('row_invalid');
    }
  }
}

function buildAnswer(
  question: OfficialTimingQuestionMatch,
  metricId: OfficialTimingPlan['metric_id'],
  row: Record<string, unknown>
) {
  const metricLabel = metricId === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID ? 'mean' : 'median';
  const delta = row[`${metricLabel}_delta_seconds`];
  if (typeof delta !== 'string') {
    throw new OfficialTimingFormatError('row_invalid');
  }
  const winnerText = row.winner_driver_id === null
    ? 'Neither driver was faster'
    : `${row.winner_driver_id === row.driver_a_id ? question.driver_a.text : question.driver_b.text} was faster`;
  const scope = metricId === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? `at the ${CERTIFIED_SCOPE.event_name}`
    : `over laps ${row.lap_start} to ${row.lap_end} at the ${CERTIFIED_SCOPE.event_name}`;
  return {
    headline: `${winnerText} on official ${metricLabel} race lap time ${scope} by ${delta}s`,
    facts: [
      { subject: question.driver_a.text, values: { [`${metricLabel}_lap_time_seconds`]: row[`driver_a_${metricLabel}_lap_time_seconds`] as string } },
      { subject: question.driver_b.text, values: { [`${metricLabel}_lap_time_seconds`]: row[`driver_b_${metricLabel}_lap_time_seconds`] as string } }
    ]
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
