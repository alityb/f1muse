import { QueryIntent } from '../../types/query-intent';
import { ConfidenceMetadata } from '../../types/results';
import {
  computeComparisonConfidence,
  computeRankingConfidence,
  computeTeammateGapConfidence,
  computeCoverageLevel
} from '../confidence-analyzer';

type CoverageLevel = 'high' | 'moderate' | 'low' | 'insufficient';

export function computeConfidence(intent: QueryIntent, rows: any[]): ConfidenceMetadata {
  const row = rows[0];

  switch (intent.kind) {
    case 'season_driver_vs_driver':
    case 'cross_team_track_scoped_driver_comparison':
      return buildComparisonConfidence(row);

    case 'driver_season_summary':
      return buildLooseConfidence(parseInt(row.laps_considered || '0'));

    case 'track_fastest_drivers':
      return buildRankingConfidence(rows);

    case 'teammate_gap_summary_season':
      return buildTeammateGapConfidenceFromRow(row);

    case 'teammate_gap_dual_comparison':
      return buildDualComparisonConfidenceFromRow(row);

    case 'driver_career_summary':
      return buildLooseConfidence(parseInt(row.seasons_raced || '0'));

    case 'race_results_summary':
      return { coverage_level: 'high', laps_considered: 0, notes: ['Official race results from F1DB'] };

    case 'driver_head_to_head_count':
      return buildHeadToHeadConfidence(row);

    case 'driver_performance_vector':
      return buildPerformanceVectorConfidence(row);

    case 'driver_multi_comparison':
      return buildMultiComparisonConfidence(rows);

    case 'driver_matchup_lookup':
      return buildMatchupLookupConfidence(row);

    case 'driver_profile_summary':
    case 'driver_trend_summary':
      return buildProfileTrendConfidence(row, intent.kind);

    case 'driver_pole_count':
    case 'driver_q3_count':
      return buildQualifyingStatsConfidence(row);

    case 'season_q3_rankings':
      return buildQ3RankingsConfidence(rows);

    case 'qualifying_gap_teammates':
    case 'qualifying_gap_drivers':
      return buildQualifyingGapConfidence(row);

    default:
      throw new Error(`Cannot compute confidence for intent kind: ${(intent as any).kind}`);
  }
}

function buildComparisonConfidence(row: any): ConfidenceMetadata {
  const laps_a = parseInt(row.driver_a_laps || '0');
  const laps_b = parseInt(row.driver_b_laps || '0');
  const clean_air_laps_a = row.driver_a_clean_air_laps ? parseInt(row.driver_a_clean_air_laps) : undefined;
  const clean_air_laps_b = row.driver_b_clean_air_laps ? parseInt(row.driver_b_clean_air_laps) : undefined;
  const shared_valid_laps = row.shared_valid_laps ? parseInt(row.shared_valid_laps) : undefined;

  return computeComparisonConfidence(laps_a, laps_b, clean_air_laps_a, clean_air_laps_b, shared_valid_laps);
}

function buildRankingConfidence(rows: any[]): ConfidenceMetadata {
  const total_laps = rows.reduce((sum, r) => sum + parseInt(r.laps_considered || '0'), 0);
  const laps_per_driver = rows.map(r => parseInt(r.laps_considered || '0'));
  const min_laps = Math.min(...laps_per_driver);
  const max_laps = Math.max(...laps_per_driver);
  const clean_air_laps = rows.reduce((sum, r) => sum + (r.clean_air_laps ? parseInt(r.clean_air_laps) : 0), 0);

  return computeRankingConfidence(total_laps, min_laps, max_laps, clean_air_laps > 0 ? clean_air_laps : undefined);
}

function buildTeammateGapConfidenceFromRow(row: any): ConfidenceMetadata {
  const shared_races = parseInt(row.shared_races || '0');
  const coverage_status = row.coverage_status || 'insufficient';
  return computeTeammateGapConfidence(shared_races, coverage_status);
}

function buildDualComparisonConfidenceFromRow(row: any): ConfidenceMetadata {
  const qualifyingSharedRaces = parseInt(row.qualifying_shared_races || '0');
  const raceSharedRaces = parseInt(row.race_shared_races || '0');
  const qualifyingCoverage = row.qualifying_coverage_status || 'insufficient';
  const raceCoverage = row.race_coverage_status || 'insufficient';
  const qualifyingAvailable = row.qualifying_available === true;
  const raceAvailable = row.race_available === true;

  const combinedCoverage = determineCombinedCoverage(
    qualifyingAvailable,
    raceAvailable,
    qualifyingCoverage,
    raceCoverage
  );

  return computeTeammateGapConfidence(Math.max(qualifyingSharedRaces, raceSharedRaces), combinedCoverage);
}

