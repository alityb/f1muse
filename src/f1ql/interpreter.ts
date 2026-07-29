import { AggregateMeasure, StandingsFilter } from './ast';
import { CORE_COMPARISON_SUMMARY_SIGNATURES, CoreAggregateNode, CoreComparisonSummaryNode, CoreComposeNode, CoreDeltaNode, CoreEventClassificationFilter, CoreEventMetadataFilter, CoreFilterNode, CoreJoinNode, CoreLapPaceFilter, CoreLimitNode, CoreOfficialEventMeanFilter, CoreOfficialLapTimingFilter, CorePipelineNode, CoreProgram, CoreQualifyingClassificationFilter } from './core';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';
import { DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID, DRIVER_CAREER_WIN_SEASONS } from './driver-career-wins-by-circuit';
import { OFFICIAL_DRIVER_RESULTS_COMPARISON_INPUT_ALIASES, OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID, OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MAX, OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MIN, OFFICIAL_DRIVER_RESULTS_COMPARISON_SELECT } from './official-driver-results-comparison';
import { RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID } from './race-season-finishing-position-h2h';
import { QUALIFYING_SEASON_POSITION_H2H_METRIC_ID } from './qualifying-season-position-h2h';
import { RACE_EVENT_FINISHING_POSITION_COMPARISON_METRIC_ID } from './race-event-finishing-position-comparison';

export interface StandingsRow {
  season: number;
  driver_id: string;
  championship_position: number | null;
  points: number;
  championship_won: boolean;
}

export interface PaceLapRow {
  season: number;
  round: number;
  driver_id: string;
  lap_time_seconds: number | null;
  is_valid_lap: boolean;
  is_pit_lap: boolean;
  is_in_lap: boolean;
  is_out_lap: boolean;
  clean_air_flag: boolean;
  compound: string | null;
  session_type?: string;
  methodology_version?: string;
}

export interface EventClassificationRow {
  season: number;
  round: number;
  driver_id: string;
  team_id: string | null;
  finishing_position: number | null;
  points: number;
  classification_status: string;
  status_reason: string | null;
}

export interface QualifyingClassificationRow {
  season: number;
  round: number;
  driver_id: string;
  team_id: string | null;
  qualifying_position: number | null;
  best_time_ms: number | null;
  best_session: string | null;
  eliminated_in_round: string | null;
  classification_status: string;
}

export interface EventMetadataRow {
  season: number;
  round: number;
  event_id: string;
  event_name: string;
  circuit_id: string | null;
  date: string | null;
}

export interface OfficialLapTimingRow {
  dataset_sha256: string;
  season: number;
  round: number;
  session_type: string;
  event_name: string;
  source_manifest_sha256: string;
  identity_map_sha256: string;
  fact_fingerprint: string;
  driver_id: string;
  lap_number: number;
  lap_time_seconds: number;
  official_deleted_lap: boolean;
  official_pit_marker: boolean;
}

export interface ComparisonSummaryRow {
  season: number;
  round: number;
  driver_id: string;
  finishing_position?: number | null;
  qualifying_position?: number | null;
}

