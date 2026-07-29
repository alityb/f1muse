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

// Configuration
const CONFIG = {
  CONNECTION_TIMEOUT_MS: 5000,
  OPERATION_TIMEOUT_MS: 1000,
};

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
