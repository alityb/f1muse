import { F1QLProgram } from './ast';
import { MAX_OFFICIAL_LAP_WINDOW_LAPS } from './official-lap-window';

const MAX_REQUESTED_ROUNDS = 24;
export const MAX_F1QL_RESPONSE_ROWS = 100;

export class F1QLCostLimitError extends Error {}

export function enforceF1QLCostLimits(program: F1QLProgram): void {
  if (program.root.op === 'official_lap_window_median_compare' && program.root.lap_end - program.root.lap_start + 1 > MAX_OFFICIAL_LAP_WINDOW_LAPS) {
    throw new F1QLCostLimitError(`At most ${MAX_OFFICIAL_LAP_WINDOW_LAPS} laps may be requested`);
  }
  if (program.root.op === 'pace_delta' || program.root.op === 'pace_summary') {
    const rounds = program.root.scope.rounds;
    if (rounds !== undefined && rounds.length > MAX_REQUESTED_ROUNDS) {
      throw new F1QLCostLimitError(`At most ${MAX_REQUESTED_ROUNDS} rounds may be requested`);
    }
  }
}
