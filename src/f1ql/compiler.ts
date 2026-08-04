import { StandingsFilter } from './ast';
import { CORE_COMPARISON_SUMMARY_SIGNATURES, CoreAggregateNode, CoreComparisonSummaryNode, CoreComposeNode, CoreDeltaNode, CoreEventClassificationFilter, CoreEventMetadataFilter, CoreJoinNode, CoreLapPaceFilter, CoreLimitNode, CoreOfficialEventMeanFilter, CoreOfficialLapTimingFilter, CorePipelineNode, CoreProgram, CoreQualifyingClassificationFilter, CoreSourceNode } from './core';
import { MINIMUM_ELIGIBLE_LAPS_PER_EVENT } from './lower';
import { MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS, OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS, OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';
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
import { FINAL_STANDINGS_SOURCE_INTEGRITY_FIELD } from './final-standings-response-contract';

export const CLEAN_AIR_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';

export interface CompiledF1QL {
  sql: string;
  params: unknown[];
}

export function compileF1QL(program: CoreProgram): CompiledF1QL {
  if (program.root.op === 'compose') {
    return compileCompose(program.root);
  }
  if (isDriverCareerWinsAggregate(program.root)) {
    return compileDriverCareerWinsByCircuit(program.root);
  }
  if (isQualifyingCountRoot(program.root)) {
    return compileQualifyingCount(program.root);
  }
  if (program.root.op === 'comparison_summary') {
    return compileComparisonSummary(program.root);
  }
  if (getSource(program.root as CorePipelineNode | CoreDeltaNode).source === 'official_lap_timing') {
    return program.root.op === 'delta' && program.root.metric_id === OFFICIAL_EVENT_MEAN_METRIC_ID
      ? compileOfficialEventMean(program.root)
      : compileOfficialLapWindow(program.root);
  }
  if (getSource(program.root as CorePipelineNode | CoreDeltaNode).source === 'lap_pace') {
    return compileLapPace(program.root);
  }
  if (getSource(program.root as CorePipelineNode).source === 'event_classification') {
    return compileEventClassification(program.root as CorePipelineNode);
  }
  if (getSource(program.root as CorePipelineNode).source === 'qualifying_classification') {
    return compileQualifyingClassification(program.root as CorePipelineNode);
  }
  if (getSource(program.root as CorePipelineNode).source === 'event_metadata') {
    return compileEventMetadata(program.root as CorePipelineNode);
  }
  const aggregate = getAggregateRoot(program);
  const { whereSql, params } = compileStandingsFilter(aggregate.input.op === 'filter' ? aggregate.input.where : {});
  const measures = aggregate.measures.map((measure) => {
    if (measure.function === 'count') {
      return `COUNT(*)::integer AS ${measure.as}`;
    }
    const field = measure.field === 'points' ? 'points' : 'championship_position';
    return `${measure.function.toUpperCase()}(${field}) AS ${measure.as}`;
  });
  const rankSql = program.root.op === 'limit' ? compileLimit(program.root) : '';
  const finalStandingsPoints = isFinalStandingsPointsAggregate(aggregate);
  const integrityProjection = finalStandingsPoints
    ? `, NOT EXISTS (
          SELECT 1 FROM f1ql.driver_standings AS f1ql_integrity_source
          WHERE f1ql_integrity_source.season = ANY($1::integer[])
          GROUP BY f1ql_integrity_source.season, f1ql_integrity_source.driver_id
          HAVING COUNT(*) > 1
        ) AS "${FINAL_STANDINGS_SOURCE_INTEGRITY_FIELD}"`
    : '';

  return {
    sql: `
      SELECT driver_id, ${measures.join(', ')}${integrityProjection}
      FROM f1ql.driver_standings
      ${whereSql}
      GROUP BY driver_id
      ${rankSql}
    `,
    params
  };
}

// eslint-disable-next-line complexity
function isFinalStandingsPointsAggregate(aggregate: CoreAggregateNode): boolean {
  const where = aggregate.input.op === 'filter' ? aggregate.input.where as StandingsFilter : undefined;
  return aggregate.input.op === 'filter' && aggregate.input.input.op === 'source' &&
    aggregate.input.input.source === 'standings' && typeof where?.season === 'number' &&
    (where.driver_id === undefined ||
      (Array.isArray(where.driver_id) && where.driver_id.length >= 1 && where.driver_id.length <= 4)) &&
    aggregate.group_by.length === 1 && aggregate.group_by[0] === 'driver_id' &&
    aggregate.measures.length === 1 && aggregate.measures[0].as === 'points' &&
    aggregate.measures[0].function === 'max' && aggregate.measures[0].field === 'points';
}

function isQualifyingCountRoot(root: CoreProgram['root']): root is CoreAggregateNode | (Extract<CoreProgram['root'], { op: 'sort' }> & { input: CoreAggregateNode }) {
  return (root.op === 'aggregate' && root.source_record_integrity !== undefined) ||
    (root.op === 'sort' && root.input.op === 'aggregate' && root.input.source_record_integrity !== undefined);
}

// This compiler check intentionally does not rely on the validator's plan extraction.
// eslint-disable-next-line complexity,max-lines-per-function
function compileQualifyingCount(root: CoreAggregateNode | (Extract<CoreProgram['root'], { op: 'sort' }> & { input: CoreAggregateNode })): CompiledF1QL {
  const ranked = root.op === 'sort';
  const node = ranked ? root.input : root;
  const input = node.input;
  const where = input.op === 'filter' ? input.where as Record<string, unknown> : undefined;
  const measure = node.measures[0];
  const metric = node.metric_id;
  const p1 = metric === DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID || metric === DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID;
  const topTen = metric === DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID || metric === SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID;
  if (input.op !== 'filter' || input.input.op !== 'source' || input.input.source !== 'qualifying_classification' || !where ||
      node.measures.length !== 1 || (!p1 && !topTen) ||
      JSON.stringify(measure) !== JSON.stringify({
        as: p1 ? 'qualifying_p1_count' : 'qualifying_top_ten_count', function: 'count',
        where: { field: 'qualifying_position', min: QUALIFYING_POSITION_MIN, max: p1 ? QUALIFYING_POSITION_MIN : QUALIFYING_TOP_TEN_MAX }
      }) || JSON.stringify(node.source_record_integrity) !== JSON.stringify({
        key: ['season', 'round', 'driver_id'], position_field: 'qualifying_position',
        position_min: QUALIFYING_POSITION_MIN, position_max: QUALIFYING_POSITION_MAX,
        require_source_presence: true, require_non_null_keys: true, require_unique_keys: true, require_unique_positions: true
      }) || node.source_integrity !== undefined || JSON.stringify(node.group_by) !== JSON.stringify(ranked ? ['driver_id'] : []) ||
      (ranked && (root.by !== 'qualifying_top_ten_count' || root.direction !== 'desc' || root.nulls !== undefined))) {
    throw new Error('Expected the closed qualifying count aggregate');
  }
  const career = metric === DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID;
  const keys = Object.keys(where).sort();
  const season = where.season;
  const driverId = where.driver_id;
  if (ranked !== (metric === SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID) ||
      JSON.stringify(keys) !== JSON.stringify(ranked ? ['season'] : ['driver_id', 'season']) ||
      (career ? JSON.stringify(season) !== JSON.stringify(COMPLETED_QUALIFYING_SEASONS) :
        typeof season !== 'number' || !Number.isSafeInteger(season) || season < 1950 || season > 2025) ||
      (!ranked && (typeof driverId !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(driverId)))) {
    throw new Error('Expected exact qualifying count scope and identity');
  }
  const countAlias = p1 ? 'qualifying_p1_count' : 'qualifying_top_ten_count';
  const params: unknown[] = [season];
  const driverClause = ranked ? '' : ` AND driver_id = $${params.push(driverId)}`;
  const countMinParam = params.push(QUALIFYING_POSITION_MIN);
  const countMaxParam = params.push(p1 ? QUALIFYING_POSITION_MIN : QUALIFYING_TOP_TEN_MAX);
  const metricParam = params.push(metric);
  const seasonClause = career ? 'season = ANY($1::integer[])' : 'season = $1';
  const groupedDriver = ranked ? 'driver_id, ' : '';
  const groupBy = ranked ? ' GROUP BY driver_id' : '';
  const selectedDriver = ranked ? 'counts.driver_id' : `${driverClause ? '$2' : 'NULL'}::text`;
  const invalidDriver = ranked ? 'NULL::text' : `${driverClause ? '$2' : 'NULL'}::text`;
  return {
    sql: `
      WITH season_source AS (
        SELECT season, round, driver_id, qualifying_position
        FROM f1ql.qualifying_classification
        WHERE ${seasonClause}
      ),
      scoped_source AS (
        SELECT * FROM season_source
        WHERE TRUE${driverClause}
      ),
      position_integrity AS (
        SELECT COALESCE(sum(position_rows - 1), 0)::integer AS duplicate_qualifying_position_rows
        FROM (
          SELECT count(*)::integer AS position_rows
          FROM season_source
          WHERE round IS NOT NULL AND qualifying_position BETWEEN $${countMinParam} AND $${countMaxParam}
          GROUP BY season, round, qualifying_position
          HAVING count(*) > 1
        ) AS duplicate_positions
      ),
      integrity AS (
        SELECT
          count(*)::integer AS qualifying_source_rows,
          count(DISTINCT (season, round, driver_id)) FILTER (WHERE season IS NOT NULL AND round IS NOT NULL AND driver_id IS NOT NULL)::integer AS distinct_qualifying_keys,
          count(*) FILTER (WHERE season IS NULL OR round IS NULL OR driver_id IS NULL)::integer AS missing_qualifying_key_rows,
          (count(*) FILTER (WHERE season IS NOT NULL AND round IS NOT NULL AND driver_id IS NOT NULL) -
            count(DISTINCT (season, round, driver_id)) FILTER (WHERE season IS NOT NULL AND round IS NOT NULL AND driver_id IS NOT NULL))::integer AS duplicate_qualifying_rows,
           count(*) FILTER (WHERE qualifying_position IS NOT NULL AND (qualifying_position < ${QUALIFYING_POSITION_MIN} OR qualifying_position > ${QUALIFYING_POSITION_MAX}))::integer AS invalid_qualifying_position_rows,
           (SELECT duplicate_qualifying_position_rows FROM position_integrity) AS duplicate_qualifying_position_rows
        FROM scoped_source
      ),
      checked_integrity AS (
        SELECT *,
          qualifying_source_rows > 0 AS source_presence_ok,
          missing_qualifying_key_rows = 0 AND duplicate_qualifying_rows = 0 AS source_key_integrity_ok,
          invalid_qualifying_position_rows = 0 AND duplicate_qualifying_position_rows = 0 AS position_integrity_ok,
          qualifying_source_rows > 0 AND missing_qualifying_key_rows = 0 AND duplicate_qualifying_rows = 0 AND invalid_qualifying_position_rows = 0 AND duplicate_qualifying_position_rows = 0 AS source_integrity_ok
        FROM integrity
      ),
      counts AS (
        SELECT ${groupedDriver}count(*) FILTER (WHERE qualifying_position BETWEEN $${countMinParam} AND $${countMaxParam})::integer AS ${countAlias}
        FROM scoped_source CROSS JOIN checked_integrity
        WHERE source_integrity_ok${groupBy}
      )
      SELECT * FROM (
        SELECT $${metricParam}::text AS metric_id, ${selectedDriver} AS driver_id, counts.${countAlias},
          integrity.qualifying_source_rows, integrity.distinct_qualifying_keys, integrity.missing_qualifying_key_rows,
          integrity.duplicate_qualifying_rows, integrity.invalid_qualifying_position_rows, integrity.duplicate_qualifying_position_rows,
          integrity.source_presence_ok, integrity.source_key_integrity_ok, integrity.position_integrity_ok, integrity.source_integrity_ok
        FROM counts CROSS JOIN checked_integrity AS integrity
        WHERE integrity.source_integrity_ok
        UNION ALL
        SELECT $${metricParam}::text, ${invalidDriver}, NULL::integer,
          integrity.qualifying_source_rows, integrity.distinct_qualifying_keys, integrity.missing_qualifying_key_rows,
          integrity.duplicate_qualifying_rows, integrity.invalid_qualifying_position_rows, integrity.duplicate_qualifying_position_rows,
          integrity.source_presence_ok, integrity.source_key_integrity_ok, integrity.position_integrity_ok, integrity.source_integrity_ok
        FROM checked_integrity AS integrity
        WHERE NOT integrity.source_integrity_ok
      ) AS qualifying_counts${ranked ? ` ORDER BY ${countAlias} DESC NULLS LAST, driver_id COLLATE "C" ASC NULLS LAST` : ''}
    `,
    params
  };
}

function compileCompose(node: CoreComposeNode): CompiledF1QL {
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(node.metric_id) || node.require_exactly_one_row_per_input !== true || node.inputs.length < 2 || node.inputs.length > 8 || node.select.length < 1 || node.select.length > 100) {
    throw new Error('Expected a bounded scalar composition');
  }
  if (node.metric_id !== OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID) {
    throw new Error('Unsupported composition metric');
  }
  validateOfficialComposePlan(node);
  const params: unknown[] = [];
  const aliases = new Set<string>();
  const fields = new Map<string, Set<string>>();
  const ctes = node.inputs.map(({ as, input, require }) => {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(as) || aliases.has(as)) {
      throw new Error('Compose input aliases must be unique bounded identifiers');
    }
    aliases.add(as);
    const available = composeInputFields(input, require);
    fields.set(as, available);
    const compiled = compileF1QL({ version: 1, root: input });
    const sql = rebaseSqlParams(compiled.sql, params.length);
    params.push(...compiled.params);
    return require === undefined
      ? `${as} AS (${sql})`
      : `${as} AS (SELECT * FROM (${sql}) AS composed_input WHERE ${require.field} = ${require.equals} AND ${require.non_null_fields.map(field => `${field} IS NOT NULL`).join(' AND ')})`;
  });
  const outputAliases = new Set<string>();
  const selections = node.select.map(selection => {
    if (!aliases.has(selection.input) || !fields.get(selection.input)?.has(selection.field) || !/^[a-z][a-z0-9_]{0,99}$/.test(selection.as) || outputAliases.has(selection.as)) {
      throw new Error('Compose selections require known inputs and unique bounded identifiers');
    }
    outputAliases.add(selection.as);
    return `${selection.input}.${selection.field} AS ${selection.as}`;
  });
  params.push(node.metric_id);
  return {
    sql: `WITH ${ctes.join(',\n')} SELECT $${params.length}::text AS metric_id, ${selections.join(', ')} FROM ${Array.from(aliases).join(' CROSS JOIN ')}`,
    params
  };
}

