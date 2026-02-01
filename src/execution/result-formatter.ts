import { QueryIntent } from '../types/query-intent';
import {
  ResultPayload,
  DriverRankingPayload,
  DriverRankingEntry,
  CrossTeamTrackScopedDriverComparisonPayload,
  TeammateGapSummarySeasonPayload,
  TeammateGapDualComparisonPayload,
  DualComparisonMetricComponent,
  DualComparisonSummary,
  CoverageStatus,
  SeasonDriverSummaryPayload,
  SeasonDriverVsDriverPayload,
  DriverCareerSummaryPayload,
  RaceResultsSummaryPayload,
  RaceResultsEntry,
  DriverHeadToHeadCountPayload,
  HeadToHeadFiltersApplied,
  DriverPerformanceVectorPayload,
  DriverMultiComparisonPayload,
  DriverMultiComparisonEntry,
  DriverMatchupLookupPayload,
  DriverProfileSummaryPayload,
  DriverTrendSummaryPayload,
  TrackPerformanceEntry,
  SeasonPerformanceEntry
} from '../types/results';
import { classifyGapBand } from '../observability/gap-bands';
import { getCoverageStatus } from '../config/teammate-gap';

/**
 * Formats raw database results into structured result payloads
 */
export class ResultFormatter {
  format(intent: QueryIntent, rows: any[]): ResultPayload {
    switch (intent.kind) {
      case 'driver_season_summary':
        return this.formatSeasonDriverSummary(intent, rows);

      case 'season_driver_vs_driver':
        return this.formatSeasonDriverVsDriver(intent, rows);

      case 'driver_career_summary':
        return this.formatDriverCareerSummary(intent, rows);

      case 'track_fastest_drivers':
        return this.formatDriverRanking(intent, rows);

      case 'cross_team_track_scoped_driver_comparison':
        return this.formatCrossTeamTrackScopedComparison(intent, rows);

      case 'teammate_gap_summary_season':
        return this.formatTeammateGapSummarySeason(intent, rows);

      case 'teammate_gap_dual_comparison':
        return this.formatTeammateGapDualComparison(intent, rows);

      case 'race_results_summary':
        return this.formatRaceResultsSummary(intent, rows);

      case 'driver_head_to_head_count':
        return this.formatDriverHeadToHeadCount(intent, rows);

      case 'driver_performance_vector':
        return this.formatDriverPerformanceVector(intent, rows);

      case 'driver_multi_comparison':
        return this.formatDriverMultiComparison(intent, rows);

      case 'driver_matchup_lookup':
        return this.formatDriverMatchupLookup(intent, rows);

      case 'driver_profile_summary':
        return this.formatDriverProfileSummary(intent, rows);

      case 'driver_trend_summary':
        return this.formatDriverTrendSummary(intent, rows);

      case 'driver_pole_count':
        return this.formatDriverPoleCount(intent, rows);

      case 'driver_q3_count':
        return this.formatDriverQ3Count(intent, rows);

      case 'season_q3_rankings':
        return this.formatSeasonQ3Rankings(intent, rows);

      case 'qualifying_gap_teammates':
        return this.formatQualifyingGapTeammates(intent, rows);

      case 'qualifying_gap_drivers':
        return this.formatQualifyingGapDrivers(intent, rows);

      default:
        throw new Error(`Cannot format results for intent kind: ${(intent as any).kind}`);
    }
  }

  private formatSeasonDriverSummary(
    intent: Extract<QueryIntent, { kind: 'driver_season_summary' }>,
    rows: any[]
  ): SeasonDriverSummaryPayload {
    const row = rows[0];

    return {
      type: 'driver_season_summary',
      season: intent.season,
      driver_id: row.driver_id,
      wins: parseInt(row.wins || '0'),
      podiums: parseInt(row.podiums || '0'),
      dnfs: parseInt(row.dnfs || '0'),
      race_count: parseInt(row.race_count || '0'),
      avg_race_pace: row.avg_race_pace !== null && row.avg_race_pace !== undefined
        ? parseFloat(row.avg_race_pace)
        : null,
      laps_considered: parseInt(row.laps_considered || '0')
    };
  }

