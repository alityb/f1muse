/**
 * Production Invariant Enforcement
 *
 * This module provides centralized invariant checking for production-critical data integrity.
 *
 * Behavior:
 * - Development: Always throw on invariant violations
 * - Production with STRICT_INVARIANTS=true: Throw on invariant violations
 * - Production with STRICT_INVARIANTS=false: Log errors loudly (do NOT swallow)
 *
 * ENFORCED INVARIANTS:
 * 1. NORMALIZATION_MATCH: Normalized output must have matching normalization type
 * 2. KNOWN_NORMALIZATION: Only recognized normalization types allowed
 * 3. VALID_COVERAGE: Coverage status must be present and valid for comparison queries
 */

const KNOWN_NORMALIZATIONS = new Set([
  'session_median_percent',
  'team_baseline',
  'none',
  'raw',
]);

const VALID_COVERAGE_STATUSES = new Set([
  'valid',
  'low_coverage',
  'insufficient',
]);

export type InvariantViolation =
  | 'NORMALIZATION_MISMATCH'
  | 'UNKNOWN_NORMALIZATION'
  | 'INVALID_COVERAGE';

interface InvariantContext {
  location: string;
  expected?: string;
  actual?: string;
  details?: Record<string, unknown>;
}

/**
 * Check if strict invariant enforcement is enabled
 */
export function isStrictMode(): boolean {
  // Always strict in development
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  // In production, check STRICT_INVARIANTS flag
  return process.env.STRICT_INVARIANTS === 'true';
}

/**
 * Handle an invariant violation
 * - In strict mode: throws Error
 * - In non-strict mode: logs error loudly and returns false
 */
export function handleInvariantViolation(
  violation: InvariantViolation,
  message: string,
  context: InvariantContext
): never | boolean {
  const fullMessage = `[INVARIANT VIOLATION: ${violation}] ${message}`;
  const contextStr = JSON.stringify(context);

  if (isStrictMode()) {
    throw new Error(`${fullMessage}\nContext: ${contextStr}`);
  }

  // Log loudly in production (do NOT swallow)
  console.error('========================================');
  console.error(fullMessage);
  console.error('Context:', contextStr);
  console.error('========================================');
  console.error('Set STRICT_INVARIANTS=true to throw on this error');

  return false;
}

/**
 * Assert that normalized output has matching normalization type
 */
export function assertNormalizationMatch(
  isNormalizedOutput: boolean,
  intentNormalization: string | undefined,
  location: string
): void {
  if (isNormalizedOutput && intentNormalization && intentNormalization !== 'session_median_percent') {
    handleInvariantViolation(
      'NORMALIZATION_MISMATCH',
      `Got normalized output but intent.normalization='${intentNormalization}' (expected 'session_median_percent')`,
      {
        location,
        expected: 'session_median_percent',
        actual: intentNormalization,
      }
    );
  }
}

/**
 * Assert that normalization type is known
 */
export function assertKnownNormalization(
  normalization: string | null | undefined,
  location: string
): void {
  if (normalization && !KNOWN_NORMALIZATIONS.has(normalization)) {
    const knownTypes = Array.from(KNOWN_NORMALIZATIONS).join(', ');
    handleInvariantViolation(
      'UNKNOWN_NORMALIZATION',
      `Unknown normalization type: '${normalization}'`,
      {
        location,
        expected: `one of: ${knownTypes}`,
        actual: normalization,
      }
    );
  }
}

/**
 * Assert that coverage status is valid for comparison queries
 */
export function assertValidCoverage(
  coverageStatus: string | null | undefined,
  queryKind: string,
  location: string
): void {
  // Coverage is required for comparison queries
  const requiresCoverage = [
    'season_driver_vs_driver',
    'teammate_gap_summary_season',
    'teammate_gap_dual_comparison',
    'cross_team_track_scoped_driver_comparison',
  ].includes(queryKind);

  if (requiresCoverage) {
    const validStatuses = Array.from(VALID_COVERAGE_STATUSES).join(', ');
    if (!coverageStatus) {
      handleInvariantViolation(
        'INVALID_COVERAGE',
        `Missing coverage_status for ${queryKind}`,
        {
          location,
          expected: `one of: ${validStatuses}`,
          actual: 'undefined',
          details: { queryKind },
        }
      );
    } else if (!VALID_COVERAGE_STATUSES.has(coverageStatus)) {
      handleInvariantViolation(
        'INVALID_COVERAGE',
        `Invalid coverage_status: '${coverageStatus}'`,
        {
          location,
          expected: `one of: ${validStatuses}`,
          actual: coverageStatus,
          details: { queryKind },
        }
      );
    }
  }
}

/**
 * Log current invariant enforcement mode on startup
 */
export function logInvariantMode(): void {
  const mode = isStrictMode() ? 'STRICT (will throw)' : 'LENIENT (will log)';
  console.log(`[Invariants] Mode: ${mode}`);
  if (!isStrictMode()) {
    console.log('[Invariants] Set STRICT_INVARIANTS=true to enable strict mode in production');
  }
}
