import { F1QLProgram, PaceDeltaNode, PaceSummaryNode } from './ast';

export function renderF1QL(program: F1QLProgram): string {
  if (program.root.op === 'pace_delta') {
    return renderPaceDelta(program.root);
  }
  if (program.root.op === 'pace_summary') {
    return renderPaceSummary(program.root);
  }
  return renderStandings(program);
}

function renderPaceDelta(node: PaceDeltaNode): string {
  const rounds = node.scope.rounds?.join(', ') ?? 'all completed rounds';
  const cleanAir = node.filters?.clean_air_only ? '; clean-air laps only' : '';
  const compound = node.filters?.compound ? `; compound ${node.filters.compound}` : '';
  return `Median valid race-lap pace per shared event, then mean across events; ${node.driver_a_id} minus ${node.driver_b_id}; season ${node.scope.season}; rounds ${rounds}${cleanAir}${compound}.`;
}

function renderPaceSummary(node: PaceSummaryNode): string {
  const rounds = node.scope.rounds?.join(', ') ?? 'all available rounds';
  const cleanAir = node.filters?.clean_air_only ? '; clean-air laps only' : '';
  const compound = node.filters?.compound ? `; compound ${node.filters.compound}` : '';
  return `Median valid race-lap pace per event, then mean; ${node.driver_id}; season ${node.scope.season}; rounds ${rounds}${cleanAir}${compound}.`;
}

function renderStandings(program: F1QLProgram): string {
  if (program.root.op === 'pace_delta' || program.root.op === 'pace_summary') {
    throw new Error('renderStandings does not accept pace programs');
  }
  const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
  const filter = aggregate.input.op === 'filter' ? aggregate.input.where : {};
  const measures = aggregate.measures.map((measure) => {
    if (measure.function === 'count') {
      return 'count standings rows';
    }
    return `${measure.function} ${measure.field}`;
  }).join(', ');
  const scope = [
    filter.season === undefined ? null : `season ${asList(filter.season)}`,
    filter.driver_id === undefined ? null : `drivers ${asList(filter.driver_id)}`
  ].filter(Boolean).join('; ');
  const ranking = program.root.op === 'rank'
    ? `; rank by ${program.root.by} ${program.root.direction}, top ${program.root.limit}`
    : '';

  return `From official driver standings: ${measures}, grouped by driver${scope ? `; ${scope}` : ''}${ranking}.`;
}

function asList(value: string | number | string[] | number[]): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