// eslint-disable-next-line complexity,max-lines-per-function
export function interpretDriverCareerWinsByCircuit(
  program: CoreProgram,
  classificationRows: EventClassificationRow[],
  metadataRows: EventMetadataRow[]
): Array<Record<string, unknown>> {
  if (program.root.op !== 'aggregate' || program.root.input.op !== 'join') {
    throw new Error('Expected a joined career race-wins aggregate');
  }
  const node = program.root as CoreAggregateNode & { input: CoreJoinNode };
  const { left, right } = node.input;
  const integrityContract = node.source_integrity;
  if (node.input.type !== 'left' || JSON.stringify(node.input.on) !== JSON.stringify(['season', 'round']) ||
      left.op !== 'filter' || left.input.op !== 'filter' || left.input.input.op !== 'source' || left.input.input.source !== 'event_classification' ||
      right.op !== 'filter' || right.input.op !== 'source' || right.input.source !== 'event_metadata' ||
      JSON.stringify(node.group_by) !== JSON.stringify(['circuit_id']) ||
      JSON.stringify(node.measures) !== JSON.stringify([{ as: 'wins', function: 'count' }]) ||
      JSON.stringify(integrityContract) !== JSON.stringify({
        left_key: ['season', 'round'], left_key_scope: 'before_outer_filter', right_key: ['season', 'round'], require_unique_left_keys: true,
        require_exactly_one_right_match: true, require_non_null_right_fields: ['circuit_id']
      })) {
    throw new Error('Expected the closed career race-wins integrity contract');
  }
  const leftWhere = left.where as CoreEventClassificationFilter;
  const winnerWhere = left.input.where as CoreEventClassificationFilter;
  const rightWhere = right.where as CoreEventMetadataFilter;
  if (JSON.stringify(Object.keys(leftWhere).sort()) !== JSON.stringify(['driver_id']) ||
      JSON.stringify(Object.keys(winnerWhere).sort()) !== JSON.stringify(['finishing_position', 'season']) ||
      JSON.stringify(Object.keys(rightWhere).sort()) !== JSON.stringify(['season']) ||
      JSON.stringify(winnerWhere.season) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS) ||
      JSON.stringify(rightWhere.season) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS) ||
      JSON.stringify(winnerWhere.finishing_position) !== JSON.stringify([1]) || typeof leftWhere.driver_id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,99}$/.test(leftWhere.driver_id)) {
    throw new Error('Expected exact career scope, driver, and race P1 filters');
  }
  const allP1Rows = classificationRows.filter(row => DRIVER_CAREER_WIN_SEASONS.includes(row.season) && row.finishing_position === 1);
  const requestedEventKeys = new Set(allP1Rows.filter(row => row.driver_id === leftWhere.driver_id).map(row => JSON.stringify([row.season, row.round])));
  const winnerRows = allP1Rows.filter(row => requestedEventKeys.has(JSON.stringify([row.season, row.round])));
  if (requestedEventKeys.size === 0) {
    return [];
  }
  const winnerKeys = groupRows(winnerRows, row => JSON.stringify([row.season, row.round]));
  const metadataKeys = groupRows(
    metadataRows.filter(row => DRIVER_CAREER_WIN_SEASONS.includes(row.season)),
    row => JSON.stringify([row.season, row.round])
  );
  const joined = Array.from(winnerKeys.values()).map(winners => {
    const winner = winners[0];
    const metadata = metadataKeys.get(JSON.stringify([winner.season, winner.round])) ?? [];
    return { winners, metadata, circuit_id: metadata.map(row => row.circuit_id).sort()[0] ?? null };
  });
  const sentinels = {
    winner_source_rows: winnerRows.length,
    distinct_winner_event_keys: winnerKeys.size,
    duplicate_winner_rows: winnerRows.length - winnerKeys.size,
    metadata_source_rows: joined.reduce((sum, item) => sum + item.metadata.length, 0),
    distinct_metadata_event_keys: joined.filter(item => item.metadata.length > 0).length,
    missing_event_metadata_rows: joined.filter(item => item.metadata.length === 0).length,
    duplicate_event_metadata_rows: joined.reduce((sum, item) => sum + Math.max(item.metadata.length - 1, 0), 0),
    missing_circuit_id_rows: joined.filter(item => item.metadata.length === 1 && (item.circuit_id === null || item.circuit_id.trim() === '')).length,
    source_presence_ok: true
  };
  const sourceIntegrityOk = sentinels.duplicate_winner_rows === 0 && sentinels.missing_event_metadata_rows === 0 &&
    sentinels.duplicate_event_metadata_rows === 0 && sentinels.missing_circuit_id_rows === 0;
  if (!sourceIntegrityOk) {
    return [{ metric_id: DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID, driver_id: leftWhere.driver_id, circuit_id: null, wins: null, ...sentinels, source_integrity_ok: false }];
  }
  const groups = groupRows(joined, item => item.circuit_id!);
  return Array.from(groups.entries())
    .map(([circuitId, wins]) => ({
      metric_id: DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID, driver_id: leftWhere.driver_id,
      circuit_id: circuitId, wins: wins.length, ...sentinels, source_integrity_ok: true
    }))
    .sort((left, right) => Number(right.wins) - Number(left.wins) || compareUtf8Bytes(String(left.circuit_id), String(right.circuit_id)));
}

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function groupRows<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return groups;
}

export function interpretComparisonSummary(program: CoreProgram, rows: ComparisonSummaryRow[]): Array<Record<string, unknown>> {
  if (program.root.op !== 'comparison_summary') {
    throw new Error('Expected a comparison summary');
  }
  const node: CoreComparisonSummaryNode = program.root;
  const { season, round, leftId, rightId, leftField, rightField } = referenceComparisonSummaryPlan(node);
  const scoped = rows.filter(row => row.season === season && (round === undefined || row.round === round) && (row.driver_id === leftId || row.driver_id === rightId));
  const driverASourceRows = scoped.filter(row => row.driver_id === leftId).length;
  const driverBSourceRows = scoped.filter(row => row.driver_id === rightId).length;
  const distinctSourceKeys = new Set(scoped.map(row => JSON.stringify([row.season, row.round, row.driver_id]))).size;
  const duplicateSourceRows = scoped.length - distinctSourceKeys;
  const sourcePresenceOk = driverASourceRows > 0 && driverBSourceRows > 0;
  const sourceUniqueKeysOk = duplicateSourceRows === 0;
  const byRound = new Map<number, ComparisonSummaryRow[]>();
  for (const row of scoped) {
    const round = byRound.get(row.round) ?? [];
    round.push(row);
    byRound.set(row.round, round);
  }
  const shared = Array.from(byRound.values()).flatMap(round => {
    const left = round.filter(row => row.driver_id === leftId);
    const right = round.filter(row => row.driver_id === rightId);
    const leftPosition = left[0]?.[leftField];
    const rightPosition = right[0]?.[rightField];
    return left.length === 1 && right.length === 1 && typeof leftPosition === 'number' && typeof rightPosition === 'number'
      ? [{ left: leftPosition, right: rightPosition }]
      : [];
  });
  const sourceIntegrityOk = (!node.require_source_presence || sourcePresenceOk) && (!node.require_unique_source_keys || sourceUniqueKeysOk)
    && (!node.require_exactly_one_shared_event || shared.length === 1);
  return [{
    metric_id: node.metric_id,
    season,
    driver_a_id: leftId,
    driver_b_id: rightId,
    driver_a_ahead: sourceIntegrityOk ? shared.filter(event => node.lower_is_better ? event.left < event.right : event.left > event.right).length : null,
    driver_b_ahead: sourceIntegrityOk ? shared.filter(event => node.lower_is_better ? event.right < event.left : event.right > event.left).length : null,
    ties: sourceIntegrityOk ? shared.filter(event => event.left === event.right).length : null,
    shared_events: sourceIntegrityOk ? shared.length : null,
    driver_a_source_rows: driverASourceRows,
    driver_b_source_rows: driverBSourceRows,
    distinct_source_keys: distinctSourceKeys,
    duplicate_source_rows: duplicateSourceRows,
    source_presence_ok: sourcePresenceOk,
    source_unique_keys_ok: sourceUniqueKeysOk,
    source_integrity_ok: sourceIntegrityOk
  }];
}

