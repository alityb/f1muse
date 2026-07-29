export const OFFICIAL_DRIVER_RESULTS_COMPARISON_METRIC_ID = 'official_driver_results_comparison_v1' as const;
export const OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MIN = 1950;
export const OFFICIAL_DRIVER_RESULTS_COMPARISON_SEASON_MAX = 2025;

const summaryFields = ['driver_a_ahead', 'driver_b_ahead', 'ties', 'shared_events', 'driver_a_source_rows', 'driver_b_source_rows', 'distinct_source_keys', 'duplicate_source_rows', 'source_presence_ok', 'source_unique_keys_ok', 'source_integrity_ok'] as const;

export const OFFICIAL_DRIVER_RESULTS_COMPARISON_INPUT_ALIASES = Object.freeze(['driver_a_standing', 'driver_b_standing', 'race', 'qualifying'] as const);

export const OFFICIAL_DRIVER_RESULTS_COMPARISON_SELECT = Object.freeze([
  Object.freeze({ input: 'race', field: 'season', as: 'season' }),
  Object.freeze({ input: 'race', field: 'driver_a_id', as: 'driver_a_id' }),
  Object.freeze({ input: 'race', field: 'driver_b_id', as: 'driver_b_id' }),
  ...['championship_position', 'points', 'standing_rows'].map(field => Object.freeze({ input: 'driver_a_standing', field, as: `driver_a_${field}` })),
  ...['championship_position', 'points', 'standing_rows'].map(field => Object.freeze({ input: 'driver_b_standing', field, as: `driver_b_${field}` })),
  Object.freeze({ input: 'race', field: 'metric_id', as: 'race_metric_id' }),
  ...summaryFields.map(field => Object.freeze({ input: 'race', field, as: `race_${field}` })),
  Object.freeze({ input: 'qualifying', field: 'metric_id', as: 'qualifying_metric_id' }),
  ...summaryFields.map(field => Object.freeze({ input: 'qualifying', field, as: `qualifying_${field}` }))
]);
