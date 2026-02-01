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
  let rows_excluded_reason: string | undefined;

  const driverALaps = rows[0]?.driver_a_laps || rows[0]?.laps_considered || 0;
  const driverBLaps = rows[0]?.driver_b_laps || rows[0]?.laps_considered || 0;
  const sharedValidLapsRaw = rows[0]?.shared_valid_laps;

  if (sharedValidLapsRaw !== undefined && sharedValidLapsRaw !== null) {
    const sharedValidLaps = parseInt(sharedValidLapsRaw, 10);
    min_lap_requirement = MIN_LAPS_COMPARISON;

    if (sharedValidLaps < MIN_LAPS_COMPARISON) {
      rows_excluded_reason = `Insufficient shared valid laps: ${sharedValidLaps} laps found, minimum ${MIN_LAPS_COMPARISON} required`;
    }
  }

  if (!rows_excluded_reason && (driverALaps < MIN_LAPS_COMPARISON || driverBLaps < MIN_LAPS_COMPARISON)) {
    rows_excluded_reason = `Insufficient laps: Driver A (${driverALaps}), Driver B (${driverBLaps})`;
  }

  return { min_lap_requirement, rows_included, rows_excluded_reason };
}

function computeSeasonSummaryCoverage(rows: any[]): RowCoverageResult {
  const minRaceCount = 1;
  const raceCount = parseInt(rows[0]?.race_count || '0', 10);
  let rows_excluded_reason: string | undefined;

  if (raceCount < minRaceCount) {
    rows_excluded_reason = `Insufficient race count: ${raceCount} races found, minimum ${minRaceCount} required`;
  }

  return { min_lap_requirement: minRaceCount, rows_included: rows.length, rows_excluded_reason };
}

function computeRankingCoverage(rows: any[]): RowCoverageResult {
  const insufficientDrivers = rows.filter(row => (row.laps_considered || 0) < MIN_LAPS_RANKING);
  let rows_excluded_reason: string | undefined;

  if (insufficientDrivers.length > 0) {
    rows_excluded_reason = `${insufficientDrivers.length} drivers excluded due to insufficient laps`;
  }

  return { min_lap_requirement: MIN_LAPS_RANKING, rows_included: rows.length, rows_excluded_reason };
}

function computeTeammateGapCoverage(rows: any[]): RowCoverageResult {
  const minSharedRaces = TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races;
  const sharedRaces = parseInt(rows[0]?.shared_races || '0', 10);
  let rows_excluded_reason: string | undefined;

  if (sharedRaces < minSharedRaces) {
    rows_excluded_reason = `Insufficient shared-race coverage: ${sharedRaces} races found, but minimum ${minSharedRaces} shared races required for teammate gap analysis`;
  }

  return { min_lap_requirement: minSharedRaces, rows_included: rows.length, rows_excluded_reason };
}

function computeDualComparisonCoverage(rows: any[]): RowCoverageResult {
  const minDualSharedRaces = TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races;
  const qualifyingAvailable = rows[0]?.qualifying_available === true;
  const raceAvailable = rows[0]?.race_available === true;
  let rows_excluded_reason: string | undefined;

  if (!qualifyingAvailable && !raceAvailable) {
    rows_excluded_reason = 'No data available for either qualifying or race pace metrics';
  }

  return { min_lap_requirement: minDualSharedRaces, rows_included: rows.length, rows_excluded_reason };
}

function computeHeadToHeadCoverage(rows: any[]): RowCoverageResult {
  const MIN_SHARED_EVENTS = 4;
  const sharedEvents = parseInt(rows[0]?.shared_events || '0', 10);
  const coverageStatus = rows[0]?.coverage_status || 'insufficient';
  let rows_excluded_reason: string | undefined;

  if (coverageStatus === 'insufficient' || sharedEvents < MIN_SHARED_EVENTS) {
    rows_excluded_reason = `Insufficient shared events: ${sharedEvents} events found, minimum ${MIN_SHARED_EVENTS} required for head-to-head comparison`;
  }

  return { min_lap_requirement: MIN_SHARED_EVENTS, rows_included: rows.length, rows_excluded_reason };
}

function computePerformanceVectorCoverage(rows: any[]): RowCoverageResult {
  const MIN_QUALI_LAPS = 5;
  const MIN_RACE_LAPS = 20;
  const qualifyingLaps = parseInt(rows[0]?.qualifying_laps || '0', 10);
  const raceLaps = parseInt(rows[0]?.race_laps || '0', 10);
  let rows_excluded_reason: string | undefined;

  if (qualifyingLaps < MIN_QUALI_LAPS || raceLaps < MIN_RACE_LAPS) {
    rows_excluded_reason = `Insufficient data: ${qualifyingLaps} qualifying laps (min ${MIN_QUALI_LAPS}) and ${raceLaps} race laps (min ${MIN_RACE_LAPS}) found`;
  }

  return { min_lap_requirement: MIN_RACE_LAPS, rows_included: rows.length, rows_excluded_reason };
}

