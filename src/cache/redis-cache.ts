/**
 * REDIS CACHING LAYER
 *
 * Production-ready Redis cache for F1 Muse API
 *
 * Features:
 * - Graceful degradation (fallback to Postgres if Redis unavailable)
 * - TTL-based expiration (24h for historical, 1h for recent)
 * - Cache key versioning
 * - Hit/miss logging
 * - Connection pooling
 */

import { createClient, RedisClientType } from 'redis';
import { createHash } from 'crypto';
import { QueryIntent } from '../types/query-intent';
import { metrics } from '../observability/metrics';

// Configuration
const CONFIG = {
  CACHE_VERSION: 'v2',
  TTL_DEFAULT_SECONDS: 600, // 10 min default
  TTL_HISTORICAL_SECONDS: 3600, // 1 hour for career/historical
  TTL_CURRENT_SEASON_SECONDS: 300, // 5 min for current season
  CURRENT_SEASON: 2025,
  CONNECTION_TIMEOUT_MS: 5000,
  OPERATION_TIMEOUT_MS: 1000,
};

// Query kinds that should get longer TTLs (career/historical)
const CAREER_QUERY_KINDS = [
  'driver_career_summary',
  'driver_career_pole_count',
  'driver_career_wins_by_circuit',
  'teammate_comparison_career',
];

export interface CacheResult<T> {
  hit: boolean;
  data?: T;
  key?: string;
  ttl?: number;
}

/**
 * Redis Cache Manager
 */
export class RedisCache {
  private client: RedisClientType | null = null;
  private connected: boolean = false;
  private readonly url: string;