  private formatSeasonDriverVsDriver(
    intent: Extract<QueryIntent, { kind: 'season_driver_vs_driver' }>,
    rows: any[]
  ): SeasonDriverVsDriverPayload {
    const row = rows[0];

    const driver_a_value = parseFloat(row.driver_a_value);
    const driver_b_value = parseFloat(row.driver_b_value);
    const driver_a_laps = parseInt(row.driver_a_laps || '0');
    const driver_b_laps = parseInt(row.driver_b_laps || '0');

    return {
      type: 'season_driver_vs_driver',
      season: intent.season,
      driver_a: row.driver_a_id,
      driver_b: row.driver_b_id,
      metric: intent.metric,
      driver_a_value,
      driver_b_value,
      difference: driver_a_value - driver_b_value,
      normalization: intent.normalization,
      driver_a_laps,
      driver_b_laps,
      laps_considered: driver_a_laps + driver_b_laps
    };
  }

  private formatDriverRanking(
    intent: Extract<QueryIntent, { kind: 'track_fastest_drivers' }>,
    rows: any[]
  ): DriverRankingPayload {
    const entries: DriverRankingEntry[] = rows.map(row => ({
      driver_id: row.driver_id,
      value: parseFloat(row.value),
      laps_considered: parseInt(row.laps_considered)
    }));

    return {
      type: 'driver_ranking',
      season: intent.season,
      track_id: intent.track_id,
      metric: intent.metric,
      ranking_basis: 'lower_is_faster',
      entries
    };
  }

  private formatDriverCareerSummary(
    _intent: Extract<QueryIntent, { kind: 'driver_career_summary' }>,
    rows: any[]
  ): DriverCareerSummaryPayload {
    const row = rows[0];

    return {
      type: 'driver_career_summary',
      driver_id: row.driver_id,
      championships: parseInt(row.championships || '0'),
      seasons_raced: parseInt(row.seasons_raced || '0'),
      career_podiums: parseInt(row.career_podiums || '0'),
      career_wins: parseInt(row.career_wins || '0'),
      pace_trend_start_season: row.start_season !== null && row.start_season !== undefined
        ? parseInt(row.start_season, 10)
        : null,
      pace_trend_start_value: row.start_value !== null && row.start_value !== undefined
        ? parseFloat(row.start_value)
        : null,
      pace_trend_end_season: row.end_season !== null && row.end_season !== undefined
        ? parseInt(row.end_season, 10)
        : null,
      pace_trend_end_value: row.end_value !== null && row.end_value !== undefined
        ? parseFloat(row.end_value)
        : null,
      pace_trend_per_season: row.pace_trend_per_season !== null && row.pace_trend_per_season !== undefined
        ? parseFloat(row.pace_trend_per_season)
        : null
    };
  }

  private formatCrossTeamTrackScopedComparison(
    intent: Extract<QueryIntent, { kind: 'cross_team_track_scoped_driver_comparison' }>,
    rows: any[]
  ): CrossTeamTrackScopedDriverComparisonPayload {
    const row = rows[0];

    const driver_a_value = parseFloat(row.driver_a_value);
    const driver_b_value = parseFloat(row.driver_b_value);
    const driver_a_laps = parseInt(row.driver_a_laps || '0');
    const driver_b_laps = parseInt(row.driver_b_laps || '0');

    return {
      type: 'cross_team_track_scoped_driver_comparison',
      season: intent.season,
      track_id: intent.track_id,
      metric: intent.metric,
      driver_a: row.driver_a_id,
      driver_b: row.driver_b_id,
      driver_a_value,
      driver_b_value,
      pace_delta: driver_a_value - driver_b_value,  // lower = faster
      compound_context: intent.compound_context,
      driver_a_laps,
      driver_b_laps,
      laps_considered: driver_a_laps + driver_b_laps
    };
  }

