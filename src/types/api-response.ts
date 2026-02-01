/**
 * CANONICAL API RESPONSE SCHEMA
 *
 * All analytical endpoints MUST return responses conforming to this schema.
 * This ensures consistent UX across the entire API surface.
 *
 * Design principles:
 * - Deterministic structure
 * - Explicit confidence metadata
 * - Transparent methodology
 * - Structured errors
 * - Optional debug traces
 */

// ============================================================================
// CONFIDENCE MODEL
// ============================================================================

/**
 * Confidence levels for analytical results
 *
 * - high: ≥8 shared races, full statistical validity
 * - medium: 4-7 shared races, directional results only
 * - low: <4 shared races but some data exists
 * - none: No usable data available
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

/**
 * Coverage status from ingestion
 */
export type CoverageStatus = 'valid' | 'low_coverage' | 'insufficient';

/**
 * Formal confidence object - included in every analytical response
 *
 * TIER 1 ENHANCEMENT: Extended with reasons array and additional metadata.
 */
export interface Confidence {
  /** Overall confidence level */
  level: ConfidenceLevel;

  /** Coverage status from ingestion pipeline */
  coverage_status: CoverageStatus;

  /** Number of shared races/sessions analyzed */
  sample_size: number;

  /** Human-readable explanation of confidence assessment */
  reason: string;

  /** Array of detailed reasons explaining the confidence assessment */
  reasons?: string[];

  /** Coverage percentage (0-100) when applicable */
  coverage_percent?: number;

  /** Number of shared events (races/sessions) analyzed */
  shared_events?: number;

  /** Whether a fallback season was used */
  fallback_season_used?: number;
}

// ============================================================================
// METHODOLOGY METADATA
// ============================================================================

/**
 * Methodology metadata - describes how the result was computed
 *
 * Included in every analytical response for full transparency.
 * This allows clients to understand exactly how results were derived.
 */
export interface Methodology {
  /** Type of metric being computed */
  metric_type: string;

  /** Source table(s) used */
  data_source: string[];

  /** Aggregation method (e.g., 'median', 'mean', 'sum') */
  aggregation: string;

  /** Normalization strategy applied */
  normalization: string;

  /** Mathematical formula used */
  formula: string;

  /** Scope of analysis (e.g., 'season', 'race', 'career') */
  scope: string;

  /** Data exclusions applied */
  exclusions: string[];

  /** Filters applied during query execution */
  filters_applied?: string[];

  /** Assumptions made in the analysis */
  assumptions?: string[];

  /** Known limitations of this analysis */
  limitations?: string[];
}

// ============================================================================
// STRUCTURED ERROR MODEL
// ============================================================================

/**
 * Standard error codes for analytical failures
 *
 * FAIL-CLOSED: All errors result in rejection, never silent degradation.
 */
export type ErrorCode =
  | 'INSUFFICIENT_COVERAGE'    // Not enough shared races/sessions
  | 'INSUFFICIENT_DATA'        // Alias for clarity - not enough data points
  | 'NOT_TEAMMATES'            // Drivers are not on the same team
  | 'NO_DATA'                  // No data exists for this query
  | 'INVALID_SEASON'           // Season out of valid range
  | 'UNKNOWN_DRIVER'           // Driver ID could not be resolved
  | 'UNKNOWN_TRACK'            // Track ID could not be resolved
  | 'UNKNOWN_TEAM'             // Team ID could not be resolved
  | 'METRIC_NOT_AVAILABLE'     // Requested metric doesn't exist
  | 'PARTIAL_DATA'             // Some but not all metrics available
  | 'VALIDATION_FAILED'        // Request validation failed
  | 'INTERNAL_ERROR';          // Unexpected system error

/**
 * Structured error object
 */
export interface StructuredError {
  /** Machine-readable error code */
  code: ErrorCode;

  /** Human-readable error message */
  message: string;

  /** Whether the client can recover by modifying the request */
  recoverable: boolean;

  /** Actionable suggestions for the client */
  suggestions: string[];
}

// ============================================================================
// DEBUG TRACE
// ============================================================================

/**
 * Debug trace - included when ?debug=true or X-Debug: true header is set
 *
 * TIER 1 ENHANCEMENT: Extended with SQL parameters and coverage evaluation.
 */
export interface DebugTrace {
  /** The parsed query intent */
  parsed_intent: Record<string, unknown>;

  /** Routing decisions made during execution */
  routing_path: string[];

  /** SQL template ID used (if any) */
  sql_template: string | null;