  constructor(redisUrl?: string) {
    this.url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<boolean> {
    if (this.connected && this.client) {
      return true;
    }

    try {
      this.client = createClient({
        url: this.url,
        socket: {
          connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
          reconnectStrategy: (retries) => {
            if (retries > 3) {
              console.warn('[Redis] Max reconnection attempts reached, operating in degraded mode');
              return false;
            }
            return Math.min(retries * 100, 3000);
          },
        },
      });

      this.client.on('error', (err) => {
        console.error('[Redis] Connection error:', err.message);
        this.connected = false;
      });

      this.client.on('connect', () => {
        console.log('[Redis] Connected');
        this.connected = true;
      });

      this.client.on('disconnect', () => {
        console.warn('[Redis] Disconnected');
        this.connected = false;
      });

      await this.client.connect();
      this.connected = true;
      return true;
    } catch (error: any) {
      console.warn(`[Redis] Failed to connect: ${error.message}. Operating in degraded mode.`);
      this.connected = false;
      return false;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.connected = false;
    }
  }

  /**
   * Check if Redis is available
   */
  isAvailable(): boolean {
    return this.connected && this.client !== null;
  }

  /**
   * Generate cache key from QueryIntent
   */
  generateCacheKey(intent: QueryIntent): string {
    const kind = intent.kind;
    const season = intent.season;

    // Create normalized params object for hashing
    const params: Record<string, any> = { ...intent };
    delete params.raw_query; // Don't include raw query in cache key

    // Sort keys for deterministic hashing
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((obj: Record<string, any>, key) => {
        obj[key] = params[key];
        return obj;
      }, {});

    const paramsHash = createHash('sha256')
      .update(JSON.stringify(sortedParams))
      .digest('hex')
      .substring(0, 16);

    return `f1muse:query:${CONFIG.CACHE_VERSION}:${kind}:${season}:${paramsHash}`;
  }

  /**
   * Get TTL based on season and query kind
   * - Career queries: 1 hour (stable data)
   * - Historical seasons (< 2025): 1 hour
   * - Current season (2025): 5 minutes
   * - Default: 10 minutes
   */
  private getTTL(season: number, kind?: string): number {
    // Career queries get longer TTL regardless of season
    if (kind && CAREER_QUERY_KINDS.includes(kind)) {
      return CONFIG.TTL_HISTORICAL_SECONDS;
    }

    // Historical seasons get longer TTL
    if (season < CONFIG.CURRENT_SEASON) {
      return CONFIG.TTL_HISTORICAL_SECONDS;
    }

    // Current season gets shorter TTL
    if (season === CONFIG.CURRENT_SEASON) {
      return CONFIG.TTL_CURRENT_SEASON_SECONDS;
    }

    return CONFIG.TTL_DEFAULT_SECONDS;
  }

  /**
   * Get cached result
   */
  async get<T>(key: string): Promise<CacheResult<T>> {
    if (!this.isAvailable()) {
      metrics.incrementCacheMiss();
      return { hit: false };
    }

    try {
      const data = await Promise.race([
        this.client!.get(key),
        this.timeout(CONFIG.OPERATION_TIMEOUT_MS),
      ]);

      if (data) {
        metrics.incrementCacheHit();
        return {
          hit: true,
          data: JSON.parse(data as string),
          key,
        };
      }

      metrics.incrementCacheMiss();
      return { hit: false, key };
    } catch (error: any) {
      console.warn(`[Redis] Get error for ${key}: ${error.message}`);
      metrics.incrementCacheMiss();
      return { hit: false };
    }
  }

  /**
   * Set cached result
   */
  async set<T>(key: string, data: T, season: number, kind?: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const ttl = this.getTTL(season, kind);
      const serialized = JSON.stringify(data);

      await Promise.race([
        this.client!.setEx(key, ttl, serialized),
        this.timeout(CONFIG.OPERATION_TIMEOUT_MS),
      ]);

      return true;
    } catch (error: any) {
      console.warn(`[Redis] Set error for ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Increment a key atomically (for rate limiting)
   */
  async incr(key: string): Promise<number | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const result = await Promise.race([
        this.client!.incr(key),
        this.timeout(CONFIG.OPERATION_TIMEOUT_MS),
      ]);
      return result as number;
    } catch (error: any) {
      console.warn(`[Redis] Incr error for ${key}: ${error.message}`);
      return null;
    }
  }

  /**
   * Set expiration on a key
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await Promise.race([
        this.client!.expire(key, seconds),
        this.timeout(CONFIG.OPERATION_TIMEOUT_MS),
      ]);
      return true;
    } catch (error: any) {
      console.warn(`[Redis] Expire error for ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get TTL of a key in seconds
   */
  async ttl(key: string): Promise<number> {
    if (!this.isAvailable()) {
      return -2; // Key does not exist or Redis unavailable
    }

    try {
      const result = await Promise.race([
        this.client!.ttl(key),
        this.timeout(CONFIG.OPERATION_TIMEOUT_MS),
      ]);
      return result as number;
    } catch (error: any) {
      console.warn(`[Redis] TTL error for ${key}: ${error.message}`);
      return -2;
    }
  }

  /**
   * Delete cached result
   */
  async delete(key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client!.del(key);
      return true;
    } catch (error: any) {
      console.warn(`[Redis] Delete error for ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear all cache for a specific query kind
   */
  async clearByKind(kind: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const pattern = `f1muse:query:${CONFIG.CACHE_VERSION}:${kind}:*`;
      const keys = await this.client!.keys(pattern);

      if (keys.length > 0) {
        await this.client!.del(keys);
      }

      return keys.length;
    } catch (error: any) {
      console.warn(`[Redis] Clear error for kind ${kind}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Clear all cache
   */
  async clearAll(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const pattern = `f1muse:query:${CONFIG.CACHE_VERSION}:*`;
      const keys = await this.client!.keys(pattern);

      if (keys.length > 0) {
        await this.client!.del(keys);
      }

      console.log(`[Redis] Cleared ${keys.length} cache entries`);
      return true;
    } catch (error: any) {
      console.warn(`[Redis] Clear all error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    connected: boolean;
    keyCount: number;
    memoryUsage?: string;
  }> {
    if (!this.isAvailable()) {
      return { connected: false, keyCount: 0 };
    }

    try {
      const pattern = `f1muse:query:${CONFIG.CACHE_VERSION}:*`;
      const keys = await this.client!.keys(pattern);
      const info = await this.client!.info('memory');

      const memMatch = info.match(/used_memory_human:(\S+)/);

      return {
        connected: true,
        keyCount: keys.length,
        memoryUsage: memMatch ? memMatch[1] : undefined,
      };
    } catch (error: any) {
      return { connected: false, keyCount: 0 };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const pong = await this.client!.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Timeout helper
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Redis operation timeout')), ms);
    });
  }
}

// Singleton instance
let cacheInstance: RedisCache | null = null;

export function getRedisCache(): RedisCache {
  if (!cacheInstance) {
    cacheInstance = new RedisCache();
  }
  return cacheInstance;
}

export async function initRedisCache(): Promise<RedisCache> {
  const cache = getRedisCache();
  await cache.connect();
  return cache;
}

export function resetRedisCache(): void {
  if (cacheInstance) {
    cacheInstance.disconnect();
  }
  cacheInstance = null;
}
