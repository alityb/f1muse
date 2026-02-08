import { Pool } from 'pg';
import * as crypto from 'crypto';
import { QueryIntent } from '../types/query-intent';
import { QueryResult } from '../types/results';
import {
  METHODOLOGY_VERSION,
  SCHEMA_VERSION,
  getCacheExpirationDate
} from '../config/versioning';

/**
 * Cache entry stored in the database
 */
export interface CacheEntry {
  cache_key: string;
  query_kind: string;
  query_hash: string;
  parameters: Record<string, unknown>;
  response: QueryResult;
  confidence_level: 'valid' | 'low_coverage' | 'insufficient';
  coverage_percent: number | null;
  shared_events: number | null;
  methodology_version: string;
  schema_version: string;
  created_at: Date;
  expires_at: Date | null;
  hit_count: number;
  last_hit_at: Date | null;
}

/**
 * Cache lookup result
 */
export interface CacheLookupResult {
  hit: boolean;
  entry: CacheEntry | null;
}

/**
 * Debug information for cache operations
 */
export interface CacheDebugInfo {
  hit: boolean;
  cache_key: string;
  created_at: Date | null;
  expires_at: Date | null;
  hit_count: number | null;
}

/**
 * Parameters for computing cache key
 */
interface CacheKeyParams {
  kind: string;
  parameters: Record<string, unknown>;
}

/**
 * CacheService - Manages query result caching in PostgreSQL
 *
 * Features:
 * - Deterministic cache keys based on query kind and parameters
 * - TTL based on confidence level
 * - Automatic version invalidation
 * - Hit tracking for analytics
 */
export class CacheService {
  private writePool: Pool;

  constructor(pool: Pool) {
    // Cache service needs write access
    // The pool passed should allow writes for cache operations
    this.writePool = pool;
  }

