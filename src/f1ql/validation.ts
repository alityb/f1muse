import { Pool, PoolClient } from 'pg';
import { F1QLProgram } from './ast';
import { CORE_COMPARISON_SUMMARY_SIGNATURES, CoreAggregateNode, CoreComparisonSummaryNode, CoreComposeNode, CoreDeltaNode, CoreEventClassificationFilter, CoreFilterNode, CoreOfficialEventMeanFilter, CoreOfficialLapTimingFilter, CorePipelineNode, CoreProgram, CoreSourceNode } from './core';
import { MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS, OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { MAX_OFFICIAL_LAP_WINDOW_LAPS, MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS, OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';
import { DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID, DRIVER_CAREER_WIN_SEASONS } from './driver-career-wins-by-circuit';
import { OFFICIAL_DRIVER_RESULTS_COMPARISON_INPUT_ALIASES, OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID, OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MAX, OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MIN, OFFICIAL_DRIVER_RESULTS_COMPARISON_SELECT } from './official-driver-results-comparison';
import { RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID } from './race-season-finishing-position-h2h';
import { QUALIFYING_SEASON_POSITION_H2H_METRIC_ID } from './qualifying-season-position-h2h';
import { RACE_EVENT_FINISHING_POSITION_COMPARISON_METRIC_ID } from './race-event-finishing-position-comparison';
import {
  COMPLETED_QUALIFYING_SEASONS,
  DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID,
  DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID,
  DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID,
  QUALIFYING_POSITION_MAX,
  QUALIFYING_POSITION_MIN,
  QUALIFYING_TOP_TEN_MAX,
  SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID
} from './qualifying-counts';

export const F1QL_DEFINITIONS_VERSION = 'v10';
export const F1QL_SIGNATURES = {
  standings: { fields: ['season', 'driver_id', 'points', 'championship_position'], operators: ['source', 'filter', 'aggregate', 'sort', 'limit', 'rank', 'compose', 'official_driver_results_comparison'] },
  lap_pace: { fields: ['season', 'round', 'driver_id', 'lap_time_seconds', 'is_valid_lap', 'is_pit_lap', 'is_in_lap', 'is_out_lap', 'compound', 'clean_air_flag'], operators: ['source', 'filter', 'aggregate', 'join', 'compare', 'delta', 'pace_summary', 'pace_delta'] },
  event_classification: { fields: ['season', 'round', 'driver_id', 'team_id', 'classification_status', 'finishing_position'], operators: ['source', 'filter', 'sort', 'limit', 'join', 'aggregate', 'compare', 'comparison_summary', 'compose', 'event_classification', 'race_season_finishing_position_h2h', 'race_event_finishing_position_comparison', 'official_driver_results_comparison', 'driver_career_wins_by_circuit'] },
  qualifying_classification: { fields: ['season', 'round', 'driver_id', 'team_id', 'classification_status', 'qualifying_position'], operators: ['source', 'filter', 'sort', 'limit', 'join', 'aggregate', 'compare', 'comparison_summary', 'compose', 'qualifying_classification', 'qualifying_season_position_h2h', 'official_driver_results_comparison', 'driver_season_qualifying_p1_count', 'driver_career_qualifying_p1_count', 'driver_season_qualifying_top_ten_count', 'season_qualifying_top_ten_ranking'] },
  event_metadata: { fields: ['season', 'round', 'event_id', 'event_name', 'circuit_id', 'date', 'session_scope'], operators: ['source', 'filter', 'join', 'aggregate', 'event_metadata', 'driver_career_wins_by_circuit'] },
  official_lap_timing: {
    fields: ['season', 'round', 'session_type', 'driver_id', 'lap_start', 'lap_end', 'complete_requested_window', 'complete_event', 'official_deleted_lap', 'official_pit_marker', 'lap_time_seconds'],
    operators: ['source', 'filter', 'aggregate', 'join', 'compare', 'delta', 'official_lap_window_median_compare', 'official_event_mean_compare']
  }
} as const;

export type F1QLValidationCode = 'definitions_version_mismatch' | 'complexity_exceeded' | 'coverage_unsupported' | 'participation_missing' | 'signature_invalid';

export class F1QLValidationError extends Error {
  constructor(public readonly code: F1QLValidationCode, message: string) {
    super(message);
  }
}

export interface F1QLValidationOptions {
  definitionsVersion?: string;
  maxNodes?: number;
}

export function refreshF1QLDefinitionsVersion(): string {
  return process.env.F1QL_DEFINITIONS_VERSION ?? F1QL_DEFINITIONS_VERSION;
}

export async function validateParticipation(pool: Pool, program: F1QLProgram): Promise<void> {
  return validateParticipationFrom(pool, program, 'public');
}

export async function validateAnswerParticipation(queryable: Pick<PoolClient, 'query'>, program: F1QLProgram): Promise<void> {
  return validateParticipationFrom(queryable, program, 'answer');
}

async function validateParticipationFrom(queryable: Pick<Pool, 'query'>, program: F1QLProgram, mode: 'public' | 'answer'): Promise<void> {
  const { season, drivers } = getParticipationScope(program);
  if (season === undefined || drivers.length === 0) {
    return;
  }
  const result = mode === 'answer'
    ? await queryable.query(
      `SELECT DISTINCT REPLACE(driver_id, '_', '-') AS driver_id FROM f1ql.answer_season_participation WHERE season = $1 AND REPLACE(driver_id, '_', '-') = ANY($2::text[])`,
      [season, drivers]
    )
    : await queryable.query(
      `SELECT DISTINCT REPLACE(driver_id, '_', '-') AS driver_id FROM season_entrant_driver WHERE year = $1 AND REPLACE(driver_id, '_', '-') = ANY($2::text[]) AND COALESCE(test_driver, false) = false`,
      [season, drivers]
    );
  if (result.rows.length !== drivers.length) {
    throw new F1QLValidationError('participation_missing', 'Driver did not participate in the requested season');
  }
}

// eslint-disable-next-line complexity
function getParticipationScope(program: F1QLProgram): { season?: number; drivers: string[] } {
  const root = program.root;
  if (root.op === 'pace_delta') {
    return { season: root.scope.season, drivers: [root.driver_a_id, root.driver_b_id] };
  }
  if (root.op === 'official_lap_window_median_compare' || root.op === 'official_event_mean_compare' || root.op === 'race_season_finishing_position_h2h' || root.op === 'race_event_finishing_position_comparison' || root.op === 'qualifying_season_position_h2h' || root.op === 'official_driver_results_comparison') {
    return { season: root.season, drivers: [root.driver_a_id, root.driver_b_id] };
  }
  if (root.op === 'pace_summary') {
    return { season: root.scope.season, drivers: [root.driver_id] };
  }
  if (root.op === 'event_classification' || root.op === 'qualifying_classification') {
    return { season: root.season, drivers: root.filters?.driver_id ? [root.filters.driver_id] : [] };
  }
  if (root.op === 'event_metadata') {
    return { drivers: [] };
  }
  if (root.op === 'driver_career_wins_by_circuit') {
    return { drivers: [] };
  }
  if (root.op === 'driver_career_qualifying_p1_count') {
    return { drivers: [] };
  }
  if (root.op === 'driver_season_qualifying_p1_count' || root.op === 'driver_season_qualifying_top_ten_count') {
    return { season: root.season, drivers: [root.driver_id] };
  }
  if (root.op === 'season_qualifying_top_ten_ranking') {
    return { drivers: [] };
  }
  const aggregate = root.op === 'rank' ? root.input : root;
  if (aggregate.input.op !== 'filter' || typeof aggregate.input.where.season !== 'number' || !aggregate.input.where.driver_id) {
    return { drivers: [] };
  }
  const drivers = Array.isArray(aggregate.input.where.driver_id)
    ? aggregate.input.where.driver_id
    : [aggregate.input.where.driver_id];
  return { season: aggregate.input.where.season, drivers };
}

export function validateF1QLProgram(program: F1QLProgram, options: F1QLValidationOptions = {}): void {
  const definitionsVersion = options.definitionsVersion ?? refreshF1QLDefinitionsVersion();
  if (definitionsVersion !== F1QL_DEFINITIONS_VERSION) {
    throw new F1QLValidationError('definitions_version_mismatch', 'Definitions version is not active');
  }
  const maxNodes = options.maxNodes ?? 12;
  if (countNodes(program.root) > maxNodes) {
    throw new F1QLValidationError('complexity_exceeded', `Program exceeds the ${maxNodes}-node complexity budget`);
  }
  validateSignature(program);
  if ((program.root.op === 'event_classification' || program.root.op === 'qualifying_classification' || program.root.op === 'event_metadata' || program.root.op === 'official_lap_window_median_compare' || program.root.op === 'official_event_mean_compare' || program.root.op === 'race_event_finishing_position_comparison') && program.root.round > 30) {
    throw new F1QLValidationError('coverage_unsupported', 'Round is outside supported event coverage');
  }
}

// Lowering is an internal boundary too: only the signature-approved generic IR reaches compilation.
export function validateCoreProgram(program: CoreProgram): void {
  if (program.version !== 1) {
    throw new F1QLValidationError('signature_invalid', 'Core program version is not supported');
  }
  if (program.root.op === 'delta') {
    validateDelta(program.root);
    return;
  }
  if (program.root.op === 'comparison_summary') {
    validateComparisonSummary(program.root);
    return;
  }
  if (program.root.op === 'compose') {
    validateCompose(program.root);
    return;
  }
  if (program.root.op === 'aggregate' && program.root.input.op === 'join') {
    validateDriverCareerWinsAggregate(program.root);
    return;
  }
  if (isQualifyingCountCoreRoot(program.root)) {
    if (program.root.op === 'sort' && (program.root.by !== 'qualifying_top_ten_count' || program.root.direction !== 'desc' || program.root.nulls !== undefined)) {
      throw new F1QLValidationError('signature_invalid', 'Qualifying top-ten ranking requires deterministic descending count order');
    }
    validateQualifyingCountAggregate(program.root.op === 'sort' ? program.root.input : program.root, program.root.op === 'sort');
    return;
  }
  const source = validatePipeline(program.root);
  if ((source === 'event_classification' || source === 'qualifying_classification') && program.root.op !== 'limit') {
    throw new F1QLValidationError('signature_invalid', 'Classification requires a limit');
  }
}

function isQualifyingCountCoreRoot(root: CoreProgram['root']): root is CoreAggregateNode | (Extract<CoreProgram['root'], { op: 'sort' }> & { input: CoreAggregateNode }) {
  return (root.op === 'aggregate' && root.source_record_integrity !== undefined) ||
    (root.op === 'sort' && root.input.op === 'aggregate' && root.input.source_record_integrity !== undefined);
}

// eslint-disable-next-line complexity
function validateQualifyingCountAggregate(node: CoreAggregateNode, ranked: boolean): void {
  const input = node.input;
  const where = input.op === 'filter' ? input.where as Record<string, unknown> : undefined;
  const measure = node.measures[0];
  const metric = node.metric_id;
  const expectedIntegrity = {
    key: ['season', 'round', 'driver_id'], position_field: 'qualifying_position',
    position_min: QUALIFYING_POSITION_MIN, position_max: QUALIFYING_POSITION_MAX,
    require_source_presence: true, require_non_null_keys: true, require_unique_keys: true, require_unique_positions: true
  };
  const isP1 = metric === DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID || metric === DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID;
  const isTopTen = metric === DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID || metric === SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID;
  if (input.op !== 'filter' || input.input.op !== 'source' || input.input.source !== 'qualifying_classification' || !where ||
      node.measures.length !== 1 || (!isP1 && !isTopTen) ||
      JSON.stringify(measure) !== JSON.stringify({
        as: isP1 ? 'qualifying_p1_count' : 'qualifying_top_ten_count', function: 'count',
        where: { field: 'qualifying_position', min: QUALIFYING_POSITION_MIN, max: isP1 ? QUALIFYING_POSITION_MIN : QUALIFYING_TOP_TEN_MAX }
      }) || JSON.stringify(node.source_record_integrity) !== JSON.stringify(expectedIntegrity) || node.source_integrity !== undefined ||
      JSON.stringify(node.group_by) !== JSON.stringify(ranked ? ['driver_id'] : [])) {
    throw new F1QLValidationError('signature_invalid', 'Qualifying count requires the exact filtered aggregate and source-record integrity contract');
  }
  const keys = Object.keys(where).sort();
  const season = where.season;
  const driverId = where.driver_id;
  const career = metric === DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID;
  if (ranked !== (metric === SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID) ||
      JSON.stringify(keys) !== JSON.stringify(ranked ? ['season'] : ['driver_id', 'season']) ||
      (career ? JSON.stringify(season) !== JSON.stringify(COMPLETED_QUALIFYING_SEASONS) :
        typeof season !== 'number' || !Number.isInteger(season) || season < 1950 || season > 2025) ||
      (!ranked && (!isNonemptyString(driverId) || !/^[a-z][a-z0-9-]{0,99}$/.test(driverId)))) {
    throw new F1QLValidationError('signature_invalid', 'Qualifying count requires its exact completed-season and canonical-driver scope');
  }
  assertSignature('qualifying_classification', 'source', []);
  assertSignature('qualifying_classification', 'filter', keys);
  assertSignature('qualifying_classification', 'aggregate', ['season', 'round', 'driver_id', 'qualifying_position']);
  if (ranked) {
    assertSignature('qualifying_classification', 'sort', []);
  }
}

function validateCompose(node: CoreComposeNode): void {
  if (!isBoundedIdentifier(node.metric_id) || node.require_exactly_one_row_per_input !== true || node.inputs.length < 2 || node.inputs.length > 8 || node.select.length < 1 || node.select.length > 100) {
    throw new F1QLValidationError('signature_invalid', 'Compose requires a bounded metric and bounded exact-one-row inputs and selections');
  }
  const outputs = new Map<string, Set<string>>();
  for (const item of node.inputs) {
    if (!isBoundedIdentifier(item.as) || outputs.has(item.as)) {
      throw new F1QLValidationError('signature_invalid', 'Compose input aliases must be unique bounded identifiers');
    }
    if (item.input.op === 'comparison_summary') {
      validateComparisonSummary(item.input);
      outputs.set(item.as, new Set(['metric_id', 'season', 'driver_a_id', 'driver_b_id', 'driver_a_ahead', 'driver_b_ahead', 'ties', 'shared_events', 'driver_a_source_rows', 'driver_b_source_rows', 'distinct_source_keys', 'duplicate_source_rows', 'source_presence_ok', 'source_unique_keys_ok', 'source_integrity_ok']));
      if (item.require !== undefined) {
        throw new F1QLValidationError('signature_invalid', 'Comparison summary inputs cannot add scalar count requirements');
      }
    } else {
      const source = validatePipeline(item.input);
      const aggregateInput = item.input.input;
      const where = aggregateInput.op === 'filter' ? aggregateInput.where as Record<string, unknown> : undefined;
      if (source !== 'standings' || aggregateInput.op !== 'filter' || typeof where?.season !== 'number' || typeof where.driver_id !== 'string' ||
          JSON.stringify(Object.keys(where).sort()) !== JSON.stringify(['driver_id', 'season']) ||
          JSON.stringify(item.input.group_by) !== JSON.stringify(['driver_id']) || JSON.stringify(item.input.measures) !== JSON.stringify([
            { as: 'championship_position', function: 'min', field: 'championship_position' },
            { as: 'points', function: 'max', field: 'points' },
            { as: 'standing_rows', function: 'count' }
          ]) || JSON.stringify(item.require) !== JSON.stringify({ field: 'standing_rows', equals: 1, non_null_fields: ['championship_position', 'points'] })) {
        throw new F1QLValidationError('signature_invalid', 'Compose aggregate inputs must be scalar-driver standings aggregates');
      }
      outputs.set(item.as, new Set(['driver_id', ...item.input.measures.map(measure => measure.as)]));
    }
  }
  const selected = new Set<string>();
  for (const selection of node.select) {
    if (!isBoundedIdentifier(selection.input) || !isBoundedIdentifier(selection.field) || !isBoundedIdentifier(selection.as) || selected.has(selection.as) || !outputs.get(selection.input)?.has(selection.field)) {
      throw new F1QLValidationError('signature_invalid', 'Compose selections must reference declared fields and unique bounded aliases');
    }
    selected.add(selection.as);
  }
  if (node.metric_id !== OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID) {
    throw new F1QLValidationError('signature_invalid', 'Unsupported composition metric');
  }
  validateOfficialDriverResultsComposition(node);
}

function validateOfficialDriverResultsComposition(node: CoreComposeNode): void {
  if (JSON.stringify(node.inputs.map(input => input.as)) !== JSON.stringify(OFFICIAL_DRIVER_RESULTS_COMPARISON_INPUT_ALIASES) ||
      JSON.stringify(node.select) !== JSON.stringify(OFFICIAL_DRIVER_RESULTS_COMPARISON_SELECT)) {
    throw new F1QLValidationError('signature_invalid', 'Official driver results composition requires the exact inputs and projection contract');
  }
  const [standingA, standingB, race, qualifying] = node.inputs;
  if (standingA.input.op !== 'aggregate' || standingB.input.op !== 'aggregate' || race.input.op !== 'comparison_summary' || qualifying.input.op !== 'comparison_summary') {
    throw new F1QLValidationError('signature_invalid', 'Official driver results composition input types changed');
  }
  const standingAWhere = (standingA.input.input as CoreFilterNode).where as Record<string, unknown>;
  const standingBWhere = (standingB.input.input as CoreFilterNode).where as Record<string, unknown>;
  const raceLeft = classificationComparisonBranch(race.input.input.input.left);
  const raceRight = classificationComparisonBranch(race.input.input.input.right);
  const qualifyingLeft = classificationComparisonBranch(qualifying.input.input.input.left);
  const qualifyingRight = classificationComparisonBranch(qualifying.input.input.input.right);
  const raceSeason = raceLeft.where.season;
  if (typeof raceSeason !== 'number' || raceSeason < OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MIN || raceSeason > OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MAX ||
      race.input.metric_id !== RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID || qualifying.input.metric_id !== QUALIFYING_SEASON_POSITION_H2H_METRIC_ID ||
      race.input.lower_is_better !== true || qualifying.input.lower_is_better !== true ||
      race.input.require_unique_source_keys !== true || qualifying.input.require_unique_source_keys !== true ||
      race.input.require_source_presence !== true || qualifying.input.require_source_presence !== true ||
      raceLeft.source !== 'event_classification' || raceRight.source !== 'event_classification' ||
      qualifyingLeft.source !== 'qualifying_classification' || qualifyingRight.source !== 'qualifying_classification' ||
      standingAWhere.season !== raceLeft.where.season || standingBWhere.season !== raceLeft.where.season ||
      raceRight.where.season !== raceLeft.where.season || qualifyingLeft.where.season !== raceLeft.where.season || qualifyingRight.where.season !== raceLeft.where.season ||
      standingAWhere.driver_id !== raceLeft.where.driver_id || standingBWhere.driver_id !== raceRight.where.driver_id ||
      qualifyingLeft.where.driver_id !== raceLeft.where.driver_id || qualifyingRight.where.driver_id !== raceRight.where.driver_id ||
      raceLeft.where.round !== undefined || raceRight.where.round !== undefined || qualifyingLeft.where.round !== undefined || qualifyingRight.where.round !== undefined) {
    throw new F1QLValidationError('signature_invalid', 'Official driver results composition branches must share one season and ordered drivers');
  }
}

// eslint-disable-next-line complexity
function validateDriverCareerWinsAggregate(node: CoreAggregateNode): void {
  if (node.input.op !== 'join') {
    throw new F1QLValidationError('signature_invalid', 'Career wins requires a joined aggregate');
  }
  const { left, right } = node.input;
  if (node.input.type !== 'left' || JSON.stringify(node.input.on) !== JSON.stringify(['season', 'round']) ||
      left.op !== 'filter' || left.input.op !== 'filter' || left.input.input.op !== 'source' || left.input.input.source !== 'event_classification' ||
      right.op !== 'filter' || right.input.op !== 'source' || right.input.source !== 'event_metadata' ||
      JSON.stringify(node.group_by) !== JSON.stringify(['circuit_id']) ||
      JSON.stringify(node.measures) !== JSON.stringify([{ as: 'wins', function: 'count' }]) ||
      JSON.stringify(node.source_integrity) !== JSON.stringify({
        left_key: ['season', 'round'], left_key_scope: 'before_outer_filter', right_key: ['season', 'round'], require_unique_left_keys: true,
        require_exactly_one_right_match: true, require_non_null_right_fields: ['circuit_id']
      })) {
    throw new F1QLValidationError('signature_invalid', 'Career wins requires the exact left join, grouping, measure, and source-integrity contract');
  }
  const leftWhere = left.where as CoreEventClassificationFilter;
  const winnerWhere = left.input.where as CoreEventClassificationFilter;
  const rightWhere = right.where as Record<string, unknown>;
  if (JSON.stringify(Object.keys(leftWhere).sort()) !== JSON.stringify(['driver_id']) ||
      JSON.stringify(Object.keys(winnerWhere).sort()) !== JSON.stringify(['finishing_position', 'season']) ||
      JSON.stringify(Object.keys(rightWhere).sort()) !== JSON.stringify(['season']) ||
      JSON.stringify(winnerWhere.season) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS) ||
      JSON.stringify(rightWhere.season) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS) ||
      JSON.stringify(winnerWhere.finishing_position) !== JSON.stringify([1]) ||
      !isNonemptyString(leftWhere.driver_id) || !/^[a-z][a-z0-9-]{0,99}$/.test(leftWhere.driver_id)) {
    throw new F1QLValidationError('signature_invalid', 'Career wins requires the exact 1950-2025 scope, canonical driver, and race P1 filter');
  }
  assertSignature('event_classification', 'source', []);
  assertSignature('event_classification', 'filter', ['season', 'finishing_position']);
  assertSignature('event_classification', 'filter', ['driver_id']);
  assertSignature('event_metadata', 'source', []);
  assertSignature('event_metadata', 'filter', ['season']);
  assertSignature('event_classification', 'join', ['season', 'round']);
  assertSignature('event_metadata', 'join', ['season', 'round']);
  assertSignature('event_classification', 'aggregate', ['driver_id', 'finishing_position']);
  assertSignature('event_metadata', 'aggregate', ['circuit_id']);
}