function determineCombinedCoverage(
  qualifyingAvailable: boolean,
  raceAvailable: boolean,
  qualifyingCoverage: string,
  raceCoverage: string
): 'valid' | 'low_coverage' | 'insufficient' {
  if (qualifyingAvailable && raceAvailable) {
    if (qualifyingCoverage === 'valid' && raceCoverage === 'valid') {
      return 'valid';
    }
    if (qualifyingCoverage === 'insufficient' || raceCoverage === 'insufficient') {
      return 'insufficient';
    }
    return 'low_coverage';
  }

  if (qualifyingAvailable) {
    return qualifyingCoverage as 'valid' | 'low_coverage' | 'insufficient';
  }
  if (raceAvailable) {
    return raceCoverage as 'valid' | 'low_coverage' | 'insufficient';
  }

  return 'insufficient';
}

function buildHeadToHeadConfidence(row: any): ConfidenceMetadata {
  const shared_events = parseInt(row.shared_events || '0');
  const coverage_status = row.coverage_status || 'insufficient';

  let coverage_level: CoverageLevel;
  if (coverage_status === 'valid') {
    coverage_level = shared_events >= 15 ? 'high' : 'moderate';
  } else if (coverage_status === 'low_coverage') {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [`Based on ${shared_events} shared events`];
  if (coverage_status === 'low_coverage') {
    notes.push('Low coverage: fewer than 8 shared events');
  } else if (coverage_status === 'insufficient') {
    notes.push('Insufficient coverage: fewer than 4 shared events');
  }

  return { coverage_level, laps_considered: shared_events, notes };
}

function buildPerformanceVectorConfidence(row: any): ConfidenceMetadata {
  const race_laps = parseInt(row.race_laps || '0', 10);
  const qualifying_laps = parseInt(row.qualifying_laps || '0', 10);

  let coverage_level: CoverageLevel;
  if (qualifying_laps >= 10 && race_laps >= 50) {
    coverage_level = 'high';
  } else if (qualifying_laps >= 5 && race_laps >= 20) {
    coverage_level = 'moderate';
  } else if (qualifying_laps >= 3 && race_laps >= 10) {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [`Based on ${qualifying_laps} qualifying laps and ${race_laps} race laps`];
  if (coverage_level === 'low') {
    notes.push('Low coverage: limited sample for some metrics');
  } else if (coverage_level === 'insufficient') {
    notes.push('Insufficient coverage: results may be unreliable');
  }

  return { coverage_level, laps_considered: race_laps, notes };
}

function buildMultiComparisonConfidence(rows: any[]): ConfidenceMetadata {
  const totalDrivers = parseInt(rows[0]?.total_drivers || '0', 10);
  const rankedDrivers = parseInt(rows[0]?.ranked_drivers || '0', 10);
  const minLapsRow = rows.reduce((min, r) => {
    const laps = parseInt(r.laps_considered || '0', 10);
    return laps < min ? laps : min;
  }, Infinity);
  const minLaps = minLapsRow === Infinity ? 0 : minLapsRow;

  let coverage_level: CoverageLevel;
  if (minLaps >= 50 && rankedDrivers === totalDrivers) {
    coverage_level = 'high';
  } else if (minLaps >= 20 && rankedDrivers >= totalDrivers * 0.8) {
    coverage_level = 'moderate';
  } else if (minLaps >= 10 && rankedDrivers >= totalDrivers * 0.5) {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [
    `Comparing ${rankedDrivers} of ${totalDrivers} drivers`,
    `Minimum laps per driver: ${minLaps}`
  ];
  if (rankedDrivers < totalDrivers) {
    notes.push(`${totalDrivers - rankedDrivers} drivers excluded due to missing data`);
  }
  if (coverage_level === 'low') {
    notes.push('Low coverage: some drivers have limited data');
  } else if (coverage_level === 'insufficient') {
    notes.push('Insufficient coverage: results may be unreliable');
  }

  return { coverage_level, laps_considered: minLaps, notes };
}

function buildMatchupLookupConfidence(row: any): ConfidenceMetadata {
  const shared_events = parseInt(row.shared_events || '0', 10);
  const coverage_status = row.coverage_status || 'insufficient';

  let coverage_level: CoverageLevel;
  if (coverage_status === 'valid') {
    coverage_level = shared_events >= 15 ? 'high' : 'moderate';
  } else if (coverage_status === 'low_coverage') {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [
    `Based on ${shared_events} shared events (precomputed)`,
    `Computed at: ${row.computed_at}`
  ];
  if (coverage_status === 'low_coverage') {
    notes.push('Low coverage: fewer than 8 shared events');
  } else if (coverage_status === 'insufficient') {
    notes.push('Insufficient coverage: fewer than 4 shared events');
  }

  return { coverage_level, laps_considered: shared_events, notes };
}

function buildProfileTrendConfidence(row: any, kind: string): ConfidenceMetadata {
  const sharedRaces = parseInt(row.teammate_shared_races || row.seasons_analyzed || '0', 10);

  let coverage_level: CoverageLevel;
  if (sharedRaces >= 10) {
    coverage_level = 'high';
  } else if (sharedRaces >= 5) {
    coverage_level = 'moderate';
  } else if (sharedRaces >= 1) {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [];
  if (sharedRaces < 5) {
    notes.push(`Limited data: ${sharedRaces} data points`);
  }
  if (sharedRaces === 1 && kind === 'driver_trend_summary') {
    notes.push('Single season: no trend can be calculated');
  }

  return { coverage_level, laps_considered: sharedRaces, notes };
}

function buildQualifyingStatsConfidence(row: any): ConfidenceMetadata {
  const totalSessions = parseInt(row.total_sessions || '0', 10);

  let coverage_level: CoverageLevel;
  if (totalSessions >= 15) {
    coverage_level = 'high';
  } else if (totalSessions >= 8) {
    coverage_level = 'moderate';
  } else if (totalSessions >= 4) {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [`Based on ${totalSessions} qualifying sessions`];
  if (coverage_level === 'low') {
    notes.push('Low coverage: fewer than 8 qualifying sessions');
  } else if (coverage_level === 'insufficient') {
    notes.push('Insufficient coverage: fewer than 4 qualifying sessions');
  }

  return { coverage_level, laps_considered: totalSessions, notes };
}

function buildQ3RankingsConfidence(rows: any[]): ConfidenceMetadata {
  const driverCount = rows.length;

  let coverage_level: CoverageLevel;
  if (driverCount >= 18) {
    coverage_level = 'high';
  } else if (driverCount >= 10) {
    coverage_level = 'moderate';
  } else if (driverCount >= 5) {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  return {
    coverage_level,
    laps_considered: driverCount,
    notes: [`Ranking ${driverCount} drivers by Q3 appearances`]
  };
}

function buildQualifyingGapConfidence(row: any): ConfidenceMetadata {
  const sharedSessions = parseInt(row.shared_races || row.shared_sessions || '0', 10);
  const coverageStatus = row.coverage_status || 'insufficient';

  let coverage_level: CoverageLevel;
  if (coverageStatus === 'valid') {
    coverage_level = sharedSessions >= 15 ? 'high' : 'moderate';
  } else if (coverageStatus === 'low_coverage') {
    coverage_level = 'low';
  } else {
    coverage_level = 'insufficient';
  }

  const notes: string[] = [`Based on ${sharedSessions} shared qualifying sessions`];
  if (coverageStatus === 'low_coverage') {
    notes.push('Low coverage: fewer than 10 shared sessions');
  } else if (coverageStatus === 'insufficient') {
    notes.push('Insufficient coverage: fewer than 5 shared sessions');
  }

  return { coverage_level, laps_considered: sharedSessions, notes };
}

export function buildLooseConfidence(laps_considered: number): ConfidenceMetadata {
  const coverage_level = computeCoverageLevel(laps_considered);
  const notes: string[] = [];

  if (coverage_level === 'insufficient') {
    notes.push('Insufficient sample size — results are limited');
  } else if (coverage_level === 'low') {
    notes.push('Low sample size — treat results cautiously');
  } else if (coverage_level === 'moderate') {
    notes.push('Moderate sample size — results have reasonable confidence');
  } else if (coverage_level === 'high') {
    notes.push('High sample size — results have strong statistical confidence');
  }

  return { coverage_level, laps_considered, notes };
}
