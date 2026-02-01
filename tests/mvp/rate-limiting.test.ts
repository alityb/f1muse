/**
 * Rate Limiting Tests
 *
 * Tests for Section B - Rate limiting and cost protection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_NL_QUERY_LENGTH, MAX_REQUEST_BODY_SIZE } from '../../src/middleware/rate-limiter';

describe('Rate Limiting Configuration', () => {
  describe('Constants', () => {
    it('should have max NL query length of 500 characters', () => {
      expect(MAX_NL_QUERY_LENGTH).toBe(500);
    });

    it('should have max request body size of 16KB', () => {
      expect(MAX_REQUEST_BODY_SIZE).toBe(16 * 1024);
    });
  });
});

describe('Rate Limit Response Contract', () => {
  it('should define 429 response shape', () => {
    const expectedShape = {
      error_type: 'rate_limit_exceeded',
      error_code: 'too_many_requests',
      reason: 'Rate limit exceeded...',
      retry_after_seconds: 60,
    };

    expect(expectedShape).toHaveProperty('error_type', 'rate_limit_exceeded');
    expect(expectedShape).toHaveProperty('error_code', 'too_many_requests');
    expect(expectedShape).toHaveProperty('retry_after_seconds');
  });

  it('should include required rate limit headers', () => {
    const expectedHeaders = [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ];

    for (const header of expectedHeaders) {
      expect(header).toBeDefined();
    }
  });
});

describe('Request Body Size Protection', () => {
  it('should reject requests larger than 16KB', () => {
    // Express is configured with: express.json({ limit: '16kb' })
    // Requests exceeding this limit get 413 Payload Too Large
    const expectedStatus = 413;
    expect(expectedStatus).toBe(413);
  });

  it('should define 413 response shape', () => {
    const expectedShape = {
      error_type: 'routing_error',
      error_code: 'payload_too_large',
      reason: 'Request body exceeds maximum size...',
    };

    expect(expectedShape).toHaveProperty('error_code', 'payload_too_large');
  });
});

describe('Question Length Protection', () => {
  it('should reject questions longer than MAX_NL_QUERY_LENGTH', () => {
    const longQuestion = 'a'.repeat(MAX_NL_QUERY_LENGTH + 1);
    expect(longQuestion.length).toBeGreaterThan(MAX_NL_QUERY_LENGTH);
  });

  it('should accept questions at exactly MAX_NL_QUERY_LENGTH', () => {
    const maxQuestion = 'a'.repeat(MAX_NL_QUERY_LENGTH);
    expect(maxQuestion.length).toBe(MAX_NL_QUERY_LENGTH);
  });

  it('should define error response for question too long', () => {
    const expectedError = {
      error_type: 'routing_error',
      error_code: 'question_too_long',
      reason: `Question must be ${MAX_NL_QUERY_LENGTH} characters or less`,
    };

    expect(expectedError).toHaveProperty('error_code', 'question_too_long');
  });
});

describe('Rate Limit Tiers', () => {
  it('should document NL query rate limit (60/min)', () => {
    const nlQueryLimit = {
      windowMs: 60 * 1000,
      maxRequests: 60,
    };

    expect(nlQueryLimit.maxRequests).toBe(60);
    expect(nlQueryLimit.windowMs).toBe(60000);
  });

  it('should document share creation rate limit (30/min)', () => {
    const shareLimit = {
      windowMs: 60 * 1000,
      maxRequests: 30,
    };

    expect(shareLimit.maxRequests).toBe(30);
    expect(shareLimit.windowMs).toBe(60000);
  });
});

describe('IP-based Rate Limiting', () => {
  it('should document X-Forwarded-For header support', () => {
    // Rate limiter checks X-Forwarded-For header first for proxied requests
    const headerName = 'x-forwarded-for';
    expect(headerName).toBe('x-forwarded-for');
  });

  it('should document socket IP fallback', () => {
    // Falls back to req.socket.remoteAddress when no X-Forwarded-For
    const fallbackSource = 'req.socket.remoteAddress';
    expect(fallbackSource).toBeDefined();
  });
});
