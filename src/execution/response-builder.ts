/**
 * RESPONSE BUILDER
 *
 * Builds canonical API responses for all analytical endpoints.
 * Integrates:
 * - Metric registry for methodology
 * - Confidence calculation
 * - Error handling
 * - Debug traces
 */

import {
  AnalyticalResponse,
  Confidence,
  Methodology,
  StructuredError,
  DebugTrace,
  ErrorCode,
  CoverageStatus,
  buildConfidence,
  buildError
} from '../types/api-response';
import { getMethodology, determineCoverageStatus } from '../observability/registry';

// ============================================================================
// RESPONSE BUILDER CLASS
// ============================================================================

/**
 * Builder for canonical API responses
 */
export class ResponseBuilder<T> {
  private kind: string;
  private input: Record<string, unknown> = {};
  private result: T | null = null;
  private confidence: Confidence | null = null;
  private methodology: Methodology | null = null;
  private warnings: string[] = [];
  private debug: DebugTrace | undefined;
  private error: StructuredError | undefined;

  /**
   * Create a new response builder
   *
   * @param kind - Query kind identifier
   */
  constructor(kind: string) {
    this.kind = kind;
  }

  /**
   * Set the input parameters
   */
  setInput(input: Record<string, unknown>): this {
    this.input = input;
    return this;
  }

  /**
   * Set the result payload
   */
  setResult(result: T): this {
    this.result = result;
    return this;
  }

  /**
   * Set confidence from coverage data
   */
  setConfidenceFromCoverage(
    coverageStatus: CoverageStatus,
    sampleSize: number,
    reason?: string
  ): this {
    this.confidence = buildConfidence(coverageStatus, sampleSize, reason);
    return this;
  }

  /**
   * Set confidence directly
   */
  setConfidence(confidence: Confidence): this {
    this.confidence = confidence;
    return this;
  }

  /**
   * Set methodology from metric registry
   */
  setMethodologyFromMetric(metricId: string): this {
    const methodology = getMethodology(metricId);
    if (methodology) {
      this.methodology = methodology;
    }
    return this;
  }

  /**
   * Set methodology directly
   */
  setMethodology(methodology: Methodology): this {
    this.methodology = methodology;
    return this;
  }

  /**
   * Add a warning
   */
  addWarning(warning: string): this {
    this.warnings.push(warning);
    return this;
  }

  /**
   * Add multiple warnings
   */
  addWarnings(warnings: string[]): this {
    this.warnings.push(...warnings);
    return this;
  }

  /**
   * Set debug trace
   */
  setDebug(debug: DebugTrace | undefined): this {
    this.debug = debug;
    return this;
  }

  /**
   * Set error
   */
  setError(code: ErrorCode, message: string, suggestions: string[] = []): this {
    this.error = buildError(code, message, suggestions);
    // When there's an error, result should be null
    this.result = null;
    // Set confidence to none
    this.confidence = {
      level: 'none',
      coverage_status: 'insufficient',
      sample_size: 0,
      reason: message
    };
    return this;
  }

  /**
   * Set error directly
   */
  setStructuredError(error: StructuredError): this {
    this.error = error;
    this.result = null;
    return this;
  }