  /**
   * Compute cache key from query parameters
   *
   * Key is SHA256 hash of:
   * - kind
   * - normalized parameters
   * - methodology_version
   * - schema_version
   */
  computeCacheKey(params: CacheKeyParams): string {
    const payload = {
      kind: params.kind,
      parameters: this.normalizeParameters(params.parameters),
      methodology_version: METHODOLOGY_VERSION,
      schema_version: SCHEMA_VERSION
    };

    const json = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Compute hash of just the parameters (for debugging)
   */
  computeQueryHash(parameters: Record<string, unknown>): string {
    const normalized = this.normalizeParameters(parameters);
    const json = JSON.stringify(normalized);
    return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  }

  /**
   * Normalize parameters for consistent hashing
   *
   * Removes undefined values and sorts keys
   */
  private normalizeParameters(params: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    const keys = Object.keys(params).sort();

    for (const key of keys) {
      const value = params[key];
      // Skip undefined, null, and internal fields
      if (value === undefined || value === null) {
        continue;
      }
      if (key.startsWith('_')) {
        continue;
      }
      if (key === 'raw_query') {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        normalized[key] = this.normalizeParameters(value as Record<string, unknown>);
      } else {
        normalized[key] = value;
      }
    }

    return normalized;
  }

  /**
   * Extract cacheable parameters from QueryIntent
   */
  extractCacheParameters(intent: QueryIntent): Record<string, unknown> {
    // Create a shallow copy and remove non-cacheable fields
    const params: Record<string, unknown> = { ...intent };

    // Remove fields that should not affect cache key
    delete params.raw_query;

    return params;
  }

  /**
   * Look up a cache entry by key
   *
   * Returns null if:
   * - Entry doesn't exist
   * - Entry has expired
   * - Version mismatch
   */
  async get(cacheKey: string): Promise<CacheLookupResult> {
    try {
      const result = await this.writePool.query<CacheEntry>(
        `SELECT *
         FROM api_query_cache
         WHERE cache_key = $1
           AND methodology_version = $2
           AND schema_version = $3
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [cacheKey, METHODOLOGY_VERSION, SCHEMA_VERSION]
      );

      if (result.rows.length === 0) {
        return { hit: false, entry: null };
      }

      return { hit: true, entry: result.rows[0] };
    } catch (err) {
      console.error('[CacheService] Error looking up cache entry:', err);
      return { hit: false, entry: null };
    }
  }

  /**
   * Store a cache entry
   *
   * Does NOT cache if confidence_level is 'insufficient'
   */
  async set(entry: Omit<CacheEntry, 'created_at' | 'hit_count' | 'last_hit_at'>): Promise<boolean> {
    // Do not cache insufficient confidence results
    if (entry.confidence_level === 'insufficient') {
      return false;
    }

    try {
      await this.writePool.query(
        `INSERT INTO api_query_cache (
          cache_key,
          query_kind,
          query_hash,
          parameters,
          response,
          confidence_level,
          coverage_percent,
          shared_events,
          methodology_version,
          schema_version,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (cache_key) DO UPDATE SET
          response = EXCLUDED.response,
          confidence_level = EXCLUDED.confidence_level,
          coverage_percent = EXCLUDED.coverage_percent,
          shared_events = EXCLUDED.shared_events,
          expires_at = EXCLUDED.expires_at,
          created_at = NOW()`,
        [
          entry.cache_key,
          entry.query_kind,
          entry.query_hash,
          JSON.stringify(entry.parameters),
          JSON.stringify(entry.response),
          entry.confidence_level,
          entry.coverage_percent,
          entry.shared_events,
          entry.methodology_version,
          entry.schema_version,
          entry.expires_at
        ]
      );
      return true;
    } catch (err) {
      console.error('[CacheService] Error storing cache entry:', err);
      return false;
    }
  }

  /**
   * Increment hit count for a cache entry
   */
  async incrementHit(cacheKey: string): Promise<void> {
    try {
      await this.writePool.query(
        `UPDATE api_query_cache
         SET hit_count = hit_count + 1,
             last_hit_at = NOW()
         WHERE cache_key = $1`,
        [cacheKey]
      );
    } catch (err) {
      console.error('[CacheService] Error incrementing hit count:', err);
    }
  }

  /**
   * Invalidate all cache entries for a specific query kind
   */
  async invalidateByKind(kind: string): Promise<number> {
    try {
      const result = await this.writePool.query(
        `DELETE FROM api_query_cache WHERE query_kind = $1`,
        [kind]
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error('[CacheService] Error invalidating by kind:', err);
      return 0;
    }
  }

  /**
   * Purge all expired cache entries
   */
  async purgeExpired(): Promise<number> {
    try {
      const result = await this.writePool.query(
        `DELETE FROM api_query_cache
         WHERE expires_at IS NOT NULL AND expires_at < NOW()`
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error('[CacheService] Error purging expired entries:', err);
      return 0;
    }
  }

  /**
   * Invalidate all entries with mismatched versions
   */
  async invalidateStaleVersions(): Promise<number> {
    try {
      const result = await this.writePool.query(
        `DELETE FROM api_query_cache
         WHERE methodology_version != $1 OR schema_version != $2`,
        [METHODOLOGY_VERSION, SCHEMA_VERSION]
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error('[CacheService] Error invalidating stale versions:', err);
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    total_entries: number;
    valid_entries: number;
    low_coverage_entries: number;
    expired_entries: number;
    total_hits: number;
  }> {
    try {
      const result = await this.writePool.query(`
        SELECT
          COUNT(*) as total_entries,
          COUNT(*) FILTER (WHERE confidence_level = 'valid') as valid_entries,
          COUNT(*) FILTER (WHERE confidence_level = 'low_coverage') as low_coverage_entries,
          COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < NOW()) as expired_entries,
          COALESCE(SUM(hit_count), 0) as total_hits
        FROM api_query_cache
        WHERE methodology_version = $1 AND schema_version = $2
      `, [METHODOLOGY_VERSION, SCHEMA_VERSION]);

      const row = result.rows[0];
      return {
        total_entries: parseInt(row.total_entries || '0'),
        valid_entries: parseInt(row.valid_entries || '0'),
        low_coverage_entries: parseInt(row.low_coverage_entries || '0'),
        expired_entries: parseInt(row.expired_entries || '0'),
        total_hits: parseInt(row.total_hits || '0')
      };
    } catch (err) {
      console.error('[CacheService] Error getting stats:', err);
      return {
        total_entries: 0,
        valid_entries: 0,
        low_coverage_entries: 0,
        expired_entries: 0,
        total_hits: 0
      };
    }
  }

  /**
   * Build debug info from cache lookup
   */
  buildDebugInfo(cacheKey: string, lookupResult: CacheLookupResult): CacheDebugInfo {
    return {
      hit: lookupResult.hit,
      cache_key: cacheKey,
      created_at: lookupResult.entry?.created_at || null,
      expires_at: lookupResult.entry?.expires_at || null,
      hit_count: lookupResult.entry?.hit_count || null
    };
  }
}

/**
 * Map confidence level from coverage status
 */
export function mapCoverageToConfidenceLevel(
  coverageStatus: 'valid' | 'low_coverage' | 'insufficient' | string
): 'valid' | 'low_coverage' | 'insufficient' {
  if (coverageStatus === 'valid') {
    return 'valid';
  }
  if (coverageStatus === 'low_coverage') {
    return 'low_coverage';
  }
  return 'insufficient';
}

/**
 * Create a cache entry from query result
 */
export function createCacheEntry(
  cacheService: CacheService,
  intent: QueryIntent,
  result: QueryResult,
  sharedEvents?: number,
  coveragePercent?: number
): Omit<CacheEntry, 'created_at' | 'hit_count' | 'last_hit_at'> {
  const parameters = cacheService.extractCacheParameters(intent);
  const cacheKey = cacheService.computeCacheKey({
    kind: intent.kind,
    parameters
  });
  const queryHash = cacheService.computeQueryHash(parameters);

  // Extract confidence level from result
  const confidenceLevel = mapCoverageToConfidenceLevel(
    result.interpretation?.confidence?.coverage_level || 'insufficient'
  );

  const expiresAt = getCacheExpirationDate(confidenceLevel);

  return {
    cache_key: cacheKey,
    query_kind: intent.kind,
    query_hash: queryHash,
    parameters,
    response: result,
    confidence_level: confidenceLevel,
    coverage_percent: coveragePercent ?? null,
    shared_events: sharedEvents ?? null,
    methodology_version: METHODOLOGY_VERSION,
    schema_version: SCHEMA_VERSION,
    expires_at: expiresAt
  };
}