  // uses race pace symmetric percent difference methodology
  private formatTeammateGapSummarySeason(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_summary_season' }>,
    rows: any[]
  ): TeammateGapSummarySeasonPayload {
    const row = rows[0];

    const gapSeconds = row.gap_seconds !== null ? parseFloat(row.gap_seconds) : 0;
    const gapSecondsAbs = Math.abs(gapSeconds);
    const sharedRaces = parseInt(row.shared_races || '0', 10);
    const fasterDriverPrimaryCount = parseInt(row.faster_driver_primary_count || '0', 10);

    // Use coverage status from ingestion (fallback if missing)
    const coverageStatusRaw = typeof row.coverage_status === 'string' ? row.coverage_status : null;
    const coverageStatus: CoverageStatus = coverageStatusRaw === 'valid' ||
      coverageStatusRaw === 'low_coverage' ||
      coverageStatusRaw === 'insufficient'
      ? coverageStatusRaw
      : getCoverageStatus(sharedRaces);

    // Classify gap band based on percent difference
    const gapBand = classifyGapBand(gapSecondsAbs);

    // Get symmetric percent difference from SQL result
    const gapPct: number | null = row.gap_pct !== undefined && row.gap_pct !== null
      ? parseFloat(row.gap_pct)
      : null;
    const gapPctAbs: number | null = gapPct !== null ? Math.abs(gapPct) : null;

    return {
      type: 'teammate_gap_summary_season',
      season: intent.season,
      team_id: row.team_id,
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
      gap_seconds: gapSeconds,
      gap_seconds_abs: gapSecondsAbs,
      gap_pct: gapPct,
      gap_pct_abs: gapPctAbs,
      shared_races: sharedRaces,
      faster_driver_primary_count: fasterDriverPrimaryCount,
      coverage_status: coverageStatus,
      gap_band: gapBand
    };
  }

  // compares qualifying gap vs race pace gap between teammates
  private formatTeammateGapDualComparison(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
    rows: any[]
  ): TeammateGapDualComparisonPayload {
    const row = rows[0];

    // Build qualifying component
    const qualifyingAvailable = row.qualifying_available === true;
    const qualifying: DualComparisonMetricComponent = {
      gap_percent: qualifyingAvailable && row.qualifying_gap_percent !== null
        ? parseFloat(row.qualifying_gap_percent)
        : null,
      gap_seconds: qualifyingAvailable && row.qualifying_gap_seconds !== null
        ? parseFloat(row.qualifying_gap_seconds)
        : null,
      winner: qualifyingAvailable ? (row.qualifying_winner || null) : null,
      shared_races: qualifyingAvailable
        ? parseInt(row.qualifying_shared_races || '0', 10)
        : 0,
      faster_primary_count: qualifyingAvailable
        ? parseInt(row.qualifying_faster_primary_count || '0', 10)
        : 0,
      coverage_status: qualifyingAvailable
        ? (row.qualifying_coverage_status as CoverageStatus || 'insufficient')
        : 'insufficient',
      available: qualifyingAvailable
    };

    // Build race pace component
    const raceAvailable = row.race_available === true;
    const race_pace: DualComparisonMetricComponent = {
      gap_percent: raceAvailable && row.race_gap_percent !== null
        ? parseFloat(row.race_gap_percent)
        : null,
      gap_seconds: raceAvailable && row.race_gap_seconds !== null
        ? parseFloat(row.race_gap_seconds)
        : null,
      winner: raceAvailable ? (row.race_winner || null) : null,
      shared_races: raceAvailable
        ? parseInt(row.race_shared_races || '0', 10)
        : 0,
      faster_primary_count: raceAvailable
        ? parseInt(row.race_faster_primary_count || '0', 10)
        : 0,
      coverage_status: raceAvailable
        ? (row.race_coverage_status as CoverageStatus || 'insufficient')
        : 'insufficient',
      available: raceAvailable
    };

    // Build overall summary
    const sameWinner: boolean | null = row.same_winner !== undefined && row.same_winner !== null
      ? row.same_winner === true
      : null;

    const advantageArea: 'qualifying' | 'race' | 'mixed' | 'partial' =
      row.advantage_area || 'partial';

    const overall_summary: DualComparisonSummary = {
      same_winner: sameWinner,
      advantage_area: advantageArea
    };

    return {
      type: 'teammate_gap_dual_comparison',
      season: intent.season,
      team_id: row.team_id || null,
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
      qualifying,
      race_pace,
      overall_summary
    };
  }