export function interpretOfficialDriverResultsComparison(
  program: CoreProgram,
  standingsRows: StandingsRow[],
  raceRows: EventClassificationRow[],
  qualifyingRows: QualifyingClassificationRow[]
): Array<Record<string, unknown>> {
  if (program.root.op !== 'compose') {
    throw new Error('Expected a scalar composition');
  }
  const node: CoreComposeNode = program.root;
  if (node.require_exactly_one_row_per_input !== true || node.inputs.length < 2 || node.inputs.length > 8 || node.select.length < 1 || node.select.length > 100) {
    throw new Error('Composition must require bounded exactly-one-row inputs');
  }
  if (node.metric_id !== OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID) {
    throw new Error('Unsupported composition metric');
  }
  validateReferenceOfficialCompositionPlan(node);
  const results = new Map<string, Record<string, unknown>>();
  for (const item of node.inputs) {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(item.as)) {
      throw new Error('Composition input aliases must be bounded identifiers');
    }
    if (item.input.op === 'aggregate' && (JSON.stringify(item.input.measures) !== JSON.stringify([
      { as: 'championship_position', function: 'min', field: 'championship_position' },
      { as: 'points', function: 'max', field: 'points' },
      { as: 'standing_rows', function: 'count' }
    ]) || JSON.stringify(item.require) !== JSON.stringify({ field: 'standing_rows', equals: 1, non_null_fields: ['championship_position', 'points'] }))) {
      throw new Error('Composition standings inputs require the exact integrity aggregate');
    }
    if (item.input.op === 'aggregate') {
      const aggregateInput = item.input.input;
      const where = aggregateInput.op === 'filter' ? aggregateInput.where as Record<string, unknown> : undefined;
      if (aggregateInput.op !== 'filter' || aggregateInput.input.op !== 'source' || aggregateInput.input.source !== 'standings' ||
          JSON.stringify(Object.keys(where ?? {}).sort()) !== JSON.stringify(['driver_id', 'season']) ||
          typeof where?.season !== 'number' || typeof where.driver_id !== 'string' || JSON.stringify(item.input.group_by) !== JSON.stringify(['driver_id'])) {
        throw new Error('Composition standings input shape changed');
      }
    }
    if (item.input.op === 'comparison_summary' && item.require !== undefined) {
      throw new Error('Comparison summary inputs cannot add scalar count requirements');
    }
    const child = { version: 1 as const, root: item.input };
    const rows = item.input.op === 'aggregate'
      ? interpretStandingsProgram(child, standingsRows)
      : interpretComparisonSummary(child, getSourceName(item.input.input.input.left) === 'event_classification' ? raceRows : qualifyingRows);
    if (rows.length !== 1 || (item.require !== undefined && (rows[0][item.require.field] !== item.require.equals || item.require.non_null_fields.some(field => rows[0][field] === null || rows[0][field] === undefined)))) {
      return [];
    }
    if (results.has(item.as)) {
      throw new Error('Composition input aliases must be unique');
    }
    results.set(item.as, rows[0]);
  }
  validateReferenceOfficialCompositionResults(results);
  const output: Record<string, unknown> = { metric_id: node.metric_id };
  for (const selection of node.select) {
    const input = results.get(selection.input);
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(selection.input) || !/^[a-z][a-z0-9_]{0,99}$/.test(selection.field) || !/^[a-z][a-z0-9_]{0,99}$/.test(selection.as) ||
        !input || Object.prototype.hasOwnProperty.call(output, selection.as) || !Object.prototype.hasOwnProperty.call(input, selection.field)) {
      throw new Error(`Composition selected an unavailable or duplicate field: ${selection.input}.${selection.field} as ${selection.as}`);
    }
    output[selection.as] = input[selection.field];
  }
  return [output];
}

function validateReferenceOfficialCompositionPlan(node: CoreComposeNode): void {
  if (JSON.stringify(node.inputs.map(input => input.as)) !== JSON.stringify(OFFICIAL_DRIVER_RESULTS_COMPARISON_INPUT_ALIASES) ||
      JSON.stringify(node.select) !== JSON.stringify(OFFICIAL_DRIVER_RESULTS_COMPARISON_SELECT)) {
    throw new Error('Official driver results composition requires the exact inputs and projection contract');
  }
  const [standingAInput, standingBInput, raceInput, qualifyingInput] = node.inputs;
  if (standingAInput.input.op !== 'aggregate' || standingBInput.input.op !== 'aggregate' || raceInput.input.op !== 'comparison_summary' || qualifyingInput.input.op !== 'comparison_summary') {
    throw new Error('Official driver results composition input types changed');
  }
  const standingAWhere = (standingAInput.input.input as CoreFilterNode).where as Record<string, unknown>;
  const standingBWhere = (standingBInput.input.input as CoreFilterNode).where as Record<string, unknown>;
  const racePlan = referenceComparisonSummaryPlan(raceInput.input);
  const qualifyingPlan = referenceComparisonSummaryPlan(qualifyingInput.input);
  if (racePlan.season < OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MIN || racePlan.season > OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MAX ||
      raceInput.input.metric_id !== RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID || qualifyingInput.input.metric_id !== QUALIFYING_SEASON_POSITION_H2H_METRIC_ID ||
      raceInput.input.lower_is_better !== true || qualifyingInput.input.lower_is_better !== true ||
      raceInput.input.require_unique_source_keys !== true || qualifyingInput.input.require_unique_source_keys !== true ||
      raceInput.input.require_source_presence !== true || qualifyingInput.input.require_source_presence !== true ||
      racePlan.source !== 'event_classification' || qualifyingPlan.source !== 'qualifying_classification' ||
      standingAWhere.season !== racePlan.season || standingBWhere.season !== racePlan.season || qualifyingPlan.season !== racePlan.season ||
      standingAWhere.driver_id !== racePlan.leftId || standingBWhere.driver_id !== racePlan.rightId ||
      qualifyingPlan.leftId !== racePlan.leftId || qualifyingPlan.rightId !== racePlan.rightId ||
      racePlan.round !== undefined || qualifyingPlan.round !== undefined) {
    throw new Error('Official driver results composition branches must share one season and ordered drivers');
  }
}

