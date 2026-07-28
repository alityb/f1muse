import { StandingsFilter } from './ast';
import { CORE_COMPARISON_SUMMARY_SIGNATURES, CoreAggregateNode, CoreComparisonSummaryNode, CoreDeltaNode, CoreEventClassificationFilter, CoreEventMetadataFilter, CoreLapPaceFilter, CoreLimitNode, CoreOfficialEventMeanFilter, CoreOfficialLapTimingFilter, CorePipelineNode, CoreProgram, CoreQualifyingClassificationFilter, CoreSourceNode } from './core';
import { MINIMUM_ELIGIBLE_LAPS_PER_EVENT } from './lower';
import { MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS, OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS, OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';

export const CLEAN_AIR_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';

export interface CompiledF1QL {
  sql: string;
  params: unknown[];
}

export function compileF1QL(program: CoreProgram): CompiledF1QL {
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

  return {
    sql: `
      SELECT driver_id, ${measures.join(', ')}
      FROM f1ql.driver_standings
      ${whereSql}
      GROUP BY driver_id
      ${rankSql}
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
  const { season, leftId, rightId, table, field } = comparisonSummaryPlan(node);
  const params = [season, leftId, rightId, node.metric_id, node.lower_is_better];
  return {
    sql: `
      WITH scoped_source AS (
        SELECT season, round, driver_id, ${field} AS comparison_value
        FROM ${table}
        WHERE season = $1 AND driver_id IN ($2, $3)
      ),
      source_integrity AS (
        SELECT
          count(*) FILTER (WHERE driver_id = $2)::integer AS driver_a_source_rows,
          count(*) FILTER (WHERE driver_id = $3)::integer AS driver_b_source_rows,
          count(DISTINCT (season, round, driver_id))::integer AS distinct_source_keys,
          (count(*) - count(DISTINCT (season, round, driver_id)))::integer AS duplicate_source_rows
        FROM scoped_source
      ),
      unique_shared_rounds AS (
        SELECT
          round,
          max(comparison_value) FILTER (WHERE driver_id = $2) AS driver_a_value,
          max(comparison_value) FILTER (WHERE driver_id = $3) AS driver_b_value
        FROM scoped_source
        GROUP BY round
        HAVING count(*) FILTER (WHERE driver_id = $2) = 1
           AND count(*) FILTER (WHERE driver_id = $3) = 1
      ),
      comparison AS (
        SELECT
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL AND (($5::boolean AND driver_a_value < driver_b_value) OR (NOT $5::boolean AND driver_a_value > driver_b_value)))::integer AS driver_a_ahead,
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL AND (($5::boolean AND driver_b_value < driver_a_value) OR (NOT $5::boolean AND driver_b_value > driver_a_value)))::integer AS driver_b_ahead,
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL AND driver_a_value = driver_b_value)::integer AS ties,
          count(*) FILTER (WHERE driver_a_value IS NOT NULL AND driver_b_value IS NOT NULL)::integer AS shared_events
        FROM unique_shared_rounds
      )
      SELECT
        $4::text AS metric_id,
        $1::integer AS season,
        $2::text AS driver_a_id,
        $3::text AS driver_b_id,
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
          driver_a_source_rows > 0 AND driver_b_source_rows > 0 AND duplicate_source_rows = 0 AS source_integrity_ok
        FROM source_integrity
      ) AS integrity
    `,
    params
  };
}

interface ComparisonSummaryPlan {
  season: number;
  leftId: string;
  rightId: string;
  table: string;
  field: string;
}

// eslint-disable-next-line complexity
function comparisonSummaryPlan(node: CoreComparisonSummaryNode): ComparisonSummaryPlan {
  const { left, right } = node.input.input;
  if (left.op !== 'filter' || right.op !== 'filter' ||
      left.input.op !== 'source' || right.input.op !== 'source' || left.input.source !== right.input.source ||
      !Object.prototype.hasOwnProperty.call(COMPARISON_SUMMARY_SQL_SOURCES, left.input.source)) {
    throw new Error('Expected filtered covered comparison-summary branches');
  }
  const source = left.input.source as keyof typeof COMPARISON_SUMMARY_SQL_SOURCES;
  const sqlSource = COMPARISON_SUMMARY_SQL_SOURCES[source];
  if (node.input.left.field !== sqlSource.field || node.input.right.field !== sqlSource.field) {
    throw new Error('Expected a covered comparison-summary field');
  }
  const leftWhere = left.where as { season?: number; driver_id?: string };
  const rightWhere = right.where as { season?: number; driver_id?: string };
  if (typeof leftWhere.season !== 'number' || leftWhere.season !== rightWhere.season ||
      typeof leftWhere.driver_id !== 'string' || typeof rightWhere.driver_id !== 'string') {
    throw new Error('Expected shared season and ordered driver filters');
  }
  return {
    season: leftWhere.season,
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

function appendEqualityFilter(pipeline: { where: string[]; params: unknown[] }, field: 'season' | 'round', value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  pipeline.params.push(value);
  pipeline.where.push(`${field} = $${pipeline.params.length}`);
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

function compileLapPace(node: Exclude<CoreProgram['root'], CoreComparisonSummaryNode>): CompiledF1QL {
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