  private formatRaceResultsSummary(
    intent: Extract<QueryIntent, { kind: 'race_results_summary' }>,
    rows: any[]
  ): RaceResultsSummaryPayload {
    const entries: RaceResultsEntry[] = rows.map(row => ({
      position: parseInt(row.position || '0', 10),
      driver_id: row.driver_id,
      driver_name: row.driver_name,
      constructor_name: row.constructor_name,
      laps_completed: row.laps_completed !== null && row.laps_completed !== undefined
        ? parseInt(row.laps_completed, 10)
        : null,
      race_time: row.race_time ?? null,
      fastest_lap: row.fastest_lap ?? null,
      grid_position: row.grid_position !== null && row.grid_position !== undefined
        ? parseInt(row.grid_position, 10)
        : null,
      points: row.points !== null && row.points !== undefined
        ? parseFloat(row.points)
        : null
    }));

    const winner = entries[0];

    return {
      type: 'race_results_summary',
      season: intent.season,
      track_id: intent.track_id,
      race_name: rows[0]?.race_name ?? null,
      race_date: rows[0]?.race_date ?? null,
      circuit_name: rows[0]?.circuit_name ?? null,
      podium: entries.slice(0, 3),
      top10: entries.slice(0, 10),
      laps_completed: winner?.laps_completed ?? null,
      winner_time: winner?.race_time ?? null
    };
  }

  // position-based comparison with optional filters
  private formatDriverHeadToHeadCount(
    intent: Extract<QueryIntent, { kind: 'driver_head_to_head_count' }>,
    rows: any[]
  ): DriverHeadToHeadCountPayload {
    const row = rows[0];

    const sharedEvents = parseInt(row.shared_events || '0', 10);
    const primaryWins = parseInt(row.primary_wins || '0', 10);
    const secondaryWins = parseInt(row.secondary_wins || '0', 10);
    const ties = parseInt(row.ties || '0', 10);

    // Get coverage status from SQL or compute it
    let coverageStatus: 'valid' | 'low_coverage' | 'insufficient';
    if (row.coverage_status === 'valid' || row.coverage_status === 'low_coverage' || row.coverage_status === 'insufficient') {
      coverageStatus = row.coverage_status;
    } else if (sharedEvents >= 8) {
      coverageStatus = 'valid';
    } else if (sharedEvents >= 4) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    // Build filters_applied from row data (conditional template) or intent
    let filtersApplied: HeadToHeadFiltersApplied | undefined;

    // Check if we got filter data from the conditional template
    const hasFilterData =
      row.session_filter_applied ||
      row.track_type_filter_applied ||
      row.weather_filter_applied ||
      row.rounds_filter_applied ||
      row.date_from_filter_applied ||
      row.date_to_filter_applied ||
      row.exclude_dnfs_applied;

    if (hasFilterData || intent.filters) {
      filtersApplied = {
        session: row.session_filter_applied || intent.filters?.session || null,
        track_type: row.track_type_filter_applied || intent.filters?.track_type || null,
        weather: row.weather_filter_applied || intent.filters?.weather || null,
        rounds: row.rounds_filter_applied ||
          (intent.filters?.rounds?.length ? intent.filters.rounds.join(',') : null),
        date_from: row.date_from_filter_applied || intent.filters?.date_from || null,
        date_to: row.date_to_filter_applied || intent.filters?.date_to || null,
        exclude_dnfs: row.exclude_dnfs_applied ?? intent.filters?.exclude_dnfs ?? null
      };

      // Clean up null values - only include if at least one filter was applied
      const hasActiveFilter = Object.values(filtersApplied).some(v => v !== null && v !== false);
      if (!hasActiveFilter) {
        filtersApplied = undefined;
      }
    }

    const result: DriverHeadToHeadCountPayload = {
      type: 'driver_head_to_head_count',
      season: intent.season,
      metric: intent.h2h_metric,
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
      shared_events: sharedEvents,
      primary_wins: primaryWins,
      secondary_wins: secondaryWins,
      ties,
      coverage_status: coverageStatus
    };

    if (filtersApplied) {
      result.filters_applied = filtersApplied;
    }

    return result;
  }

