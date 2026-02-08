/**
 * CACHE MAINTENANCE
 *
 * Background maintenance tasks for the api_query_cache table:
 * - purgeExpired(): Delete rows where expires_at < NOW()
 * - enforceMaxEntries(): Delete oldest entries if limit exceeded (LRU)
 * - vacuumHint(): Optional hint for PostgreSQL vacuum
 *
 * Usage:
 *   const maintenance = new CacheMaintenance(pool);
 *   await maintenance.runAll();
 */

import { Pool } from 'pg';

/**
 * Cache maintenance result
 */
export interface MaintenanceResult {
  expired_purged: number;
  lru_evicted: number;
  stale_versions_removed: number;
  vacuum_suggested: boolean;
  duration_ms: number;
}

/**
 * Cache maintenance options
 */
export interface MaintenanceOptions {
  /** Maximum number of cache entries to keep (default: 250,000) */
  max_entries?: number;

  /** Whether to log maintenance activity (default: true) */
  verbose?: boolean;

  /** Whether to suggest vacuum after large deletions (default: true) */
  vacuum_hint?: boolean;
}

const DEFAULT_MAX_ENTRIES = 250_000;
const VACUUM_THRESHOLD = 10_000; // Suggest vacuum if > 10k rows deleted

/**
 * CacheMaintenance - Manages cache cleanup and limits
 */
export class CacheMaintenance {
  private pool: Pool;
  private options: Required<MaintenanceOptions>;

  constructor(pool: Pool, options: MaintenanceOptions = {}) {
    this.pool = pool;
    this.options = {
      max_entries: options.max_entries ?? DEFAULT_MAX_ENTRIES,
      verbose: options.verbose ?? true,
      vacuum_hint: options.vacuum_hint ?? true
    };
  }

  /**
   * Purge all expired cache entries
   *
   * Deletes rows where expires_at < NOW()
   */
  async purgeExpired(): Promise<number> {
    try {
      const result = await this.pool.query(`
        DELETE FROM api_query_cache
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
      `);

      const count = result.rowCount || 0;
      if (this.options.verbose && count > 0) {
        console.log(`[CacheMaintenance] Purged ${count} expired entries`);
      }
      return count;
    } catch (err) {
      console.error('[CacheMaintenance] Error purging expired entries:', err);
      return 0;
    }
  }

  /**
   * Enforce maximum number of cache entries (LRU eviction)
   *
   * Deletes oldest entries by last_hit_at (or created_at if never accessed)
   * when total entries exceed max_entries limit.
   */
  async enforceMaxEntries(maxEntries?: number): Promise<number> {
    const limit = maxEntries ?? this.options.max_entries;

    try {
      // Get current count
      const countResult = await this.pool.query(`
        SELECT COUNT(*) as total FROM api_query_cache
      `);
      const currentCount = parseInt(countResult.rows[0]?.total || '0', 10);

      if (currentCount <= limit) {
        if (this.options.verbose) {
          console.log(`[CacheMaintenance] Cache size ${currentCount} within limit ${limit}, no eviction needed`);
        }
        return 0;
      }

      const toDelete = currentCount - limit;

      // Delete oldest entries by last_hit_at (LRU), falling back to created_at
      const result = await this.pool.query(`
        DELETE FROM api_query_cache
        WHERE cache_key IN (
          SELECT cache_key
          FROM api_query_cache
          ORDER BY COALESCE(last_hit_at, created_at) ASC
          LIMIT $1
        )
      `, [toDelete]);

      const count = result.rowCount || 0;
      if (this.options.verbose) {
        console.log(`[CacheMaintenance] LRU evicted ${count} entries (was ${currentCount}, limit ${limit})`);
      }
      return count;
    } catch (err) {
      console.error('[CacheMaintenance] Error enforcing max entries:', err);
      return 0;
    }
  }