function validateReferenceOfficialCompositionResults(results: Map<string, Record<string, unknown>>): void {
  const standingA = results.get('driver_a_standing')!;
  const standingB = results.get('driver_b_standing')!;
  const race = results.get('race')!;
  const qualifying = results.get('qualifying')!;
  if (standingA.driver_id !== race.driver_a_id || standingB.driver_id !== race.driver_b_id ||
      qualifying.season !== race.season || qualifying.driver_a_id !== race.driver_a_id || qualifying.driver_b_id !== race.driver_b_id) {
    throw new Error('Official driver results composition outputs must retain one season and ordered drivers');
  }
}

// eslint-disable-next-line complexity
function referenceComparisonSummaryPlan(node: CoreComparisonSummaryNode): {
  season: number;
  round?: number;
  source: 'event_classification' | 'qualifying_classification';
  leftId: string;
  rightId: string;
  leftField: 'finishing_position' | 'qualifying_position';
  rightField: 'finishing_position' | 'qualifying_position';
} {
  const { left, right } = node.input.input;
  if (node.input.op !== 'compare' || node.input.input.op !== 'join' || node.input.input.type !== 'inner' ||
      JSON.stringify(node.input.input.on) !== JSON.stringify(['season', 'round']) ||
      node.require_unique_source_keys !== true || node.require_source_presence !== true || typeof node.lower_is_better !== 'boolean' ||
      !/^[a-z][a-z0-9_]{0,99}$/.test(node.metric_id) || left.op !== 'filter' || right.op !== 'filter' || left.input.op !== 'source' || right.input.op !== 'source' ||
      left.input.source !== right.input.source || !Object.prototype.hasOwnProperty.call(CORE_COMPARISON_SUMMARY_SIGNATURES, left.input.source)) {
    throw new Error('Expected filtered comparison branches');
  }
  const source = left.input.source as keyof typeof CORE_COMPARISON_SUMMARY_SIGNATURES;
  const signature = CORE_COMPARISON_SUMMARY_SIGNATURES[source];
  const fields = signature.comparison_fields as readonly string[];
  if (!fields.includes(node.input.left.field) || !fields.includes(node.input.right.field) ||
      node.input.left.as !== signature.comparison_aliases[0] || node.input.right.as !== signature.comparison_aliases[1]) {
    throw new Error('Expected covered comparison fields');
  }
  const leftWhere = left.where as { season?: number; round?: number; driver_id?: string };
  const rightWhere = right.where as { season?: number; round?: number; driver_id?: string };
  const validKeys = (where: typeof leftWhere) => {
    const keys = JSON.stringify(Object.keys(where).sort());
    return keys === JSON.stringify(['driver_id', 'season']) || keys === JSON.stringify(['driver_id', 'round', 'season']);
  };
  const eventScoped = leftWhere.round !== undefined || rightWhere.round !== undefined;
  if (!validKeys(leftWhere) || !validKeys(rightWhere) ||
      !Number.isInteger(leftWhere.season) || leftWhere.season! < 1950 || leftWhere.season! > 2100 || leftWhere.season !== rightWhere.season ||
      leftWhere.round !== rightWhere.round || (leftWhere.round !== undefined && (!Number.isInteger(leftWhere.round) || leftWhere.round < 1 || leftWhere.round > 30)) ||
      (eventScoped && (node.metric_id !== RACE_EVENT_FINISHING_POSITION_COMPARISON_METRIC_ID || node.require_exactly_one_shared_event !== true)) ||
      (!eventScoped && node.require_exactly_one_shared_event !== undefined) ||
      (eventScoped && (source !== 'event_classification' || node.lower_is_better !== true || node.input.left.field !== 'finishing_position' || node.input.right.field !== 'finishing_position')) ||
      typeof leftWhere.driver_id !== 'string' || leftWhere.driver_id.trim().length === 0 ||
      typeof rightWhere.driver_id !== 'string' || rightWhere.driver_id.trim().length === 0 || leftWhere.driver_id === rightWhere.driver_id) {
    throw new Error('Expected shared season and ordered driver filters');
  }
  return {
    season: leftWhere.season!,
    ...(leftWhere.round === undefined ? {} : { round: leftWhere.round }),
    source,
    leftId: leftWhere.driver_id,
    rightId: rightWhere.driver_id,
    leftField: node.input.left.field as 'finishing_position' | 'qualifying_position',
    rightField: node.input.right.field as 'finishing_position' | 'qualifying_position'
  };
}