// eslint-disable-next-line complexity
function validateComparisonSummary(node: CoreComparisonSummaryNode): void {
  const compare = node.input as unknown as Record<string, unknown>;
  const join = compare.input as Record<string, unknown> | undefined;
  const leftComparison = compare.left as Record<string, unknown> | undefined;
  const rightComparison = compare.right as Record<string, unknown> | undefined;
  if (!isBoundedIdentifier(node.metric_id) || typeof node.lower_is_better !== 'boolean' ||
      node.require_unique_source_keys !== true || node.require_source_presence !== true || compare.op !== 'compare' ||
      join?.op !== 'join' || join.type !== 'inner' || JSON.stringify(join.on) !== JSON.stringify(['season', 'round']) ||
      !isBoundedIdentifier(leftComparison?.field) || !isBoundedIdentifier(leftComparison?.as) ||
      !isBoundedIdentifier(rightComparison?.field) || !isBoundedIdentifier(rightComparison?.as) ||
      leftComparison.as === rightComparison.as) {
    throw new F1QLValidationError('signature_invalid', 'Comparison summary requires bounded identifiers, an inner event join, and fail-closed source integrity');
  }
  const left = classificationComparisonBranch(join.left);
  const right = classificationComparisonBranch(join.right);
  const eventScoped = left.where.round !== undefined || right.where.round !== undefined;
  if (left.source !== right.source || typeof left.where.season !== 'number' || !Number.isInteger(left.where.season) || left.where.season < 1950 || left.where.season > 2100 || left.where.season !== right.where.season ||
      left.where.round !== right.where.round || (left.where.round !== undefined && (!Number.isInteger(left.where.round) || left.where.round < 1 || left.where.round > 30)) ||
      (eventScoped && (node.metric_id !== RACE_EVENT_FINISHING_POSITION_COMPARISON_METRIC_ID || node.require_exactly_one_shared_event !== true)) ||
      (!eventScoped && node.require_exactly_one_shared_event !== undefined) ||
      !isNonemptyString(left.where.driver_id) || !isNonemptyString(right.where.driver_id) || left.where.driver_id === right.where.driver_id) {
    throw new F1QLValidationError('signature_invalid', 'Comparison summary requires one season, one shared source, and two distinct nonempty ordered driver IDs');
  }
  const signature = CORE_COMPARISON_SUMMARY_SIGNATURES[left.source];
  if (eventScoped && (left.source !== 'event_classification' || node.lower_is_better !== true ||
      leftComparison.field !== 'finishing_position' || rightComparison.field !== 'finishing_position')) {
    throw new F1QLValidationError('signature_invalid', 'Race event comparison requires official finishing positions with lower position ahead');
  }
  if (!signature.comparison_fields.includes(leftComparison.field as never) || !signature.comparison_fields.includes(rightComparison.field as never)) {
    throw new F1QLValidationError('signature_invalid', 'Comparison field is not covered by the classification summary signature');
  }
  if (leftComparison.as !== signature.comparison_aliases[0] || rightComparison.as !== signature.comparison_aliases[1]) {
    throw new F1QLValidationError('signature_invalid', 'Comparison aliases do not match the classification summary signature');
  }
  validatePipeline(join.left as CorePipelineNode);
  validatePipeline(join.right as CorePipelineNode);
  assertSignature(left.source, 'join', []);
  assertSignature(left.source, 'compare', [leftComparison.field as string, rightComparison.field as string]);
  assertSignature(left.source, 'comparison_summary', ['season', 'round', 'driver_id', leftComparison.field as string, rightComparison.field as string]);
}