  private formatDriverPerformanceVector(
    intent: Extract<QueryIntent, { kind: 'driver_performance_vector' }>,
    rows: any[]
  ): DriverPerformanceVectorPayload {
    const row = rows[0];

    const qualifyingLaps = parseInt(row.qualifying_laps || '0', 10);
    const raceLaps = parseInt(row.race_laps || '0', 10);
    const streetLaps = parseInt(row.street_laps || '0', 10);
    const wetLaps = parseInt(row.wet_laps || '0', 10);

    // Determine coverage status based on sample sizes
    let coverageStatus: 'valid' | 'low_coverage' | 'insufficient';
    if (qualifyingLaps >= 10 && raceLaps >= 50) {
      coverageStatus = 'valid';
    } else if (qualifyingLaps >= 5 && raceLaps >= 20) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    return {
      type: 'driver_performance_vector',
      season: intent.season,
      driver_id: row.driver_id,
      qualifying_percentile: row.qualifying_percentile !== null
        ? parseFloat(row.qualifying_percentile)
        : null,
      race_pace_percentile: row.race_pace_percentile !== null
        ? parseFloat(row.race_pace_percentile)
        : null,
      consistency_score: row.consistency_score !== null
        ? parseFloat(row.consistency_score)
        : null,
      street_delta: row.street_delta !== null
        ? parseFloat(row.street_delta)
        : null,
      wet_delta: row.wet_delta !== null
        ? parseFloat(row.wet_delta)
        : null,
      sample_sizes: {
        qualifying_laps: qualifyingLaps,
        race_laps: raceLaps,
        street_laps: streetLaps,
        wet_laps: wetLaps
      },
      coverage_status: coverageStatus
    };
  }

  private formatDriverMultiComparison(
    intent: Extract<QueryIntent, { kind: 'driver_multi_comparison' }>,
    rows: any[]
  ): DriverMultiComparisonPayload {
    // Extract comparison type based on driver count
    const totalDrivers = parseInt(rows[0]?.total_drivers || '0', 10);
    const rankedDrivers = parseInt(rows[0]?.ranked_drivers || '0', 10);
    const comparisonType: 'multi_driver' | 'head_to_head' = totalDrivers === 2 ? 'head_to_head' : 'multi_driver';

    // Build entries from rows
    const entries: DriverMultiComparisonEntry[] = rows.map(row => ({
      driver_id: row.driver_id,
      rank: parseInt(row.rank || '0', 10),
      metric_value: parseFloat(row.metric_value || '0'),
      laps_considered: parseInt(row.laps_considered || '0', 10)
    }));

    // Determine coverage status based on minimum laps and completion
    let coverageStatus: 'valid' | 'low_coverage' | 'insufficient';
    const minLaps = entries.reduce((min, e) => Math.min(min, e.laps_considered), Infinity);
    const minLapsActual = minLaps === Infinity ? 0 : minLaps;

    if (minLapsActual >= 50 && rankedDrivers === totalDrivers) {
      coverageStatus = 'valid';
    } else if (minLapsActual >= 20 && rankedDrivers >= totalDrivers * 0.8) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    return {
      type: 'driver_multi_comparison',
      season: intent.season,
      metric: intent.comparison_metric,
      comparison_type: comparisonType,
      entries,
      total_drivers: totalDrivers,
      ranked_drivers: rankedDrivers,
      coverage_status: coverageStatus
    };
  }

