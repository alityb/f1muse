import { AggregateNode, F1QLProgram } from './ast';
import { CoreAggregateNode, CoreLapPaceFilter, CoreProgram, CoreSourceNode } from './core';

export function lowerF1QL(program: F1QLProgram): CoreProgram {
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
      root: {
        op: 'filter',
        input: { op: 'source', source: 'event_metadata' },
        where: {
          season: program.root.season,
          round: program.root.round,
          session_scope: program.root.session_scope ?? 'race'
        }
      }
    };
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const coreAggregate = lowerAggregate(aggregate);

  if (program.root.op === 'rank') {
    return lowerRank(coreAggregate, program.root);
  }

  return { version: 1, root: coreAggregate };
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
    rounds: scope.rounds,
    lap_time_seconds: 'not_null',
    is_valid_lap: true,
    is_pit_lap: false,
    is_in_lap: false,
    is_out_lap: false,
    clean_air_only: filters.clean_air_only === true,
    compound: filters.compound
  };
  return {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'lap_pace' }, where },
    group_by: ['round'],
    measures: [{ as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }]
  };
}

function lowerEventClassification(node: Extract<F1QLProgram['root'], { op: 'event_classification' }>): CoreProgram {
  return {
    version: 1,
    root: {
      op: 'limit',
      input: {
        op: 'sort',
        input: {
          op: 'filter',
          input: { op: 'source', source: 'event_classification' },
          where: { season: node.season, round: node.round, ...node.filters }
        },
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
        input: {
          op: 'filter',
          input: { op: 'source', source: 'qualifying_classification' },
          where: { season: node.season, round: node.round, ...node.filters }
        },
        by: 'qualifying_position',
        direction: 'asc',
        nulls: 'last'
      },
      limit: node.limit
    }
  };
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
