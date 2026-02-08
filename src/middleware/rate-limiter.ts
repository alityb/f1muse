/**
 * Rate Limiting Middleware
 *
 * Redis-backed rate limiter with burst protection and in-memory fallback.
 * Returns 429 with Retry-After header when limit exceeded.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { getRedisCache } from '../cache/redis-cache';
import { metrics } from '../observability/metrics';

interface RateLimitConfig {
  windowMs: number;        // Time window in milliseconds
  maxRequests: number;     // Max requests per window
  burstWindowMs: number;   // Burst window in milliseconds
  burstMaxRequests: number; // Max requests per burst window
  name: string;            // Identifier for logging/metrics
}

interface RequestRecord {
  count: number;
  windowStart: number;
}

interface InMemoryRecords {
  window: Map<string, RequestRecord>;
  burst: Map<string, RequestRecord>;
}

/**
 * Hash User-Agent to 8 characters for composite key
 */
function hashUA(ua: string): string {
  return createHash('sha256')
    .update(ua || 'unknown')
    .digest('hex')
    .substring(0, 8);
}

/**
 * Redis-backed Rate Limiter with burst protection
 */
class RedisRateLimiter {
  private config: RateLimitConfig;
  private fallbackRecords: InMemoryRecords;
  private cleanupInterval: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.fallbackRecords = {
      window: new Map(),
      burst: new Map(),
    };

