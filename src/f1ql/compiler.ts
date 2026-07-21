import { StandingsFilter } from './ast';
import { CoreAggregateNode, CoreDeltaNode, CoreEventClassificationFilterNode, CoreLapPaceFilter, CoreLimitNode, CoreProgram } from './core';

export interface CompiledF1QL {
  sql: string;
  params: unknown[];
}

export function compileF1QL(program: CoreProgram): CompiledF1QL {
  if (program.root.op === 'delta') {
    return compileDelta(program.root);
  }
  if (isLapPaceAggregate(program.root)) {
    return compileLapPaceAggregate(program.root);
  }
  if (isEventClassificationProgram(program)) {
    return compileEventClassification(program.root.input.input, program.root.input, program.root.limit);
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

function getAggregateRoot(program: CoreProgram): CoreAggregateNode {
  if (program.root.op === 'limit' && program.root.input.input.op === 'aggregate') {
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

function isEventClassificationProgram(program: CoreProgram): program is CoreProgram & { root: CoreLimitNode & { input: { input: CoreEventClassificationFilterNode } } } {
  return program.root.op === 'limit'
    && program.root.input.input.op === 'filter'
    && program.root.input.input.input.source === 'event_classification';
}

function compileEventClassification(node: CoreEventClassificationFilterNode, sort: CoreLimitNode['input'], limit: number): CompiledF1QL {
  if (sort.by !== 'finishing_position') {
    throw new Error(`Unsupported event classification sort field: ${sort.by}`);
  }
  const params: unknown[] = [node.where.season, node.where.round];
  const clauses = ['season = $1', 'round = $2'];
  if (node.where.classification_status) {
    params.push(node.where.classification_status);
    clauses.push(`classification_status = ANY($${params.length}::text[])`);
  }
  if (node.where.driver_id) {
    params.push(node.where.driver_id);
    clauses.push(`driver_id = $${params.length}`);
  }
  if (node.where.team_id) {
    params.push(node.where.team_id);
    clauses.push(`team_id = $${params.length}`);
  }
  return {
    sql: `SELECT driver_id, finishing_position, points, classification_status, status_reason FROM f1ql.event_classification WHERE ${clauses.join(' AND ')} ORDER BY finishing_position ${sort.direction.toUpperCase()} NULLS ${(sort.nulls ?? 'last').toUpperCase()}, driver_id ASC LIMIT ${limit}`,
    params
  };
}

function isLapPaceAggregate(node: CoreProgram['root']): node is CoreAggregateNode {
  return node.op === 'aggregate'
    && node.input.op === 'aggregate'
    && node.input.input.op === 'filter'
    && node.input.input.input.source === 'lap_pace';
}

function compileLapPaceAggregate(node: CoreAggregateNode): CompiledF1QL {
  const eventMedians = node.input as CoreAggregateNode;
  const filter = eventMedians.input as { where: CoreLapPaceFilter };
  const params: unknown[] = [
    filter.where.season,
    filter.where.driver_id,
    filter.where.rounds ?? null,
    filter.where.clean_air_only,
    filter.where.compound ?? null
  ];

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
          AND (NOT $4::boolean OR COALESCE(clean_air_flag, false) = true)
          AND ($5::text IS NULL OR compound = $5::text)
      ),
      event_medians AS (
        SELECT
          round,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lap_time_seconds) AS median_lap_time_seconds
        FROM filtered_laps
        GROUP BY round
      )
      SELECT
        $2::text AS driver_id,
        COUNT(*)::integer AS events,
        AVG(median_lap_time_seconds) AS avg_lap_time_seconds
      FROM event_medians
    `,
    params
  };
}

function compileDelta(node: CoreDeltaNode): CompiledF1QL {
  const params = compileDeltaParams(node);

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

function compileDeltaParams(node: CoreDeltaNode): unknown[] {
  const { left, right } = node.input.input;
  if (!isLapPaceEventAggregate(left) || !isLapPaceEventAggregate(right)) {
    throw new Error('Expected lap pace aggregates for delta');
  }
  const leftFilter = left.input as { where: CoreLapPaceFilter };
  const rightFilter = right.input as { where: CoreLapPaceFilter };
  if (leftFilter.where.season !== rightFilter.where.season
    || JSON.stringify(leftFilter.where.rounds) !== JSON.stringify(rightFilter.where.rounds)
    || leftFilter.where.clean_air_only !== rightFilter.where.clean_air_only
    || leftFilter.where.compound !== rightFilter.where.compound) {
    throw new Error('Delta inputs must share lap pace eligibility filters');
  }
  return [
    leftFilter.where.season,
    leftFilter.where.driver_id,
    rightFilter.where.driver_id,
    leftFilter.where.rounds ?? null,
    leftFilter.where.clean_air_only,
    leftFilter.where.compound ?? null
  ];
}

function isLapPaceEventAggregate(node: CoreAggregateNode): boolean {
  return node.input.op === 'filter' && node.input.input.source === 'lap_pace'
    && node.group_by.length === 1 && node.group_by[0] === 'round';
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
  const direction = node.input.direction === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${node.input.by} ${direction}, driver_id ASC LIMIT ${node.limit}`;
}