  private formatDriverMatchupLookup(
    intent: Extract<QueryIntent, { kind: 'driver_matchup_lookup' }>,
    rows: any[]
  ): DriverMatchupLookupPayload {
    const row = rows[0];

    const sharedEvents = parseInt(row.shared_events || '0', 10);
    const primaryWins = parseInt(row.primary_wins || '0', 10);
    const secondaryWins = parseInt(row.secondary_wins || '0', 10);
    const ties = parseInt(row.ties || '0', 10);

    // Get coverage status from precomputed matrix
    let coverageStatus: 'valid' | 'low_coverage' | 'insufficient';
    if (row.coverage_status === 'valid' || row.coverage_status === 'low_coverage' || row.coverage_status === 'insufficient') {
      coverageStatus = row.coverage_status;
    } else if (sharedEvents >= 8) {
      coverageStatus = 'valid';
    } else if (sharedEvents >= 4) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    return {
      type: 'driver_matchup_lookup',
      season: intent.season,
      metric: intent.h2h_metric,
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
      primary_wins: primaryWins,
      secondary_wins: secondaryWins,
      ties,
      shared_events: sharedEvents,
      coverage_status: coverageStatus,
      computed_at: row.computed_at?.toISOString?.() || row.computed_at || new Date().toISOString()
    };
  }

  private formatDriverProfileSummary(
    intent: Extract<QueryIntent, { kind: 'driver_profile_summary' }>,
    rows: any[]
  ): DriverProfileSummaryPayload {
    const row = rows[0];

    // Parse best/worst tracks from JSON
    const bestTracks: TrackPerformanceEntry[] = (row.best_tracks || []).map((t: any) => ({
      track_id: t.track_id,
      track_name: t.track_name,
      avg_position: parseFloat(t.avg_position || '0'),
      races: parseInt(t.races || '0', 10),
      wins: parseInt(t.wins || '0', 10),
      podiums: parseInt(t.podiums || '0', 10)
    }));

    const worstTracks: TrackPerformanceEntry[] = (row.worst_tracks || []).map((t: any) => ({
      track_id: t.track_id,
      track_name: t.track_name,
      avg_position: parseFloat(t.avg_position || '0'),
      races: parseInt(t.races || '0', 10),
      wins: parseInt(t.wins || '0', 10),
      podiums: parseInt(t.podiums || '0', 10)
    }));

    // Build latest season teammate comparison
    const latestSeasonTeammate = row.teammate_season && row.teammate_id ? {
      season: parseInt(row.teammate_season, 10),
      teammate_id: row.teammate_id,
      teammate_name: row.teammate_name || null,
      qualifying_gap_percent: row.qualifying_gap_percent !== null && row.qualifying_gap_percent !== undefined
        ? parseFloat(row.qualifying_gap_percent)
        : null,
      race_pace_gap_percent: row.race_gap_percent !== null && row.race_gap_percent !== undefined
        ? parseFloat(row.race_gap_percent)
        : null,
      shared_races: parseInt(row.teammate_shared_races || '0', 10)
    } : null;

    return {
      type: 'driver_profile_summary',
      driver_id: row.driver_id,
      driver_name: row.driver_name || row.driver_id,
      career: {
        championships: parseInt(row.championships || '0', 10),
        seasons_raced: parseInt(row.seasons_raced || '0', 10),
        total_wins: parseInt(row.total_wins || '0', 10),
        total_podiums: parseInt(row.total_podiums || '0', 10),
        total_poles: parseInt(row.total_poles || '0', 10),
        first_season: row.first_season ? parseInt(row.first_season, 10) : 0,
        latest_season: row.latest_season ? parseInt(row.latest_season, 10) : intent.season
      },
      best_tracks: bestTracks,
      worst_tracks: worstTracks,
      latest_season_teammate: latestSeasonTeammate,
      trend: {
        seasons: [], // Populated separately if needed
        classification: 'stable',
        slope_per_season: null
      },
      percentiles: []
    };
  }

