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
  QualifyingResultsSummaryPayload,
  QualifyingResultsEntry,
  DriverHeadToHeadCountPayload,
  HeadToHeadFiltersApplied,
  DriverPerformanceVectorPayload,
  DriverMultiComparisonPayload,
  DriverMultiComparisonEntry,
  DriverMatchupLookupPayload,
  DriverProfileSummaryPayload,
  DriverTrendSummaryPayload,
  TrackPerformanceEntry,
  SeasonPerformanceEntry,
  DriverVsDriverComprehensivePayload,
  DriverCareerWinsByCircuitPayload,
  TeammateComparisonCareerPayload
} from '../types/results';
import { MetricScope, TeamRef } from '../types/semantic';
import { DriverRefService } from '../identity/driver-ref-service';
import { TrackRefService } from '../identity/track-ref-service';
import { MetricBuilder } from './metric-builder';
import { classifyGapBand } from '../observability/gap-bands';
import { getCoverageStatus } from '../config/teammate-gap';
import {
  assertNormalizationMatch,
  assertValidCoverage
} from './invariants';

/**
 * Formats raw database results into structured result payloads
 *
 * Now async to support driver name resolution from database.
 * Produces self-describing payloads with DriverRef and Metric types.
 */
export class ResultFormatter {
  constructor(
    private driverRefService: DriverRefService,
    private trackRefService: TrackRefService
  ) {}

  async format(intent: QueryIntent, rows: any[]): Promise<ResultPayload> {
    switch (intent.kind) {
      case 'driver_season_summary':
        return await this.formatSeasonDriverSummary(intent, rows);

      case 'season_driver_vs_driver':
        return await this.formatSeasonDriverVsDriver(intent, rows);

      case 'driver_career_summary':
        return await this.formatDriverCareerSummary(intent, rows);

      case 'track_fastest_drivers':
        return await this.formatDriverRanking(intent, rows);

      case 'cross_team_track_scoped_driver_comparison':
        return await this.formatCrossTeamTrackScopedComparison(intent, rows);

      case 'teammate_gap_summary_season':
        return await this.formatTeammateGapSummarySeason(intent, rows);

      case 'teammate_gap_dual_comparison':
        return await this.formatTeammateGapDualComparison(intent, rows);

      case 'race_results_summary':
        return await this.formatRaceResultsSummary(intent, rows);

      case 'driver_head_to_head_count':
        return await this.formatDriverHeadToHeadCount(intent, rows);

      case 'driver_performance_vector':
        return await this.formatDriverPerformanceVector(intent, rows);

      case 'driver_multi_comparison':
        return await this.formatDriverMultiComparison(intent, rows);

      case 'driver_matchup_lookup':
        return await this.formatDriverMatchupLookup(intent, rows);

      case 'driver_profile_summary':
        return await this.formatDriverProfileSummary(intent, rows);

      case 'driver_trend_summary':
        return await this.formatDriverTrendSummary(intent, rows);

      case 'driver_pole_count':
        return await this.formatDriverPoleCount(intent, rows);

      case 'driver_career_pole_count':
        return await this.formatDriverCareerPoleCount(intent, rows);

      case 'driver_q3_count':
        return await this.formatDriverQ3Count(intent, rows);

      case 'season_q3_rankings':
        return await this.formatSeasonQ3Rankings(intent, rows);

      case 'qualifying_gap_teammates':
        return await this.formatQualifyingGapTeammates(intent, rows);

      case 'qualifying_gap_drivers':
        return await this.formatQualifyingGapDrivers(intent, rows);

      case 'driver_vs_driver_comprehensive':
        return await this.formatDriverVsDriverComprehensive(intent, rows);

      case 'driver_career_wins_by_circuit':
        return await this.formatDriverCareerWinsByCircuit(intent, rows);

      case 'teammate_comparison_career':
        return await this.formatTeammateComparisonCareer(intent, rows);

      case 'qualifying_results_summary':
        return await this.formatQualifyingResultsSummary(intent, rows);

      default:
        throw new Error(`Cannot format results for intent kind: ${(intent as any).kind}`);
    }
  }

