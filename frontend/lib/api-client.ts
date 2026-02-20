/**
 * F1Muse API Client
 *
 * Calls the real backend at /nl-query instead of using mock data.
 * All data flows through this module.
 */

// Backend API URL - defaults to localhost in development
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Semantic types for self-describing data
 */
export interface DriverRef {
  id: string;
  name: string;
  short_name?: string;
}

export interface TrackRef {
  id: string;
  name: string;
  circuit_name?: string;
}

export interface TeamRef {
  id: string;
  name: string;
  short_name?: string;
}

export interface Metric<T = number> {
  key: string;
  label: string;
  value: T;
  scope?: { type: string; year?: number; track_id?: string };
  units?: 'count' | 'percent' | 'seconds' | 'positions' | 'percentile';
  source?: 'F1DB' | 'Lap Data' | 'Computed';
}

export interface OrderedDriverPair {
  drivers: [DriverRef, DriverRef];
  order_source: 'user_query' | 'alphabetic';
}

export interface Coverage {
  status: 'valid' | 'low_coverage' | 'insufficient';
  sample_size: number;
  sample_type: 'races' | 'laps' | 'sessions';
}

/**
 * Structured answer from the backend
 */
export interface StructuredAnswer {
  query_kind: string;
  headline: string;
  bullets: string[];
  coverage: {
    level: string;
    summary: string;
  };
  followups: string[];
}

/**
 * Backend response structure from /nl-query
 */
export interface NLQueryResponse {
  request_id: string;
  error_type: string | null;
  query_kind: string | null;
  question: string;
  queryIntent: QueryIntent;
  result: QueryResult;
  answer: StructuredAnswer | string;
  fallbacks?: unknown[];
  supplemental_results?: unknown[];
  canonical_response?: string;
  debug?: {
    intent_cache_hit: boolean;
    sql_executed: boolean;
    rows_returned: number;
    coverage_reason: string | null;
  };
  metadata?: {
    llmBackend: string;
    fallbackUsed: boolean;
  };
}

export interface QueryIntent {
  kind: string;
  season?: number;
  driver_id?: string;
  driver_a_id?: string;
  driver_b_id?: string;
  track_id?: string;
  metric?: string;
  normalization?: string;
  raw_query?: string;
  [key: string]: unknown;
}

export interface QueryResult {
  intent?: QueryIntent;
  result?: {
    type: string;
    payload: ResultPayload;
  };
  interpretation?: Interpretation;
  metadata?: ResultMetadata;
  error?: string;
  reason?: string;
}

export interface Interpretation {
  comparison_basis: string;
  normalization_scope: string;
  metric_definition: string;
  constraints: {
    min_lap_requirement: number;
    rows_included: number;
    rows_excluded_reason?: string;
    other_constraints: string[];
  };
  confidence_notes: string[];
  confidence: {
    coverage_level: 'high' | 'moderate' | 'low' | 'insufficient';
    laps_considered: number;
    notes: string[];
  };
}

export interface ResultMetadata {
  sql_template_id: string;
  data_scope: string;
  rows: number;
}

/**
 * Union of all result payload types
 */
export type ResultPayload =
  | SeasonDriverSummaryPayload
  | SeasonDriverVsDriverPayload
  | DriverRankingPayload
  | RaceResultsSummaryPayload
  | CrossTeamTrackScopedDriverComparisonPayload
  | TeammateGapSummarySeasonPayload
  | TeammateGapDualComparisonPayload
  | DriverCareerSummaryPayload
  | DriverHeadToHeadCountPayload
  | DriverPerformanceVectorPayload
  | DriverMultiComparisonPayload
  | DriverVsDriverComprehensivePayload
  | DriverCareerWinsByCircuitPayload
  | TeammateComparisonCareerPayload
  | QualifyingResultsSummaryPayload
  | DriverPoleCountPayload
  | DriverQ3CountPayload
  | SeasonQ3RankingsPayload
  | QualifyingGapPayload
  | { type: string; [key: string]: unknown };

