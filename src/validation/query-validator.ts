import { QueryIntent } from '../types/query-intent';
import { QueryError } from '../types/results';
import { MetricRegistryValidator } from '../observability/metric-registry';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: QueryError;
  warnings?: string[];
}

const MIN_SEASON = 1950;
const MAX_SEASON = 2100;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

type MetricIntent = Exclude<QueryIntent, { kind: 'race_results_summary' } | { kind: 'qualifying_results_summary' }>;

/**
 * Minimal QueryIntent validator
 */
export class QueryValidator {
  async validate(intent: QueryIntent): Promise<ValidationResult> {
    const seasonValidation = this.validateSeason(intent.season);
    if (!seasonValidation.valid) {
      return seasonValidation;
    }

    if (intent.kind === 'race_results_summary' || intent.kind === 'qualifying_results_summary') {
      return this.validateKindSpecific(intent);
    }

    const metricIntent: MetricIntent = intent;

    // STATMUSE REFACTOR: Metric-less query kinds (pure results/summaries)
    const metriclessKinds = new Set([
      'driver_season_summary',
      'driver_career_summary',
      'driver_profile_summary',     // Comprehensive profile (uses multiple metrics internally)
      'driver_trend_summary',       // Multi-season trend (uses teammate gaps internally)
      'teammate_gap_dual_comparison',
      'driver_head_to_head_count',  // Position-based, not pace-based
      'driver_performance_vector',  // Cross-metric profile (has own metric logic)
      'driver_multi_comparison',    // Multi-driver comparison (uses comparison_metric)
      'driver_matchup_lookup',      // Precomputed matchup lookup (position-based)
      // QUALIFYING QUERY TYPES
      'driver_pole_count',          // Position-based count (season)
      'driver_career_pole_count',   // Position-based count (career)
      'driver_q3_count',            // Q3 appearance count
      'season_q3_rankings',         // Rankings by Q3 appearances
      'qualifying_gap_teammates',   // Teammate qualifying gap
      'qualifying_gap_drivers'      // Cross-team qualifying gap
    ]);

    if (!metriclessKinds.has(metricIntent.kind)) {
      const registryValidation = MetricRegistryValidator.validate(
        metricIntent.metric,
        metricIntent.kind,
        metricIntent.normalization
      );
      if (!registryValidation.valid) {
        return {
          valid: false,
          error: {
            error: 'validation_failed',
            reason: registryValidation.reason
          }
        };
      }

      const cleanAirValidation = this.validateCleanAirUsage(metricIntent);
      if (!cleanAirValidation.valid) {
        return cleanAirValidation;
      }
    }

    return this.validateKindSpecific(intent);
  }

  private validateSeason(season: number): ValidationResult {
    if (!Number.isInteger(season)) {
      return this.fail('Season must be an integer');
    }

    if (season < MIN_SEASON || season > MAX_SEASON) {
      return this.fail(`Invalid season: ${season}`);
    }

    return { valid: true };
  }

  private validateCleanAirUsage(intent: MetricIntent): ValidationResult {
    if (intent.metric === 'clean_air_pace' && !intent.clean_air_only) {
      return this.fail('clean_air_pace metric requires clean_air_only=true');
    }

    return { valid: true };
  }