  private async formatSeasonDriverSummary(
    intent: Extract<QueryIntent, { kind: 'driver_season_summary' }>,
    rows: any[]
  ): Promise<SeasonDriverSummaryPayload> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);
    const scope: MetricScope = { type: 'season', year: intent.season };

    const wins = parseInt(row.wins || '0');
    const podiums = parseInt(row.podiums || '0');
    const poles = parseInt(row.poles || '0');
    const dnfs = parseInt(row.dnfs || '0');
    const raceCount = parseInt(row.race_count || '0');
    const lapsConsidered = parseInt(row.laps_considered || '0');
    const racesWithPaceData = parseInt(row.races_with_pace_data || '0');

    // NORMALIZED pace: avg_race_pace_pct is session-median normalized (percent)
    // Sign convention: negative = faster than median, positive = slower
    const avgRacePacePct = row.avg_race_pace_pct !== null && row.avg_race_pace_pct !== undefined
      ? parseFloat(row.avg_race_pace_pct)
      : null;

    // Coverage status from SQL
    const coverageStatus = row.coverage_status as 'valid' | 'low_coverage' | 'insufficient' || 'insufficient';

    return {
      type: 'driver_season_summary',
      season: intent.season,
      driver: driverRef,
      metrics: {
        wins: MetricBuilder.wins(wins, scope),
        podiums: MetricBuilder.podiums(podiums, scope),
        poles: MetricBuilder.poles(poles, scope),
        dnfs: MetricBuilder.dnfs(dnfs, scope),
        race_count: MetricBuilder.raceCount(raceCount, scope),
        // NORMALIZED: Using gapPct (percent) instead of avgRacePace (seconds)
        avg_race_pace: avgRacePacePct !== null ? MetricBuilder.gapPct(avgRacePacePct, scope) : null,
        laps_considered: MetricBuilder.lapsConsidered(lapsConsidered, scope),
      },
      coverage: {
        status: coverageStatus,
        sample_size: racesWithPaceData,
        sample_type: 'races',
      },
      // Backwards compatibility (deprecated)
      driver_id: row.driver_id,
      wins,
      podiums,
      poles,
      dnfs,
      race_count: raceCount,
      avg_race_pace: avgRacePacePct,  // Now percent, not seconds
      laps_considered: lapsConsidered,
    };
  }

  private async formatSeasonDriverVsDriver(
    intent: Extract<QueryIntent, { kind: 'season_driver_vs_driver' }>,
    rows: any[]
  ): Promise<SeasonDriverVsDriverPayload> {
    const row = rows[0];

    // Resolve driver names in USER ORDER (from intent)
    const orderedPair = await this.driverRefService.getOrderedPair(
      intent.driver_a_id,
      intent.driver_b_id,
      'user_query'
    );

    const scope: MetricScope = { type: 'season', year: intent.season };

    // Map SQL results to intent order (swap if needed)
    const sqlMatchesIntent = row.driver_a_id === intent.driver_a_id;
    const driver_a_value_raw = parseFloat(row.driver_a_value);
    const driver_b_value_raw = parseFloat(row.driver_b_value);
    const driver_a_laps_raw = parseInt(row.driver_a_laps || '0');
    const driver_b_laps_raw = parseInt(row.driver_b_laps || '0');

    // Reorder values to match user intent
    const driver_a_value = sqlMatchesIntent ? driver_a_value_raw : driver_b_value_raw;
    const driver_b_value = sqlMatchesIntent ? driver_b_value_raw : driver_a_value_raw;
    const driver_a_laps = sqlMatchesIntent ? driver_a_laps_raw : driver_b_laps_raw;
    const driver_b_laps = sqlMatchesIntent ? driver_b_laps_raw : driver_a_laps_raw;

    // check if this is normalized output (has shared_races and coverage_status)
    const isNormalized = row.shared_races !== undefined;

    if (isNormalized) {
      // Invariant: normalized output MUST have session_median_percent normalization
      assertNormalizationMatch(isNormalized, intent.normalization, 'ResultFormatter.formatSeasonDriverVsDriver');

      // normalized percent pace mode
      const sharedRaces = parseInt(row.shared_races || '0');
      const coverageStatus = row.coverage_status as 'valid' | 'low_coverage' | 'insufficient';

      // Invariant: coverage status must be valid
      assertValidCoverage(coverageStatus, 'season_driver_vs_driver', 'ResultFormatter.formatSeasonDriverVsDriver');

      const difference = row.difference_percent !== undefined
        ? (sqlMatchesIntent ? parseFloat(row.difference_percent) : -parseFloat(row.difference_percent))
        : driver_a_value - driver_b_value;

      return {
        type: 'season_driver_vs_driver',
        season: intent.season,
        drivers: orderedPair,
        metrics: {
          driver_a_value: MetricBuilder.gapPercent(driver_a_value, scope),
          driver_b_value: MetricBuilder.gapPercent(driver_b_value, scope),
          difference: MetricBuilder.gapPercent(difference, scope),
          shared_races: MetricBuilder.sharedRaces(sharedRaces, scope),
          driver_a_laps: MetricBuilder.lapsConsidered(driver_a_laps, scope),
          driver_b_laps: MetricBuilder.lapsConsidered(driver_b_laps, scope),
        },
        coverage: {
          status: coverageStatus,
          sample_size: sharedRaces,
          sample_type: 'races',
        },
        // Backwards compatibility (deprecated)
        driver_a: intent.driver_a_id,
        driver_b: intent.driver_b_id,
        metric: 'normalized_percent_pace' as any,
        driver_a_value,
        driver_b_value,
        difference,
        normalization: 'session_median_percent',
        driver_a_laps,
        driver_b_laps,
        laps_considered: driver_a_laps + driver_b_laps,
        shared_races: sharedRaces,
        coverage_status: coverageStatus,
        units: 'percent'
      };
    }

    // raw pace mode (normalization='none')
    const difference = driver_a_value - driver_b_value;
    return {
      type: 'season_driver_vs_driver',
      season: intent.season,
      drivers: orderedPair,
      metrics: {
        driver_a_value: MetricBuilder.gapSeconds(driver_a_value, scope),
        driver_b_value: MetricBuilder.gapSeconds(driver_b_value, scope),
        difference: MetricBuilder.gapSeconds(difference, scope),
        driver_a_laps: MetricBuilder.lapsConsidered(driver_a_laps, scope),
        driver_b_laps: MetricBuilder.lapsConsidered(driver_b_laps, scope),
      },
      coverage: {
        status: 'valid',
        sample_size: driver_a_laps + driver_b_laps,
        sample_type: 'laps',
      },
      // Backwards compatibility (deprecated)
      driver_a: intent.driver_a_id,
      driver_b: intent.driver_b_id,
      metric: intent.metric,
      driver_a_value,
      driver_b_value,
      difference,
      normalization: intent.normalization,
      driver_a_laps,
      driver_b_laps,
      laps_considered: driver_a_laps + driver_b_laps,
      units: 'seconds'
    };
  }

  private async formatDriverRanking(
    intent: Extract<QueryIntent, { kind: 'track_fastest_drivers' }>,
    rows: any[]
  ): Promise<DriverRankingPayload> {
    const scope: MetricScope = { type: 'track', track_id: intent.track_id };

    // Batch resolve all driver IDs and track
    const driverIds = rows.map(row => row.driver_id);
    const [driverRefs, trackRef] = await Promise.all([
      this.driverRefService.getRefs(driverIds),
      this.trackRefService.getRef(intent.track_id)
    ]);

    // Get P1's time as baseline for delta calculation
    const p1Value = rows.length > 0 ? parseFloat(rows[0].value) : 0;

    const entries: DriverRankingEntry[] = rows.map((row, index) => {
      const value = parseFloat(row.value);
      const lapsConsidered = parseInt(row.laps_considered);

      // P1 shows formatted lap time, P2+ show delta from P1
      const isLeader = index === 0;
      const displayValue = isLeader ? value : (value - p1Value);

      // Use lap_time for P1, gap_seconds for others
      const pace = isLeader
        ? MetricBuilder.lapTime(value, scope)
        : MetricBuilder.gapSeconds(displayValue, scope);

      return {
        driver: driverRefs.get(row.driver_id)!,
        pace,
        laps: MetricBuilder.lapsConsidered(lapsConsidered, scope),
        // Backwards compatibility (deprecated)
        driver_id: row.driver_id,
        value: displayValue,
        laps_considered: lapsConsidered,
      };
    });

    return {
      type: 'driver_ranking',
      season: intent.season,
      track: trackRef,
      // Backwards compatibility (deprecated)
      track_id: intent.track_id,
      metric: intent.metric,
      ranking_basis: 'lower_is_faster',
      entries
    };
  }

  private async formatDriverCareerSummary(
    _intent: Extract<QueryIntent, { kind: 'driver_career_summary' }>,
    rows: any[]
  ): Promise<DriverCareerSummaryPayload> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);

    const championships = parseInt(row.championships || '0');
    const seasonsRaced = parseInt(row.seasons_raced || '0');
    const careerPodiums = parseInt(row.career_podiums || '0');
    const careerWins = parseInt(row.career_wins || '0');
    const careerPoles = parseInt(row.career_poles || '0');

    return {
      type: 'driver_career_summary',
      driver: driverRef,
      metrics: {
        championships: MetricBuilder.championships(championships),
        seasons_raced: MetricBuilder.seasonsRaced(seasonsRaced),
        career_podiums: MetricBuilder.podiums(careerPodiums, { type: 'career' }),
        career_wins: MetricBuilder.wins(careerWins, { type: 'career' }),
        career_poles: MetricBuilder.poles(careerPoles, { type: 'career' }),
      },
      // Backwards compatibility (deprecated)
      driver_id: row.driver_id,
      championships,
      seasons_raced: seasonsRaced,
      career_podiums: careerPodiums,
      career_wins: careerWins,
      career_poles: careerPoles,
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

  private async formatCrossTeamTrackScopedComparison(
    intent: Extract<QueryIntent, { kind: 'cross_team_track_scoped_driver_comparison' }>,
    rows: any[]
  ): Promise<CrossTeamTrackScopedDriverComparisonPayload> {
    const row = rows[0];

    // Resolve driver names in USER ORDER (from intent) and track
    const [orderedPair, trackRef] = await Promise.all([
      this.driverRefService.getOrderedPair(
        intent.driver_a_id,
        intent.driver_b_id,
        'user_query'
      ),
      this.trackRefService.getRef(intent.track_id)
    ]);

    const scope: MetricScope = { type: 'track', track_id: intent.track_id };

    // Map SQL results to intent order (swap if needed)
    const sqlMatchesIntent = row.driver_a_id === intent.driver_a_id;
    const driver_a_value_raw = parseFloat(row.driver_a_value);
    const driver_b_value_raw = parseFloat(row.driver_b_value);
    // Support both old (driver_a_laps) and new (driver_a_valid_laps) column names
    const driver_a_laps_raw = parseInt(row.driver_a_valid_laps || row.driver_a_laps || '0');
    const driver_b_laps_raw = parseInt(row.driver_b_valid_laps || row.driver_b_laps || '0');

    // Reorder values to match user intent
    const driver_a_value = sqlMatchesIntent ? driver_a_value_raw : driver_b_value_raw;
    const driver_b_value = sqlMatchesIntent ? driver_b_value_raw : driver_a_value_raw;
    const driver_a_laps = sqlMatchesIntent ? driver_a_laps_raw : driver_b_laps_raw;
    const driver_b_laps = sqlMatchesIntent ? driver_b_laps_raw : driver_a_laps_raw;
    const pace_delta = driver_a_value - driver_b_value;

    // Compute coverage semantics
    const basis_laps = Math.min(driver_a_laps, driver_b_laps);
    const confidence: 'high' | 'medium' | 'low' =
      basis_laps >= 30 ? 'high' :
      basis_laps >= 10 ? 'medium' : 'low';

    return {
      type: 'cross_team_track_scoped_driver_comparison',
      season: intent.season,
      track: trackRef,
      // Backwards compatibility (deprecated)
      track_id: intent.track_id,
      metric: intent.metric,
      drivers: orderedPair,
      metrics: {
        driver_a_value: MetricBuilder.avgRacePace(driver_a_value, scope),
        driver_b_value: MetricBuilder.avgRacePace(driver_b_value, scope),
        pace_delta: MetricBuilder.gapSeconds(pace_delta, scope),
        driver_a_laps: MetricBuilder.lapsConsidered(driver_a_laps, scope),
        driver_b_laps: MetricBuilder.lapsConsidered(driver_b_laps, scope),
      },
      coverage: {
        driver_a_laps,
        driver_b_laps,
        basis_laps,
        confidence,
      },
      compound_context: intent.compound_context,
      // Backwards compatibility (deprecated)
      driver_a: intent.driver_a_id,
      driver_b: intent.driver_b_id,
      driver_a_value,
      driver_b_value,
      pace_delta,
      driver_a_laps,
      driver_b_laps,
      laps_considered: basis_laps
    };
  }

  // uses race pace symmetric percent difference methodology
  private async formatTeammateGapSummarySeason(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_summary_season' }>,
    rows: any[]
  ): Promise<TeammateGapSummarySeasonPayload> {
    const row = rows[0];
    const scope: MetricScope = { type: 'season', year: intent.season };

    // Resolve driver names in USER ORDER (from intent)
    const primaryId = intent.driver_a_id || row.driver_primary_id;
    const secondaryId = intent.driver_b_id || row.driver_secondary_id;
    const orderedPair = await this.driverRefService.getOrderedPair(primaryId, secondaryId, 'user_query');

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
      drivers: orderedPair,
      metrics: {
        gap_seconds: MetricBuilder.gapSeconds(gapSeconds, scope),
        gap_pct: gapPct !== null ? MetricBuilder.gapPct(gapPct, scope) : null,
        shared_races: MetricBuilder.sharedRaces(sharedRaces, scope),
        faster_count: MetricBuilder.build({
          key: 'faster_count',
          label: `${orderedPair.drivers[0].name} Faster`,
          value: fasterDriverPrimaryCount,
          scope,
          units: 'count',
          source: 'Lap Data',
        }),
      },
      coverage: {
        status: coverageStatus,
        sample_size: sharedRaces,
        sample_type: 'races',
      },
      // Backwards compatibility (deprecated)
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
  private async formatTeammateGapDualComparison(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
    rows: any[]
  ): Promise<TeammateGapDualComparisonPayload> {
    const row = rows[0];

    // Resolve driver names in USER ORDER (from intent)
    const primaryId = intent.driver_a_id || row.driver_primary_id;
    const secondaryId = intent.driver_b_id || row.driver_secondary_id;
    const orderedPair = await this.driverRefService.getOrderedPair(primaryId, secondaryId, 'user_query');

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
      drivers: orderedPair,
      qualifying,
      race_pace,
      overall_summary,
      // Backwards compatibility (deprecated)
      driver_primary_id: row.driver_primary_id,
      driver_secondary_id: row.driver_secondary_id,
    };
  }

  private async formatRaceResultsSummary(
    intent: Extract<QueryIntent, { kind: 'race_results_summary' }>,
    rows: any[]
  ): Promise<RaceResultsSummaryPayload> {
    // Batch resolve all driver IDs and track
    const driverIds = rows.map(row => row.driver_id).filter(Boolean);
    const [driverRefs, trackRef] = await Promise.all([
      this.driverRefService.getRefs(driverIds),
      this.trackRefService.getRef(intent.track_id)
    ]);

    const entries: RaceResultsEntry[] = rows.map(row => ({
      position: parseInt(row.position || '0', 10),
      driver: driverRefs.get(row.driver_id) || { id: row.driver_id, name: row.driver_name || row.driver_id },
      // Backwards compatibility (deprecated)
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
      track: trackRef,
      // Backwards compatibility (deprecated)
      track_id: intent.track_id,
      race_name: rows[0]?.race_name ?? null,
      race_date: rows[0]?.race_date ?? null,
      circuit_name: rows[0]?.circuit_name ?? null,
      winner: winner?.driver_id ?? null,
      winner_name: winner?.driver.name ?? winner?.driver_name ?? null,
      podium: entries.slice(0, 3),
      top10: entries.slice(0, 10),
      laps_completed: winner?.laps_completed ?? null,
      winner_time: winner?.race_time ?? null
    };
  }

  // position-based comparison with optional filters
  private async formatDriverHeadToHeadCount(
    intent: Extract<QueryIntent, { kind: 'driver_head_to_head_count' }>,
    rows: any[]
  ): Promise<DriverHeadToHeadCountPayload> {
    const row = rows[0];
    const scope: MetricScope = { type: 'season', year: intent.season };

    // Resolve driver names in USER ORDER (from intent)
    const orderedPair = await this.driverRefService.getOrderedPair(
      intent.driver_a_id,
      intent.driver_b_id,
      'user_query'
    );

    // Map SQL results to intent order (swap if needed)
    const sqlMatchesIntent = row.driver_primary_id === intent.driver_a_id;

    const sharedEvents = parseInt(row.shared_events || '0', 10);
    const primaryWins_raw = parseInt(row.primary_wins || '0', 10);
    const secondaryWins_raw = parseInt(row.secondary_wins || '0', 10);
    const ties = parseInt(row.ties || '0', 10);

    // Reorder wins to match user intent
    const primaryWins = sqlMatchesIntent ? primaryWins_raw : secondaryWins_raw;
    const secondaryWins = sqlMatchesIntent ? secondaryWins_raw : primaryWins_raw;

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
      drivers: orderedPair,
      metrics: {
        primary_wins: MetricBuilder.h2hWins(primaryWins, orderedPair.drivers[0].name, scope),
        secondary_wins: MetricBuilder.h2hWins(secondaryWins, orderedPair.drivers[1].name, scope),
        ties: MetricBuilder.h2hTies(ties, scope),
        shared_events: MetricBuilder.sharedEvents(sharedEvents, scope),
      },
      coverage: {
        status: coverageStatus,
        sample_size: sharedEvents,
        sample_type: 'events',
      },
      // Backwards compatibility (deprecated)
      driver_primary_id: intent.driver_a_id,
      driver_secondary_id: intent.driver_b_id,
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

  private async formatDriverPerformanceVector(
    intent: Extract<QueryIntent, { kind: 'driver_performance_vector' }>,
    rows: any[]
  ): Promise<DriverPerformanceVectorPayload> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);

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
      driver: driverRef,
      // Backwards compatibility (deprecated)
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

  private async formatDriverMultiComparison(
    intent: Extract<QueryIntent, { kind: 'driver_multi_comparison' }>,
    rows: any[]
  ): Promise<DriverMultiComparisonPayload> {
    const scope: MetricScope = { type: 'season', year: intent.season };

    // Extract comparison type based on driver count
    const totalDrivers = parseInt(rows[0]?.total_drivers || '0', 10);
    const rankedDrivers = parseInt(rows[0]?.ranked_drivers || '0', 10);
    const comparisonType: 'multi_driver' | 'head_to_head' = totalDrivers === 2 ? 'head_to_head' : 'multi_driver';

    // Batch resolve all driver IDs
    const driverIds = rows.map(row => row.driver_id);
    const driverRefs = await this.driverRefService.getRefs(driverIds);

    // Build entries from rows
    const entries: DriverMultiComparisonEntry[] = rows.map(row => {
      const metricValue = parseFloat(row.metric_value || '0');
      const lapsConsidered = parseInt(row.laps_considered || '0', 10);
      return {
        driver: driverRefs.get(row.driver_id)!,
        rank: parseInt(row.rank || '0', 10),
        metric: MetricBuilder.avgRacePace(metricValue, scope),
        laps: MetricBuilder.lapsConsidered(lapsConsidered, scope),
        // Backwards compatibility (deprecated)
        driver_id: row.driver_id,
        metric_value: metricValue,
        laps_considered: lapsConsidered,
      };
    });

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
      coverage: {
        status: coverageStatus,
        sample_size: minLapsActual,
        sample_type: 'laps',
      },
      // Backwards compatibility (deprecated)
      coverage_status: coverageStatus
    };
  }

  private async formatDriverMatchupLookup(
    intent: Extract<QueryIntent, { kind: 'driver_matchup_lookup' }>,
    rows: any[]
  ): Promise<DriverMatchupLookupPayload> {
    const row = rows[0];
    const scope: MetricScope = { type: 'season', year: intent.season };

    // Resolve driver names in USER ORDER (from intent)
    const orderedPair = await this.driverRefService.getOrderedPair(
      intent.driver_a_id,
      intent.driver_b_id,
      'user_query'
    );

    // Map SQL results to intent order (swap if needed)
    const sqlMatchesIntent = row.driver_primary_id === intent.driver_a_id;

    const sharedEvents = parseInt(row.shared_events || '0', 10);
    const primaryWins_raw = parseInt(row.primary_wins || '0', 10);
    const secondaryWins_raw = parseInt(row.secondary_wins || '0', 10);
    const ties = parseInt(row.ties || '0', 10);

    // Reorder wins to match user intent
    const primaryWins = sqlMatchesIntent ? primaryWins_raw : secondaryWins_raw;
    const secondaryWins = sqlMatchesIntent ? secondaryWins_raw : primaryWins_raw;

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
      drivers: orderedPair,
      metrics: {
        primary_wins: MetricBuilder.h2hWins(primaryWins, orderedPair.drivers[0].name, scope),
        secondary_wins: MetricBuilder.h2hWins(secondaryWins, orderedPair.drivers[1].name, scope),
        ties: MetricBuilder.h2hTies(ties, scope),
        shared_events: MetricBuilder.sharedEvents(sharedEvents, scope),
      },
      coverage: {
        status: coverageStatus,
        sample_size: sharedEvents,
        sample_type: 'events',
      },
      // Backwards compatibility (deprecated)
      driver_primary_id: intent.driver_a_id,
      driver_secondary_id: intent.driver_b_id,
      primary_wins: primaryWins,
      secondary_wins: secondaryWins,
      ties,
      shared_events: sharedEvents,
      coverage_status: coverageStatus,
      computed_at: row.computed_at?.toISOString?.() || row.computed_at || new Date().toISOString()
    };
  }

  private async formatDriverProfileSummary(
    intent: Extract<QueryIntent, { kind: 'driver_profile_summary' }>,
    rows: any[]
  ): Promise<DriverProfileSummaryPayload> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);

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
      driver: driverRef,
      // Backwards compatibility (deprecated)
      driver_id: row.driver_id,
      driver_name: driverRef.name,
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

  private async formatDriverTrendSummary(
    intent: Extract<QueryIntent, { kind: 'driver_trend_summary' }>,
    rows: any[]
  ): Promise<DriverTrendSummaryPayload> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);

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
      driver: driverRef,
      // Backwards compatibility (deprecated)
      driver_id: row.driver_id,
      driver_name: driverRef.name,
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
  private async formatDriverPoleCount(
    intent: Extract<QueryIntent, { kind: 'driver_pole_count' }>,
    rows: any[]
  ): Promise<any> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);

    return {
      type: 'driver_pole_count',
      season: intent.season,
      driver: driverRef,
      // Backwards compatibility (deprecated)
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

  private async formatDriverCareerPoleCount(
    _intent: Extract<QueryIntent, { kind: 'driver_career_pole_count' }>,
    rows: any[]
  ): Promise<any> {
    const row = rows[0];
    if (!row) {
      throw new Error('No career pole data found');
    }
    const driverRef = await this.driverRefService.getRef(row.driver_id);

    return {
      type: 'driver_career_pole_count',
      driver: driverRef,
      driver_id: row.driver_id,
      driver_name: row.driver_name,
      total_poles: parseInt(row.total_poles || '0', 10),
      total_race_starts: parseInt(row.total_race_starts || '0', 10),
      total_wins: parseInt(row.total_wins || '0', 10),
      total_podiums: parseInt(row.total_podiums || '0', 10),
      championships: parseInt(row.championships || '0', 10),
      pole_rate_percent: row.pole_rate_percent !== null
        ? parseFloat(row.pole_rate_percent)
        : null,
      first_season: row.first_season !== null
        ? parseInt(row.first_season, 10)
        : null,
      last_season: row.last_season !== null
        ? parseInt(row.last_season, 10)
        : null
    };
  }

  private async formatDriverQ3Count(
    intent: Extract<QueryIntent, { kind: 'driver_q3_count' }>,
    rows: any[]
  ): Promise<any> {
    const row = rows[0];
    const driverRef = await this.driverRefService.getRef(row.driver_id);

    return {
      type: 'driver_q3_count',
      season: intent.season,
      driver: driverRef,
      // Backwards compatibility (deprecated)
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

  private async formatSeasonQ3Rankings(
    intent: Extract<QueryIntent, { kind: 'season_q3_rankings' }>,
    rows: any[]
  ): Promise<any> {
    // Batch resolve all driver IDs
    const driverIds = rows.map(row => row.driver_id);
    const driverRefs = await this.driverRefService.getRefs(driverIds);

    const entries = rows.map(row => ({
      rank: parseInt(row.rank || '0', 10),
      driver: driverRefs.get(row.driver_id),
      // Backwards compatibility (deprecated)
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

  private async formatQualifyingGapTeammates(
    intent: Extract<QueryIntent, { kind: 'qualifying_gap_teammates' }>,
    rows: any[]
  ): Promise<any> {
    const row = rows[0];

    // Resolve driver names in USER ORDER (from intent)
    const primaryId = intent.driver_a_id || row.driver_primary_id;
    const secondaryId = intent.driver_b_id || row.driver_secondary_id;
    const orderedPair = await this.driverRefService.getOrderedPair(primaryId, secondaryId, 'user_query');

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
      drivers: orderedPair,
      // Backwards compatibility (deprecated)
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

  private async formatQualifyingGapDrivers(
    intent: Extract<QueryIntent, { kind: 'qualifying_gap_drivers' }>,
    rows: any[]
  ): Promise<any> {
    const row = rows[0];

    // Resolve driver names in USER ORDER (from intent)
    const orderedPair = await this.driverRefService.getOrderedPair(
      intent.driver_a_id,
      intent.driver_b_id,
      'user_query'
    );

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
      drivers: orderedPair,
      // Backwards compatibility (deprecated)
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

  private async formatDriverVsDriverComprehensive(
    intent: Extract<QueryIntent, { kind: 'driver_vs_driver_comprehensive' }>,
    rows: any[]
  ): Promise<DriverVsDriverComprehensivePayload> {
    const row = rows[0];
    const scope: MetricScope = { type: 'season', year: intent.season };

    // Resolve driver names in USER ORDER (from intent)
    const orderedPair = await this.driverRefService.getOrderedPair(
      intent.driver_a_id,
      intent.driver_b_id,
      'user_query'
    );

    // Parse normalized pace data (% relative to session median)
    // Negative = faster than field, Positive = slower than field
    const driverAAvgPacePct = row.driver_a_avg_pace_pct !== null && row.driver_a_avg_pace_pct !== undefined
      ? parseFloat(row.driver_a_avg_pace_pct)
      : null;
    const driverBAvgPacePct = row.driver_b_avg_pace_pct !== null && row.driver_b_avg_pace_pct !== undefined
      ? parseFloat(row.driver_b_avg_pace_pct)
      : null;
    const paceDeltaPct = row.pace_delta_pct !== null && row.pace_delta_pct !== undefined
      ? parseFloat(row.pace_delta_pct)
      : null;
    const sharedRaces = parseInt(row.shared_races || '0', 10);

    // Get coverage status
    let coverageStatus: CoverageStatus;
    if (row.coverage_status === 'valid' || row.coverage_status === 'low_coverage' || row.coverage_status === 'insufficient') {
      coverageStatus = row.coverage_status;
    } else if (sharedRaces >= 8) {
      coverageStatus = 'valid';
    } else if (sharedRaces >= 4) {
      coverageStatus = 'low_coverage';
    } else {
      coverageStatus = 'insufficient';
    }

    return {
      type: 'driver_vs_driver_comprehensive',
      season: intent.season,
      drivers: orderedPair,

      pace: {
        driver_a_avg_pace_pct: driverAAvgPacePct !== null
          ? MetricBuilder.gapPct(driverAAvgPacePct, scope)
          : null,
        driver_b_avg_pace_pct: driverBAvgPacePct !== null
          ? MetricBuilder.gapPct(driverBAvgPacePct, scope)
          : null,
        pace_delta_pct: paceDeltaPct !== null
          ? MetricBuilder.gapPct(paceDeltaPct, scope)
          : null,
        shared_races: sharedRaces,
      },

      qualifying_gap: {
        gap_pct: row.qual_gap_pct !== null && row.qual_gap_pct !== undefined
          ? MetricBuilder.gapPct(parseFloat(row.qual_gap_pct), scope)
          : null,
        gap_ms: row.qual_gap_ms !== null && row.qual_gap_ms !== undefined
          ? parseFloat(row.qual_gap_ms)
          : null,
        shared_sessions: parseInt(row.qual_shared_sessions || '0', 10),
      },

      head_to_head: {
        qualifying: {
          a_wins: parseInt(row.qual_h2h_a_wins || '0', 10),
          b_wins: parseInt(row.qual_h2h_b_wins || '0', 10),
          ties: parseInt(row.qual_h2h_ties || '0', 10),
        },
        race_finish: {
          a_wins: parseInt(row.race_h2h_a_wins || '0', 10),
          b_wins: parseInt(row.race_h2h_b_wins || '0', 10),
          ties: parseInt(row.race_h2h_ties || '0', 10),
        },
      },

      stats: {
        driver_a: {
          wins: MetricBuilder.wins(parseInt(row.driver_a_wins || '0', 10), scope),
          podiums: MetricBuilder.podiums(parseInt(row.driver_a_podiums || '0', 10), scope),
          poles: MetricBuilder.poles(parseInt(row.driver_a_poles || '0', 10), scope),
          dnfs: MetricBuilder.dnfs(parseInt(row.driver_a_dnfs || '0', 10), scope),
          points: MetricBuilder.build({
            key: 'points',
            label: 'Points',
            value: parseFloat(row.driver_a_points || '0'),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
          race_count: MetricBuilder.build({
            key: 'race_count',
            label: 'Races',
            value: parseInt(row.driver_a_race_count || '0', 10),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
          fastest_laps: MetricBuilder.build({
            key: 'fastest_laps',
            label: 'Fastest Laps',
            value: parseInt(row.driver_a_fastest_laps || '0', 10),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
          sprint_points: MetricBuilder.build({
            key: 'sprint_points',
            label: 'Sprint Points',
            value: parseFloat(row.driver_a_sprint_points || '0'),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
        },
        driver_b: {
          wins: MetricBuilder.wins(parseInt(row.driver_b_wins || '0', 10), scope),
          podiums: MetricBuilder.podiums(parseInt(row.driver_b_podiums || '0', 10), scope),
          poles: MetricBuilder.poles(parseInt(row.driver_b_poles || '0', 10), scope),
          dnfs: MetricBuilder.dnfs(parseInt(row.driver_b_dnfs || '0', 10), scope),
          points: MetricBuilder.build({
            key: 'points',
            label: 'Points',
            value: parseFloat(row.driver_b_points || '0'),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
          race_count: MetricBuilder.build({
            key: 'race_count',
            label: 'Races',
            value: parseInt(row.driver_b_race_count || '0', 10),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
          fastest_laps: MetricBuilder.build({
            key: 'fastest_laps',
            label: 'Fastest Laps',
            value: parseInt(row.driver_b_fastest_laps || '0', 10),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
          sprint_points: MetricBuilder.build({
            key: 'sprint_points',
            label: 'Sprint Points',
            value: parseFloat(row.driver_b_sprint_points || '0'),
            scope,
            units: 'count',
            source: 'F1DB',
          }),
        },
      },

      coverage: {
        status: coverageStatus,
        sample_size: sharedRaces,
        sample_type: 'races',
      },
    };
  }

  private async formatDriverCareerWinsByCircuit(
    intent: Extract<QueryIntent, { kind: 'driver_career_wins_by_circuit' }>,
    rows: any[]
  ): Promise<DriverCareerWinsByCircuitPayload> {
    // Resolve driver name
    const driverRef = await this.driverRefService.getRef(intent.driver_id);

    // Get total wins from first row
    const totalWins = rows.length > 0 ? parseInt(rows[0].total_wins || '0', 10) : 0;

    // Resolve all track refs
    const trackIds = rows.map(row => row.grand_prix_id || row.circuit_id);
    const trackRefs = await this.trackRefService.getRefs(trackIds);

    // Build circuits array
    const circuits = rows.map(row => {
      const trackId = row.grand_prix_id || row.circuit_id;
      const trackRef = trackRefs.get(trackId) || {
        id: trackId,
        name: row.grand_prix_name || row.circuit_name || trackId,
        circuit_name: row.circuit_full_name || row.circuit_name,
      };

      return {
        track: trackRef,
        wins: parseInt(row.wins || '0', 10),
        last_win_year: parseInt(row.last_win_year || '0', 10),
      };
    });

    return {
      type: 'driver_career_wins_by_circuit',
      driver: driverRef,
      total_wins: totalWins,
      circuits,
    };
  }

  private async formatTeammateComparisonCareer(
    intent: Extract<QueryIntent, { kind: 'teammate_comparison_career' }>,
    rows: any[]
  ): Promise<TeammateComparisonCareerPayload> {
    // Resolve driver names in USER ORDER (from intent)
    const orderedPair = await this.driverRefService.getOrderedPair(
      intent.driver_a_id,
      intent.driver_b_id,
      'user_query'
    );

    // Build per-season data
    const seasons = rows.map(row => ({
      season: parseInt(row.season || '0', 10),
      team: {
        id: row.team_id,
        name: row.team_id ? row.team_id.charAt(0).toUpperCase() + row.team_id.slice(1).replace(/-/g, ' ') : 'Unknown',
      } as TeamRef,
      team_id: row.team_id,
      gap_seconds: row.gap_seconds !== null ? parseFloat(row.gap_seconds) : 0,
      gap_pct: row.gap_pct !== null ? parseFloat(row.gap_pct) : null,
      shared_races: parseInt(row.shared_races || '0', 10),
      faster_primary_count: parseInt(row.faster_primary_count || '0', 10),
    }));

    // Get aggregate from first row (same for all rows)
    const firstRow = rows[0] || {};

    // Calculate avg_gap_pct from seasons data (weighted by shared_races)
    const totalRaces = seasons.reduce((sum, s) => sum + s.shared_races, 0);
    const weightedGapPctSum = seasons.reduce((sum, s) =>
      sum + (s.gap_pct ?? 0) * s.shared_races, 0);
    const avgGapPct = totalRaces > 0 ? weightedGapPctSum / totalRaces : null;

    // Get aggregate H2H from SQL or calculate from seasons
    const totalFasterPrimaryCount = firstRow.total_faster_primary_count !== undefined
      ? parseInt(firstRow.total_faster_primary_count || '0', 10)
      : seasons.reduce((sum, s) => sum + s.faster_primary_count, 0);

    const aggregate = {
      total_shared_races: parseInt(firstRow.total_shared_races || '0', 10),
      total_faster_primary_count: totalFasterPrimaryCount,
      avg_gap_seconds: firstRow.avg_gap_seconds !== null ? parseFloat(firstRow.avg_gap_seconds) : 0,
      avg_gap_pct: avgGapPct,
      seasons_together: parseInt(firstRow.seasons_together || '0', 10),
      overall_winner: (firstRow.overall_winner || 'draw') as 'primary' | 'secondary' | 'draw',
    };

    return {
      type: 'teammate_comparison_career',
      drivers: orderedPair,
      seasons,
      aggregate,
    };
  }

  private async formatQualifyingResultsSummary(
    intent: Extract<QueryIntent, { kind: 'qualifying_results_summary' }>,
    rows: any[]
  ): Promise<QualifyingResultsSummaryPayload> {
    // Batch resolve all driver IDs and track
    const driverIds = rows.map(row => row.driver_id).filter(Boolean);
    const [driverRefs, trackRef] = await Promise.all([
      this.driverRefService.getRefs(driverIds),
      this.trackRefService.getRef(intent.track_id)
    ]);

    const entries: QualifyingResultsEntry[] = rows.map(row => ({
      position: parseInt(row.position || '0', 10),
      driver: driverRefs.get(row.driver_id) || { id: row.driver_id, name: row.driver_name || row.driver_id },
      // Backwards compatibility (deprecated)
      driver_id: row.driver_id,
      driver_name: row.driver_name,
      constructor_name: row.constructor_name,
      q1_time: row.q1_time ?? null,
      q2_time: row.q2_time ?? null,
      q3_time: row.q3_time ?? null,
      qualifying_time: row.qualifying_time ?? null,
    }));

    const poleSitter = entries[0];

    return {
      type: 'qualifying_results_summary',
      season: intent.season,
      round: rows[0]?.round ? parseInt(rows[0].round, 10) : null,
      track: trackRef,
      // Backwards compatibility (deprecated)
      track_id: intent.track_id,
      track_name: rows[0]?.track_name ?? null,
      pole_sitter: poleSitter?.driver_id ?? null,
      pole_sitter_name: poleSitter?.driver.name ?? poleSitter?.driver_name ?? null,
      pole_time: poleSitter?.q3_time ?? poleSitter?.qualifying_time ?? null,
      front_row: entries.slice(0, 2),
      top10: entries.slice(0, 10),
      full_grid: entries,
    };
  }
}