export function interpretOfficialEventMeanProgram(program: CoreProgram, rows: OfficialLapTimingRow[]): Array<Record<string, unknown>> {
  if (program.root.op !== 'delta' || program.root.metric_id !== OFFICIAL_EVENT_MEAN_METRIC_ID) {
    throw new Error('Expected an official event-mean comparison');
  }
  const leftFilter = officialEventMeanFilter(program.root.input.input.left);
  const rightFilter = officialEventMeanFilter(program.root.input.input.right);
  const summarize = (filter: CoreOfficialEventMeanFilter) => {
    const raw = rows.filter(row => row.season === filter.season && row.round === filter.round && row.session_type === 'R' && row.driver_id === filter.driver_id);
    const eligible = raw.filter(row => !row.official_deleted_lap && !row.official_pit_marker);
    if (eligible.length < 2) {
      return null;
    }
    return {
      raw,
      completed_laps: raw.length,
      eligible_laps: eligible.length,
      excluded_deleted_laps: raw.filter(row => row.official_deleted_lap).length,
      excluded_pit_marker_laps: raw.filter(row => row.official_pit_marker).length,
      mean_lap_time_ticks: roundedTenthMillisecondTicks(
        eligible.reduce((sum, row) => sum + Math.round(row.lap_time_seconds * 1000), 0),
        eligible.length
      )
    };
  };
  const left = summarize(leftFilter);
  const right = summarize(rightFilter);
  if (!left || !right) {
    return [];
  }
  const metadataRows = [...left.raw, ...right.raw];
  const provenance = new Set(metadataRows.map(row => JSON.stringify([
    row.dataset_sha256,
    row.event_name,
    row.source_manifest_sha256,
    row.identity_map_sha256,
    row.fact_fingerprint
  ])));
  if (provenance.size !== 1) {
    return [];
  }
  const metadata = metadataRows[0];
  let winner: string | null = null;
  if (left.mean_lap_time_ticks < right.mean_lap_time_ticks) {
    winner = program.root.left_id;
  } else if (right.mean_lap_time_ticks < left.mean_lap_time_ticks) {
    winner = program.root.right_id;
  }
  return [{
    driver_a_id: program.root.left_id,
    driver_b_id: program.root.right_id,
    metric_id: OFFICIAL_EVENT_MEAN_METRIC_ID,
    season: leftFilter.season,
    round: leftFilter.round,
    session_type: 'R',
    event_name: metadata.event_name,
    driver_a_completed_laps: left.completed_laps,
    driver_b_completed_laps: right.completed_laps,
    driver_a_eligible_laps: left.eligible_laps,
    driver_b_eligible_laps: right.eligible_laps,
    driver_a_excluded_deleted_laps: left.excluded_deleted_laps,
    driver_b_excluded_deleted_laps: right.excluded_deleted_laps,
    driver_a_excluded_pit_marker_laps: left.excluded_pit_marker_laps,
    driver_b_excluded_pit_marker_laps: right.excluded_pit_marker_laps,
    driver_a_mean_lap_time_seconds: left.mean_lap_time_ticks / 10_000,
    driver_b_mean_lap_time_seconds: right.mean_lap_time_ticks / 10_000,
    mean_delta_seconds: Math.abs(left.mean_lap_time_ticks - right.mean_lap_time_ticks) / 10_000,
    winner_driver_id: winner,
    dataset_sha256: metadata.dataset_sha256,
    source_manifest_sha256: metadata.source_manifest_sha256,
    identity_map_sha256: metadata.identity_map_sha256,
    fact_fingerprint: metadata.fact_fingerprint
  }];
}

// eslint-disable-next-line complexity,max-lines-per-function
export function interpretOfficialLapWindowProgram(program: CoreProgram, rows: OfficialLapTimingRow[]): Array<Record<string, unknown>> {
  if (program.root.op !== 'delta' || program.root.metric_id !== OFFICIAL_LAP_WINDOW_METRIC_ID) {
    throw new Error('Expected an official lap-window comparison');
  }
  const leftFilter = officialLapFilter(program.root.input.input.left);
  const rightFilter = officialLapFilter(program.root.input.input.right);
  const requestedLaps = leftFilter.lap_end - leftFilter.lap_start + 1;
  const summarize = (filter: CoreOfficialLapTimingFilter) => {
    const raw = rows.filter(row => row.season === filter.season && row.round === filter.round && row.session_type === 'R' &&
      row.driver_id === filter.driver_id && row.lap_number >= filter.lap_start && row.lap_number <= filter.lap_end);
    if (raw.length !== requestedLaps || new Set(raw.map(row => row.lap_number)).size !== requestedLaps) {
      return null;
    }
    const eligible = raw.filter(row => !row.official_deleted_lap && !row.official_pit_marker);
    if (eligible.length < 2) {
      return null;
    }
    return {
      raw,
      eligible_laps: eligible.length,
      excluded_deleted_laps: raw.filter(row => row.official_deleted_lap).length,
      excluded_pit_marker_laps: raw.filter(row => row.official_pit_marker).length,
      median_lap_time_seconds: median(eligible.map(row => Math.round(row.lap_time_seconds * 1000))) / 1000
    };
  };
  const left = summarize(leftFilter);
  const right = summarize(rightFilter);
  if (!left || !right) {
    return [];
  }
  const metadataRows = [...left.raw, ...right.raw];
  if (new Set(metadataRows.map(row => row.dataset_sha256)).size !== 1) {
    return [];
  }
  const metadata = metadataRows[0];
  const delta = Math.round(Math.abs(left.median_lap_time_seconds - right.median_lap_time_seconds) * 10_000) / 10_000;
  let winner: string | null = null;
  if (left.median_lap_time_seconds < right.median_lap_time_seconds) {
    winner = program.root.left_id;
  } else if (right.median_lap_time_seconds < left.median_lap_time_seconds) {
    winner = program.root.right_id;
  }
  return [{
    driver_a_id: program.root.left_id,
    driver_b_id: program.root.right_id,
    metric_id: OFFICIAL_LAP_WINDOW_METRIC_ID,
    season: leftFilter.season,
    round: leftFilter.round,
    session_type: 'R',
    event_name: metadata.event_name,
    lap_start: leftFilter.lap_start,
    lap_end: leftFilter.lap_end,
    requested_laps_per_driver: requestedLaps,
    driver_a_eligible_laps: left.eligible_laps,
    driver_b_eligible_laps: right.eligible_laps,
    driver_a_excluded_deleted_laps: left.excluded_deleted_laps,
    driver_b_excluded_deleted_laps: right.excluded_deleted_laps,
    driver_a_excluded_pit_marker_laps: left.excluded_pit_marker_laps,
    driver_b_excluded_pit_marker_laps: right.excluded_pit_marker_laps,
    driver_a_median_lap_time_seconds: left.median_lap_time_seconds,
    driver_b_median_lap_time_seconds: right.median_lap_time_seconds,
    median_delta_seconds: delta,
    winner_driver_id: winner,
    dataset_sha256: metadata.dataset_sha256,
    source_manifest_sha256: metadata.source_manifest_sha256,
    identity_map_sha256: metadata.identity_map_sha256,
    fact_fingerprint: metadata.fact_fingerprint
  }];
}

