import { AggregateNode, F1QLProgram } from './ast';
import { CoreAggregateNode, CoreEventClassificationFilter, CoreFilterNode, CoreLapPaceFilter, CoreOfficialEventMeanFilter, CoreOfficialLapTimingFilter, CorePipelineNode, CoreProgram, CoreQualifyingClassificationFilter, CoreSourceNode } from './core';
import { MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS } from './official-event-mean';
import { MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS } from './official-lap-window';

export const MINIMUM_ELIGIBLE_LAPS_PER_EVENT = 2;

// eslint-disable-next-line max-lines-per-function
export function lowerF1QL(program: F1QLProgram): CoreProgram {
  if (program.root.op === 'race_season_finishing_position_h2h') {
    return {
      version: 1,
      root: {
        op: 'comparison_summary',
        input: {
          op: 'compare',
          input: {
            op: 'join',
            left: {
              op: 'filter',
              input: { op: 'source', source: 'event_classification' },
              where: { season: program.root.season, driver_id: program.root.driver_a_id }
            },
            right: {
              op: 'filter',
              input: { op: 'source', source: 'event_classification' },
              where: { season: program.root.season, driver_id: program.root.driver_b_id }
            },
            on: ['season', 'round'],
            type: 'inner'
          },
          left: { field: 'finishing_position', as: 'driver_a_position' },
          right: { field: 'finishing_position', as: 'driver_b_position' }
        },
        metric_id: program.root.metric,
        lower_is_better: true,
        require_unique_source_keys: true,
        require_source_presence: true
      }
    };
  }
  if (program.root.op === 'official_event_mean_compare') {
    return {
      version: 1,
      root: {
        op: 'delta',
        input: {
          op: 'compare',
          input: {
            op: 'join',
            left: lowerOfficialEventMean(program.root.driver_a_id, program.root),
            right: lowerOfficialEventMean(program.root.driver_b_id, program.root),
            on: [],
            type: 'inner'
          },
          left: { field: 'mean_lap_time_seconds', as: 'driver_a_mean_lap_time_seconds' },
          right: { field: 'mean_lap_time_seconds', as: 'driver_b_mean_lap_time_seconds' }
        },
        left_id: program.root.driver_a_id,
        right_id: program.root.driver_b_id,
        metric_id: program.root.metric,
        lower_is_better: true
      }
    };
  }
  if (program.root.op === 'official_lap_window_median_compare') {
    return {
      version: 1,
      root: {
        op: 'delta',
        input: {
          op: 'compare',
          input: {
            op: 'join',
            left: lowerOfficialLapWindowMedian(program.root.driver_a_id, program.root),
            right: lowerOfficialLapWindowMedian(program.root.driver_b_id, program.root),
            on: [],
            type: 'inner'
          },
          left: { field: 'median_lap_time_seconds', as: 'driver_a_median_lap_time_seconds' },
          right: { field: 'median_lap_time_seconds', as: 'driver_b_median_lap_time_seconds' }
        },
        left_id: program.root.driver_a_id,
        right_id: program.root.driver_b_id,
        metric_id: program.root.metric,
        lower_is_better: true
      }
    };
  }
  if (program.root.op === 'pace_delta') {
    const filters = program.root.filters ?? {};
    return {
      version: 1,
      root: {
        op: 'delta',
        input: {
          op: 'compare',
          input: {
            op: 'join',
            left: lowerPaceEventMedians(program.root.driver_a_id, program.root.scope, filters),
            right: lowerPaceEventMedians(program.root.driver_b_id, program.root.scope, filters),
            on: ['round'],
            type: 'inner'
          },
          left: { field: 'median_lap_time_seconds', as: 'driver_a_median' },
          right: { field: 'median_lap_time_seconds', as: 'driver_b_median' }
        },
        left_id: program.root.driver_a_id,
        right_id: program.root.driver_b_id
      }
    };
  }
  if (program.root.op === 'pace_summary') {
    const filters = program.root.filters ?? {};
    return {
      version: 1,
      root: lowerPaceSummary(program.root.driver_id, program.root.scope, filters)
    };
  }
  if (program.root.op === 'event_classification') {
    return lowerEventClassification(program.root);
  }
  if (program.root.op === 'qualifying_classification') {
    return lowerQualifyingClassification(program.root);
  }
  if (program.root.op === 'event_metadata') {
    return {
      version: 1,
      root: applyFilters({ op: 'source', source: 'event_metadata' }, [
        { season: program.root.season, round: program.root.round },
        { session_scope: program.root.session_scope ?? 'race' }
      ])
    };
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const coreAggregate = lowerAggregate(aggregate);

  if (program.root.op === 'rank') {
    return lowerRank(coreAggregate, program.root);
  }

  return { version: 1, root: coreAggregate };
}

function lowerOfficialEventMean(
  driverId: string,
  scope: Extract<F1QLProgram['root'], { op: 'official_event_mean_compare' }>
): CoreAggregateNode {
  const where: CoreOfficialEventMeanFilter = {
    season: scope.season,
    round: scope.round,
    session_type: 'R',
    driver_id: driverId,
    complete_event: true,
    official_deleted_lap: false,
    official_pit_marker: false
  };
  return {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'official_lap_timing' }, where },
    group_by: [],
    measures: [
      { as: 'eligible_laps', function: 'count' },
      { as: 'mean_lap_time_seconds', function: 'avg', field: 'lap_time_seconds' }
    ],
    minimum_rows: MINIMUM_OFFICIAL_EVENT_MEAN_ELIGIBLE_LAPS
  };
}