function classificationComparisonBranch(input: unknown): { source: keyof typeof CORE_COMPARISON_SUMMARY_SIGNATURES; where: CoreEventClassificationFilter } {
  const branch = input as Record<string, unknown> | null;
  const source = branch?.input as Record<string, unknown> | undefined;
  const where = branch?.where as Record<string, unknown> | undefined;
  const keys = JSON.stringify(Object.keys(where ?? {}).sort());
  if (branch?.op !== 'filter' || source?.op !== 'source' || !isComparisonSummarySource(source.source) || !where ||
      (keys !== JSON.stringify(['driver_id', 'season']) && keys !== JSON.stringify(['driver_id', 'round', 'season']))) {
    throw new F1QLValidationError('signature_invalid', 'Comparison summary branches require exact season, optional round, and driver filters over a covered classification source');
  }
  return { source: source.source, where: where as CoreEventClassificationFilter };
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value);
}

function isComparisonSummarySource(value: unknown): value is keyof typeof CORE_COMPARISON_SUMMARY_SIGNATURES {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CORE_COMPARISON_SUMMARY_SIGNATURES, value);
}

// eslint-disable-next-line complexity
function validatePipeline(node: CorePipelineNode): CoreSourceNode['source'] {
  if (node.op === 'source') {
    assertSignature(node.source, 'source', []);
    return node.source;
  }
  if (node.op === 'filter') {
    const source = validatePipeline(node.input);
    const season = (node.where as { season?: unknown }).season;
    if (Array.isArray(season) && (source === 'event_classification' || source === 'qualifying_classification' || source === 'event_metadata')) {
      throw new F1QLValidationError('signature_invalid', 'Multi-season Core filters require a closed joined aggregate');
    }
    assertSignature(source, 'filter', signatureFieldsForFilter(source, node));
    return source;
  }
  if (node.op === 'aggregate') {
    if (node.input.op === 'join') {
      throw new F1QLValidationError('signature_invalid', 'Joined aggregates require a closed integrity contract');
    }
    if (node.measures.some(measure => 'where' in measure && measure.where !== undefined)) {
      throw new F1QLValidationError('signature_invalid', 'Conditional aggregate measures require a closed integrity contract');
    }
    const source = validatePipeline(node.input);
    assertSignature(source, 'aggregate', signatureFieldsForAggregate(source, node));
    return source;
  }
  if (node.op === 'sort') {
    const source = validatePipeline(node.input);
    const sortFields: Partial<Record<CoreSourceNode['source'], string>> = {
      event_classification: 'finishing_position',
      qualifying_classification: 'qualifying_position'
    };
    const sortField = sortFields[source];
    if (sortField && node.by !== sortField) {
      throw new F1QLValidationError('signature_invalid', `${node.by} is not a supported ${source} field`);
    }
    assertSignature(source, 'sort', []);
    return source;
  }
  if (node.op === 'limit') {
    const source = validatePipeline(node.input);
    assertSignature(source, 'limit', []);
    return source;
  }
  throw new F1QLValidationError('signature_invalid', `Unsupported core operator ${(node as { op: string }).op}`);
}

