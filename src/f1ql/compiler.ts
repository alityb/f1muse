import { StandingsFilter } from './ast';
import { CoreEventClassificationNode, CorePaceAggregateNode, CoreProgram, CoreSortLimitNode, CoreSubtractNode } from './core';

export interface CompiledF1QL {
  sql: string;
  params: unknown[];
}

export function compileF1QL(program: CoreProgram): CompiledF1QL {
  if (program.root.op === 'subtract') {
    return compilePaceSubtract(program.root);
  }
  if (program.root.op === 'pace_aggregate') {
    return compilePaceAggregate(program.root);
  }
  if (program.root.op === 'event_classification') {
    return compileEventClassification(program.root);
  }
  const aggregate = program.root.op === 'sort_limit' ? program.root.input : program.root;
  const { whereSql, params } = compileStandingsFilter(aggregate.input.op === 'filter' ? aggregate.input.where : {});
  const measures = aggregate.measures.map((measure) => {
    if (measure.function === 'count') {
      return `COUNT(*)::integer AS ${measure.as}`;
    }
    const field = measure.field === 'points' ? 'points' : 'championship_position';
    return `${measure.function.toUpperCase()}(${field}) AS ${measure.as}`;
  });
  const rankSql = program.root.op === 'sort_limit' ? compileSortLimit(program.root) : '';

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

function compileEventClassification(node: CoreEventClassificationNode): CompiledF1QL {
  return {
    sql: `SELECT driver_id, finishing_position, points, classification_status, status_reason FROM f1ql.event_classification WHERE season = $1 AND round = $2 ORDER BY finishing_position ASC NULLS LAST, driver_id ASC LIMIT ${node.limit}`,
    params: [node.season, node.round]
  };
}

function compilePaceAggregate(node: CorePaceAggregateNode): CompiledF1QL {
  const params: unknown[] = [
    node.season,
    node.driver_id,
    node.rounds ?? null,
    node.clean_air_only,
    node.compound ?? null
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

function compilePaceSubtract(node: CoreSubtractNode): CompiledF1QL {
  const params: unknown[] = [
    node.left.season,
    node.left.driver_id,
    node.right.driver_id,
    node.left.rounds ?? null,
    node.left.clean_air_only,
    node.left.compound ?? null
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

function compileSortLimit(node: CoreSortLimitNode): string {
  const direction = node.direction === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${node.by} ${direction}, driver_id ASC LIMIT ${node.limit}`;
}