// Result payload interfaces
export interface SeasonDriverSummaryPayload {
  type: 'driver_season_summary';
  season: number;
  driver: DriverRef;
  driver_id: string;
  metrics: {
    wins: Metric<number>;
    podiums: Metric<number>;
    dnfs: Metric<number>;
    race_count: Metric<number>;
    avg_race_pace: Metric<number> | null;
    laps_considered: Metric<number>;
  };
  wins: number;
  podiums: number;
  dnfs: number;
  race_count: number;
  avg_race_pace: number | null;
  laps_considered: number;
}

export interface SeasonDriverVsDriverPayload {
  type: 'season_driver_vs_driver';
  season: number;
  drivers: OrderedDriverPair;
  metrics: {
    driver_a_value: Metric<number>;
    driver_b_value: Metric<number>;
    difference: Metric<number>;
    shared_races?: Metric<number>;
    driver_a_laps: Metric<number>;
    driver_b_laps: Metric<number>;
  };
  coverage: Coverage;
  driver_a: string;
  driver_b: string;
  metric: string;
  driver_a_value: number;
  driver_b_value: number;
  difference: number;
  normalization: string;
  units?: 'percent' | 'seconds';
}

export interface DriverRankingEntry {
  driver: DriverRef;
  driver_id: string;
  pace: Metric<number>;
  value: number;
  laps: Metric<number>;
  laps_considered: number;
}

export interface DriverRankingPayload {
  type: 'driver_ranking';
  season: number;
  track?: TrackRef;
  track_id: string;
  metric: string;
  ranking_basis: 'lower_is_faster';
  entries: DriverRankingEntry[];
}

export interface RaceResultsEntry {
  position: number;
  driver: DriverRef;
  driver_id: string;
  driver_name: string;
  constructor_name: string;
  laps_completed: number | null;
  race_time: string | null;
  fastest_lap: string | null;
  grid_position: number | null;
  points: number | null;
}

export interface RaceResultsSummaryPayload {
  type: 'race_results_summary';
  season: number;
  track?: TrackRef;
  track_id: string;
  race_name: string | null;
  race_date: string | null;
  circuit_name: string | null;
  winner: string | null;
  winner_name: string | null;
  podium: RaceResultsEntry[];
  top10: RaceResultsEntry[];
  laps_completed: number | null;
  winner_time: string | null;
}

export interface CrossTeamTrackScopedDriverComparisonPayload {
  type: 'cross_team_track_scoped_driver_comparison';
  season: number;
  track?: TrackRef;
  track_id: string;
  metric: string;
  drivers: OrderedDriverPair;
  metrics: {
    driver_a_value: Metric<number>;
    driver_b_value: Metric<number>;
    pace_delta: Metric<number>;
    driver_a_laps: Metric<number>;
    driver_b_laps: Metric<number>;
  };
  driver_a: string;
  driver_b: string;
  pace_delta: number;
}

export interface TeammateGapSummarySeasonPayload {
  type: 'teammate_gap_summary_season';
  season: number;
  team_id: string;
  drivers: OrderedDriverPair;
  metrics: {
    gap_seconds: Metric<number>;
    gap_pct: Metric<number> | null;
    shared_races: Metric<number>;
    faster_count: Metric<number>;
  };
  coverage: Coverage;
  gap_seconds: number;
  gap_pct: number | null;
  shared_races: number;
  gap_band: string;
}

export interface TeammateGapDualComparisonPayload {
  type: 'teammate_gap_dual_comparison';
  season: number;
  team_id: string | null;
  drivers: OrderedDriverPair;
  qualifying: {
    gap_percent: number | null;
    gap_seconds: number | null;
    winner: string | null;
    shared_races: number;
    faster_primary_count: number;
    coverage_status: string;
    available: boolean;
  };
  race_pace: {
    gap_percent: number | null;
    gap_seconds: number | null;
    winner: string | null;
    shared_races: number;
    faster_primary_count: number;
    coverage_status: string;
    available: boolean;
  };
  overall_summary: {
    same_winner: boolean | null;
    advantage_area: string;
  };
}

export interface DriverCareerSummaryPayload {
  type: 'driver_career_summary';
  driver: DriverRef;
  driver_id: string;
  metrics: {
    championships: Metric<number>;
    seasons_raced: Metric<number>;
    career_podiums: Metric<number>;
    career_wins: Metric<number>;
  };
  championships: number;
  seasons_raced: number;
  career_podiums: number;
  career_wins: number;
}

