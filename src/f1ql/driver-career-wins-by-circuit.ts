export const DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID = 'official_race_p1_by_circuit_1950_2025_v1' as const;
export const DRIVER_CAREER_WIN_SEASONS = Object.freeze(Array.from({ length: 76 }, (_, index) => 1950 + index));
export const DRIVER_CAREER_WIN_SOURCE_ROUND_BRANCHES = DRIVER_CAREER_WIN_SEASONS.length * 30 * 2;