function validateOfficialComposePlan(node: CoreComposeNode): void {
  if (JSON.stringify(node.inputs.map(input => input.as)) !== JSON.stringify(OFFICIAL_DRIVER_RESULTS_COMPARISON_INPUT_ALIASES) ||
      JSON.stringify(node.select) !== JSON.stringify(OFFICIAL_DRIVER_RESULTS_COMPARISON_SELECT)) {
    throw new Error('Official driver results composition requires the exact inputs and projection contract');
  }
  const [standingA, standingB, race, qualifying] = node.inputs;
  if (standingA.input.op !== 'aggregate' || standingB.input.op !== 'aggregate' || race.input.op !== 'comparison_summary' || qualifying.input.op !== 'comparison_summary') {
    throw new Error('Official driver results composition input types changed');
  }
  const whereA = standingA.input.input.op === 'filter' ? standingA.input.input.where as Record<string, unknown> : {};
  const whereB = standingB.input.input.op === 'filter' ? standingB.input.input.where as Record<string, unknown> : {};
  const racePlan = comparisonSummaryPlan(race.input);
  const qualifyingPlan = comparisonSummaryPlan(qualifying.input);
  if (racePlan.season < OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MIN || racePlan.season > OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MAX ||
      race.input.metric_id !== RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID || qualifying.input.metric_id !== QUALIFYING_SEASON_POSITION_H2H_METRIC_ID ||
      race.input.lower_is_better !== true || qualifying.input.lower_is_better !== true ||
      race.input.require_unique_source_keys !== true || qualifying.input.require_unique_source_keys !== true ||
      race.input.require_source_presence !== true || qualifying.input.require_source_presence !== true ||
      racePlan.table !== 'f1ql.event_classification' || qualifyingPlan.table !== 'f1ql.qualifying_classification' ||
      whereA.season !== racePlan.season || whereB.season !== racePlan.season || qualifyingPlan.season !== racePlan.season ||
      whereA.driver_id !== racePlan.leftId || whereB.driver_id !== racePlan.rightId ||
      qualifyingPlan.leftId !== racePlan.leftId || qualifyingPlan.rightId !== racePlan.rightId ||
      racePlan.round !== undefined || qualifyingPlan.round !== undefined) {
    throw new Error('Official driver results composition branches must share one season and ordered drivers');
  }
}