    // Cleanup stale in-memory records periodically
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.fallbackRecords.window.entries()) {
        if (now - record.windowStart > this.config.windowMs * 2) {
          this.fallbackRecords.window.delete(key);
        }
      }
      for (const [key, record] of this.fallbackRecords.burst.entries()) {
        if (now - record.windowStart > this.config.burstWindowMs * 2) {
          this.fallbackRecords.burst.delete(key);
        }
      }
    }, this.config.windowMs);
  }

  private getClientKey(req: Request): string {
    // Prefer X-Forwarded-For for proxied requests, fallback to socket IP
    const forwardedFor = req.headers['x-forwarded-for'];
    let ip: string;
    if (forwardedFor) {
      ip = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor.split(',')[0].trim();
    } else {
      ip = req.socket.remoteAddress || 'unknown';
    }

    // Create composite key: IP + UA hash
    const ua = req.headers['user-agent'] || '';
    const uaHash = hashUA(ua);
    return `${ip}:${uaHash}`;
  }

  /**
   * Check rate limit using Redis, falling back to in-memory
   */
  private async checkLimit(
    clientKey: string,
    type: 'window' | 'burst',
    maxRequests: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; count: number; retryAfter: number }> {
    const redisCache = getRedisCache();
    const redisKey = `ratelimit:${this.config.name}:${type}:${clientKey}`;

    // Try Redis first
    if (redisCache.isAvailable()) {
      try {
        const count = await redisCache.incr(redisKey);
        if (count !== null) {
          // Set expiration on first request in window
          if (count === 1) {
            await redisCache.expire(redisKey, windowSeconds);
          }

          const ttl = await redisCache.ttl(redisKey);
          const retryAfter = ttl > 0 ? ttl : windowSeconds;

          return {
            allowed: count <= maxRequests,
            count,
            retryAfter,
          };
        }
      } catch (error) {
        // Fall through to in-memory
      }
    }

    // Fallback to in-memory
    return this.checkLimitInMemory(clientKey, type, maxRequests, windowSeconds * 1000);
  }

  private checkLimitInMemory(
    clientKey: string,
    type: 'window' | 'burst',
    maxRequests: number,
    windowMs: number
  ): { allowed: boolean; count: number; retryAfter: number } {
    const records = type === 'window' ? this.fallbackRecords.window : this.fallbackRecords.burst;
    const now = Date.now();

    let record = records.get(clientKey);

    // Reset window if expired
    if (!record || now - record.windowStart > windowMs) {
      record = { count: 0, windowStart: now };
      records.set(clientKey, record);
    }

    record.count++;

    const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);

    return {
      allowed: record.count <= maxRequests,
      count: record.count,
      retryAfter: Math.max(1, retryAfter),
    };
  }

  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const clientKey = this.getClientKey(req);

      // Check burst limit first (stricter, shorter window)
      const burstResult = await this.checkLimit(
        clientKey,
        'burst',
        this.config.burstMaxRequests,
        Math.ceil(this.config.burstWindowMs / 1000)
      );

      if (!burstResult.allowed) {
        metrics.incrementRateLimitBlock(this.config.name, 'burst');
        console.log(
          `[RateLimit] ${this.config.name} BURST limit exceeded for ${clientKey}: ${burstResult.count}/${this.config.burstMaxRequests}`
        );

        res.setHeader('Retry-After', burstResult.retryAfter);
        res.setHeader('X-RateLimit-Limit', this.config.burstMaxRequests);
        res.setHeader('X-RateLimit-Remaining', 0);

        res.status(429).json({
          error_type: 'rate_limit_exceeded',
          error_code: 'burst_limit',
          reason: `Burst rate limit exceeded. Maximum ${this.config.burstMaxRequests} requests per ${this.config.burstWindowMs / 1000} seconds.`,
          retry_after_seconds: burstResult.retryAfter,
        });
        return;
      }

      // Check window limit
      const windowResult = await this.checkLimit(
        clientKey,
        'window',
        this.config.maxRequests,
        Math.ceil(this.config.windowMs / 1000)
      );

      // Set rate limit headers
      const remaining = Math.max(0, this.config.maxRequests - windowResult.count);
      res.setHeader('X-RateLimit-Limit', this.config.maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + windowResult.retryAfter);

      if (!windowResult.allowed) {
        metrics.incrementRateLimitBlock(this.config.name, 'window');
        console.log(
          `[RateLimit] ${this.config.name} WINDOW limit exceeded for ${clientKey}: ${windowResult.count}/${this.config.maxRequests}`
        );

        res.setHeader('Retry-After', windowResult.retryAfter);

        res.status(429).json({
          error_type: 'rate_limit_exceeded',
          error_code: 'window_limit',
          reason: `Rate limit exceeded. Maximum ${this.config.maxRequests} requests per ${this.config.windowMs / 1000} seconds.`,
          retry_after_seconds: windowResult.retryAfter,
        });
        return;
      }

      next();
    };
  }

  // For testing
  reset(): void {
    this.fallbackRecords.window.clear();
    this.fallbackRecords.burst.clear();
  }

  getStats(): { activeClients: number; totalRecords: number } {
    return {
      activeClients: this.fallbackRecords.window.size,
      totalRecords: this.fallbackRecords.window.size + this.fallbackRecords.burst.size,
    };
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

// Pre-configured rate limiters
// Tuned for legitimate usage patterns - generous enough for power users,
// strict enough to prevent casual abuse
export const nlQueryRateLimiter = new RedisRateLimiter({
  windowMs: 60 * 1000,        // 1 minute window
  maxRequests: 120,           // 120 requests per minute
  burstWindowMs: 10 * 1000,   // 10 second burst window
  burstMaxRequests: 40,       // 40 requests per 10 seconds
  name: 'nl-query',
});

export const shareRateLimiter = new RedisRateLimiter({
  windowMs: 60 * 1000,        // 1 minute window
  maxRequests: 60,            // 60 requests per minute
  burstWindowMs: 10 * 1000,   // 10 second burst window
  burstMaxRequests: 15,       // 15 requests per 10 seconds
  name: 'share',
});

/**
 * Bot Protection Middleware
 *
 * Blocks requests from known bot User-Agents and missing UA headers.
 * Allows monitoring services through an allowlist.
 */

// Bot UA patterns to block (case-insensitive)
const BOT_PATTERNS = [
  /^curl\//i,
  /^wget\//i,
  /^python-requests\//i,
  /^python-urllib\//i,
  /^httpie\//i,
  /postman/i,
  /^insomnia\//i,
  /^axios\//i,
  /^node-fetch\//i,
  /^got\//i,
  /^undici\//i,
  /scrapy/i,
  /\bbot\b/i,
  /spider/i,
  /crawler/i,
  /^java\//i,
  /^go-http-client\//i,
  /^okhttp\//i,
];

// Monitoring services to allow
const ALLOWED_MONITORING = [
  /UptimeRobot/i,
  /Pingdom/i,
  /GoogleHC\//i,
  /kube-probe\//i,
];

interface BotProtectionOptions {
  delayMs?: number;  // Optional delay for uncached queries
}

/**
 * Check if UA is a known bot
 */
function isBot(ua: string): boolean {
  // Check allowlist first
  for (const pattern of ALLOWED_MONITORING) {
    if (pattern.test(ua)) {
      return false;
    }
  }

  // Check bot patterns
  for (const pattern of BOT_PATTERNS) {
    if (pattern.test(ua)) {
      return true;
    }
  }

  return false;
}

/**
 * Bot protection middleware factory
 */
export function botProtection(options: BotProtectionOptions = {}) {
  const { delayMs = 0 } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const ua = req.headers['user-agent'];

    // Reject missing User-Agent
    if (!ua || ua.trim() === '') {
      metrics.incrementBotBlock('missing_ua');
      console.log(`[BotProtection] Blocked request with missing User-Agent from ${req.ip}`);

      res.status(400).json({
        error_type: 'bad_request',
        error_code: 'missing_user_agent',
        reason: 'User-Agent header is required.',
      });
      return;
    }

    // Reject known bot UAs
    if (isBot(ua)) {
      metrics.incrementBotBlock('bot_ua');
      console.log(`[BotProtection] Blocked bot request: ${ua.substring(0, 50)} from ${req.ip}`);

      res.status(403).json({
        error_type: 'forbidden',
        error_code: 'bot_detected',
        reason: 'Automated access is not permitted. Please use the official API.',
      });
      return;
    }

    // Store delay option in request for later use (after cache miss)
    if (delayMs > 0) {
      (req as any).__botProtectionDelayMs = delayMs;
    }

    next();
  };
}

/**
 * Apply challenge delay (call after cache miss check)
 */
export async function applyBotProtectionDelay(req: Request): Promise<void> {
  const delayMs = (req as any).__botProtectionDelayMs;
  if (delayMs && delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

/**
 * Request body size guard middleware
 * Rejects requests with body larger than specified limit
 */
export function bodySizeGuard(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      res.status(413).json({
        error_type: 'routing_error',
        error_code: 'payload_too_large',
        reason: `Request body exceeds maximum size of ${maxBytes} bytes.`,
      });
      return;
    }
    next();
  };
}

// Max NL query length constant (exported for validation)
export const MAX_NL_QUERY_LENGTH = 500;
export const MAX_REQUEST_BODY_SIZE = 16 * 1024; // 16KB
