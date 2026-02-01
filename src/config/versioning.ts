/**
 * Versioning constants for cache invalidation
 *
 * When these versions change, cached entries become invalid automatically.
 * Increment METHODOLOGY_VERSION when calculation logic changes.
 * Increment SCHEMA_VERSION when response schema changes.
 */

/**
 * Methodology version - increment when calculation logic changes
 *
 * Examples of changes requiring increment:
 * - Pace calculation formula changes
 * - Gap band thresholds change
 * - Coverage classification changes
 * - Filtering logic changes
 */
export const METHODOLOGY_VERSION = '1.0.0';

/**
 * Schema version - increment when response schema changes
 *
 * Examples of changes requiring increment:
 * - New fields added to response
 * - Field types change
 * - Field names change
 * - Nested structure changes
 */
export const SCHEMA_VERSION = '1.0.0';

/**
 * Cache TTL configuration
 *
 * PHASE 3 UPDATE: Low coverage results now cached for 1 hour (improved cache hit rate)
 */
export const CACHE_TTL = {
  /** TTL for valid (high confidence) results - 30 days */
  VALID_DAYS: 30,
  /** TTL for low coverage results - 1 hour (PHASE 3 optimization) */
  LOW_COVERAGE_HOURS: 1,
  /** Insufficient coverage results are NOT cached */
  INSUFFICIENT_DAYS: 0
} as const;

/**
 * Get TTL in milliseconds for a given confidence level
 *
 * PHASE 3 UPDATE: Low coverage results cached for 1 hour (previously 3 days)
 */
export function getCacheTTLMs(confidenceLevel: 'valid' | 'low_coverage' | 'insufficient'): number | null {
  switch (confidenceLevel) {
    case 'valid':
      return CACHE_TTL.VALID_DAYS * 24 * 60 * 60 * 1000;
    case 'low_coverage':
      return CACHE_TTL.LOW_COVERAGE_HOURS * 60 * 60 * 1000; // PHASE 3: 1 hour
    case 'insufficient':
      return null; // Do not cache
    default:
      return null;
  }
}

/**
 * Get expiration date for a given confidence level
 */
export function getCacheExpirationDate(confidenceLevel: 'valid' | 'low_coverage' | 'insufficient'): Date | null {
  const ttlMs = getCacheTTLMs(confidenceLevel);
  if (ttlMs === null) {
    return null;
  }
  return new Date(Date.now() + ttlMs);
}
