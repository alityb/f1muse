import { QueryIntent } from '../../types/query-intent';
import { Interpretation } from '../../types/results';
import { getGapBandThresholdDescriptions } from '../../observability/gap-bands';
import { TEAMMATE_GAP_THRESHOLDS } from '../../config/teammate-gap';
import { computeRowCoverage } from './compute-coverage';
import { computeConfidence } from './compute-confidence';

export function buildInterpretation(intent: QueryIntent, rows: any[]): Interpretation {
  const rowCoverage = computeRowCoverage(intent, rows);

  // coverage is descriptive only - never blocks execution
  // confidence.level is computed separately in compute-confidence.ts

  const confidence = computeConfidence(intent, rows);
  const metricDefinition = getMetricDefinition(intent);

  const interpretation: Interpretation = {
    comparison_basis: getComparisonBasis(intent),
    normalization_scope: getNormalizationScope(intent),
    metric_definition: metricDefinition,
    constraints: {
      min_lap_requirement: rowCoverage.min_lap_requirement,
      rows_included: rowCoverage.rows_included,
      rows_excluded_reason: rowCoverage.rows_excluded_reason,
      other_constraints: getOtherConstraints(intent)
    },
    confidence_notes: buildConfidenceNotes(intent, rows),
    confidence
  };

  return interpretation;
}

function getMetricDefinition(intent: QueryIntent): string {
  if (intent.kind === 'race_results_summary') {
    return 'Race results (no pace metrics)';
  }

  // check for normalized percent pace (season_driver_vs_driver default)
  if (intent.kind === 'season_driver_vs_driver' && intent.normalization !== 'none') {
    return 'Session-median normalized percent pace. Each lap normalized as (lap_time - session_median) / session_median * 100. Negative = faster than field median, positive = slower. Aggregated: median per race, then mean across races (equal weight per race).';
  }

  switch (intent.metric) {
    case 'avg_true_pace':
      return 'Average true pace in seconds (lower is faster). Excludes invalid, pit, and heavily traffic-affected laps.';
    case 'clean_air_pace':
      return 'Average pace in clean air conditions only. Strictly excludes all traffic-affected laps.';
    case 'teammate_gap_raw':
      return 'Season-level teammate gap (median shared-lap pace difference). Signed: primary - secondary (negative = primary faster).';
    default:
      return 'Unknown metric';
  }
}

function getComparisonBasis(intent: QueryIntent): string {
  const asAny = intent as any;

  // dynamic basis for season_driver_vs_driver based on normalization
  if (intent.kind === 'season_driver_vs_driver') {
    if (intent.normalization === 'none') {
      return 'Season-scoped cross-team comparison (raw pace, no normalization)';
    }
    return 'Season-scoped cross-team comparison (session-median normalized percent pace)';
  }

  const basisMap: Record<string, string> = {
    driver_season_summary: `Season summary for ${asAny.driver_id}`,
    driver_career_summary: `Career summary for ${asAny.driver_id}`,
    cross_team_track_scoped_driver_comparison: `Cross-team track-scoped comparison at ${(intent as any).track_id} (raw pace, track-bounded)`,
    teammate_gap_summary_season: 'Full-season teammate gap (median shared-lap pace; signed primary - secondary)',
    teammate_gap_dual_comparison: 'Dual comparison: qualifying gap vs race pace gap (signed primary - secondary)',
    track_fastest_drivers: `Driver ranking at ${(intent as any).track_id}`,
    race_results_summary: 'Official race results from F1DB',
    driver_head_to_head_count: 'Position-based head-to-head comparison (who finished/qualified ahead)',
    driver_performance_vector: 'Cross-metric performance profile (percentiles, consistency, contextual performance)',
    driver_multi_comparison: 'Multi-driver comparison (2-6 drivers ranked by metric)',
    driver_matchup_lookup: 'Precomputed head-to-head lookup from matchup matrix',
    driver_profile_summary: 'Comprehensive driver profile summary',
    driver_trend_summary: 'Multi-season performance trend analysis',
    driver_pole_count: 'Pole position count for driver in season',
    driver_q3_count: 'Q3 appearance count for driver in season',
    season_q3_rankings: 'All drivers ranked by Q3 appearances in season',
    qualifying_gap_teammates: 'Qualifying time gap between teammates (deepest common round Q3>Q2>Q1)',
    qualifying_gap_drivers: 'Qualifying position gap between any two drivers'
  };

  return basisMap[intent.kind] || 'Unknown';
}