function composeInputFields(input: CoreComposeNode['inputs'][number]['input'], require: CoreComposeNode['inputs'][number]['require']): Set<string> {
  if (input.op === 'comparison_summary') {
    comparisonSummaryPlan(input);
    if (require !== undefined) {
      throw new Error('Comparison summary inputs cannot add scalar count requirements');
    }
    return new Set(['metric_id', 'season', 'driver_a_id', 'driver_b_id', 'driver_a_ahead', 'driver_b_ahead', 'ties', 'shared_events', 'driver_a_source_rows', 'driver_b_source_rows', 'distinct_source_keys', 'duplicate_source_rows', 'source_presence_ok', 'source_unique_keys_ok', 'source_integrity_ok']);
  }
  const aggregateInput = input.input;
  const where = aggregateInput.op === 'filter' ? aggregateInput.where as Record<string, unknown> : undefined;
  if (aggregateInput.op !== 'filter' || aggregateInput.input.op !== 'source' || aggregateInput.input.source !== 'standings' ||
      JSON.stringify(Object.keys(where ?? {}).sort()) !== JSON.stringify(['driver_id', 'season']) ||
      typeof where?.season !== 'number' || typeof where.driver_id !== 'string' || JSON.stringify(input.group_by) !== JSON.stringify(['driver_id']) ||
      JSON.stringify(input.measures) !== JSON.stringify([
        { as: 'championship_position', function: 'min', field: 'championship_position' },
        { as: 'points', function: 'max', field: 'points' },
        { as: 'standing_rows', function: 'count' }
      ]) || JSON.stringify(require) !== JSON.stringify({ field: 'standing_rows', equals: 1, non_null_fields: ['championship_position', 'points'] })) {
    throw new Error('Compose standings inputs require the exact scalar driver integrity aggregate');
  }
  return new Set(['driver_id', 'championship_position', 'points', 'standing_rows']);
}

function rebaseSqlParams(sql: string, offset: number): string {
  return offset === 0 ? sql : sql.replace(/\$(\d+)/g, (_, value: string) => `$${Number(value) + offset}`);
}

function isDriverCareerWinsAggregate(node: CoreProgram['root']): node is CoreAggregateNode & { input: CoreJoinNode } {
  return node.op === 'aggregate' && node.input.op === 'join';
}

