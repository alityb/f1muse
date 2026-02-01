/**
 * Rate Limiting Middleware
 *
 * In-memory rate limiter with IP-based tracking.
 * Returns 429 with Retry-After header when limit exceeded.
 */

import { Request, Response, NextFunction } from 'express';

interface RateLimitConfig {
  windowMs: number;     // Time window in milliseconds
  maxRequests: number;  // Max requests per window
  name: string;         // Identifier for logging
}

interface RequestRecord {
  count: number;
  windowStart: number;
}

class RateLimiter {
  private records = new Map<string, RequestRecord>();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;

    // Cleanup stale records periodically
    setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.records.entries()) {
        if (now - record.windowStart > this.config.windowMs * 2) {
          this.records.delete(key);
        }
      }
    }, this.config.windowMs);
  }

  private getClientKey(req: Request): string {
    // Prefer X-Forwarded-For for proxied requests, fallback to socket IP
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ip = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : forwardedFor.split(',')[0].trim();
      return ip;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
      const clientKey = this.getClientKey(req);
      const now = Date.now();

      let record = this.records.get(clientKey);

      // Reset window if expired
      if (!record || now - record.windowStart > this.config.windowMs) {
        record = { count: 0, windowStart: now };
        this.records.set(clientKey, record);
      }

      record.count++;

      // Calculate remaining requests and reset time
      const remaining = Math.max(0, this.config.maxRequests - record.count);
      const resetTime = new Date(record.windowStart + this.config.windowMs);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', this.config.maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime.getTime() / 1000));

      if (record.count > this.config.maxRequests) {
        const retryAfterSeconds = Math.ceil(
          (record.windowStart + this.config.windowMs - now) / 1000
        );

        res.setHeader('Retry-After', retryAfterSeconds);
        console.log(
          `[RateLimit] ${this.config.name} limit exceeded for ${clientKey}: ${record.count}/${this.config.maxRequests}`
        );

        res.status(429).json({
          error_type: 'rate_limit_exceeded',
          error_code: 'too_many_requests',
          reason: `Rate limit exceeded. Maximum ${this.config.maxRequests} requests per ${this.config.windowMs / 1000} seconds.`,
          retry_after_seconds: retryAfterSeconds,
        });
        return;
      }

      next();
    };
  }

  // For testing
  reset(): void {
    this.records.clear();
  }

  getStats(): { activeClients: number; totalRecords: number } {
    return {
      activeClients: this.records.size,
      totalRecords: this.records.size,
    };
  }
}

// Pre-configured rate limiters
export const nlQueryRateLimiter = new RateLimiter({
  windowMs: 60 * 1000,   // 1 minute
  maxRequests: 60,       // 60 requests per minute
  name: 'nl-query',
});

export const shareRateLimiter = new RateLimiter({
  windowMs: 60 * 1000,   // 1 minute
  maxRequests: 30,       // 30 requests per minute
  name: 'share',
});

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