function computeMultiComparisonCoverage(rows: any[]): RowCoverageResult {
  const MIN_LAPS_PER_DRIVER = 10;
  const totalDrivers = parseInt(rows[0]?.total_drivers || '0', 10);
  const rankedDrivers = parseInt(rows[0]?.ranked_drivers || '0', 10);
  let rows_excluded_reason: string | undefined;

  if (rankedDrivers < 2) {
    rows_excluded_reason = `Insufficient data: only ${rankedDrivers} of ${totalDrivers} drivers have enough data for comparison`;
  } else {
    const minLaps = rows.reduce((min, r) => {
      const laps = parseInt(r.laps_considered || '0', 10);
      return laps < min ? laps : min;
    }, Infinity);

    if (minLaps < MIN_LAPS_PER_DRIVER) {
      rows_excluded_reason = `Insufficient data: minimum laps per driver is ${minLaps} (min ${MIN_LAPS_PER_DRIVER} required)`;
    }
  }

  return { min_lap_requirement: MIN_LAPS_PER_DRIVER, rows_included: rows.length, rows_excluded_reason };
}

function computeMatchupLookupCoverage(rows: any[]): RowCoverageResult {
  const MIN_SHARED_EVENTS = 4;
  const sharedEvents = parseInt(rows[0]?.shared_events || '0', 10);
  const coverageStatus = rows[0]?.coverage_status || 'insufficient';
  let rows_excluded_reason: string | undefined;

  if (coverageStatus === 'insufficient' || sharedEvents < MIN_SHARED_EVENTS) {
    rows_excluded_reason = `Insufficient shared events: ${sharedEvents} events found, minimum ${MIN_SHARED_EVENTS} required`;
  }

  return { min_lap_requirement: MIN_SHARED_EVENTS, rows_included: rows.length, rows_excluded_reason };
}

function computeProfileCoverage(rows: any[]): RowCoverageResult {
  const hasCareerData = rows[0]?.championships !== null || rows[0]?.total_wins !== null;
  let rows_excluded_reason: string | undefined;

  if (!hasCareerData) {
    rows_excluded_reason = 'Driver not found in database';
  }

  return { min_lap_requirement: 1, rows_included: rows.length, rows_excluded_reason };
}

function computeTrendCoverage(rows: any[]): RowCoverageResult {
  const seasonsAnalyzed = parseInt(rows[0]?.seasons_analyzed || '0', 10);
  let rows_excluded_reason: string | undefined;

  if (seasonsAnalyzed < 1) {
    rows_excluded_reason = `Insufficient seasons: ${seasonsAnalyzed} analyzed, minimum 1 required`;
  }

  return { min_lap_requirement: 1, rows_included: rows.length, rows_excluded_reason };
}

function computeQualifyingStatsCoverage(rows: any[]): RowCoverageResult {
  const totalSessions = parseInt(rows[0]?.total_sessions || '0', 10);
  let rows_excluded_reason: string | undefined;

  if (totalSessions < 1) {
    rows_excluded_reason = 'No qualifying sessions found for driver in this season';
  }

  return { min_lap_requirement: 1, rows_included: rows.length, rows_excluded_reason };
}

function computeQ3RankingsCoverage(rows: any[]): RowCoverageResult {
  let rows_excluded_reason: string | undefined;

  if (rows.length < 5) {
    rows_excluded_reason = `Insufficient drivers: ${rows.length} found, minimum 5 required for ranking`;
  }

  return { min_lap_requirement: 5, rows_included: rows.length, rows_excluded_reason };
}

function computeQualifyingGapCoverage(rows: any[]): RowCoverageResult {
  const MIN_SHARED_SESSIONS = 5;
  const sharedSessions = parseInt(rows[0]?.shared_races || rows[0]?.shared_sessions || '0', 10);
  const coverageStatus = rows[0]?.coverage_status || 'insufficient';
  let rows_excluded_reason: string | undefined;

  if (coverageStatus === 'insufficient' || sharedSessions < MIN_SHARED_SESSIONS) {
    rows_excluded_reason = `Insufficient shared qualifying sessions: ${sharedSessions} found, minimum ${MIN_SHARED_SESSIONS} required`;
  }

  return { min_lap_requirement: MIN_SHARED_SESSIONS, rows_included: rows.length, rows_excluded_reason };
}
