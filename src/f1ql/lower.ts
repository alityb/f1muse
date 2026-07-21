import { AggregateNode, F1QLProgram } from './ast';
import { CoreAggregateNode, CoreProgram, CoreSourceNode } from './core';

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
    return lowerEventClassification(program.root);
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const coreAggregate = lowerAggregate(aggregate);

  if (program.root.op === 'rank') {
    return lowerRank(coreAggregate, program.root);
  }

  return { version: 1, root: coreAggregate };
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