function officialLapFilter(node: CorePipelineNode): CoreOfficialLapTimingFilter {
  if (node.op !== 'aggregate' || node.input.op !== 'filter') {
    throw new Error('Expected an official lap aggregate');
  }
  return node.input.where as CoreOfficialLapTimingFilter;
}

function officialEventMeanFilter(node: CorePipelineNode): CoreOfficialEventMeanFilter {
  if (node.op !== 'aggregate' || node.input.op !== 'filter') {
    throw new Error('Expected an official event-mean aggregate');
  }
  return node.input.where as CoreOfficialEventMeanFilter;
}

function roundedTenthMillisecondTicks(sumMilliseconds: number, count: number): number {
  return Math.floor((sumMilliseconds * 20 + count) / (count * 2));
}

export function interpretEventClassification(program: CoreProgram, rows: EventClassificationRow[]): Array<Record<string, unknown>> {
  return interpretEventClassificationNode(program.root as CorePipelineNode, rows)
    .map(({ driver_id, finishing_position, points, classification_status, status_reason }) => ({ driver_id, finishing_position, points, classification_status, status_reason }));
}

export function interpretQualifyingClassification(program: CoreProgram, rows: QualifyingClassificationRow[]): Array<Record<string, unknown>> {
  return interpretQualifyingClassificationNode(program.root as CorePipelineNode, rows)
    .map(({ driver_id, qualifying_position, best_time_ms, best_session, eliminated_in_round, classification_status }) => ({
      driver_id, qualifying_position, best_time_ms, best_session, eliminated_in_round, classification_status
    }));
}

export function interpretEventMetadata(program: CoreProgram, rows: EventMetadataRow[]): Array<Record<string, unknown>> {
  const { rows: filtered, sessionScope } = interpretEventMetadataNode(program.root as CorePipelineNode, rows);
  return filtered.map(({ event_id, event_name, circuit_id, date }) => ({ event_id, event_name, circuit_id, date, session_scope: sessionScope }));
}

export function interpretStandingsProgram(
  program: CoreProgram,
  rows: StandingsRow[]
): Array<Record<string, unknown>> {
  if (program.root.op === 'delta' || program.root.op === 'comparison_summary' || program.root.op === 'compose' || getSourceName(program.root) !== 'standings') {
    throw new Error('interpretStandingsProgram does not accept pace programs');
  }
  const aggregate = getAggregateRoot(program);
  const filter = aggregate.input.op === 'filter' ? aggregate.input.where : {};
  const filtered = rows.filter((row) => matchesFilter(row, filter));
  const grouped = new Map<string, StandingsRow[]>();

  for (const row of filtered) {
    const key = row.driver_id;
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }

  const result = Array.from(grouped.entries()).map(([driverId, group]) => {
    const output: Record<string, unknown> = { driver_id: driverId };
    for (const measure of aggregate.measures as AggregateMeasure[]) {
      output[measure.as] = evaluateMeasure(measure, group);
    }
    return output;
  });

  if (program.root.op === 'limit') {
    return limitRows(result, program.root);
  }
  return result;
}

function interpretEventClassificationNode(node: CorePipelineNode, rows: EventClassificationRow[]): EventClassificationRow[] {
  if (node.op === 'source') {
    if (node.source !== 'event_classification') {
      throw new Error(`interpretEventClassification received ${node.source}`);
    }
    return rows;
  }
  if (node.op === 'filter') {
    const where = node.where as CoreEventClassificationFilter;
    return interpretEventClassificationNode(node.input, rows)
      .filter((row) => where.season === undefined || matchesValue(row.season, where.season))
      .filter((row) => where.round === undefined || row.round === where.round)
      .filter((row) => where.classification_status === undefined || where.classification_status.includes(row.classification_status))
      .filter((row) => where.driver_id === undefined || row.driver_id === where.driver_id)
      .filter((row) => where.team_id === undefined || row.team_id === where.team_id)
      .filter((row) => where.finishing_position === undefined || (row.finishing_position !== null && where.finishing_position.includes(row.finishing_position)));
  }
  if (node.op === 'sort') {
    const direction = node.direction === 'asc' ? 1 : -1;
    return [...interpretEventClassificationNode(node.input, rows)]
      .sort((a, b) => compareClassificationRows(a, b, node.by, direction, node.nulls));
  }
  if (node.op === 'limit') {
    return interpretEventClassificationNode(node.input, rows).slice(0, node.limit);
  }
  throw new Error(`Unsupported event classification core operator ${node.op}`);
}

