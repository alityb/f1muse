export const DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID = 'official_recorded_qualifying_p1_season_count_v1' as const;
export const DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID = 'official_recorded_qualifying_p1_1950_2025_count_v1' as const;
export const DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID = 'official_recorded_qualifying_top_ten_season_count_v1' as const;
export const SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID = 'official_recorded_qualifying_top_ten_season_ranking_v1' as const;

export const COMPLETED_QUALIFYING_SEASONS = Object.freeze(Array.from({ length: 76 }, (_, index) => 1950 + index));
export const QUALIFYING_POSITION_MIN = 1;
export const QUALIFYING_POSITION_MAX = 30;
export const QUALIFYING_TOP_TEN_MAX = 10;
export const SEASON_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES = 30;
export const CAREER_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES = COMPLETED_QUALIFYING_SEASONS.length * 30;