  /** Total execution time in milliseconds */
  execution_time_ms: number;

  /** Raw SQL query executed (sanitized of values) */
  sql_query_pattern?: string;

  /** SQL parameters (sanitized - no actual values, just types) */
  sql_parameters?: string[];

  /** Number of rows returned from database */
  rows_returned?: number;

  /** Coverage evaluation result */
  coverage_evaluation?: string;

  /** Identity resolution trace */
  identity_resolution?: {
    driver_a?: { input: string; resolved: string };
    driver_b?: { input: string; resolved: string };
    track?: { input: string; resolved: string };
  };

  /** Fallback information if applicable */
  fallback_info?: {
    original_season?: number;
    fallback_season?: number;
    reason?: string;
  };

  /** Cache information */
  cache?: {
    hit: boolean;
    cache_key: string;
    created_at?: string | null;
    expires_at?: string | null;
    hit_count?: number | null;
  };

  // === PERFORMANCE TRACING (PART 3) ===

  /** Time spent executing SQL query (milliseconds) */
  sql_execution_ms?: number;

  /** Time spent looking up cache (milliseconds) */
  cache_lookup_ms?: number;

  /** Data source: "cache" or "database" */
  source?: 'cache' | 'database';

  /** Optional EXPLAIN query plan (only with ?explain=true) */
  query_plan?: string;
}

// ============================================================================
// CANONICAL RESPONSE
// ============================================================================

/**
 * Canonical API response for all analytical endpoints
 *
 * Every analytical endpoint MUST return this structure.
 *
 * @template T - The type of the result payload
 */
export interface AnalyticalResponse<T> {
  /** Query kind that was executed */
  kind: string;

  /** Normalized input parameters */
  input: Record<string, unknown>;

  /** Result payload (null if error) */
  result: T | null;

  /** Confidence assessment */
  confidence: Confidence;

  /** Methodology documentation */
  methodology: Methodology;

  /** Non-fatal warnings */
  warnings: string[];

  /** Debug trace (only when ?debug=true) */
  debug?: DebugTrace;

  /** Error details (only on failure) */
  error?: StructuredError;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Map coverage status to confidence level
 */
export function coverageToConfidence(status: CoverageStatus): ConfidenceLevel {
  switch (status) {
    case 'valid':
      return 'high';
    case 'low_coverage':
      return 'medium';
    case 'insufficient':
      return 'none';
    default:
      return 'none';
  }
}

/**
 * Build a confidence object from coverage data
 */
export function buildConfidence(
  coverageStatus: CoverageStatus,
  sampleSize: number,
  reason?: string
): Confidence {
  const level = coverageToConfidence(coverageStatus);

  const defaultReasons: Record<CoverageStatus, string> = {
    valid: `High confidence: ${sampleSize} shared races analyzed`,
    low_coverage: `Medium confidence: ${sampleSize} shared races (directional only)`,
    insufficient: `Insufficient data: only ${sampleSize} shared races available`
  };

  return {
    level,
    coverage_status: coverageStatus,
    sample_size: sampleSize,
    reason: reason || defaultReasons[coverageStatus]
  };
}

/**
 * Build a structured error
 */
export function buildError(
  code: ErrorCode,
  message: string,
  suggestions: string[] = []
): StructuredError {
  const recoverableCodes: ErrorCode[] = [
    'INVALID_SEASON',
    'UNKNOWN_DRIVER',
    'UNKNOWN_TEAM',
    'METRIC_NOT_AVAILABLE'
  ];

  return {
    code,
    message,
    recoverable: recoverableCodes.includes(code),
    suggestions
  };
}

/**
 * Create an error response
 */
export function errorResponse<T>(
  kind: string,
  input: Record<string, unknown>,
  error: StructuredError,
  methodology: Methodology,
  debug?: DebugTrace
): AnalyticalResponse<T> {
  return {
    kind,
    input,
    result: null,
    confidence: {
      level: 'none',
      coverage_status: 'insufficient',
      sample_size: 0,
      reason: error.message
    },
    methodology,
    warnings: [],
    error,
    debug
  };
}

/**
 * Create a success response
 */
export function successResponse<T>(
  kind: string,
  input: Record<string, unknown>,
  result: T,
  confidence: Confidence,
  methodology: Methodology,
  warnings: string[] = [],
  debug?: DebugTrace
): AnalyticalResponse<T> {
  return {
    kind,
    input,
    result,
    confidence,
    methodology,
    warnings,
    debug
  };
}