function interpretQualifyingClassificationNode(node: CorePipelineNode, rows: QualifyingClassificationRow[]): QualifyingClassificationRow[] {
  if (node.op === 'source') {
    if (node.source !== 'qualifying_classification') {
      throw new Error(`interpretQualifyingClassification received ${node.source}`);
    }
    return rows;
  }
  if (node.op === 'filter') {
    const where = node.where as CoreQualifyingClassificationFilter;
    return interpretQualifyingClassificationNode(node.input, rows)
      .filter((row) => where.season === undefined || matchesValue(row.season, where.season))
      .filter((row) => where.round === undefined || row.round === where.round)
      .filter((row) => where.classification_status === undefined || where.classification_status.includes(row.classification_status))
      .filter((row) => where.driver_id === undefined || row.driver_id === where.driver_id)
      .filter((row) => where.team_id === undefined || row.team_id === where.team_id)
      .filter((row) => where.qualifying_position === undefined || (row.qualifying_position !== null && where.qualifying_position.includes(row.qualifying_position)));
  }
  if (node.op === 'sort') {
    const direction = node.direction === 'asc' ? 1 : -1;
    return [...interpretQualifyingClassificationNode(node.input, rows)]
      .sort((a, b) => compareClassificationRows(a, b, node.by, direction, node.nulls));
  }
  if (node.op === 'limit') {
    return interpretQualifyingClassificationNode(node.input, rows).slice(0, node.limit);
  }
  throw new Error(`Unsupported qualifying classification core operator ${node.op}`);
}

function interpretEventMetadataNode(node: CorePipelineNode, rows: EventMetadataRow[], sessionScope: 'race' | 'qualifying' = 'race'): { rows: EventMetadataRow[]; sessionScope: 'race' | 'qualifying' } {
  if (node.op === 'source') {
    if (node.source !== 'event_metadata') {
      throw new Error(`interpretEventMetadata received ${node.source}`);
    }
    return { rows, sessionScope };
  }
  if (node.op !== 'filter') {
    throw new Error(`Unsupported event metadata core operator ${node.op}`);
  }
  const result = interpretEventMetadataNode(node.input, rows, sessionScope);
  const where = node.where as CoreEventMetadataFilter;
  return {
    rows: result.rows
      .filter((row) => where.season === undefined || matchesValue(row.season, where.season))
      .filter((row) => where.round === undefined || row.round === where.round),
    sessionScope: where.session_scope ?? result.sessionScope
  };
}

function getSourceName(node: CorePipelineNode | CoreDeltaNode): string {
  if (node.op === 'source') {
    return node.source;
  }
  if (node.op === 'delta') {
    return getSourceName(node.input.input.left);
  }
  if (node.op === 'aggregate') {
    return node.input.op === 'join' ? getSourceName(node.input.left) : getSourceName(node.input);
  }
  return getSourceName(node.input);
}

function getAggregateRoot(program: CoreProgram): CoreAggregateNode {
  if (program.root.op === 'limit' && program.root.input.op === 'sort' && program.root.input.input.op === 'aggregate') {
    return program.root.input.input;
  }
  if (program.root.op === 'sort' && program.root.input.op === 'aggregate') {
    return program.root.input;
  }
  if (program.root.op === 'aggregate') {
    return program.root;
  }
  throw new Error('Expected a standings aggregate core program');
}

export function interpretLapPaceProgram(program: CoreProgram, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  if (program.root.op === 'delta') {
    return interpretPaceDelta(program.root, rows);
  }
  if (program.root.op === 'comparison_summary') {
    throw new Error('interpretLapPaceProgram does not accept comparison summaries');
  }
  if (program.root.op === 'compose') {
    throw new Error('interpretLapPaceProgram does not accept compositions');
  }
  const result = interpretPacePipeline(program.root, rows);
  const driverId = getPaceConstant(program.root, 'driver_id');
  if (driverId === undefined) {
    throw new Error('Lap pace summary requires a driver filter');
  }
  return result.map((row) => ({ driver_id: driverId, methodology_version: 'clean_air_gap_2_0s_v1', ...row }));
}

function interpretPaceDelta(node: CoreDeltaNode, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  const comparisons = interpretPaceCompare(node.input, rows);
  const driverAValues = comparisons.map((row) => row.driver_a_median as number);
  const driverBValues = comparisons.map((row) => row.driver_b_median as number);
  const driverAAvg = mean(driverAValues);
  const driverBAvg = mean(driverBValues);

  return [{
    driver_a_id: node.left_id,
    driver_b_id: node.right_id,
    methodology_version: 'clean_air_gap_2_0s_v1',
    shared_events: comparisons.length,
    driver_a_avg_lap_time_seconds: driverAAvg,
    driver_b_avg_lap_time_seconds: driverBAvg,
    delta_seconds: driverAAvg === null || driverBAvg === null ? null : driverAAvg - driverBAvg,
    delta_percent: driverAAvg === null || driverBAvg === null || driverBAvg === 0
      ? null
      : ((driverAAvg - driverBAvg) / driverBAvg) * 100
  }];
}

function matchesFilter(row: StandingsRow, filter: StandingsFilter): boolean {
  return matchesValue(row.season, filter.season) && matchesValue(row.driver_id, filter.driver_id);
}

function matchesValue<T>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