  /**
   * Build the final response
   */
  build(): AnalyticalResponse<T> {
    // Ensure methodology is set
    if (!this.methodology) {
      // Try to get from metric registry using kind
      const methodology = getMethodology(this.kind);
      if (methodology) {
        this.methodology = methodology;
      } else {
        // Fallback methodology
        this.methodology = {
          metric_type: this.kind,
          data_source: ['unknown'],
          aggregation: 'unknown',
          normalization: 'unknown',
          formula: 'unknown',
          scope: 'unknown',
          exclusions: []
        };
      }
    }

    // Ensure confidence is set
    if (!this.confidence) {
      this.confidence = {
        level: 'none',
        coverage_status: 'insufficient',
        sample_size: 0,
        reason: 'Confidence not computed'
      };
    }

    return {
      kind: this.kind,
      input: this.input,
      result: this.result,
      confidence: this.confidence,
      methodology: this.methodology,
      warnings: this.warnings,
      debug: this.debug,
      error: this.error
    };
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a success response for teammate gap query
 */
export function buildTeammateGapResponse<T>(
  kind: string,
  input: Record<string, unknown>,
  result: T,
  sharedRaces: number,
  metricId: string,
  warnings: string[] = [],
  debug?: DebugTrace
): AnalyticalResponse<T> {
  const coverageStatus = determineCoverageStatus(metricId, sharedRaces);

  return new ResponseBuilder<T>(kind)
    .setInput(input)
    .setResult(result)
    .setConfidenceFromCoverage(coverageStatus, sharedRaces)
    .setMethodologyFromMetric(metricId)
    .addWarnings(warnings)
    .setDebug(debug)
    .build();
}

/**
 * Create an error response
 */
export function buildErrorResponse<T>(
  kind: string,
  input: Record<string, unknown>,
  code: ErrorCode,
  message: string,
  suggestions: string[] = [],
  metricId?: string,
  debug?: DebugTrace
): AnalyticalResponse<T> {
  const builder = new ResponseBuilder<T>(kind)
    .setInput(input)
    .setError(code, message, suggestions)
    .setDebug(debug);

  if (metricId) {
    builder.setMethodologyFromMetric(metricId);
  }

  return builder.build();
}

/**
 * Create a partial result response (some metrics available, some not)
 */
export function buildPartialResponse<T>(
  kind: string,
  input: Record<string, unknown>,
  result: T,
  availableMetrics: { metricId: string; sharedRaces: number }[],
  missingMetrics: { metricId: string; reason: string }[],
  debug?: DebugTrace
): AnalyticalResponse<T> {
  // Calculate combined confidence from available metrics
  let minCoverageStatus: CoverageStatus = 'valid';
  let totalSampleSize = 0;

  for (const metric of availableMetrics) {
    const status = determineCoverageStatus(metric.metricId, metric.sharedRaces);
    totalSampleSize += metric.sharedRaces;

    if (status === 'insufficient') {
      minCoverageStatus = 'insufficient';
    } else if (status === 'low_coverage' && minCoverageStatus !== 'insufficient') {
      minCoverageStatus = 'low_coverage';
    }
  }

  // Build warnings for missing metrics
  const warnings = missingMetrics.map(
    m => `${m.metricId}: ${m.reason}`
  );

  // Add partial result warning
  if (missingMetrics.length > 0) {
    warnings.unshift('Partial result: some metrics unavailable');
  }

  // Use primary metric for methodology (first available)
  const primaryMetricId = availableMetrics[0]?.metricId || kind;

  return new ResponseBuilder<T>(kind)
    .setInput(input)
    .setResult(result)
    .setConfidenceFromCoverage(
      minCoverageStatus,
      Math.round(totalSampleSize / Math.max(availableMetrics.length, 1)),
      `Based on ${availableMetrics.length} of ${availableMetrics.length + missingMetrics.length} metrics`
    )
    .setMethodologyFromMetric(primaryMetricId)
    .addWarnings(warnings)
    .setDebug(debug)
    .build();
}

// ============================================================================
// ERROR CODE MAPPING
// ============================================================================

/**
 * Map error reasons to error codes
 */
export function mapReasonToErrorCode(reason: string): ErrorCode {
  const reasonLower = reason.toLowerCase();

  if (reasonLower.includes('insufficient') || reasonLower.includes('coverage')) {
    return 'INSUFFICIENT_COVERAGE';
  }
  if (reasonLower.includes('not teammates') || reasonLower.includes('different team')) {
    return 'NOT_TEAMMATES';
  }
  if (reasonLower.includes('no data') || reasonLower.includes('no rows')) {
    return 'NO_DATA';
  }
  if (reasonLower.includes('invalid season') || reasonLower.includes('season')) {
    return 'INVALID_SEASON';
  }
  if (reasonLower.includes('unknown driver') || reasonLower.includes('driver not found')) {
    return 'UNKNOWN_DRIVER';
  }
  if (reasonLower.includes('unknown team') || reasonLower.includes('team not found')) {
    return 'UNKNOWN_TEAM';
  }
  if (reasonLower.includes('metric not available') || reasonLower.includes('unsupported metric')) {
    return 'METRIC_NOT_AVAILABLE';
  }

  return 'INTERNAL_ERROR';
}

/**
 * Generate suggestions based on error code
 */
export function getSuggestionsForError(code: ErrorCode): string[] {
  switch (code) {
    case 'INSUFFICIENT_COVERAGE':
      return [
        'Try a different season with more races',
        'Check if both drivers were active for the full season',
        'Use a different pair of teammates'
      ];
    case 'NOT_TEAMMATES':
      return [
        'Verify both drivers were on the same team in the specified season',
        'Use cross-team comparison for drivers on different teams'
      ];
    case 'NO_DATA':
      return [
        'Verify the season has completed races',
        'Check if the ingestion pipeline has run for this season'
      ];
    case 'INVALID_SEASON':
      return [
        'Use a season between 1950 and current year',
        'Check for typos in the year'
      ];
    case 'UNKNOWN_DRIVER':
      return [
        'Check driver name spelling',
        'Use driver ID format (e.g., "max_verstappen")',
        'Verify driver was active in F1'
      ];
    case 'UNKNOWN_TEAM':
      return [
        'Check team name spelling',
        'Use team ID format (e.g., "mclaren", "red-bull")',
        'Verify team was active in specified season'
      ];
    case 'METRIC_NOT_AVAILABLE':
      return [
        'Check available metrics in /capabilities endpoint',
        'Use a supported metric type'
      ];
    case 'PARTIAL_DATA':
      return [
        'Some metrics may be available - check warnings',
        'Run additional ingestion for missing metrics'
      ];
    default:
      return [
        'Try again later',
        'Contact support if issue persists'
      ];
  }
}