// eslint-disable-next-line complexity,max-lines-per-function
function compileDriverCareerWinsByCircuit(node: CoreAggregateNode & { input: CoreJoinNode }): CompiledF1QL {
  const { left, right } = node.input;
  const integrity = node.source_integrity;
  if (node.input.type !== 'left' || JSON.stringify(node.input.on) !== JSON.stringify(['season', 'round']) ||
      left.op !== 'filter' || left.input.op !== 'filter' || left.input.input.op !== 'source' || left.input.input.source !== 'event_classification' ||
      right.op !== 'filter' || right.input.op !== 'source' || right.input.source !== 'event_metadata' ||
      JSON.stringify(node.group_by) !== JSON.stringify(['circuit_id']) ||
      JSON.stringify(node.measures) !== JSON.stringify([{ as: 'wins', function: 'count' }]) ||
      JSON.stringify(integrity) !== JSON.stringify({
        left_key: ['season', 'round'], left_key_scope: 'before_outer_filter', right_key: ['season', 'round'], require_unique_left_keys: true,
        require_exactly_one_right_match: true, require_non_null_right_fields: ['circuit_id']
      })) {
    throw new Error('Expected the closed joined career race-wins aggregate');
  }
  const leftWhere = left.where as CoreEventClassificationFilter;
  const winnerWhere = left.input.where as CoreEventClassificationFilter;
  const rightWhere = right.where as CoreEventMetadataFilter;
  if (JSON.stringify(Object.keys(leftWhere).sort()) !== JSON.stringify(['driver_id']) ||
      JSON.stringify(Object.keys(winnerWhere).sort()) !== JSON.stringify(['finishing_position', 'season']) ||
      JSON.stringify(Object.keys(rightWhere).sort()) !== JSON.stringify(['season']) ||
      JSON.stringify(winnerWhere.season) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS) ||
      JSON.stringify(rightWhere.season) !== JSON.stringify(DRIVER_CAREER_WIN_SEASONS) ||
      JSON.stringify(winnerWhere.finishing_position) !== JSON.stringify([1]) ||
      typeof leftWhere.driver_id !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(leftWhere.driver_id)) {
    throw new Error('Expected exact career scope, driver, and race P1 filters');
  }
  const params = [DRIVER_CAREER_WIN_SEASONS, leftWhere.driver_id, DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID];
  return {
    sql: `
      WITH all_p1_source AS (
        SELECT season, round, driver_id
        FROM f1ql.event_classification
        WHERE season = ANY($1::integer[]) AND finishing_position = 1
      ),
      requested_winner_events AS (
        SELECT DISTINCT season, round
        FROM all_p1_source
        WHERE driver_id = $2
      ),
      winner_keys AS (
        SELECT source.season, source.round, count(*)::integer AS source_rows
        FROM all_p1_source AS source
        JOIN requested_winner_events AS requested USING (season, round)
        GROUP BY source.season, source.round
      ),
      metadata_keys AS (
        SELECT season, round, count(*)::integer AS source_rows, min(circuit_id) AS circuit_id
        FROM f1ql.event_metadata
        WHERE season = ANY($1::integer[])
        GROUP BY season, round
      ),
      joined_keys AS (
        SELECT winners.*, metadata.source_rows AS metadata_rows, metadata.circuit_id
        FROM winner_keys AS winners
        LEFT JOIN metadata_keys AS metadata USING (season, round)
      ),
      integrity AS (
        SELECT
          coalesce(sum(source_rows), 0)::integer AS winner_source_rows,
          count(*)::integer AS distinct_winner_event_keys,
          coalesce(sum(source_rows - 1), 0)::integer AS duplicate_winner_rows,
          coalesce(sum(metadata_rows), 0)::integer AS metadata_source_rows,
          count(*) FILTER (WHERE metadata_rows IS NOT NULL)::integer AS distinct_metadata_event_keys,
          count(*) FILTER (WHERE metadata_rows IS NULL)::integer AS missing_event_metadata_rows,
          coalesce(sum(greatest(metadata_rows - 1, 0)), 0)::integer AS duplicate_event_metadata_rows,
          count(*) FILTER (WHERE metadata_rows = 1 AND nullif(btrim(circuit_id), '') IS NULL)::integer AS missing_circuit_id_rows
        FROM joined_keys
      ),
      checked_integrity AS (
        SELECT *, winner_source_rows > 0 AS source_presence_ok,
          duplicate_winner_rows = 0 AND missing_event_metadata_rows = 0 AND
          duplicate_event_metadata_rows = 0 AND missing_circuit_id_rows = 0 AS source_integrity_ok
        FROM integrity
      ),
      grouped AS (
        SELECT joined.circuit_id, count(*)::integer AS wins
        FROM joined_keys AS joined CROSS JOIN checked_integrity AS integrity
        WHERE integrity.source_integrity_ok
        GROUP BY joined.circuit_id
      )
      SELECT * FROM (
      SELECT $3::text AS metric_id, $2::text AS driver_id, grouped.circuit_id, grouped.wins,
        integrity.winner_source_rows, integrity.distinct_winner_event_keys, integrity.duplicate_winner_rows,
        integrity.metadata_source_rows, integrity.distinct_metadata_event_keys, integrity.missing_event_metadata_rows,
        integrity.duplicate_event_metadata_rows, integrity.missing_circuit_id_rows,
        integrity.source_presence_ok, integrity.source_integrity_ok
      FROM grouped CROSS JOIN checked_integrity AS integrity
      UNION ALL
      SELECT $3::text, $2::text, NULL::text, NULL::integer,
        integrity.winner_source_rows, integrity.distinct_winner_event_keys, integrity.duplicate_winner_rows,
        integrity.metadata_source_rows, integrity.distinct_metadata_event_keys, integrity.missing_event_metadata_rows,
        integrity.duplicate_event_metadata_rows, integrity.missing_circuit_id_rows,
        integrity.source_presence_ok, integrity.source_integrity_ok
      FROM checked_integrity AS integrity
      WHERE integrity.source_presence_ok AND NOT integrity.source_integrity_ok
      ) AS career_results
      ORDER BY wins DESC NULLS LAST, circuit_id COLLATE "C" ASC NULLS LAST
    `,
    params
  };
}

const COMPARISON_SUMMARY_SQL_SOURCES: Record<keyof typeof CORE_COMPARISON_SUMMARY_SIGNATURES, { table: string; field: string }> = {
  event_classification: { table: 'f1ql.event_classification', field: 'finishing_position' },
  qualifying_classification: { table: 'f1ql.qualifying_classification', field: 'qualifying_position' }
};

// eslint-disable-next-line max-lines-per-function
function compileComparisonSummary(node: CoreComparisonSummaryNode): CompiledF1QL {
  const { season, round, leftId, rightId, table, field } = comparisonSummaryPlan(node);
  const params = round === undefined
    ? [season, leftId, rightId, node.metric_id, node.lower_is_better]
    : [season, round, leftId, rightId, node.metric_id, node.lower_is_better];
  const leftParam = round === undefined ? 2 : 3;
  const rightParam = leftParam + 1;
  const metricParam = rightParam + 1;
  const directionParam = metricParam + 1;
  const roundClause = round === undefined ? '' : ' AND round = $2';
  return {
    sql: `
      WITH scoped_source AS (
        SELECT season, round, driver_id, ${field} AS comparison_value
        FROM ${table}
        WHERE season = $1${roundClause} AND driver_id IN ($${leftParam}, $${rightParam})
      ),
      source_integrity AS (
        SELECT
          count(*) FILTER (WHERE driver_id = $${leftParam})::integer AS driver_a_source_rows,
          count(*) FILTER (WHERE driver_id = $${rightParam})::integer AS driver_b_source_rows,
          count(DISTINCT (season, round, driver_id))::integer AS distinct_source_keys,
          (count(*) - count(DISTINCT (season, round, driver_id)))::integer AS duplicate_source_rows
        FROM scoped_source
      ),
      unique_shared_rounds AS (
        SELECT
          round,
          max(comparison_value) FILTER (WHERE driver_id = $${leftParam}) AS driver_a_value,
          max(comparison_value) FILTER (WHERE driver_id = $${rightParam}) AS driver_b_value
        FROM scoped_source
        GROUP BY round
        HAVING count(*) FILTER (WHERE driver_id = $${leftParam}) = 1
           AND count(*) FILTER (WHERE driver_id = $${rightParam}) = 1
      ),
      comparison AS (
        SELECT
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL AND (($${directionParam}::boolean AND driver_a_value < driver_b_value) OR (NOT $${directionParam}::boolean AND driver_a_value > driver_b_value)))::integer AS driver_a_ahead,
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL AND (($${directionParam}::boolean AND driver_b_value < driver_a_value) OR (NOT $${directionParam}::boolean AND driver_b_value > driver_a_value)))::integer AS driver_b_ahead,
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL AND driver_a_value = driver_b_value)::integer AS ties,
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL)::integer AS shared_events
        FROM unique_shared_rounds
      )
      SELECT
        $${metricParam}::text AS metric_id,
        $1::integer AS season,
        $${leftParam}::text AS driver_a_id,
        $${rightParam}::text AS driver_b_id,
        CASE WHEN integrity.source_integrity_ok THEN comparison.driver_a_ahead ELSE NULL END AS driver_a_ahead,
        CASE WHEN integrity.source_integrity_ok THEN comparison.driver_b_ahead ELSE NULL END AS driver_b_ahead,
        CASE WHEN integrity.source_integrity_ok THEN comparison.ties ELSE NULL END AS ties,
        CASE WHEN integrity.source_integrity_ok THEN comparison.shared_events ELSE NULL END AS shared_events,
        integrity.driver_a_source_rows,
        integrity.driver_b_source_rows,
        integrity.distinct_source_keys,
        integrity.duplicate_source_rows,
        integrity.source_presence_ok,
        integrity.source_unique_keys_ok,
        integrity.source_integrity_ok
      FROM comparison
      CROSS JOIN LATERAL (
        SELECT
          source_integrity.*,
          driver_a_source_rows > 0 AND driver_b_source_rows > 0 AS source_presence_ok,
          duplicate_source_rows = 0 AS source_unique_keys_ok,
          driver_a_source_rows > 0 AND driver_b_source_rows > 0 AND duplicate_source_rows = 0${node.require_exactly_one_shared_event ? ' AND comparison.shared_events = 1' : ''} AS source_integrity_ok
        FROM source_integrity
      ) AS integrity
    `,
    params
  };
}