function getNormalizationScope(intent: QueryIntent): string {
  // dynamic scope for season_driver_vs_driver based on normalization
  if (intent.kind === 'season_driver_vs_driver') {
    if (intent.normalization === 'none') {
      return 'No normalization (raw pace in seconds)';
    }
    return 'Session-median percent normalization (cross-circuit comparable)';
  }

  const scopeMap: Record<string, string> = {
    driver_season_summary: 'Non-normalized summary statistics',
    driver_career_summary: 'Non-normalized summary statistics',
    teammate_gap_summary_season: 'Team-bounded, season-scoped, teammate-relative gap',
    teammate_gap_dual_comparison: 'Dual metric comparison: qualifying and race pace gaps (symmetric percent difference)',
    race_results_summary: 'Pure race results (no pace metrics)',
    driver_head_to_head_count: 'Position-based comparison (no pace normalization)',
    driver_performance_vector: 'Grid-relative percentiles and contextual deltas',
    driver_multi_comparison: 'Raw metric comparison (no normalization)',
    driver_matchup_lookup: 'Position-based comparison from precomputed matrix',
    driver_pole_count: 'Qualifying position-based (no pace normalization)',
    driver_q3_count: 'Qualifying position-based (no pace normalization)',
    season_q3_rankings: 'Qualifying position-based (no pace normalization)',
    qualifying_gap_teammates: 'Team-bounded, season-scoped qualifying gap (time-based comparison)',
    qualifying_gap_drivers: 'Cross-team qualifying gap (position-based comparison)'
  };

  if (scopeMap[intent.kind]) {
    return scopeMap[intent.kind];
  }

  switch (intent.normalization) {
    case 'team_baseline':
      return 'Normalized to team baseline (teammate-relative performance)';
    case 'none':
      return 'No normalization (raw pace)';
    default:
      return 'Unknown normalization';
  }
}

function buildConfidenceNotes(intent: QueryIntent, rows: any[]): string[] {
  const notes: string[] = [];

  if (intent.kind !== 'race_results_summary' && intent.clean_air_only) {
    notes.push('Analysis limited to clean air laps only. Traffic-affected laps excluded.');
  }

  if (intent.kind !== 'race_results_summary' && intent.compound_context === 'per_compound') {
    notes.push('Comparison segmented by tyre compound. Each compound analyzed separately.');
  }

  if (intent.kind === 'teammate_gap_summary_season' && rows.length > 0) {
    const row = rows[0];
    const coverageStatus = row.coverage_status || 'unknown';
    const sharedRaces = row.shared_races || 0;

    notes.push(`coverage_status: ${coverageStatus}`);
    notes.push(`shared_races: ${sharedRaces}`);

    if (coverageStatus === 'low_coverage') {
      notes.push(
        `Low coverage: Analysis based on fewer than ${TEAMMATE_GAP_THRESHOLDS.valid_shared_races} shared races.`
      );
    }
  }

  // add confidence notes for normalized season_driver_vs_driver
  if (intent.kind === 'season_driver_vs_driver' && rows.length > 0) {
    const row = rows[0];
    if (row.shared_races !== undefined) {
      // normalized mode
      const coverageStatus = row.coverage_status || 'unknown';
      const sharedRaces = row.shared_races || 0;

      notes.push(`coverage_status: ${coverageStatus}`);
      notes.push(`shared_races: ${sharedRaces}`);
      notes.push('Confidence based on shared race count, not lap count.');

      if (coverageStatus === 'low_coverage') {
        notes.push('Low coverage: Analysis based on fewer than 8 shared races.');
      }
    }
  }

  return notes;
}

