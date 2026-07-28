import { F1QLProgram } from './ast';
import { MAX_OFFICIAL_LAP_WINDOW_LAPS } from './official-lap-window';

const MAX_REQUESTED_ROUNDS = 24;
export const MAX_F1QL_SOURCE_ROUND_BRANCHES = 60;
export const RACE_SEASON_H2H_SOURCE_ROUND_BRANCHES = 30 * 2;
export const MAX_F1QL_RESPONSE_ROWS = 100;

export class F1QLCostLimitError extends Error {}

export interface F1QLCostEstimate {
  source_round_branches: number;
}

export interface F1QLCostLimitOptions {
  maxSourceRoundBranches?: number;
}

export function estimateF1QLCost(program: F1QLProgram): F1QLCostEstimate {
  const root = program.root;
  if (root.op === 'race_season_finishing_position_h2h') {
    return { source_round_branches: RACE_SEASON_H2H_SOURCE_ROUND_BRANCHES };
  }
  if (root.op === 'pace_delta' || root.op === 'pace_summary') {
    const rounds = root.scope.rounds?.length ?? MAX_REQUESTED_ROUNDS;
    return { source_round_branches: rounds * (root.op === 'pace_delta' ? 2 : 1) };
  }
  if (root.op === 'official_lap_window_median_compare' || root.op === 'official_event_mean_compare') {
    return { source_round_branches: 2 };
  }
  if (root.op === 'event_classification' || root.op === 'qualifying_classification' || root.op === 'event_metadata') {
    return { source_round_branches: 1 };
  }
  return { source_round_branches: 0 };
}

export function enforceF1QLCostLimits(program: F1QLProgram, options: F1QLCostLimitOptions = {}): void {
  if (program.root.op === 'official_lap_window_median_compare' && program.root.lap_end - program.root.lap_start + 1 > MAX_OFFICIAL_LAP_WINDOW_LAPS) {
    throw new F1QLCostLimitError(`At most ${MAX_OFFICIAL_LAP_WINDOW_LAPS} laps may be requested`);
  }
  if (program.root.op === 'pace_delta' || program.root.op === 'pace_summary') {
    const rounds = program.root.scope.rounds;
    if (rounds !== undefined && rounds.length > MAX_REQUESTED_ROUNDS) {
      throw new F1QLCostLimitError(`At most ${MAX_REQUESTED_ROUNDS} rounds may be requested`);
    }
  }
  const maximum = options.maxSourceRoundBranches ?? MAX_F1QL_SOURCE_ROUND_BRANCHES;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_F1QL_SOURCE_ROUND_BRANCHES) {
    throw new F1QLCostLimitError(`maxSourceRoundBranches must be between 0 and ${MAX_F1QL_SOURCE_ROUND_BRANCHES}`);
  }
  const estimate = estimateF1QLCost(program);
  if (estimate.source_round_branches > maximum) {
    throw new F1QLCostLimitError(`Program requires ${estimate.source_round_branches} source-round branches; maximum is ${maximum}`);
  }
}