interface ComparisonSummaryPlan {
  season: number;
  round?: number;
  leftId: string;
  rightId: string;
  table: string;
  field: string;
}

// eslint-disable-next-line complexity
function comparisonSummaryPlan(node: CoreComparisonSummaryNode): ComparisonSummaryPlan {
  const { left, right } = node.input.input;
  if (node.input.op !== 'compare' || node.input.input.op !== 'join' || node.input.input.type !== 'inner' ||
      JSON.stringify(node.input.input.on) !== JSON.stringify(['season', 'round']) ||
      node.require_unique_source_keys !== true || node.require_source_presence !== true || typeof node.lower_is_better !== 'boolean' ||
      !/^[a-z][a-z0-9_]{0,99}$/.test(node.metric_id) || left.op !== 'filter' || right.op !== 'filter' ||
      left.input.op !== 'source' || right.input.op !== 'source' || left.input.source !== right.input.source ||
      !Object.prototype.hasOwnProperty.call(COMPARISON_SUMMARY_SQL_SOURCES, left.input.source)) {
    throw new Error('Expected filtered covered comparison-summary branches');
  }
  const source = left.input.source as keyof typeof COMPARISON_SUMMARY_SQL_SOURCES;
  const sqlSource = COMPARISON_SUMMARY_SQL_SOURCES[source];
  const signature = CORE_COMPARISON_SUMMARY_SIGNATURES[source];
  if (node.input.left.field !== sqlSource.field || node.input.right.field !== sqlSource.field ||
      node.input.left.as !== signature.comparison_aliases[0] || node.input.right.as !== signature.comparison_aliases[1]) {
    throw new Error('Expected a covered comparison-summary field');
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
      (eventScoped && (source !== 'event_classification' || node.lower_is_better !== true || sqlSource.field !== 'finishing_position')) ||
      typeof leftWhere.driver_id !== 'string' || leftWhere.driver_id.trim().length === 0 ||
      typeof rightWhere.driver_id !== 'string' || rightWhere.driver_id.trim().length === 0 || leftWhere.driver_id === rightWhere.driver_id) {
    throw new Error('Expected shared season and ordered driver filters');
  }
  return {
    season: leftWhere.season!,
    ...(leftWhere.round === undefined ? {} : { round: leftWhere.round }),
    leftId: leftWhere.driver_id,
    rightId: rightWhere.driver_id,
    table: sqlSource.table,
    field: sqlSource.field
  };
}

function compileOfficialEventMean(node: CoreProgram['root']): CompiledF1QL {
  if (node.op !== 'delta' || node.metric_id !== OFFICIAL_EVENT_MEAN_METRIC_ID || node.lower_is_better !== true) {
    throw new Error('Expected an official event-mean delta');
  }
  const left = getOfficialEventMeanFilter(node.input.input.left);
  const right = getOfficialEventMeanFilter(node.input.input.right);
  if (left.season !== right.season || left.round !== right.round || left.driver_id !== node.left_id || right.driver_id !== node.right_id) {
    throw new Error('Official event-mean inputs must share scope and match comparison drivers');
  }
  const params = [left.season, left.round, node.left_id, node.right_id];
  return {
    sql: `
      WITH event_laps AS (
        SELECT *
        FROM f1ql.official_lap_timing
        WHERE season = $1 AND round = $2 AND session_type = 'R' AND driver_id IN ($3, $4)
      ),
      driver_summaries AS (
        SELECT
          dataset_sha256, event_name, source_manifest_sha256, identity_map_sha256, fact_fingerprint, driver_id,
          count(*)::integer AS completed_laps,
          count(*) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker)::integer AS eligible_laps,
          count(*) FILTER (WHERE official_deleted_lap)::integer AS excluded_deleted_laps,
          count(*) FILTER (WHERE official_pit_marker)::integer AS excluded_pit_marker_laps,
          round((avg((lap_time_seconds * 1000)::integer) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker) / 1000.0)::numeric, 4)::double precision AS mean_lap_time_seconds
        FROM event_laps
        GROUP BY dataset_sha256, event_name, source_manifest_sha256, identity_map_sha256, fact_fingerprint, driver_id
        HAVING count(*) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker) >= ${MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS}
      ),
      comparison AS (
        SELECT
          max(dataset_sha256) AS dataset_sha256,
          max(event_name) AS event_name,
          max(source_manifest_sha256) AS source_manifest_sha256,
          max(identity_map_sha256) AS identity_map_sha256,
          max(fact_fingerprint) AS fact_fingerprint,
          max(completed_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_completed_laps,
          max(completed_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_completed_laps,
          max(eligible_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_eligible_laps,
          max(eligible_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_eligible_laps,
          max(excluded_deleted_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_excluded_deleted_laps,
          max(excluded_deleted_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_excluded_deleted_laps,
          max(excluded_pit_marker_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_excluded_pit_marker_laps,
          max(excluded_pit_marker_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_excluded_pit_marker_laps,
          max(mean_lap_time_seconds) FILTER (WHERE driver_id = $3) AS driver_a_mean_lap_time_seconds,
          max(mean_lap_time_seconds) FILTER (WHERE driver_id = $4) AS driver_b_mean_lap_time_seconds
        FROM driver_summaries
        HAVING count(*) = 2 AND count(DISTINCT driver_id) = 2 AND count(DISTINCT dataset_sha256) = 1
      )
      SELECT
        $3::text AS driver_a_id,
        $4::text AS driver_b_id,
        '${OFFICIAL_EVENT_MEAN_METRIC_ID}'::text AS metric_id,
        $1::integer AS season,
        $2::integer AS round,
        'R'::text AS session_type,
        event_name,
        driver_a_completed_laps,
        driver_b_completed_laps,
        driver_a_eligible_laps,
        driver_b_eligible_laps,
        driver_a_excluded_deleted_laps,
        driver_b_excluded_deleted_laps,
        driver_a_excluded_pit_marker_laps,
        driver_b_excluded_pit_marker_laps,
        driver_a_mean_lap_time_seconds,
        driver_b_mean_lap_time_seconds,
        round(abs(driver_a_mean_lap_time_seconds - driver_b_mean_lap_time_seconds)::numeric, 4)::double precision AS mean_delta_seconds,
        CASE
          WHEN driver_a_mean_lap_time_seconds < driver_b_mean_lap_time_seconds THEN $3::text
          WHEN driver_b_mean_lap_time_seconds < driver_a_mean_lap_time_seconds THEN $4::text
          ELSE NULL
        END AS winner_driver_id,
        dataset_sha256,
        source_manifest_sha256,
        identity_map_sha256,
        fact_fingerprint
      FROM comparison
      WHERE driver_a_mean_lap_time_seconds IS NOT NULL AND driver_b_mean_lap_time_seconds IS NOT NULL
    `,
    params
  };
}