  /**
   * Remove entries with stale methodology or schema versions
   */
  async purgeStaleVersions(): Promise<number> {
    try {
      // Import versioning constants dynamically to avoid circular deps
      const { METHODOLOGY_VERSION, SCHEMA_VERSION } = await import('../config/versioning');

      const result = await this.pool.query(`
        DELETE FROM api_query_cache
        WHERE methodology_version != $1 OR schema_version != $2
      `, [METHODOLOGY_VERSION, SCHEMA_VERSION]);

      const count = result.rowCount || 0;
      if (this.options.verbose && count > 0) {
        console.log(`[CacheMaintenance] Purged ${count} stale version entries`);
      }
      return count;
    } catch (err) {
      console.error('[CacheMaintenance] Error purging stale versions:', err);
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    total_entries: number;
    expired_entries: number;
    valid_entries: number;
    low_coverage_entries: number;
    oldest_entry_age_hours: number | null;
    total_hits: number;
  }> {
    try {
      const result = await this.pool.query(`
        SELECT
          COUNT(*) as total_entries,
          COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < NOW()) as expired_entries,
          COUNT(*) FILTER (WHERE confidence_level = 'valid') as valid_entries,
          COUNT(*) FILTER (WHERE confidence_level = 'low_coverage') as low_coverage_entries,
          EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 3600 as oldest_entry_age_hours,
          COALESCE(SUM(hit_count), 0) as total_hits
        FROM api_query_cache
      `);

      const row = result.rows[0];
      return {
        total_entries: parseInt(row.total_entries || '0', 10),
        expired_entries: parseInt(row.expired_entries || '0', 10),
        valid_entries: parseInt(row.valid_entries || '0', 10),
        low_coverage_entries: parseInt(row.low_coverage_entries || '0', 10),
        oldest_entry_age_hours: row.oldest_entry_age_hours ? parseFloat(row.oldest_entry_age_hours) : null,
        total_hits: parseInt(row.total_hits || '0', 10)
      };
    } catch (err) {
      console.error('[CacheMaintenance] Error getting stats:', err);
      return {
        total_entries: 0,
        expired_entries: 0,
        valid_entries: 0,
        low_coverage_entries: 0,
        oldest_entry_age_hours: null,
        total_hits: 0
      };
    }
  }

  /**
   * Run all maintenance tasks
   *
   * Order: stale versions -> expired -> LRU eviction
   */
  async runAll(): Promise<MaintenanceResult> {
    const startTime = Date.now();

    if (this.options.verbose) {
      console.log('[CacheMaintenance] Starting maintenance cycle...');
    }

    // 1. Purge stale versions first
    const staleVersionsRemoved = await this.purgeStaleVersions();

    // 2. Purge expired entries
    const expiredPurged = await this.purgeExpired();

    // 3. Enforce max entries (LRU eviction)
    const lruEvicted = await this.enforceMaxEntries();

    const totalDeleted = staleVersionsRemoved + expiredPurged + lruEvicted;
    const vacuumSuggested = this.options.vacuum_hint && totalDeleted >= VACUUM_THRESHOLD;

    const durationMs = Date.now() - startTime;

    if (this.options.verbose) {
      console.log(`[CacheMaintenance] Maintenance complete in ${durationMs}ms`);
      console.log(`  - Stale versions: ${staleVersionsRemoved}`);
      console.log(`  - Expired: ${expiredPurged}`);
      console.log(`  - LRU evicted: ${lruEvicted}`);
      if (vacuumSuggested) {
        console.log(`  - VACUUM SUGGESTED: ${totalDeleted} rows deleted, consider running VACUUM ANALYZE api_query_cache`);
      }
    }

    return {
      expired_purged: expiredPurged,
      lru_evicted: lruEvicted,
      stale_versions_removed: staleVersionsRemoved,
      vacuum_suggested: vacuumSuggested,
      duration_ms: durationMs
    };
  }
}

/**
 * Run cache maintenance (convenience function)
 */
export async function runCacheMaintenance(
  pool: Pool,
  options?: MaintenanceOptions
): Promise<MaintenanceResult> {
  const maintenance = new CacheMaintenance(pool, options);
  return maintenance.runAll();
}

/**
 * Start background cache maintenance interval
 *
 * @param pool - Database pool with write access
 * @param intervalMs - Interval in milliseconds (default: 60 minutes)
 * @param options - Maintenance options
 * @returns Interval ID for clearing with clearInterval()
 */
export function startCacheMaintenanceInterval(
  pool: Pool,
  intervalMs: number = 60 * 60 * 1000, // 60 minutes
  options?: MaintenanceOptions
): NodeJS.Timeout {
  const maintenance = new CacheMaintenance(pool, {
    verbose: true,
    ...options
  });

  console.log(`[CacheMaintenance] Starting background maintenance (interval: ${intervalMs / 1000 / 60} minutes)`);

  // Run immediately on startup
  maintenance.runAll().catch(err => {
    console.error('[CacheMaintenance] Initial maintenance failed:', err);
  });

  // Schedule recurring maintenance
  return setInterval(() => {
    maintenance.runAll().catch(err => {
      console.error('[CacheMaintenance] Scheduled maintenance failed:', err);
    });
  }, intervalMs);
}