function validateDelta(node: CoreDeltaNode): void {
  if ((node.input as { op?: unknown }).op !== 'compare' || (node.input.input as { op?: unknown }).op !== 'join' || node.input.input.type !== 'inner') {
    throw new F1QLValidationError('signature_invalid', 'Delta requires an inner joined comparison');
  }
  const { left, right } = node.input.input;
  const leftSource = validatePipeline(left);
  const rightSource = validatePipeline(right);
  if (leftSource === 'official_lap_timing' || rightSource === 'official_lap_timing') {
    if (node.metric_id === OFFICIAL_EVENT_MEAN_METRIC_ID) {
      validateOfficialEventMeanDelta(node, leftSource, rightSource);
    } else {
      validateOfficialLapDelta(node, leftSource, rightSource);
    }
    return;
  }
  if (leftSource !== 'lap_pace' || rightSource !== 'lap_pace' || node.input.input.on.length !== 1 || node.input.input.on[0] !== 'round') {
    throw new F1QLValidationError('signature_invalid', 'Delta requires lap pace inputs joined on round');
  }
  if (node.input.left.field !== 'median_lap_time_seconds' || node.input.right.field !== 'median_lap_time_seconds') {
    throw new F1QLValidationError('signature_invalid', 'Delta compares per-round lap pace medians');
  }
  assertSignature('lap_pace', 'join', []);
  assertSignature('lap_pace', 'compare', []);
  assertSignature('lap_pace', 'delta', []);
}