  private formatDriverTrendSummary(
    intent: Extract<QueryIntent, { kind: 'driver_trend_summary' }>,
    rows: any[]
  ): DriverTrendSummaryPayload {
    const row = rows[0];

    // Parse season data from JSON
    const seasonData: SeasonPerformanceEntry[] = (row.season_data || []).map((s: any) => ({
      season: parseInt(s.season || '0', 10),
      teammate_gap_percent: s.teammate_gap_percent !== null && s.teammate_gap_percent !== undefined
        ? parseFloat(s.teammate_gap_percent)
        : null,
      qualifying_gap_percent: s.qualifying_gap_percent !== null && s.qualifying_gap_percent !== undefined
        ? parseFloat(s.qualifying_gap_percent)
        : null,
      wins: parseInt(s.wins || '0', 10),
      podiums: parseInt(s.podiums || '0', 10),
      dnfs: parseInt(s.dnfs || '0', 10)
    }));

    // Parse trend classification
    const classification = row.classification === 'improving' || row.classification === 'declining'
      ? row.classification
      : 'stable';

    return {
      type: 'driver_trend_summary',
      driver_id: row.driver_id,
      driver_name: row.driver_name || row.driver_id,
      start_season: parseInt(row.start_season || intent.start_season || '0', 10),
      end_season: parseInt(row.end_season || intent.end_season || '0', 10),
      seasons_analyzed: parseInt(row.seasons_analyzed || '0', 10),
      season_data: seasonData,
      trend: {
        classification,
        slope_per_season: row.slope_per_season !== null && row.slope_per_season !== undefined
          ? parseFloat(row.slope_per_season)
          : null,
        volatility: row.volatility !== null && row.volatility !== undefined
          ? parseFloat(row.volatility)
          : null,
        r_squared: row.r_squared !== null && row.r_squared !== undefined
          ? parseFloat(row.r_squared)
          : null
      },
      methodology: 'Linear regression on teammate gap percent across seasons. Negative slope = improving.'
    };
  }


  // pole_count = official P1 grid starts, fastest_time_count = P1 by lap time
  private formatDriverPoleCount(
    intent: Extract<QueryIntent, { kind: 'driver_pole_count' }>,
    rows: any[]
  ): any {
    const row = rows[0];

    return {
      type: 'driver_pole_count',
      season: intent.season,
      driver_id: row.driver_id,
      pole_count: parseInt(row.pole_count || '0', 10),
      fastest_time_count: parseInt(row.fastest_time_count || '0', 10),
      total_sessions: parseInt(row.total_sessions || '0', 10),
      pole_rate_percent: row.pole_rate_percent !== null
        ? parseFloat(row.pole_rate_percent)
        : null,
      front_row_count: parseInt(row.front_row_count || '0', 10),
      top_3_count: parseInt(row.top_3_count || '0', 10),
      // Official grid position averages
      avg_grid_position: row.avg_grid_position !== null
        ? parseFloat(row.avg_grid_position)
        : null,
      best_grid_position: row.best_grid_position !== null
        ? parseInt(row.best_grid_position, 10)
        : null,
      avg_qualifying_position: row.avg_qualifying_position !== null
        ? parseFloat(row.avg_qualifying_position)
        : null,
      best_qualifying_position: row.best_qualifying_position !== null
        ? parseInt(row.best_qualifying_position, 10)
        : null
    };
  }

  private formatDriverQ3Count(
    intent: Extract<QueryIntent, { kind: 'driver_q3_count' }>,
    rows: any[]
  ): any {
    const row = rows[0];

    return {
      type: 'driver_q3_count',
      season: intent.season,
      driver_id: row.driver_id,
      q3_appearances: parseInt(row.q3_appearances || '0', 10),
      q2_eliminations: parseInt(row.q2_eliminations || '0', 10),
      q1_eliminations: parseInt(row.q1_eliminations || '0', 10),
      total_sessions: parseInt(row.total_sessions || '0', 10),
      q3_rate_percent: row.q3_rate_percent !== null
        ? parseFloat(row.q3_rate_percent)
        : null,
      avg_qualifying_position: row.avg_qualifying_position !== null
        ? parseFloat(row.avg_qualifying_position)
        : null
    };
  }

