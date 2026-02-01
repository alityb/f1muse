/**
 * Example QueryIntent payloads for testing the API
 *
 * Usage:
 * curl -X POST http://localhost:3000/query \
 *   -H "Content-Type: application/json" \
 *   -d @examples/track-scoped-comparison.json
 */

import { QueryIntent } from '../src/types/query-intent';

/**
 * Example 1: Track-scoped comparison
 * "Max vs Alonso at Suzuka 2023"
 */
export const trackScopedComparison: QueryIntent = {
  kind: 'cross_team_track_scoped_driver_comparison',
  track_id: 'suzuka',
  driver_a_id: 'VER',
  driver_b_id: 'ALO',
  season: 2023,
  metric: 'avg_true_pace',
  normalization: 'none',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'Max vs Alonso at Suzuka 2023'
};

/**
 * Example 2: Teammate comparison
 * "Leclerc vs Sainz 2023"
 */
export const teammateComparison: QueryIntent = {
  kind: 'teammate_gap_summary_season',
  driver_a_id: 'LEC',
  driver_b_id: 'SAI',
  season: 2023,
  metric: 'teammate_gap_raw',
  normalization: 'team_baseline',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'Leclerc vs Sainz 2023'
};

/**
 * Example 3: Cross-team comparison
 * "Verstappen vs Alonso 2023"
 */
export const crossTeamComparison: QueryIntent = {
  kind: 'season_driver_vs_driver',
  driver_a_id: 'VER',
  driver_b_id: 'ALO',
  season: 2023,
  metric: 'avg_true_pace',
  normalization: 'none',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'Verstappen vs Alonso 2023'
};

/**
 * Example 4: Driver ranking at track
 * "Who was fastest at Monza 2022?"
 */
export const driverRanking: QueryIntent = {
  kind: 'track_fastest_drivers',
  track_id: 'monza',
  season: 2022,
  metric: 'avg_true_pace',
  normalization: 'none',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'Who was fastest at Monza 2022?'
};

/**
 * Example 5: Invalid query (missing season)
 * Should be REJECTED
 */
export const invalidMissingSeason: QueryIntent = {
  kind: 'cross_team_track_scoped_driver_comparison',
  track_id: 'suzuka',
  driver_a_id: 'VER',
  driver_b_id: 'ALO',
  season: 0,  // Invalid!
  metric: 'avg_true_pace',
  normalization: 'none',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'Max vs Alonso at Suzuka'
};

/**
 * Example 6: Invalid query (wrong normalization)
 * Should be REJECTED
 */
export const invalidWrongNormalization: QueryIntent = {
  kind: 'teammate_gap_summary_season',
  driver_a_id: 'LEC',
  driver_b_id: 'SAI',
  season: 2023,
  metric: 'teammate_gap_raw',
  normalization: 'none',  // Wrong! Should be team_baseline
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'Leclerc vs Sainz 2023'
};

// Export all examples
export const examples = {
  trackScopedComparison,
  teammateComparison,
  crossTeamComparison,
  driverRanking,
  invalidMissingSeason,
  invalidWrongNormalization
};

// If run directly, print examples as JSON
if (require.main === module) {
  console.log('=== Valid Query Examples ===\n');

  console.log('1. Track-scoped comparison:');
  console.log(JSON.stringify(trackScopedComparison, null, 2));
  console.log('\n');

  console.log('2. Teammate comparison:');
  console.log(JSON.stringify(teammateComparison, null, 2));
  console.log('\n');

  console.log('3. Cross-team comparison:');
  console.log(JSON.stringify(crossTeamComparison, null, 2));
  console.log('\n');

  console.log('4. Driver ranking:');
  console.log(JSON.stringify(driverRanking, null, 2));
  console.log('\n');

  console.log('=== Invalid Query Examples (Should Reject) ===\n');

  console.log('5. Missing season:');
  console.log(JSON.stringify(invalidMissingSeason, null, 2));
  console.log('\n');

  console.log('6. Wrong normalization:');
  console.log(JSON.stringify(invalidWrongNormalization, null, 2));
}