function validateOfficialEventMeanDelta(node: CoreDeltaNode, leftSource: CoreSourceNode['source'], rightSource: CoreSourceNode['source']): void {
  if (leftSource !== 'official_lap_timing' || rightSource !== 'official_lap_timing' || node.input.input.on.length !== 0 ||
      node.metric_id !== OFFICIAL_EVENT_MEAN_METRIC_ID || node.lower_is_better !== true || node.left_id === node.right_id ||
      node.input.left.field !== 'mean_lap_time_seconds' || node.input.left.as !== 'driver_a_mean_lap_time_seconds' ||
      node.input.right.field !== 'mean_lap_time_seconds' || node.input.right.as !== 'driver_b_mean_lap_time_seconds') {
    throw new F1QLValidationError('signature_invalid', 'Official event mean requires the fixed all-completed-laps comparison');
  }
  const left = officialLapAggregate(node.input.input.left);
  const right = officialLapAggregate(node.input.input.right);
  const leftFilter = left.input.where as CoreOfficialEventMeanFilter;
  const rightFilter = right.input.where as CoreOfficialEventMeanFilter;
  const sharedLeft = { ...leftFilter, driver_id: undefined };
  const sharedRight = { ...rightFilter, driver_id: undefined };
  if (!Number.isInteger(leftFilter.season) || leftFilter.season < 1950 || leftFilter.season > 2100 ||
      !Number.isInteger(leftFilter.round) || leftFilter.round < 1 || leftFilter.round > 30 ||
      leftFilter.session_type !== 'R' || leftFilter.complete_event !== true || leftFilter.official_deleted_lap !== false ||
      leftFilter.official_pit_marker !== false || leftFilter.driver_id !== node.left_id || rightFilter.driver_id !== node.right_id ||
      JSON.stringify(sharedLeft) !== JSON.stringify(sharedRight) ||
      left.minimum_rows !== MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS || right.minimum_rows !== MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS ||
      JSON.stringify(left.measures) !== JSON.stringify(right.measures) || JSON.stringify(left.measures) !== JSON.stringify([
        { as: 'eligible_laps', function: 'count' },
        { as: 'mean_lap_time_seconds', function: 'avg', field: 'lap_time_seconds' }
      ])) {
    throw new F1QLValidationError('signature_invalid', 'Official event mean inputs must share the fixed eligibility and aggregation contract');
  }
  assertSignature('official_lap_timing', 'join', []);
  assertSignature('official_lap_timing', 'compare', []);
  assertSignature('official_lap_timing', 'delta', []);
}

