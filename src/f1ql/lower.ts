import { AggregateNode, F1QLProgram } from './ast';
import { CoreAggregateNode, CoreProgram } from './core';

export function lowerF1QL(program: F1QLProgram): CoreProgram {
  if (program.root.op === 'pace_delta') {
    const filters = program.root.filters ?? {};
    return {
      version: 1,
      root: {
        op: 'subtract',
        left: {
          op: 'pace_aggregate',
          driver_id: program.root.driver_a_id,
          season: program.root.scope.season,
          rounds: program.root.scope.rounds,
          clean_air_only: filters.clean_air_only === true,
          compound: filters.compound
        },
        right: {
          op: 'pace_aggregate',
          driver_id: program.root.driver_b_id,
          season: program.root.scope.season,
          rounds: program.root.scope.rounds,
          clean_air_only: filters.clean_air_only === true,
          compound: filters.compound
        },
        alignment: 'shared_events'
      }
    };
  }
  if (program.root.op === 'pace_summary') {
    const filters = program.root.filters ?? {};
    return {
      version: 1,
      root: {
        op: 'pace_aggregate',
        driver_id: program.root.driver_id,
        season: program.root.scope.season,
        rounds: program.root.scope.rounds,
        clean_air_only: filters.clean_air_only === true,
        compound: filters.compound
      }
    };
  }
  if (program.root.op === 'event_classification') {
    return { version: 1, root: program.root };
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const coreAggregate = lowerAggregate(aggregate);

  if (program.root.op === 'rank') {
    return {
      version: 1,
      root: {
        op: 'sort_limit',
        input: coreAggregate,
        by: program.root.by,
        direction: program.root.direction,
        limit: program.root.limit
      }
    };
  }

  return { version: 1, root: coreAggregate };
}

function lowerAggregate(node: AggregateNode): CoreAggregateNode {
  return {
    op: 'aggregate',
    input: node.input.op === 'filter'
      ? { op: 'filter', input: node.input.input, where: node.input.where }
      : node.input,
    group_by: ['driver_id'],
    measures: node.measures
  };
}