function lowerOfficialLapWindowMedian(
  driverId: string,
  scope: Extract<F1QLProgram['root'], { op: 'official_lap_window_median_compare' }>
): CoreAggregateNode {
  const where: CoreOfficialLapTimingFilter = {
    season: scope.season,
    round: scope.round,
    session_type: 'R',
    driver_id: driverId,
    lap_start: scope.lap_start,
    lap_end: scope.lap_end,
    complete_requested_window: true,
    official_deleted_lap: false,
    official_pit_marker: false
  };
  return {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'official_lap_timing' }, where },
    group_by: [],
    measures: [
      { as: 'eligible_laps', function: 'count' },
      { as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }
    ],
    minimum_rows: MINIMUM_OFFICIAL_LAP_WINDOW_ELIGIBLE_LAPS
  };
}

function lowerPaceSummary(driverId: string, scope: { season: number; rounds?: number[] }, filters: { clean_air_only?: boolean; compound?: string }): CoreAggregateNode {
  return {
    op: 'aggregate',
    input: lowerPaceEventMedians(driverId, scope, filters),
    group_by: [],
    measures: [
      { as: 'events', function: 'count' },
      { as: 'avg_lap_time_seconds', function: 'avg', field: 'median_lap_time_seconds' }
    ]
  };
}

function lowerPaceEventMedians(driverId: string, scope: { season: number; rounds?: number[] }, filters: { clean_air_only?: boolean; compound?: string }): CoreAggregateNode {
  const where: CoreLapPaceFilter = {
    season: scope.season,
    driver_id: driverId,
    lap_time_seconds: 'not_null',
    is_valid_lap: true,
    is_pit_lap: false,
    is_in_lap: false,
    is_out_lap: false,
    clean_air_only: filters.clean_air_only === true,
    ...(scope.rounds === undefined ? {} : { rounds: scope.rounds }),
    ...(filters.compound === undefined ? {} : { compound: filters.compound })
  };
  return {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'lap_pace' }, where },
    group_by: ['round'],
    measures: [{ as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }],
    minimum_rows: MINIMUM_ELIGIBLE_LAPS_PER_EVENT
  };
}

function lowerEventClassification(node: Extract<F1QLProgram['root'], { op: 'event_classification' }>): CoreProgram {
  return {
    version: 1,
    root: {
      op: 'limit',
      input: {
        op: 'sort',
        input: applyFilters({ op: 'source', source: 'event_classification' }, classificationFilters(node)),
        by: 'finishing_position',
        direction: 'asc',
        nulls: 'last'
      },
      limit: node.limit
    }
  };
}

function lowerQualifyingClassification(node: Extract<F1QLProgram['root'], { op: 'qualifying_classification' }>): CoreProgram {
  return {
    version: 1,
    root: {
      op: 'limit',
      input: {
        op: 'sort',
        input: applyFilters({ op: 'source', source: 'qualifying_classification' }, classificationFilters(node)),
        by: 'qualifying_position',
        direction: 'asc',
        nulls: 'last'
      },
      limit: node.limit
    }
  };
}

function classificationFilters(node: Extract<F1QLProgram['root'], { op: 'event_classification' | 'qualifying_classification' }>): Array<CoreEventClassificationFilter | CoreQualifyingClassificationFilter> {
  const filters: Array<CoreEventClassificationFilter | CoreQualifyingClassificationFilter> = [
    { season: node.season, round: node.round },
    ...(node.filters?.classification_status === undefined ? [] : [{ classification_status: node.filters.classification_status }]),
    ...(node.filters?.driver_id === undefined ? [] : [{ driver_id: node.filters.driver_id }]),
    ...(node.filters?.team_id === undefined ? [] : [{ team_id: node.filters.team_id }])
  ];
  if (node.op === 'event_classification' && node.filters?.finishing_position !== undefined) {
    filters.push({ finishing_position: node.filters.finishing_position });
  }
  if (node.op === 'qualifying_classification' && node.filters?.qualifying_position !== undefined) {
    filters.push({ qualifying_position: node.filters.qualifying_position });
  }
  return filters;
}

function applyFilters(input: CorePipelineNode, filters: CoreFilterNode['where'][]): CoreFilterNode {
  return filters.reduce<CorePipelineNode>((current, where) => ({ op: 'filter', input: current, where }), input) as CoreFilterNode;
}

function lowerRank(aggregate: CoreAggregateNode, node: Extract<F1QLProgram['root'], { op: 'rank' }>): CoreProgram {
  return {
    version: 1,
    root: {
      op: 'limit',
      input: { op: 'sort', input: aggregate, by: node.by, direction: node.direction },
      limit: node.limit
    }
  };
}

function lowerAggregate(node: AggregateNode): CoreAggregateNode {
  const source: CoreSourceNode & { source: 'standings' } = { op: 'source', source: node.input.op === 'filter' ? node.input.input.source : node.input.source };
  return {
    op: 'aggregate',
    input: node.input.op === 'filter'
      ? { op: 'filter', input: source, where: node.input.where }
      : source,
    group_by: ['driver_id'],
    measures: node.measures
  };
}
