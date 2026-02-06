import { QueryIntent } from '../../types/query-intent';
import { TEAMMATE_GAP_THRESHOLDS } from '../../config/teammate-gap';

export interface RowCoverageResult {
  min_lap_requirement: number;
  rows_included: number;
  rows_excluded_reason?: string;
}

const MIN_LAPS_COMPARISON = 10;
const MIN_LAPS_RANKING = 5;

export function computeRowCoverage(intent: QueryIntent, rows: any[]): RowCoverageResult {
  const rows_included = rows.length;

  switch (intent.kind) {
    case 'season_driver_vs_driver':
    case 'cross_team_track_scoped_driver_comparison':
      return computeComparisonCoverage(rows);

    case 'driver_season_summary':
      return computeSeasonSummaryCoverage(rows);

    case 'track_fastest_drivers':
      return computeRankingCoverage(rows);

    case 'driver_career_summary':
      return { min_lap_requirement: 0, rows_included };

    case 'teammate_gap_summary_season':
      return computeTeammateGapCoverage(rows);

    case 'teammate_gap_dual_comparison':
      return computeDualComparisonCoverage(rows);

    case 'race_results_summary':
      return { min_lap_requirement: 0, rows_included };

    case 'driver_head_to_head_count':
      return computeHeadToHeadCoverage(rows);

    case 'driver_performance_vector':
      return computePerformanceVectorCoverage(rows);

    case 'driver_multi_comparison':
      return computeMultiComparisonCoverage(rows);

    case 'driver_matchup_lookup':
      return computeMatchupLookupCoverage(rows);

    case 'driver_profile_summary':
      return computeProfileCoverage(rows);

    case 'driver_trend_summary':
      return computeTrendCoverage(rows);

    case 'driver_pole_count':
    case 'driver_q3_count':
      return computeQualifyingStatsCoverage(rows);

    case 'season_q3_rankings':
      return computeQ3RankingsCoverage(rows);

    case 'qualifying_gap_teammates':
    case 'qualifying_gap_drivers':
      return computeQualifyingGapCoverage(rows);

    default:
      return { min_lap_requirement: 0, rows_included };
  }
}

function computeComparisonCoverage(rows: any[]): RowCoverageResult {
  const rows_included = rows.length;
  let min_lap_requirement = MIN_LAPS_COMPARISON;

  // coverage is informational only - never blocks execution
  // rows_excluded_reason is NOT set here to avoid misleading downstream consumers
  // confidence level is computed separately in compute-confidence.ts

  // check if this is normalized mode (has shared_races)
  const sharedRacesRaw = rows[0]?.shared_races;
  if (sharedRacesRaw !== undefined && sharedRacesRaw !== null) {
    const MIN_SHARED_RACES = 4;
    return { min_lap_requirement: MIN_SHARED_RACES, rows_included };
  }

  // raw pace mode - use lap counts
  return { min_lap_requirement, rows_included };
}

function computeSeasonSummaryCoverage(rows: any[]): RowCoverageResult {
  const minRaceCount = 1;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: minRaceCount, rows_included: rows.length };
}

function computeRankingCoverage(rows: any[]): RowCoverageResult {
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: MIN_LAPS_RANKING, rows_included: rows.length };
}

function computeTeammateGapCoverage(rows: any[]): RowCoverageResult {
  const minSharedRaces = TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: minSharedRaces, rows_included: rows.length };
}

function computeDualComparisonCoverage(rows: any[]): RowCoverageResult {
  const minDualSharedRaces = TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: minDualSharedRaces, rows_included: rows.length };
}

function computeHeadToHeadCoverage(rows: any[]): RowCoverageResult {
  const MIN_SHARED_EVENTS = 4;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: MIN_SHARED_EVENTS, rows_included: rows.length };
}

function computePerformanceVectorCoverage(rows: any[]): RowCoverageResult {
  const MIN_RACE_LAPS = 20;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: MIN_RACE_LAPS, rows_included: rows.length };
}

function computeMultiComparisonCoverage(rows: any[]): RowCoverageResult {
  const MIN_LAPS_PER_DRIVER = 10;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: MIN_LAPS_PER_DRIVER, rows_included: rows.length };
}

function computeMatchupLookupCoverage(rows: any[]): RowCoverageResult {
  const MIN_SHARED_EVENTS = 4;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: MIN_SHARED_EVENTS, rows_included: rows.length };
}

function computeProfileCoverage(rows: any[]): RowCoverageResult {
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: 1, rows_included: rows.length };
}

function computeTrendCoverage(rows: any[]): RowCoverageResult {
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: 1, rows_included: rows.length };
}

function computeQualifyingStatsCoverage(rows: any[]): RowCoverageResult {
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: 1, rows_included: rows.length };
}

function computeQ3RankingsCoverage(rows: any[]): RowCoverageResult {
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: 5, rows_included: rows.length };
}

function computeQualifyingGapCoverage(rows: any[]): RowCoverageResult {
  const MIN_SHARED_SESSIONS = 5;
  // coverage is informational only - never blocks execution
  return { min_lap_requirement: MIN_SHARED_SESSIONS, rows_included: rows.length };
}