function compareClassificationRows(
  left: EventClassificationRow | QualifyingClassificationRow,
  right: EventClassificationRow | QualifyingClassificationRow,
  field: string,
  direction: 1 | -1,
  nulls: 'first' | 'last' | undefined
): number {
  const leftValue = left[field as keyof typeof left] as number | null;
  const rightValue = right[field as keyof typeof right] as number | null;
  if (leftValue === null || rightValue === null) {
    if (leftValue === rightValue) {
      return left.driver_id.localeCompare(right.driver_id);
    }
    if (leftValue === null) {
      return nulls === 'first' ? -1 : 1;
    }
    return nulls === 'first' ? 1 : -1;
  }
  return (leftValue - rightValue) * direction || left.driver_id.localeCompare(right.driver_id);
}

function evaluateMeasure(measure: AggregateMeasure, rows: StandingsRow[]): number | null {
  if (measure.function === 'count') {
    return rows.length;
  }
  const values = rows
    .map((row) => row[measure.field!])
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) {
    return null;
  }
  if (measure.function === 'sum') {
    return values.reduce((sum, value) => sum + value, 0);
  }
  if (measure.function === 'min') {
    return Math.min(...values);
  }
  return Math.max(...values);
}

function limitRows(rows: Array<Record<string, unknown>>, node: CoreLimitNode): Array<Record<string, unknown>> {
  if (node.input.op !== 'sort') {
    throw new Error('Expected a sort before limit');
  }
  const sort = node.input;
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows]
    .sort((a, b) => {
      const aValue = Number(a[sort.by]);
      const bValue = Number(b[sort.by]);
      if (aValue !== bValue) {
        return (aValue - bValue) * direction;
      }
      return String(a.driver_id).localeCompare(String(b.driver_id));
    })
    .slice(0, node.limit);
}

function interpretPacePipeline(node: CorePipelineNode, rows: PaceLapRow[]): Array<Record<string, unknown>> {
  if (node.op === 'source') {
    if (node.source !== 'lap_pace') {
      throw new Error(`interpretLapPaceProgram received ${node.source}`);
    }
    return rows.map((row) => ({ ...row }));
  }
  if (node.op === 'filter') {
    const where = node.where as CoreLapPaceFilter;
    return interpretPacePipeline(node.input, rows)
      .filter((row) => matchesLapPaceFilter(row as unknown as PaceLapRow, where));
  }
  if (node.op === 'aggregate') {
    if (node.input.op === 'join') {
      throw new Error('Lap pace does not support joined aggregates');
    }
    const input = interpretPacePipeline(node.input, rows);
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of input) {
      const key = JSON.stringify(node.group_by.map((field) => row[field]));
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    if (node.group_by.length === 0 && groups.size === 0) {
      groups.set('[]', []);
    }
    return Array.from(groups.values()).filter((group) => node.minimum_rows === undefined || group.length >= node.minimum_rows).map((group) => {
      const output: Record<string, unknown> = {};
      for (const field of node.group_by) {
        output[field] = group[0]?.[field];
      }
      for (const measure of node.measures) {
        output[measure.as] = evaluatePaceMeasure(measure, group);
      }
      return output;
    });
  }
  throw new Error(`Unsupported lap pace core operator ${node.op}`);
}

function interpretPaceCompare(node: CoreDeltaNode['input'], rows: PaceLapRow[]): Array<Record<string, unknown>> {
  if (node.op !== 'compare') {
    throw new Error(`Expected lap pace compare, received ${node.op}`);
  }
  return interpretPaceJoin(node.input, rows).map(({ left, right }) => ({
    [node.left.as]: left[node.left.field],
    [node.right.as]: right[node.right.field]
  }));
}

function interpretPaceJoin(node: CoreDeltaNode['input']['input'], rows: PaceLapRow[]): Array<{ left: Record<string, unknown>; right: Record<string, unknown> }> {
  if (node.op !== 'join') {
    throw new Error(`Expected lap pace join, received ${node.op}`);
  }
  const left = interpretPacePipeline(node.left, rows);
  const right = interpretPacePipeline(node.right, rows);
  return left.flatMap((leftRow) => right
    .filter((rightRow) => node.on.every((field) => leftRow[field] === rightRow[field]))
    .map((rightRow) => ({ left: leftRow, right: rightRow })));
}

function evaluatePaceMeasure(measure: CoreAggregateNode['measures'][number], rows: Array<Record<string, unknown>>): number | null {
  if (measure.function === 'count') {
    return rows.length;
  }
  const values = rows
    .map((row) => row[measure.field!])
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) {
    return null;
  }
  if (measure.function === 'median') {
    return median(values);
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getPaceConstant(node: CorePipelineNode, field: keyof CoreLapPaceFilter): unknown {
  if (node.op === 'source') {
    return undefined;
  }
  if (node.op === 'filter') {
    return (node.where as CoreLapPaceFilter)[field] ?? getPaceConstant(node.input, field);
  }
  if (node.op === 'aggregate') {
    return node.input.op === 'join' ? undefined : getPaceConstant(node.input, field);
  }
  return getPaceConstant(node.input, field);
}

function matchesLapPaceFilter(row: PaceLapRow, filter: CoreLapPaceFilter): boolean {
  const matchesRounds = filter.rounds === undefined ? true : filter.rounds.includes(row.round);
  const matchesCleanAir = filter.clean_air_only ? row.clean_air_flag : true;
  const matchesCompound = filter.compound === undefined ? true : row.compound === filter.compound;
  return [
    row.season === filter.season,
    row.driver_id === filter.driver_id,
    matchesRounds,
    row.lap_time_seconds !== null,
    row.is_valid_lap,
    !row.is_pit_lap,
    !row.is_in_lap,
    !row.is_out_lap,
    row.session_type === undefined || row.session_type === 'R',
    row.methodology_version === undefined || row.methodology_version === 'clean_air_gap_2_0s_v1',
    matchesCleanAir,
    matchesCompound
  ].every(Boolean);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