export interface DriverHeadToHeadCountPayload {
  type: 'driver_head_to_head_count';
  season: number;
  metric: 'qualifying_position' | 'race_finish_position';
  drivers: OrderedDriverPair;
  metrics: {
    primary_wins: Metric<number>;
    secondary_wins: Metric<number>;
    ties: Metric<number>;
    shared_events: Metric<number>;
  };
  coverage: Coverage;
  primary_wins: number;
  secondary_wins: number;
  ties: number;
  shared_events: number;
}

export interface DriverPerformanceVectorPayload {
  type: 'driver_performance_vector';
  season: number;
  driver: DriverRef;
  driver_id: string;
  qualifying_percentile: number | null;
  race_pace_percentile: number | null;
  consistency_score: number | null;
  street_delta: number | null;
  wet_delta: number | null;
  sample_sizes: {
    qualifying_laps: number;
    race_laps: number;
    street_laps: number;
    wet_laps: number;
  };
  coverage_status: string;
}

export interface DriverMultiComparisonEntry {
  driver: DriverRef;
  driver_id: string;
  rank: number;
  metric: Metric<number>;
  metric_value: number;
  laps: Metric<number>;
  laps_considered: number;
}

export interface DriverMultiComparisonPayload {
  type: 'driver_multi_comparison';
  season: number;
  metric: string;
  comparison_type: 'multi_driver' | 'head_to_head';
  entries: DriverMultiComparisonEntry[];
  total_drivers: number;
  ranked_drivers: number;
  coverage: Coverage;
}

export interface DriverVsDriverComprehensivePayload {
  type: 'driver_vs_driver_comprehensive';
  season: number;
  drivers: OrderedDriverPair;
  pace: {
    driver_a_avg_pace: Metric<number> | null;
    driver_b_avg_pace: Metric<number> | null;
    pace_delta: Metric<number> | null;
    shared_races: number;
  };
  head_to_head: {
    qualifying: { a_wins: number; b_wins: number; ties: number };
    race_finish: { a_wins: number; b_wins: number; ties: number };
  };
  stats: {
    driver_a: {
      wins: Metric<number>;
      podiums: Metric<number>;
      poles: Metric<number>;
      dnfs: Metric<number>;
      points: Metric<number>;
    };
    driver_b: {
      wins: Metric<number>;
      podiums: Metric<number>;
      poles: Metric<number>;
      dnfs: Metric<number>;
      points: Metric<number>;
    };
  };
  coverage: Coverage;
}

export interface DriverCareerWinsByCircuitPayload {
  type: 'driver_career_wins_by_circuit';
  driver: DriverRef;
  total_wins: number;
  circuits: Array<{
    track: TrackRef;
    wins: number;
    last_win_year: number;
  }>;
}

export interface TeammateComparisonCareerPayload {
  type: 'teammate_comparison_career';
  drivers: OrderedDriverPair;
  seasons: Array<{
    season: number;
    team: TeamRef;
    team_id: string;
    gap_seconds: number;
    gap_pct: number | null;
    shared_races: number;
    faster_primary_count: number;
  }>;
  aggregate: {
    total_shared_races: number;
    avg_gap_seconds: number;
    seasons_together: number;
    overall_winner: 'primary' | 'secondary' | 'draw';
  };
}

export interface QualifyingResultsEntry {
  position: number;
  driver: DriverRef;
  driver_id: string;
  driver_name: string;
  constructor_name: string;
  q1_time: string | null;
  q2_time: string | null;
  q3_time: string | null;
  qualifying_time: string | null;
}

export interface QualifyingResultsSummaryPayload {
  type: 'qualifying_results_summary';
  season: number;
  round: number | null;
  track: TrackRef;
  track_id: string;
  track_name: string | null;
  pole_sitter: string | null;
  pole_sitter_name: string | null;
  pole_time: string | null;
  front_row: QualifyingResultsEntry[];
  top10: QualifyingResultsEntry[];
  full_grid: QualifyingResultsEntry[];
}

export interface DriverPoleCountPayload {
  type: 'driver_pole_count';
  season: number;
  driver: DriverRef;
  driver_id: string;
  pole_count: number;
  races_entered: number;
}