// eslint-disable-next-line complexity
function validateOfficialLapDelta(node: CoreDeltaNode, leftSource: CoreSourceNode['source'], rightSource: CoreSourceNode['source']): void {
  if (leftSource !== 'official_lap_timing' || rightSource !== 'official_lap_timing' || node.input.input.on.length !== 0 ||
      node.metric_id !== OFFICIAL_LAP_WINDOW_METRIC_ID || node.lower_is_better !== true || node.left_id === node.right_id ||
      node.input.left.field !== 'median_lap_time_seconds' || node.input.left.as !== 'driver_a_median_lap_time_seconds' ||
      node.input.right.field !== 'median_lap_time_seconds' || node.input.right.as !== 'driver_b_median_lap_time_seconds') {
    throw new F1QLValidationError('signature_invalid', 'Official lap delta requires the fixed complete-window median comparison');
  }
  const left = officialLapAggregate(node.input.input.left);
  const right = officialLapAggregate(node.input.input.right);
  const leftFilter = left.input.where as CoreOfficialLapTimingFilter;
  const rightFilter = right.input.where as CoreOfficialLapTimingFilter;
  const windowWidth = leftFilter.lap_end - leftFilter.lap_start + 1;
  const sharedLeft = { ...leftFilter, driver_id: undefined };
  const sharedRight = { ...rightFilter, driver_id: undefined };
  if (!Number.isInteger(leftFilter.season) || leftFilter.season < 1950 || leftFilter.season > 2100 ||
      !Number.isInteger(leftFilter.round) || leftFilter.round < 1 || leftFilter.round > 30 ||
      !Number.isInteger(leftFilter.lap_start) || leftFilter.lap_start < 1 || !Number.isInteger(leftFilter.lap_end) ||
      windowWidth < 1 || windowWidth > MAX_OFFICIAL_LAP_WINDOW_LAPS || leftFilter.session_type !== 'R' || leftFilter.complete_requested_window !== true ||
      leftFilter.official_deleted_lap !== false || leftFilter.official_pit_marker !== false ||
      leftFilter.driver_id !== node.left_id || rightFilter.driver_id !== node.right_id || JSON.stringify(sharedLeft) !== JSON.stringify(sharedRight) ||
      left.minimum_rows !== MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS || right.minimum_rows !== MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS ||
      JSON.stringify(left.measures) !== JSON.stringify(right.measures) || JSON.stringify(left.measures) !== JSON.stringify([
        { as: 'eligible_laps', function: 'count' },
        { as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }
      ])) {
    throw new F1QLValidationError('signature_invalid', 'Official lap delta inputs must share the fixed eligibility and aggregation contract');
  }
  assertSignature('official_lap_timing', 'join', []);
  assertSignature('official_lap_timing', 'compare', []);
  assertSignature('official_lap_timing', 'delta', []);
}

