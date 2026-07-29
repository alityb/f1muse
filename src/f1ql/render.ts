import { F1QLProgram, PaceDeltaNode, PaceSummaryNode } from './ast';

export function renderF1QL(program: F1QLProgram): string {
  if (program.root.op === 'pace_delta') {
    return renderPaceDelta(program.root);
  }
  if (program.root.op === 'pace_summary') {
    return renderPaceSummary(program.root);
  }
  if (program.root.op === 'event_classification') {
    return `Official race classification; season ${program.root.season}; round ${program.root.round}; ${classificationSelection(program.root.filters?.finishing_position, program.root.limit)}.`;
  }
  if (program.root.op === 'qualifying_classification') {
    return `Official qualifying classification; season ${program.root.season}; round ${program.root.round}; ${classificationSelection(program.root.filters?.qualifying_position, program.root.limit)}.`;
  }
  if (program.root.op === 'event_metadata') {
    return `Event metadata; season ${program.root.season}; round ${program.root.round}; ${program.root.session_scope ?? 'race'} session.`;
  }
  if (program.root.op === 'official_lap_window_median_compare') {
    return `Official non-deleted, non-PIT race-lap median; ${program.root.driver_a_id} versus ${program.root.driver_b_id}; season ${program.root.season}; round ${program.root.round}; laps ${program.root.lap_start}-${program.root.lap_end}; complete window required; safety-car, weather, traffic, tyre, fuel, and race-state effects included.`;
  }
  if (program.root.op === 'official_event_mean_compare') {
    return `Official non-deleted, non-PIT completed race-lap arithmetic mean; ${program.root.driver_a_id} versus ${program.root.driver_b_id}; season ${program.root.season}; round ${program.root.round}; all completed laps per driver; safety-car, weather, traffic, tyre, fuel, and race-state effects included.`;
  }
  if (program.root.op === 'race_season_finishing_position_h2h') {
    return `Official race finishing-position head-to-head; ${program.root.driver_a_id} versus ${program.root.driver_b_id}; final season ${program.root.season}; shared rounds with two non-null positions only; lower position finishes ahead and equal positions tie; unique source rows required.`;
  }
  if (program.root.op === 'race_event_finishing_position_comparison') {
    return `Official race finishing-position comparison; ${program.root.driver_a_id} versus ${program.root.driver_b_id}; season ${program.root.season}; round ${program.root.round}; exactly one recorded numeric position per driver required; lower position finishes ahead; no pace or time gap.`;
  }
  if (program.root.op === 'qualifying_season_position_h2h') {
    return `Official qualifying-position head-to-head; ${program.root.driver_a_id} versus ${program.root.driver_b_id}; final season ${program.root.season}; shared rounds with two non-null positions only; lower position qualifies ahead and equal positions tie; unique source rows required.`;
  }
  if (program.root.op === 'official_driver_results_comparison') {
    return `Official driver results comparison; ${program.root.driver_a_id} versus ${program.root.driver_b_id}; final season ${program.root.season}; final championship position and points plus recorded shared-event race and qualifying position head-to-heads; unique source rows required; no pace, time-gap, weather, or synthetic score.`;
  }
  if (program.root.op === 'driver_career_wins_by_circuit') {
    return `Recorded official race P1 classifications for ${program.root.driver_id}; completed seasons 1950-2025; grouped only by canonical circuit_id; unique winner and event-metadata keys required.`;
  }
  if (program.root.op === 'driver_season_qualifying_p1_count') {
    return `Recorded official qualifying P1 count for ${program.root.driver_id}; final season ${program.root.season}; unique source keys and valid recorded positions required.`;
  }
  if (program.root.op === 'driver_career_qualifying_p1_count') {
    return `Recorded official qualifying P1 count for ${program.root.driver_id}; exact completed seasons 1950-2025; unique source keys and valid recorded positions required; 2026 excluded.`;
  }
  if (program.root.op === 'driver_season_qualifying_top_ten_count') {
    return `Recorded official qualifying top-ten count for ${program.root.driver_id}; final season ${program.root.season}; positions P1-P10 only; unique source keys required.`;
  }
  if (program.root.op === 'season_qualifying_top_ten_ranking') {
    return `Recorded official qualifying top-ten ranking; final season ${program.root.season}; positions P1-P10 only; ties allowed; count descending then UTF-8 byte driver_id order.`;
  }
  return renderStandings(program);
}

function classificationSelection(positions: number[] | undefined, limit: number): string {
  if (positions === undefined) {
    return `top ${limit}`;
  }
  if (positions.length === 1) {
    return `position ${positions[0]}`;
  }
  if (positions.every((position, index) => position === index + 1)) {
    return `top ${positions.length}`;
  }
  return `positions ${positions.join(', ')}`;
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

// eslint-disable-next-line complexity
function renderStandings(program: F1QLProgram): string {
  if (program.root.op === 'pace_delta' || program.root.op === 'pace_summary' || program.root.op === 'event_classification' || program.root.op === 'qualifying_classification' || program.root.op === 'event_metadata' || program.root.op === 'official_lap_window_median_compare' || program.root.op === 'official_event_mean_compare' || program.root.op === 'race_season_finishing_position_h2h' || program.root.op === 'race_event_finishing_position_comparison' || program.root.op === 'qualifying_season_position_h2h' || program.root.op === 'official_driver_results_comparison' || program.root.op === 'driver_career_wins_by_circuit' || program.root.op === 'driver_season_qualifying_p1_count' || program.root.op === 'driver_career_qualifying_p1_count' || program.root.op === 'driver_season_qualifying_top_ten_count' || program.root.op === 'season_qualifying_top_ten_ranking') {
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