// eslint-disable-next-line max-lines-per-function
function compileOfficialLapWindow(node: CoreProgram['root']): CompiledF1QL {
  if (node.op !== 'delta' || node.metric_id !== OFFICIAL_LAP_WINDOW_METRIC_ID || node.lower_is_better !== true) {
    throw new Error('Expected an official lap-window delta');
  }
  const left = getOfficialLapFilter(node.input.input.left);
  const right = getOfficialLapFilter(node.input.input.right);
  if (left.season !== right.season || left.round !== right.round || left.lap_start !== right.lap_start || left.lap_end !== right.lap_end ||
      left.driver_id !== node.left_id || right.driver_id !== node.right_id) {
    throw new Error('Official lap-window inputs must share scope and match comparison drivers');
  }
  const requestedLaps = left.lap_end - left.lap_start + 1;
  const params = [left.season, left.round, node.left_id, node.right_id, left.lap_start, left.lap_end, requestedLaps];
  return {
    sql: `
      WITH requested_laps AS (
        SELECT *
        FROM f1ql.official_lap_timing
        WHERE season = $1
          AND round = $2
          AND session_type = 'R'
          AND driver_id IN ($3, $4)
          AND lap_number BETWEEN $5 AND $6
      ),
      driver_summaries AS (
        SELECT
          dataset_sha256,
          event_name,
          source_manifest_sha256,
          identity_map_sha256,
          fact_fingerprint,
          driver_id,
          count(*)::integer AS requested_laps,
          count(*) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker)::integer AS eligible_laps,
          count(*) FILTER (WHERE official_deleted_lap)::integer AS excluded_deleted_laps,
          count(*) FILTER (WHERE official_pit_marker)::integer AS excluded_pit_marker_laps,
          (
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ((lap_time_seconds * 1000)::integer))
              FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker) / 1000.0
          )::double precision AS median_lap_time_seconds
        FROM requested_laps
        GROUP BY dataset_sha256, event_name, source_manifest_sha256, identity_map_sha256, fact_fingerprint, driver_id
        HAVING count(*) = $7
           AND count(DISTINCT lap_number) = $7
           AND count(*) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker) >= ${MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS}
      ),
      comparison AS (
        SELECT
          max(dataset_sha256) AS dataset_sha256,
          max(event_name) AS event_name,
          max(source_manifest_sha256) AS source_manifest_sha256,
          max(identity_map_sha256) AS identity_map_sha256,
          max(fact_fingerprint) AS fact_fingerprint,
          max(eligible_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_eligible_laps,
          max(eligible_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_eligible_laps,
          max(excluded_deleted_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_excluded_deleted_laps,
          max(excluded_deleted_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_excluded_deleted_laps,
          max(excluded_pit_marker_laps) FILTER (WHERE driver_id = $3)::integer AS driver_a_excluded_pit_marker_laps,
          max(excluded_pit_marker_laps) FILTER (WHERE driver_id = $4)::integer AS driver_b_excluded_pit_marker_laps,
          max(median_lap_time_seconds) FILTER (WHERE driver_id = $3) AS driver_a_median_lap_time_seconds,
          max(median_lap_time_seconds) FILTER (WHERE driver_id = $4) AS driver_b_median_lap_time_seconds
        FROM driver_summaries
        HAVING count(*) = 2 AND count(DISTINCT driver_id) = 2 AND count(DISTINCT dataset_sha256) = 1
      )
      SELECT
        $3::text AS driver_a_id,
        $4::text AS driver_b_id,
        '${OFFICIAL_LAP_WINDOW_METRIC_ID}'::text AS metric_id,
        $1::integer AS season,
        $2::integer AS round,
        'R'::text AS session_type,
        event_name,
        $5::integer AS lap_start,
        $6::integer AS lap_end,
        $7::integer AS requested_laps_per_driver,
        driver_a_eligible_laps,
        driver_b_eligible_laps,
        driver_a_excluded_deleted_laps,
        driver_b_excluded_deleted_laps,
        driver_a_excluded_pit_marker_laps,
        driver_b_excluded_pit_marker_laps,
        driver_a_median_lap_time_seconds,
        driver_b_median_lap_time_seconds,
        round(abs(driver_a_median_lap_time_seconds - driver_b_median_lap_time_seconds)::numeric, 4)::double precision AS median_delta_seconds,
        CASE
          WHEN driver_a_median_lap_time_seconds < driver_b_median_lap_time_seconds THEN $3::text
          WHEN driver_b_median_lap_time_seconds < driver_a_median_lap_time_seconds THEN $4::text
          ELSE NULL
        END AS winner_driver_id,
        dataset_sha256,
        source_manifest_sha256,
        identity_map_sha256,
        fact_fingerprint
      FROM comparison
      WHERE driver_a_median_lap_time_seconds IS NOT NULL
        AND driver_b_median_lap_time_seconds IS NOT NULL
    `,
    params
  };
}

function getOfficialLapFilter(node: CorePipelineNode): CoreOfficialLapTimingFilter {
  if (node.op !== 'aggregate' || node.input.op !== 'filter' || node.input.input.op !== 'source' || node.input.input.source !== 'official_lap_timing') {
    throw new Error('Expected a filtered official lap timing aggregate');
  }
  return node.input.where as CoreOfficialLapTimingFilter;
}