  private formatSeasonQ3Rankings(
    intent: Extract<QueryIntent, { kind: 'season_q3_rankings' }>,
    rows: any[]
  ): any {
    const entries = rows.map(row => ({
      rank: parseInt(row.rank || '0', 10),
      driver_id: row.driver_id,
      team_id: row.team_id,
      q3_appearances: parseInt(row.q3_appearances || '0', 10),
      q2_eliminations: parseInt(row.q2_eliminations || '0', 10),
      q1_eliminations: parseInt(row.q1_eliminations || '0', 10),
      total_sessions: parseInt(row.total_sessions || '0', 10),
      q3_rate_percent: row.q3_rate_percent !== null
        ? parseFloat(row.q3_rate_percent)
        : null,
      pole_count: parseInt(row.pole_count || '0', 10),
      fastest_time_count: parseInt(row.fastest_time_count || '0', 10),
      avg_grid_position: row.avg_grid_position !== null
        ? parseFloat(row.avg_grid_position)
        : null,
      avg_qualifying_position: row.avg_qualifying_position !== null
        ? parseFloat(row.avg_qualifying_position)
        : null
    }));

    return {
      type: 'season_q3_rankings',
      season: intent.season,
      entries,
      total_drivers: entries.length
    };
  }

  private formatQualifyingGapTeammates(
    intent: Extract<QueryIntent, { kind: 'qualifying_gap_teammates' }>,
    rows: any[]
  ): any {
    const row = rows[0];

    const gapPercent = row.gap_percent !== null && row.gap_percent !== undefined
      ? parseFloat(row.gap_percent)
      : null;
    const gapSeconds = row.gap_seconds !== null && row.gap_seconds !== undefined
      ? parseFloat(row.gap_seconds)
      : null;
    const sharedRaces = parseInt(row.shared_races || '0', 10);
    const primaryWins = parseInt(row.primary_wins || '0', 10);
    const secondaryWins = parseInt(row.secondary_wins || '0', 10);
    const ties = parseInt(row.ties || '0', 10);

    // Get coverage status from SQL or compute it
    let coverageStatus: CoverageStatus;
    if (row.coverage_status === 'valid' || row.coverage_status === 'low_coverage' || row.coverage_status === 'insufficient') {
      coverageStatus = row.coverage_status;
    } else if (sharedRaces >= 10) {
      coverageStatus = 'valid';
    } else if (sharedRaces >= 5) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    return {
      type: 'qualifying_gap_teammates',
      season: intent.season,
      team_id: row.team_id,
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
      gap_percent: gapPercent,
      gap_seconds: gapSeconds,
      shared_races: sharedRaces,
      primary_wins: primaryWins,
      secondary_wins: secondaryWins,
      ties,
      coverage_status: coverageStatus
    };
  }

  private formatQualifyingGapDrivers(
    intent: Extract<QueryIntent, { kind: 'qualifying_gap_drivers' }>,
    rows: any[]
  ): any {
    const row = rows[0];

    const avgPositionGap = row.avg_position_gap !== null && row.avg_position_gap !== undefined
      ? parseFloat(row.avg_position_gap)
      : null;
    const sharedSessions = parseInt(row.shared_sessions || '0', 10);
    const primaryWins = parseInt(row.primary_wins || '0', 10);
    const secondaryWins = parseInt(row.secondary_wins || '0', 10);
    const ties = parseInt(row.ties || '0', 10);

    // Get coverage status from SQL or compute it
    let coverageStatus: CoverageStatus;
    if (row.coverage_status === 'valid' || row.coverage_status === 'low_coverage' || row.coverage_status === 'insufficient') {
      coverageStatus = row.coverage_status;
    } else if (sharedSessions >= 10) {
      coverageStatus = 'valid';
    } else if (sharedSessions >= 5) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    return {
      type: 'qualifying_gap_drivers',
      season: intent.season,
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
      primary_team_id: row.primary_team_id,
      secondary_team_id: row.secondary_team_id,
      avg_position_gap: avgPositionGap,
      shared_sessions: sharedSessions,
      primary_wins: primaryWins,
      secondary_wins: secondaryWins,
      ties,
      primary_avg_position: row.primary_avg_position !== null
        ? parseFloat(row.primary_avg_position)
        : null,
      secondary_avg_position: row.secondary_avg_position !== null
        ? parseFloat(row.secondary_avg_position)
        : null,
      coverage_status: coverageStatus
    };
  }
}