function officialLapAggregate(node: CorePipelineNode): CoreAggregateNode & { input: CoreFilterNode } {
  if (node.op !== 'aggregate' || node.group_by.length !== 0 || node.input.op !== 'filter' || node.input.input.op !== 'source' || node.input.input.source !== 'official_lap_timing') {
    throw new F1QLValidationError('signature_invalid', 'Official lap comparison requires filtered scalar aggregates');
  }
  return node as CoreAggregateNode & { input: CoreFilterNode };
}

function signatureFieldsForFilter(source: CoreSourceNode['source'], node: CoreFilterNode): string[] {
  if (source === 'standings') {
    return Object.keys(node.where);
  }
  if (source === 'event_classification' || source === 'qualifying_classification' || source === 'event_metadata') {
    return Object.keys(node.where);
  }
  return Object.keys(node.where)
    .map((field) => {
      if (field === 'clean_air_only') {
        return 'clean_air_flag';
      }
      return field === 'rounds' ? 'round' : field;
    });
}

function signatureFieldsForAggregate(source: CoreSourceNode['source'], node: { group_by: string[]; measures: Array<{ field?: string }> }): string[] {
  const measures = node.measures.flatMap((measure) => measure.field ? [measure.field] : []);
  if (source === 'standings') {
    return [...node.group_by, ...measures];
  }
  return [...node.group_by, ...measures].filter((field) => field !== 'median_lap_time_seconds');
}