  private validateKindSpecific(intent: QueryIntent): ValidationResult {
    switch (intent.kind) {
      case 'season_driver_vs_driver':
      case 'cross_team_track_scoped_driver_comparison':
        if (!isNonEmptyString((intent as any).driver_a_id)) {
          return this.fail('driver_a_id is required');
        }
        if (!isNonEmptyString((intent as any).driver_b_id)) {
          return this.fail('driver_b_id is required');
        }
        if (intent.kind === 'cross_team_track_scoped_driver_comparison') {
          if (!isNonEmptyString((intent as any).track_id)) {
            return this.fail('track_id is required');
          }
        }
        return { valid: true };

      case 'driver_season_summary': {
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'track_fastest_drivers':
        if (!isNonEmptyString((intent as any).track_id)) {
          return this.fail('track_id is required');
        }
        return { valid: true };

      case 'driver_career_summary': {
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'teammate_gap_summary_season': {
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;
        const teamId = (intent as any).team_id;

        const hasDrivers = isNonEmptyString(driverA) && isNonEmptyString(driverB);
        const hasTeam = isNonEmptyString(teamId);

        if (!hasDrivers && !hasTeam) {
          return this.fail('teammate_gap_summary_season requires driver_a_id + driver_b_id or team_id');
        }

        if ((isNonEmptyString(driverA) && !isNonEmptyString(driverB)) ||
            (!isNonEmptyString(driverA) && isNonEmptyString(driverB))) {
          return this.fail('Both driver_a_id and driver_b_id are required together');
        }

        return { valid: true };
      }

      case 'teammate_gap_dual_comparison': {
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;
        const teamId = (intent as any).team_id;

        const hasDrivers = isNonEmptyString(driverA) && isNonEmptyString(driverB);
        const hasTeam = isNonEmptyString(teamId);

        if (!hasDrivers && !hasTeam) {
          return this.fail('teammate_gap_dual_comparison requires driver_a_id + driver_b_id or team_id');
        }

        if ((isNonEmptyString(driverA) && !isNonEmptyString(driverB)) ||
            (!isNonEmptyString(driverA) && isNonEmptyString(driverB))) {
          return this.fail('Both driver_a_id and driver_b_id are required together');
        }

        return { valid: true };
      }

      case 'race_results_summary': {
        // NEW: Race results validation
        if (!isNonEmptyString((intent as any).track_id)) {
          return this.fail('track_id is required');
        }
        return { valid: true };
      }

      case 'qualifying_results_summary': {
        // Qualifying results validation
        if (!isNonEmptyString((intent as any).track_id)) {
          return this.fail('track_id is required');
        }
        return { valid: true };
      }

      case 'driver_head_to_head_count': {
        // Position-based head-to-head comparison validation
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;

        if (!isNonEmptyString(driverA)) {
          return this.fail('driver_a_id is required');
        }
        if (!isNonEmptyString(driverB)) {
          return this.fail('driver_b_id is required');
        }

        // Reject same driver comparison
        if (driverA.toLowerCase() === driverB.toLowerCase()) {
          return this.fail('Cannot compare a driver to themselves');
        }

        // Validate h2h_metric
        const h2hMetric = (intent as any).h2h_metric;
        if (!h2hMetric || !['qualifying_position', 'race_finish_position'].includes(h2hMetric)) {
          return this.fail('h2h_metric must be "qualifying_position" or "race_finish_position"');
        }

        // Validate h2h_scope (optional, defaults to 'field' in executor)
        const h2hScope = (intent as any).h2h_scope;
        if (h2hScope && !['field', 'teammate'].includes(h2hScope)) {
          return this.fail('h2h_scope must be "field" or "teammate"');
        }

        // Validate filters if present
        const filters = (intent as any).filters;
        if (filters) {
          const filterValidation = this.validateHeadToHeadFilters(filters, h2hMetric);
          if (!filterValidation.valid) {
            return filterValidation;
          }
        }

        return { valid: true };
      }

      case 'driver_performance_vector': {
        // PART 4: Cross-metric performance profile validation
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'driver_multi_comparison': {
        // PART 5: Multi-driver comparison validation
        const driverIds = (intent as any).driver_ids;
        const comparisonMetric = (intent as any).comparison_metric;

        // Validate driver_ids array
        if (!Array.isArray(driverIds)) {
          return this.fail('driver_ids must be an array');
        }
        if (driverIds.length < 2) {
          return this.fail('driver_ids must contain at least 2 drivers');
        }
        if (driverIds.length > 6) {
          return this.fail('driver_ids cannot contain more than 6 drivers');
        }

        // Validate each driver_id
        for (const driverId of driverIds) {
          if (!isNonEmptyString(driverId)) {
            return this.fail('Each driver_id must be a non-empty string');
          }
        }

        // Check for duplicates
        const uniqueDrivers = new Set(driverIds.map((d: string) => d.toLowerCase()));
        if (uniqueDrivers.size !== driverIds.length) {
          return this.fail('driver_ids contains duplicate drivers');
        }

        // Validate comparison_metric
        const validMetrics = ['avg_true_pace', 'qualifying_pace', 'consistency'];
        if (!comparisonMetric || !validMetrics.includes(comparisonMetric)) {
          return this.fail(`comparison_metric must be one of: ${validMetrics.join(', ')}`);
        }

        return { valid: true };
      }

      case 'driver_matchup_lookup': {
        // PART 6: Driver matchup lookup validation
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;

        if (!isNonEmptyString(driverA)) {
          return this.fail('driver_a_id is required');
        }
        if (!isNonEmptyString(driverB)) {
          return this.fail('driver_b_id is required');
        }

        // Reject same driver comparison
        if (driverA.toLowerCase() === driverB.toLowerCase()) {
          return this.fail('Cannot compare a driver to themselves');
        }

        // Validate h2h_metric
        const h2hMetric = (intent as any).h2h_metric;
        if (!h2hMetric || !['qualifying_position', 'race_finish_position'].includes(h2hMetric)) {
          return this.fail('h2h_metric must be "qualifying_position" or "race_finish_position"');
        }

        return { valid: true };
      }

      case 'driver_profile_summary': {
        // TIER 2: Comprehensive driver profile validation
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'driver_trend_summary': {
        // TIER 2: Multi-season trend analysis validation
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      // QUALIFYING QUERY TYPES
      case 'driver_pole_count': {
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'driver_career_pole_count': {
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'driver_q3_count': {
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'season_q3_rankings': {
        // Only season is required, which is already validated
        return { valid: true };
      }

      case 'qualifying_gap_teammates': {
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;
        const teamId = (intent as any).team_id;

        const hasDrivers = isNonEmptyString(driverA) && isNonEmptyString(driverB);
        const hasTeam = isNonEmptyString(teamId);

        if (!hasDrivers && !hasTeam) {
          return this.fail('qualifying_gap_teammates requires driver_a_id + driver_b_id or team_id');
        }

        if ((isNonEmptyString(driverA) && !isNonEmptyString(driverB)) ||
            (!isNonEmptyString(driverA) && isNonEmptyString(driverB))) {
          return this.fail('Both driver_a_id and driver_b_id are required together');
        }

        return { valid: true };
      }

      case 'qualifying_gap_drivers': {
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;

        if (!isNonEmptyString(driverA)) {
          return this.fail('driver_a_id is required');
        }
        if (!isNonEmptyString(driverB)) {
          return this.fail('driver_b_id is required');
        }

        // Reject same driver comparison
        if (driverA.toLowerCase() === driverB.toLowerCase()) {
          return this.fail('Cannot compare a driver to themselves');
        }

        return { valid: true };
      }

      // =====================================================
      // NEW COMPREHENSIVE QUERY TYPES (3 NEW TYPES)
      // =====================================================

      case 'driver_vs_driver_comprehensive': {
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;

        if (!isNonEmptyString(driverA)) {
          return this.fail('driver_a_id is required');
        }
        if (!isNonEmptyString(driverB)) {
          return this.fail('driver_b_id is required');
        }

        // Reject same driver comparison
        if (driverA.toLowerCase() === driverB.toLowerCase()) {
          return this.fail('Cannot compare a driver to themselves');
        }

        return { valid: true };
      }

      case 'driver_career_wins_by_circuit': {
        const driverId = (intent as any).driver_id;
        if (!isNonEmptyString(driverId)) {
          return this.fail('driver_id is required');
        }
        return { valid: true };
      }

      case 'teammate_comparison_career': {
        const driverA = (intent as any).driver_a_id;
        const driverB = (intent as any).driver_b_id;

        if (!isNonEmptyString(driverA)) {
          return this.fail('driver_a_id is required');
        }
        if (!isNonEmptyString(driverB)) {
          return this.fail('driver_b_id is required');
        }

        // Note: No season validation needed - auto-detects shared seasons from SQL
        return { valid: true };
      }

      default:
        return this.fail(`Unknown QueryIntent kind: ${(intent as any).kind}`);
    }
  }

  private fail(reason: string): ValidationResult {
    return {
      valid: false,
      error: {
        error: 'validation_failed',
        reason
      }
    };
  }

  /**
   * Validate head-to-head filters
   */
  private validateHeadToHeadFilters(
    filters: any,
    metric: string
  ): ValidationResult {
    // Validate session filter
    if (filters.session) {
      const validSessions = ['Q1', 'Q2', 'Q3', 'BEST'];
      if (!validSessions.includes(filters.session)) {
        return this.fail(`Invalid session filter: "${filters.session}". Must be one of: ${validSessions.join(', ')}`);
      }
      // Session filter only valid for qualifying metric
      if (metric !== 'qualifying_position') {
        return this.fail('Session filter is only valid for qualifying_position metric');
      }
    }

    // Validate track_type filter
    if (filters.track_type) {
      const validTrackTypes = ['street', 'permanent'];
      if (!validTrackTypes.includes(filters.track_type)) {
        return this.fail(`Invalid track_type filter: "${filters.track_type}". Must be one of: ${validTrackTypes.join(', ')}`);
      }
    }

    // Validate weather filter
    if (filters.weather) {
      const validWeather = ['dry', 'wet', 'mixed'];
      if (!validWeather.includes(filters.weather)) {
        return this.fail(`Invalid weather filter: "${filters.weather}". Must be one of: ${validWeather.join(', ')}`);
      }
    }

    // Validate rounds filter
    if (filters.rounds) {
      if (!Array.isArray(filters.rounds)) {
        return this.fail('rounds filter must be an array of round numbers');
      }
      if (filters.rounds.length === 0) {
        return this.fail('rounds filter cannot be empty array');
      }
      for (const round of filters.rounds) {
        if (!Number.isInteger(round) || round < 1 || round > 30) {
          return this.fail(`Invalid round number: ${round}. Must be integer between 1 and 30`);
        }
      }
    }

    // Validate date_from filter
    if (filters.date_from) {
      const date = Date.parse(filters.date_from);
      if (isNaN(date)) {
        return this.fail(`Invalid date_from format: "${filters.date_from}". Use ISO 8601 format (YYYY-MM-DD)`);
      }
    }

    // Validate date_to filter
    if (filters.date_to) {
      const date = Date.parse(filters.date_to);
      if (isNaN(date)) {
        return this.fail(`Invalid date_to format: "${filters.date_to}". Use ISO 8601 format (YYYY-MM-DD)`);
      }
    }

    // Validate date range
    if (filters.date_from && filters.date_to) {
      const from = Date.parse(filters.date_from);
      const to = Date.parse(filters.date_to);
      if (from > to) {
        return this.fail('date_from must be before date_to');
      }
    }

    // Validate exclude_dnfs filter
    if (filters.exclude_dnfs !== undefined && typeof filters.exclude_dnfs !== 'boolean') {
      return this.fail('exclude_dnfs filter must be a boolean');
    }

    return { valid: true };
  }
}
