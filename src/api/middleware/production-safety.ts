/**
 * Production Safety Middleware
 * PHASE 7: Rate limiting, timeouts, CORS, logging
 */

import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

/**
 * Rate limiter for API requests
 * - 100 requests per 15 minutes per IP
 * - Prevents abuse and DoS
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    error: 'rate_limit_exceeded',
    reason: 'Too many requests from this IP. Please try again later.',
    details: {
      limit: 100,
      window_minutes: 15
    }
  }
});

/**
 * Stricter rate limiter for expensive natural language queries
 * - 20 requests per 15 minutes per IP
 */
export const nlQueryRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limit_exceeded',
    reason: 'Too many natural language queries. Please try again later.',
    details: {
      limit: 20,
      window_minutes: 15
    }
  }
});

/**
 * Request timeout middleware
 * - Enforces 30 second timeout on all requests
 */
export function requestTimeout(timeoutMs: number = 30000) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          error: 'request_timeout',
          reason: `Request exceeded ${timeoutMs}ms timeout`,
          details: { timeout_ms: timeoutMs }
        });
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    res.on('finish', () => {
      clearTimeout(timeout);
    });

    next();
  };
}

/**
 * Check if origin matches allowed dynamic patterns (Vercel preview deployments, etc.)
 */
function isAllowedDynamicOrigin(origin: string): boolean {
  // Allow Vercel preview deployments (*.vercel.app)
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) {
    return true;
  }
  // Allow Vercel production deployments with project name
  if (/^https:\/\/f1muse[a-z0-9-]*\.vercel\.app$/.test(origin)) {
    return true;
  }
  return false;
}

/**
 * CORS configuration for production
 * - Restricts origins to known domains
 * - Allows credentials if needed
 */
export function configureCORS(allowedOrigins?: string[]) {
  // Default: allow localhost in development, restrict in production
  // CORS_ALLOWED_ORIGINS env var can be comma-separated list of additional origins
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];

  const origins = allowedOrigins || [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'http://localhost:8080',
    'https://f1muse.com',
    'https://www.f1muse.com',
    ...envOrigins
  ];

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // Allow requests with no origin (like curl or Postman)
    if (!origin) {
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origins.includes(origin) || isAllowedDynamicOrigin(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Debug, Authorization');
    res.header('Access-Control-Max-Age', '86400'); // 24 hours

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  };
}

/**
 * Structured request logger
 * - Logs all requests with timing
 * - Masks sensitive data
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Add request ID to response headers
  res.setHeader('X-Request-ID', requestId);

  // Log request
  console.log(JSON.stringify({
    type: 'request',
    request_id: requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    ip: req.ip || req.socket.remoteAddress,
    user_agent: req.get('user-agent')
  }));

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      type: 'response',
      request_id: requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration
    }));
  });

  next();
}

/**
 * Mask sensitive data in error messages
 */
export function maskSensitiveData(data: unknown): unknown {
  if (typeof data === 'string') {
    // Mask connection strings
    let masked = data.replace(/postgresql:\/\/[^@]+@/gi, 'postgresql://***:***@');
    // Mask API keys
    masked = masked.replace(/([a-z_]+_api_key["\s:=]+)([a-zA-Z0-9-_]+)/gi, '$1***');
    // Mask Bearer tokens
    masked = masked.replace(/Bearer\s+[a-zA-Z0-9-_.]+/gi, 'Bearer ***');
    return masked;
  } else if (typeof data === 'object' && data !== null) {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Mask known sensitive keys
      if (/api[_-]?key|password|token|secret|auth/i.test(key)) {
        masked[key] = '***';
      } else {
        masked[key] = maskSensitiveData(value);
      }
    }
    return masked;
  }
  return data;
}

/**
 * Safe error logger that masks secrets
 */
export function logError(error: unknown, context?: Record<string, unknown>) {
  const errorData = {
    type: 'error',
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? {
      name: error.name,
      message: maskSensitiveData(error.message),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    } : maskSensitiveData(error),
    context: context ? maskSensitiveData(context) : undefined
  };

  console.error(JSON.stringify(errorData));
}