function getOfficialEventMeanFilter(node: CorePipelineNode): CoreOfficialEventMeanFilter {
  if (node.op !== 'aggregate' || node.input.op !== 'filter' || node.input.input.op !== 'source' || node.input.input.source !== 'official_lap_timing') {
    throw new Error('Expected a filtered official event-mean aggregate');
  }
  return node.input.where as CoreOfficialEventMeanFilter;
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

function compileEventClassification(node: CorePipelineNode): CompiledF1QL {
  const pipeline = compileEventClassificationPipeline(node);
  return {
    sql: `SELECT driver_id, finishing_position, points, classification_status, status_reason FROM f1ql.event_classification ${pipeline.where.length ? `WHERE ${pipeline.where.join(' AND ')}` : ''}${pipeline.orderBy ? ` ORDER BY ${pipeline.orderBy}, driver_id ASC` : ''}${pipeline.limit === undefined ? '' : ` LIMIT ${pipeline.limit}`}`,
    params: pipeline.params
  };
}

function compileEventClassificationPipeline(node: CorePipelineNode): { where: string[]; params: unknown[]; orderBy?: string; limit?: number } {
  if (node.op === 'source') {
    if (node.source !== 'event_classification') {
      throw new Error(`Expected event classification source, received ${node.source}`);
    }
    return { where: [], params: [] };
  }
  if (node.op === 'filter') {
    const pipeline = compileEventClassificationPipeline(node.input);
    const where = node.where as CoreEventClassificationFilter;
    appendEqualityFilter(pipeline, 'season', where.season);
    appendEqualityFilter(pipeline, 'round', where.round);
    if (where.classification_status) {
      pipeline.params.push(where.classification_status);
      pipeline.where.push(`classification_status = ANY($${pipeline.params.length}::text[])`);
    }
    if (where.driver_id) {
      pipeline.params.push(where.driver_id);
      pipeline.where.push(`driver_id = $${pipeline.params.length}`);
    }
    if (where.team_id) {
      pipeline.params.push(where.team_id);
      pipeline.where.push(`team_id = $${pipeline.params.length}`);
    }
    if (where.finishing_position) {
      pipeline.params.push(where.finishing_position);
      pipeline.where.push(`finishing_position = ANY($${pipeline.params.length}::integer[])`);
    }
    return pipeline;
  }
  if (node.op === 'sort') {
    if (node.by !== 'finishing_position') {
      throw new Error(`Unsupported event classification sort field: ${node.by}`);
    }
    const pipeline = compileEventClassificationPipeline(node.input);
    pipeline.orderBy = `${node.by} ${node.direction.toUpperCase()} NULLS ${(node.nulls ?? 'last').toUpperCase()}`;
    return pipeline;
  }
  if (node.op === 'limit') {
    const pipeline = compileEventClassificationPipeline(node.input);
    pipeline.limit = node.limit;
    return pipeline;
  }
  throw new Error(`Unsupported event classification core operator ${node.op}`);
}

function compileQualifyingClassification(node: CorePipelineNode): CompiledF1QL {
  const pipeline = compileQualifyingClassificationPipeline(node);
  return {
    sql: `SELECT driver_id, qualifying_position, best_time_ms, best_session, eliminated_in_round, classification_status FROM f1ql.qualifying_classification ${pipeline.where.length ? `WHERE ${pipeline.where.join(' AND ')}` : ''}${pipeline.orderBy ? ` ORDER BY ${pipeline.orderBy}, driver_id ASC` : ''}${pipeline.limit === undefined ? '' : ` LIMIT ${pipeline.limit}`}`,
    params: pipeline.params
  };
}

function compileQualifyingClassificationPipeline(node: CorePipelineNode): { where: string[]; params: unknown[]; orderBy?: string; limit?: number } {
  if (node.op === 'source') {
    if (node.source !== 'qualifying_classification') {
      throw new Error(`Expected qualifying classification source, received ${node.source}`);
    }
    return { where: [], params: [] };
  }
  if (node.op === 'filter') {
    const pipeline = compileQualifyingClassificationPipeline(node.input);
    const where = node.where as CoreQualifyingClassificationFilter;
    appendEqualityFilter(pipeline, 'season', where.season);
    appendEqualityFilter(pipeline, 'round', where.round);
    if (where.classification_status) {
      pipeline.params.push(where.classification_status);
      pipeline.where.push(`classification_status = ANY($${pipeline.params.length}::text[])`);
    }
    if (where.driver_id) {
      pipeline.params.push(where.driver_id);
      pipeline.where.push(`driver_id = $${pipeline.params.length}`);
    }
    if (where.team_id) {
      pipeline.params.push(where.team_id);
      pipeline.where.push(`team_id = $${pipeline.params.length}`);
    }
    if (where.qualifying_position) {
      pipeline.params.push(where.qualifying_position);
      pipeline.where.push(`qualifying_position = ANY($${pipeline.params.length}::integer[])`);
    }
    return pipeline;
  }
  if (node.op === 'sort') {
    if (node.by !== 'qualifying_position') {
      throw new Error(`Unsupported qualifying classification sort field: ${node.by}`);
    }
    const pipeline = compileQualifyingClassificationPipeline(node.input);
    pipeline.orderBy = `${node.by} ${node.direction.toUpperCase()} NULLS ${(node.nulls ?? 'last').toUpperCase()}`;
    return pipeline;
  }
  if (node.op === 'limit') {
    const pipeline = compileQualifyingClassificationPipeline(node.input);
    pipeline.limit = node.limit;
    return pipeline;
  }
  throw new Error(`Unsupported qualifying classification core operator ${node.op}`);
}

function compileEventMetadata(node: CorePipelineNode): CompiledF1QL {
  const pipeline = compileEventMetadataPipeline(node);
  return {
    sql: `SELECT event_id, event_name, circuit_id, date::text AS date, $${pipeline.params.length + 1}::text AS session_scope FROM f1ql.event_metadata${pipeline.where.length ? ` WHERE ${pipeline.where.join(' AND ')}` : ''}`,
    params: [...pipeline.params, pipeline.sessionScope]
  };
}

function compileEventMetadataPipeline(node: CorePipelineNode): { where: string[]; params: unknown[]; sessionScope: 'race' | 'qualifying' } {
  if (node.op === 'source') {
    if (node.source !== 'event_metadata') {
      throw new Error(`Expected event metadata source, received ${node.source}`);
    }
    return { where: [], params: [], sessionScope: 'race' };
  }
  if (node.op !== 'filter') {
    throw new Error(`Unsupported event metadata core operator ${node.op}`);
  }
  const pipeline = compileEventMetadataPipeline(node.input);
  const where = node.where as CoreEventMetadataFilter;
  appendEqualityFilter(pipeline, 'season', where.season);
  appendEqualityFilter(pipeline, 'round', where.round);
  if (where.session_scope !== undefined) {
    pipeline.sessionScope = where.session_scope;
  }
  return pipeline;
}

function appendEqualityFilter(pipeline: { where: string[]; params: unknown[] }, field: 'season' | 'round', value: number | number[] | undefined): void {
  if (value === undefined) {
    return;
  }
  pipeline.params.push(value);
  pipeline.where.push(Array.isArray(value) ? `${field} = ANY($${pipeline.params.length}::integer[])` : `${field} = $${pipeline.params.length}`);
}

function getSource(node: CorePipelineNode | CoreDeltaNode | CoreComparisonSummaryNode): CoreSourceNode {
  if (node.op === 'source') {
    return node;
  }
  if (node.op === 'delta') {
    return getSource(node.input.input.left);
  }
  if (node.op === 'comparison_summary') {
    return getSource(node.input.input.left);
  }
  if (node.op === 'aggregate') {
    return node.input.op === 'join' ? getSource(node.input.left) : getSource(node.input);
  }
  return getSource(node.input);
}

interface PaceFilterPlan {
  where: CoreLapPaceFilter;
}

interface PaceSourcePlan {
  source: 'lap_pace';
}

interface PaceAggregatePlan {
  input: PaceFilterPlan | PaceAggregatePlan;
  groupBy: string[];
  measures: CoreAggregateNode['measures'];
}

interface PaceJoinPlan {
  left: PaceAggregatePlan;
  right: PaceAggregatePlan;
  on: string[];
}

function compileLapPace(node: Exclude<CoreProgram['root'], CoreComparisonSummaryNode | CoreComposeNode>): CompiledF1QL {
  if (node.op === 'delta') {
    return compilePaceDelta(node);
  }
  const aggregate = compilePacePipeline(node);
  if (!isPaceAggregatePlan(aggregate) || !isPaceAggregatePlan(aggregate.input)) {
    throw new Error('Expected a final lap pace aggregate');
  }
  const filter = aggregate.input.input;
  if (!isPaceFilterPlan(filter)) {
    throw new Error('Expected a filtered lap pace aggregate');
  }
  const params = compilePaceParams(filter.where);

  return {
    sql: `
      WITH filtered_laps AS (
        SELECT round, lap_time_seconds
        FROM f1ql.lap_pace
        WHERE season = $1
          AND driver_id = $2
          AND ($3::integer[] IS NULL OR round = ANY($3::integer[]))
          AND lap_time_seconds IS NOT NULL
          AND is_valid_lap = true
          AND COALESCE(is_pit_lap, false) = false
          AND COALESCE(is_in_lap, false) = false
          AND COALESCE(is_out_lap, false) = false
          AND session_type = 'R'
          AND methodology_version = '${CLEAN_AIR_METHODOLOGY_VERSION}'
          AND (NOT $4::boolean OR COALESCE(clean_air_flag, false) = true)
          AND ($5::text IS NULL OR compound = $5::text)
      ),
      event_medians AS (
        SELECT
          round,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lap_time_seconds) AS median_lap_time_seconds
        FROM filtered_laps
        GROUP BY round
        HAVING COUNT(*) >= ${MINIMUM_ELIGIBLE_LAPS_PER_EVENT}
      )
      SELECT
        $2::text AS driver_id,
        '${CLEAN_AIR_METHODOLOGY_VERSION}'::text AS methodology_version,
        COUNT(*)::integer AS events,
        AVG(median_lap_time_seconds) AS avg_lap_time_seconds
      FROM event_medians
    `,
    params
  };
}

// The SQL text is intentionally kept contiguous to preserve the established parameter contract.
// eslint-disable-next-line max-lines-per-function
function compilePaceDelta(node: CoreDeltaNode): CompiledF1QL {
  const compare = compilePaceCompare(node.input);
  const { left, right } = compare.input;
  const leftFilter = getPaceFilter(left);
  const rightFilter = getPaceFilter(right);
  validateSharedPaceFilters(leftFilter, rightFilter);
  const params = [
    leftFilter.season,
    leftFilter.driver_id,
    rightFilter.driver_id,
    leftFilter.rounds ?? null,
    leftFilter.clean_air_only,
    leftFilter.compound ?? null
  ];

  return {
    sql: `
      WITH filtered_laps AS (
        SELECT round, driver_id, lap_time_seconds
        FROM f1ql.lap_pace
        WHERE season = $1
          AND driver_id IN ($2, $3)
          AND ($4::integer[] IS NULL OR round = ANY($4::integer[]))
          AND lap_time_seconds IS NOT NULL
          AND is_valid_lap = true
          AND COALESCE(is_pit_lap, false) = false
          AND COALESCE(is_in_lap, false) = false
          AND COALESCE(is_out_lap, false) = false
          AND session_type = 'R'
          AND methodology_version = '${CLEAN_AIR_METHODOLOGY_VERSION}'
          AND (NOT $5::boolean OR COALESCE(clean_air_flag, false) = true)
          AND ($6::text IS NULL OR compound = $6::text)
      ),
      event_medians AS (
        SELECT
          round,
          driver_id,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lap_time_seconds) AS median_lap_time_seconds
        FROM filtered_laps
        GROUP BY round, driver_id
        HAVING COUNT(*) >= ${MINIMUM_ELIGIBLE_LAPS_PER_EVENT}
      ),
      shared_events AS (
        SELECT
          round,
          MAX(median_lap_time_seconds) FILTER (WHERE driver_id = $2) AS driver_a_median,
          MAX(median_lap_time_seconds) FILTER (WHERE driver_id = $3) AS driver_b_median
        FROM event_medians
        GROUP BY round
        HAVING COUNT(DISTINCT driver_id) = 2
      )
      SELECT
        $2::text AS driver_a_id,
        $3::text AS driver_b_id,
        '${CLEAN_AIR_METHODOLOGY_VERSION}'::text AS methodology_version,
        COUNT(*)::integer AS shared_events,
        AVG(driver_a_median) AS driver_a_avg_lap_time_seconds,
        AVG(driver_b_median) AS driver_b_avg_lap_time_seconds,
        AVG(driver_a_median) - AVG(driver_b_median) AS delta_seconds,
        CASE
          WHEN AVG(driver_b_median) = 0 THEN NULL
          ELSE ((AVG(driver_a_median) - AVG(driver_b_median)) / AVG(driver_b_median)) * 100
        END AS delta_percent
      FROM shared_events
    `,
    params
  };
}

function compilePacePipeline(node: CorePipelineNode): PaceSourcePlan | PaceFilterPlan | PaceAggregatePlan {
  if (node.op === 'source') {
    if (node.source !== 'lap_pace') {
      throw new Error(`Expected lap pace source, received ${node.source}`);
    }
    return { source: node.source };
  }
  if (node.op === 'filter') {
    const input = compilePacePipeline(node.input);
    if (!isPaceSourcePlan(input)) {
      throw new Error('Lap pace filters require a lap pace source');
    }
    return { where: node.where as CoreLapPaceFilter };
  }
  if (node.op === 'aggregate') {
    if (node.input.op === 'join') {
      throw new Error('Lap pace does not support joined aggregates');
    }
    const input = compilePacePipeline(node.input);
    if (isPaceSourcePlan(input)) {
      throw new Error('Lap pace aggregates require a filter');
    }
    return { input, groupBy: node.group_by, measures: node.measures };
  }
  throw new Error(`Unsupported lap pace core operator ${node.op}`);
}

function compilePaceCompare(node: CoreDeltaNode['input']): { input: PaceJoinPlan } {
  if (node.op !== 'compare') {
    throw new Error(`Expected lap pace compare, received ${node.op}`);
  }
  return { input: compilePaceJoin(node.input) };
}

function compilePaceJoin(node: CoreDeltaNode['input']['input']): PaceJoinPlan {
  if (node.op !== 'join') {
    throw new Error(`Expected lap pace join, received ${node.op}`);
  }
  const left = compilePacePipeline(node.left);
  const right = compilePacePipeline(node.right);
  if (!isPaceAggregatePlan(left) || !isPaceAggregatePlan(right)) {
    throw new Error('Lap pace joins require aggregate inputs');
  }
  return { left, right, on: node.on };
}

function getPaceFilter(node: PaceAggregatePlan): CoreLapPaceFilter {
  let input: PaceFilterPlan | PaceAggregatePlan = node;
  while (isPaceAggregatePlan(input)) {
    input = input.input;
  }
  return input.where;
}

function compilePaceParams(filter: CoreLapPaceFilter): unknown[] {
  return [filter.season, filter.driver_id, filter.rounds ?? null, filter.clean_air_only, filter.compound ?? null];
}

function validateSharedPaceFilters(left: CoreLapPaceFilter, right: CoreLapPaceFilter): void {
  if (left.season !== right.season
    || JSON.stringify(left.rounds) !== JSON.stringify(right.rounds)
    || left.clean_air_only !== right.clean_air_only
    || left.compound !== right.compound) {
    throw new Error('Delta inputs must share lap pace eligibility filters');
  }
}

function isPaceFilterPlan(plan: PaceSourcePlan | PaceFilterPlan | PaceAggregatePlan): plan is PaceFilterPlan {
  return 'where' in plan;
}

function isPaceAggregatePlan(plan: PaceSourcePlan | PaceFilterPlan | PaceAggregatePlan): plan is PaceAggregatePlan {
  return 'groupBy' in plan;
}

function isPaceSourcePlan(plan: PaceSourcePlan | PaceFilterPlan | PaceAggregatePlan): plan is PaceSourcePlan {
  return 'source' in plan;
}

function compileStandingsFilter(filter: StandingsFilter): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.season !== undefined) {
    const values = Array.isArray(filter.season) ? filter.season : [filter.season];
    params.push(values);
    clauses.push(`season = ANY($${params.length}::integer[])`);
  }
  if (filter.driver_id !== undefined) {
    const values = Array.isArray(filter.driver_id) ? filter.driver_id : [filter.driver_id];
    params.push(values);
    clauses.push(`driver_id = ANY($${params.length}::text[])`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function compileLimit(node: CoreLimitNode): string {
  if (node.input.op !== 'sort') {
    throw new Error('Expected a sort before limit');
  }
  const direction = node.input.direction === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${node.input.by} ${direction}, driver_id ASC LIMIT ${node.limit}`;
}