function getOtherConstraints(intent: QueryIntent): string[] {
  const constraints: string[] = [];

  constraints.push(`Season: ${intent.season}`);

  if (intent.kind !== 'race_results_summary') {
    constraints.push(`Session scope: ${intent.session_scope}`);
    constraints.push(`Compound context: ${intent.compound_context}`);
    if (intent.clean_air_only) {
      constraints.push('Clean air laps only');
    }
  }

  if ('track_id' in intent) {
    constraints.push(`Track: ${intent.track_id}`);
  }

  constraints.push(...getKindSpecificConstraints(intent));

  return constraints;
}

function getKindSpecificConstraints(intent: QueryIntent): string[] {
  const constraints: string[] = [];

  if (intent.kind === 'season_driver_vs_driver') {
    if (intent.normalization === 'none') {
      constraints.push('Raw average lap time comparison');
      constraints.push('Not normalized for track differences');
    } else {
      constraints.push('Session-median percent normalized');
      constraints.push('Equal weight per race (not lap count)');
      constraints.push('Cross-circuit comparable');
      constraints.push('Coverage: valid ≥8 shared races, low_coverage ≥4 shared races');
    }
  }

  if (intent.kind === 'teammate_gap_summary_season') {
    constraints.push('Requires valid teammate pair (same team, same season)');
    constraints.push('Requires minimum shared-lap coverage (20 laps for low_coverage, 50 laps for valid)');
    constraints.push(...getGapBandThresholdDescriptions());
  }

  if (intent.kind === 'teammate_gap_dual_comparison') {
    constraints.push('Requires valid teammate pair (same team, same season)');
    constraints.push('Combines qualifying gap (Q3>Q2>Q1) and race pace gap');
    constraints.push('Supports partial results if one metric is available');
    constraints.push('Coverage: valid ≥8 shared races, low_coverage ≥4 shared races');
  }

  if (intent.kind === 'driver_head_to_head_count') {
    constraints.push(`Metric: ${intent.h2h_metric}`);
    constraints.push(`Scope: ${intent.h2h_scope} (${intent.h2h_scope === 'field' ? 'any two drivers' : 'same team only'})`);
    constraints.push('Lower position number = ahead (1st > 2nd > 3rd)');
    constraints.push('Coverage: valid ≥8 shared events, low_coverage ≥4 shared events');
    constraints.push(...getFilterConstraints(intent.filters));
  }

  if (intent.kind === 'driver_multi_comparison') {
    constraints.push(`Metric: ${intent.comparison_metric}`);
    constraints.push(`Drivers: ${intent.driver_ids.length} (2-6 supported)`);
    constraints.push('Lower metric value = faster (for pace metrics)');
    constraints.push('Lower consistency value = more consistent');
  }

  if (intent.kind === 'driver_matchup_lookup') {
    constraints.push(`Metric: ${intent.h2h_metric}`);
    constraints.push('Results from precomputed matchup matrix');
    constraints.push('Lower position number = ahead (1st > 2nd > 3rd)');
    constraints.push('Coverage: valid ≥8 shared events, low_coverage ≥4 shared events');
  }

  return constraints;
}

function getFilterConstraints(filters: any): string[] {
  if (!filters) { return []; }

  const constraints: string[] = [];

  if (filters.session) {
    constraints.push(`Session filter: ${filters.session}`);
  }
  if (filters.track_type) {
    constraints.push(`Track type filter: ${filters.track_type}`);
  }
  if (filters.weather) {
    constraints.push(`Weather filter: ${filters.weather}`);
  }
  if (filters.rounds?.length) {
    constraints.push(`Rounds filter: ${filters.rounds.join(', ')}`);
  }
  if (filters.date_from || filters.date_to) {
    constraints.push(`Date range: ${filters.date_from || 'start'} to ${filters.date_to || 'end'}`);
  }
  if (filters.exclude_dnfs) {
    constraints.push('DNF/DNS results excluded');
  }

  return constraints;
}

export function getDataScope(intent: QueryIntent): string {
  if (intent.kind === 'driver_career_summary') {
    return 'career-scoped';
  }
  if (intent.kind === 'driver_season_summary') {
    return `season-scoped summary: ${intent.season}`;
  }
  if ('track_id' in intent) {
    return `track-scoped: ${(intent as any).track_id}, ${intent.season}`;
  }
  return `season-scoped: ${intent.season}`;
}