export interface DriverQ3CountPayload {
  type: 'driver_q3_count';
  season: number;
  driver: DriverRef;
  driver_id: string;
  q3_count: number;
  qualifying_sessions: number;
}

export interface Q3RankingEntry {
  driver: DriverRef;
  driver_id: string;
  q3_count: number;
  qualifying_sessions: number;
}

export interface SeasonQ3RankingsPayload {
  type: 'season_q3_rankings';
  season: number;
  entries: Q3RankingEntry[];
}

export interface QualifyingGapPayload {
  type: 'qualifying_gap_teammates' | 'qualifying_gap_drivers';
  season: number;
  drivers: OrderedDriverPair;
  driver_a_id: string;
  driver_b_id: string;
  primary_ahead: number;
  secondary_ahead: number;
  avg_gap_percent: number | null;
  shared_sessions: number;
  coverage: Coverage;
}

/**
 * Error response from backend
 */
export interface APIError {
  request_id: string;
  error_type: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

/**
 * Query state for the UI
 */
export type QueryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: NLQueryResponse }
  | { status: 'error'; error: APIError };

/**
 * Execute a natural language query against the backend
 */
export async function executeQuery(question: string): Promise<NLQueryResponse> {
  const response = await fetch(`${API_BASE_URL}/nl-query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question }),
  });

  const data = await response.json();

  if (!response.ok || data.error_type) {
    const error: APIError = {
      request_id: data.request_id || 'unknown',
      error_type: data.error_type || 'request_failed',
      message: data.message || data.reason || 'Request failed',
      suggestion: data.suggestion,
      details: data.details,
    };
    throw error;
  }

  return data as NLQueryResponse;
}

/**
 * Check if a response has valid result data
 */
export function hasValidResult(response: NLQueryResponse): boolean {
  return !!(response.result?.result?.payload);
}

/**
 * Get the payload from a response
 */
export function getPayload(response: NLQueryResponse): ResultPayload | null {
  return response.result?.result?.payload || null;
}

/**
 * Get display name for a driver (from DriverRef or fallback)
 */
export function getDriverName(driver: DriverRef | string | undefined): string {
  if (!driver) return 'Unknown';
  if (typeof driver === 'string') {
    // Humanize raw ID as fallback
    return driver
      .replace(/_/g, ' ')
      .split(' ')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return driver.name || getDriverName(driver.id);
}

/**
 * Format a metric value with appropriate units
 */
export function formatMetricValue(metric: Metric | number | null | undefined, fallbackUnits?: string): string {
  if (metric === null || metric === undefined) return 'N/A';

  if (typeof metric === 'number') {
    // Plain number - try to format based on fallback units
    if (fallbackUnits === 'percent') {
      return `${metric >= 0 ? '+' : ''}${metric.toFixed(2)}%`;
    }
    if (fallbackUnits === 'seconds') {
      return `${metric >= 0 ? '+' : ''}${metric.toFixed(3)}s`;
    }
    return metric.toFixed(2);
  }

  const value = metric.value;
  if (value === null || value === undefined) return 'N/A';

  switch (metric.units) {
    case 'percent':
      return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
    case 'seconds':
      return `${value >= 0 ? '+' : ''}${value.toFixed(3)}s`;
    case 'lap_time': {
      // Format as MM:SS.mmm (e.g., 93.837 → 1:33.837)
      const minutes = Math.floor(value / 60);
      const seconds = value % 60;
      return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`;
    }
    case 'count':
      return String(Math.round(value));
    case 'positions':
      return String(Math.round(value));
    case 'percentile':
      return `${value.toFixed(0)}th`;
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

/**
 * Get metric label for display
 */
export function getMetricLabel(metric: Metric | undefined): string {
  return metric?.label || metric?.key || 'Value';
}

/**
 * Get display name for a track (from TrackRef or fallback)
 */
export function getTrackName(track: TrackRef | string | undefined): string {
  if (!track) return 'Unknown';
  if (typeof track === 'string') {
    // Humanize raw ID as fallback
    return track
      .replace(/_/g, ' ')
      .split(' ')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return track.name || getTrackName(track.id);
}
