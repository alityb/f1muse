import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisCache, getRedisCache, resetRedisCache } from '../../src/cache/redis-cache';

/**
 * Redis Cache Tests
 *
 * Note: These tests mock Redis - for integration tests, use actual Redis
 */

// Mock redis
vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    setEx: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue('PONG'),
    info: vi.fn().mockResolvedValue('used_memory_human:1M'),
    on: vi.fn(),
  })),
}));

describe('RedisCache', () => {
  let cache: RedisCache;

  beforeEach(() => {
    resetRedisCache();
    vi.clearAllMocks();
    cache = new RedisCache('redis://localhost:6379');
  });

  afterEach(async () => {
    await cache.disconnect();
    resetRedisCache();
  });

  describe('generateCacheKey', () => {
    it('should generate deterministic cache keys', () => {
      const intent1 = {
        kind: 'driver_season_summary' as const,
        driver_id: 'verstappen',
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'Verstappen 2024',
      };

      const intent2 = {
        kind: 'driver_season_summary' as const,
        driver_id: 'verstappen',
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'Different query same params', // Should be ignored
      };

      const key1 = cache.generateCacheKey(intent1);
      const key2 = cache.generateCacheKey(intent2);

      // Same params (ignoring raw_query) should generate same key
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different params', () => {
      const intent1 = {
        kind: 'driver_season_summary' as const,
        driver_id: 'verstappen',
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'test',
      };

      const intent2 = {
        kind: 'driver_season_summary' as const,
        driver_id: 'norris', // Different driver
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'test',
      };

      const key1 = cache.generateCacheKey(intent1);
      const key2 = cache.generateCacheKey(intent2);

      expect(key1).not.toBe(key2);
    });

    it('should include version in cache key', () => {
      const intent = {
        kind: 'driver_season_summary' as const,
        driver_id: 'verstappen',
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'test',
      };

      const key = cache.generateCacheKey(intent);

      expect(key).toMatch(/^cache:v1:/);
    });

    it('should include query kind in cache key', () => {
      const intent = {
        kind: 'race_results_summary' as const,
        track_id: 'monza',
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'test',
      };

      const key = cache.generateCacheKey(intent);

      expect(key).toContain(':race_results_summary:');
    });

    it('should include season in cache key', () => {
      const intent = {
        kind: 'driver_season_summary' as const,
        driver_id: 'verstappen',
        season: 2024,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query: 'test',
      };

      const key = cache.generateCacheKey(intent);

      expect(key).toContain(':2024:');
    });
  });

  describe('isAvailable', () => {
    it('should return false when not connected', () => {
      expect(cache.isAvailable()).toBe(false);
    });
  });

  describe('get/set operations', () => {
    it('should return cache miss when not connected', async () => {
      const result = await cache.get('test-key');
      expect(result.hit).toBe(false);
    });

    it('should return false for set when not connected', async () => {
      const result = await cache.set('test-key', { data: 'test' }, 2024);
      expect(result).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('should return false when not connected', async () => {
      const healthy = await cache.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return disconnected stats when not connected', async () => {
      const stats = await cache.getStats();
      expect(stats.connected).toBe(false);
      expect(stats.keyCount).toBe(0);
    });
  });
});

describe('RedisCache singleton', () => {
  beforeEach(() => {
    resetRedisCache();
  });

  afterEach(() => {
    resetRedisCache();
  });

  it('should return same instance', () => {
    const cache1 = getRedisCache();
    const cache2 = getRedisCache();
    expect(cache1).toBe(cache2);
  });

  it('should reset instance correctly', () => {
    const cache1 = getRedisCache();
    resetRedisCache();
    const cache2 = getRedisCache();
    expect(cache1).not.toBe(cache2);
  });
});