// eslint-disable-next-line complexity
function validateSignature(program: F1QLProgram): void {
  const root = program.root;
  if (root.op === 'pace_summary' || root.op === 'pace_delta') {
    const fields = ['driver_id', 'lap_time_seconds', ...Object.keys(root.filters ?? {}).map((field) => field === 'clean_air_only' ? 'clean_air_flag' : field)];
    assertSignature('lap_pace', root.op, fields);
    return;
  }
  if (root.op === 'official_lap_window_median_compare') {
    assertSignature('official_lap_timing', root.op, [
      'season', 'round', 'session_type', 'driver_id', 'lap_start', 'lap_end', 'complete_requested_window',
      'official_deleted_lap', 'official_pit_marker', 'lap_time_seconds'
    ]);
    return;
  }
  if (root.op === 'official_event_mean_compare') {
    assertSignature('official_lap_timing', root.op, [
      'season', 'round', 'session_type', 'driver_id', 'complete_event',
      'official_deleted_lap', 'official_pit_marker', 'lap_time_seconds'
    ]);
    return;
  }
  if (root.op === 'race_season_finishing_position_h2h') {
    assertSignature('event_classification', root.op, ['season', 'round', 'driver_id', 'finishing_position']);
    return;
  }
  if (root.op === 'race_event_finishing_position_comparison') {
    assertSignature('event_classification', root.op, ['season', 'round', 'driver_id', 'finishing_position']);
    return;
  }
  if (root.op === 'qualifying_season_position_h2h') {
    assertSignature('qualifying_classification', root.op, ['season', 'round', 'driver_id', 'qualifying_position']);
    return;
  }
  if (root.op === 'official_driver_results_comparison') {
    if (root.metric !== OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID) {
      throw new F1QLValidationError('signature_invalid', 'Official driver results comparison requires the fixed metric');
    }
    assertSignature('standings', root.op, ['season', 'driver_id', 'points', 'championship_position']);
    assertSignature('event_classification', root.op, ['season', 'round', 'driver_id', 'finishing_position']);
    assertSignature('qualifying_classification', root.op, ['season', 'round', 'driver_id', 'qualifying_position']);
    return;
  }
  if (root.op === 'driver_career_wins_by_circuit') {
    if (root.metric !== DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID || JSON.stringify(root.seasons) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS)) {
      throw new F1QLValidationError('signature_invalid', 'Career wins requires the fixed metric and completed-season scope');
    }
    assertSignature('event_classification', root.op, ['season', 'round', 'driver_id', 'finishing_position']);
    assertSignature('event_metadata', root.op, ['season', 'round', 'circuit_id']);
    return;
  }
  if (root.op === 'driver_season_qualifying_p1_count' || root.op === 'driver_career_qualifying_p1_count' || root.op === 'driver_season_qualifying_top_ten_count' || root.op === 'season_qualifying_top_ten_ranking') {
    const expectedMetric = {
      driver_season_qualifying_p1_count: DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID,
      driver_career_qualifying_p1_count: DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID,
      driver_season_qualifying_top_ten_count: DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID,
      season_qualifying_top_ten_ranking: SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID
    }[root.op];
    if (root.metric !== expectedMetric || (root.op === 'driver_career_qualifying_p1_count' && JSON.stringify(root.seasons) !== JSON.stringify(COMPLETED_QUALIFYING_SEASONS))) {
      throw new F1QLValidationError('signature_invalid', 'Qualifying count requires its fixed metric and completed-season scope');
    }
    assertSignature('qualifying_classification', root.op, ['season', 'round', 'driver_id', 'qualifying_position']);
    return;
  }
  if (isClassificationRoot(root)) {
    const positionFields = {
      event_classification: 'finishing_position',
      qualifying_classification: 'qualifying_position'
    } as const;
    const positionField = positionFields[root.op];
    assertSignature(root.op, root.op, [positionField, ...Object.keys(root.filters ?? {})]);
    return;
  }
  if (root.op === 'event_metadata') {
    assertSignature('event_metadata', 'event_metadata', ['season', 'round', 'session_scope']);
    return;
  }
  const aggregate = root.op === 'rank' ? root.input : root;
  const source = aggregate.input.op === 'filter' ? aggregate.input.input : aggregate.input;
  if (source.source !== 'standings') {
    throw new F1QLValidationError('coverage_unsupported', `Source ${source.source} is not supported`);
  }
  const operators = root.op === 'rank' ? ['source', 'aggregate', 'rank'] : ['source', 'aggregate'];
  const fields: string[] = [...aggregate.group_by, ...aggregate.measures.flatMap((measure) => measure.field ? [measure.field] : [])];
  if (aggregate.input.op === 'filter') {
    operators.push('filter');
    fields.push(...Object.keys(aggregate.input.where));
  }
  for (const operator of operators) {
    assertSignature('standings', operator, []);
  }
  assertSignature('standings', 'aggregate', fields);
}

function isClassificationRoot(root: F1QLProgram['root']): root is Extract<F1QLProgram['root'], { op: 'event_classification' | 'qualifying_classification' }> {
  return root.op === 'event_classification' || root.op === 'qualifying_classification';
}

function assertSignature(source: keyof typeof F1QL_SIGNATURES, operator: string, fields: string[]): void {
  const signature = F1QL_SIGNATURES[source];
  if (!signature.operators.includes(operator as never)) {
    throw new F1QLValidationError('signature_invalid', `${operator} is not allowed for ${source}`);
  }
  for (const field of fields) {
    if (!signature.fields.includes(field as never)) {
      throw new F1QLValidationError('signature_invalid', `${field} is not a supported ${source} field`);
    }
  }
}

function countNodes(root: F1QLProgram['root']): number {
  if (root.op === 'rank') {
    return 3 + (root.input.input.op === 'filter' ? 1 : 0);
  }
  if (root.op === 'aggregate') {
    return 2 + (root.input.op === 'filter' ? 1 : 0);
  }
  return 1;
}
