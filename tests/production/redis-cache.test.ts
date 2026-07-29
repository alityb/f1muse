import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisCache, getRedisCache, resetRedisCache } from '../../src/cache/redis-cache';

const redisClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(true),
  ttl: vi.fn().mockResolvedValue(60),
  ping: vi.fn().mockResolvedValue('PONG'),
  on: vi.fn()
};

vi.mock('redis', () => ({ createClient: vi.fn(() => redisClient) }));

describe('Redis rate-limit storage', () => {
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

  it('degrades safely while disconnected', async () => {
    expect(cache.isAvailable()).toBe(false);
    await expect(cache.incr('ratelimit:test')).resolves.toBeNull();
    await expect(cache.expire('ratelimit:test', 60)).resolves.toBe(false);
    await expect(cache.ttl('ratelimit:test')).resolves.toBe(-2);
    await expect(cache.healthCheck()).resolves.toBe(false);
  });

  it('supports atomic increment, expiry, ttl, and health checks when connected', async () => {
    await expect(cache.connect()).resolves.toBe(true);
    await expect(cache.incr('ratelimit:test')).resolves.toBe(1);
    await expect(cache.expire('ratelimit:test', 60)).resolves.toBe(true);
    await expect(cache.ttl('ratelimit:test')).resolves.toBe(60);
    await expect(cache.healthCheck()).resolves.toBe(true);
    expect(redisClient.incr).toHaveBeenCalledWith('ratelimit:test');
  });
});

describe('Redis singleton', () => {
  it('returns one resettable instance', () => {
    resetRedisCache();
    const first = getRedisCache();
    expect(getRedisCache()).toBe(first);
    resetRedisCache();
    expect(getRedisCache()).not.toBe(first);
  });
});
