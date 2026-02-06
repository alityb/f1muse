/**
 * PRODUCTION NATURAL LANGUAGE QUERY ENDPOINT
 *
 * Claude API only - no local LLM support
 * Includes Redis caching, metrics, structured logging
 *
 * Pipeline:
 * 1. User text → Claude → structured JSON intent
 * 2. Validation
 * 3. Cache check
 * 4. SQL execution
 * 5. Formatting
 * 6. Cache store
 * 7. Response
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ClaudeClient, getClaudeClient } from '../llm/claude-client';
import { QueryExecutor } from '../execution/query-executor';
import { buildInterpretationResponse } from '../presentation/interpretation-builder';
import { applyConversationContext } from '../conversation/context-resolver';
import { ConversationContext } from '../conversation/context-types';
import { RedisCache, getRedisCache } from '../cache/redis-cache';
import { metrics } from '../observability/metrics';
import {
  buildErrorResponse,
  getStatusCode,
  nlQueryCounters,
} from './nl-query-errors';
import { nlQueryRateLimiter, MAX_NL_QUERY_LENGTH } from '../middleware/rate-limiter';

// debug info attached to every response
interface ExecutionDebugInfo {
  intent_cache_hit: boolean;
  sql_executed: boolean;
  rows_returned: number;
  coverage_reason: string | null;
}

// Request/Response types
interface NLQueryRequest {
  question: string;
  session_id?: string;
}

/**
 * Structured logger for NL queries
 */
function logNLQuery(data: {
  request_id: string;
  question: string;
  intent_kind?: string;
  status: 'success' | 'error';
  cached: boolean;
  llm_latency_ms?: number;
  sql_latency_ms?: number;
  total_latency_ms: number;
  error?: string;
}): void {
  console.log(JSON.stringify({
    type: 'nl_query',
    timestamp: new Date().toISOString(),
    ...data,
  }));
}

/**
 * Create production NL query router
 *
 * @param pool - Primary database pool
 * @param cachePool - Optional separate pool for cache writes
 */
export function createProductionNLQueryRouter(pool: Pool, cachePool?: Pool): Router {
  const router = Router();

  // Initialize components
  let claudeClient: ClaudeClient;
  let redisCache: RedisCache;
  let executor: QueryExecutor;

  // Session contexts (keyed by session_id)
  const sessionContexts = new Map<string, ConversationContext>();

  // Lazy initialization
  const initialize = async () => {
    if (!claudeClient) {
      claudeClient = getClaudeClient();
    }
    if (!redisCache) {
      redisCache = getRedisCache();
      await redisCache.connect();
    }
    if (!executor) {
      executor = new QueryExecutor(pool, undefined, cachePool);
    }
  };

  router.post('/nl-query', nlQueryRateLimiter.middleware(), async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const startTime = Date.now();
    let queryKind: string | null = null;

    // Track concurrent requests
    metrics.incrementConcurrentRequests();
    nlQueryCounters.incrementTotal();

    try {
      await initialize();

      const { question, session_id } = req.body as NLQueryRequest;

      // Validate input
      if (!question || typeof question !== 'string') {
        metrics.decrementConcurrentRequests();
        const error = buildErrorResponse(
          requestId,
          'missing_question',
          'Please provide a "question" field with your natural language query',
          null,
          {
            suggestion: 'Include a "question" field in your JSON request body',
            details: { example: { question: 'Who was faster at Silverstone, Max or Lando?' } },
          }
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      if (question.length > MAX_NL_QUERY_LENGTH) {
        metrics.decrementConcurrentRequests();
        const error = buildErrorResponse(
          requestId,
          'question_too_long',
          `Question must be ${MAX_NL_QUERY_LENGTH} characters or less`,
          null,
          { suggestion: 'Shorten your question', details: { max_length: MAX_NL_QUERY_LENGTH, actual_length: question.length } }
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      const llmStartTime = Date.now();
      const parseResult = await claudeClient.parseIntent(question, requestId);
      const llmLatencyMs = Date.now() - llmStartTime;

      if (!parseResult.success || !parseResult.intent) {
        const totalLatencyMs = Date.now() - startTime;
        metrics.incrementError('nl_parse_failed');

        logNLQuery({
          request_id: requestId,
          question,
          status: 'error',
          cached: false,
          llm_latency_ms: llmLatencyMs,
          total_latency_ms: totalLatencyMs,
          error: parseResult.error,
        });

        metrics.decrementConcurrentRequests();
        const error = buildErrorResponse(
          requestId,
          'llm_parsing_failed',
          parseResult.error || 'Failed to parse question',
          null,
          { suggestion: 'Try rephrasing your question more clearly.' }
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      let queryIntent = parseResult.intent;

      // Apply conversation context if session_id provided
      if (session_id) {
        const previousContext = sessionContexts.get(session_id);
        const contextResult = applyConversationContext({
          raw_question: question,
          draft_intent: queryIntent,
          previous: previousContext,
        });
        queryIntent = contextResult.resolved_intent;
        sessionContexts.set(session_id, contextResult.updated_context);

        // Limit session context storage (prevent memory leak)
        if (sessionContexts.size > 10000) {
          const oldestKey = sessionContexts.keys().next().value;
          if (oldestKey) {
            sessionContexts.delete(oldestKey);
          }
        }
      }

      queryIntent.raw_query = question;
      queryKind = queryIntent.kind;
      metrics.incrementRequestCount(queryIntent.kind);


      const cacheKey = redisCache.generateCacheKey(queryIntent);
      const cacheResult = await redisCache.get<any>(cacheKey);

      if (cacheResult.hit && cacheResult.data) {
        const totalLatencyMs = Date.now() - startTime;

        logNLQuery({
          request_id: requestId,
          question,
          intent_kind: queryIntent.kind,
          status: 'success',
          cached: true,
          llm_latency_ms: llmLatencyMs,
          total_latency_ms: totalLatencyMs,
        });

        // debug info for cached response
        const cachedDebug: ExecutionDebugInfo = {
          intent_cache_hit: true,
          sql_executed: false,
          rows_returned: cacheResult.data.result?.metadata?.rows ?? 0,
          coverage_reason: null
        };

        metrics.decrementConcurrentRequests();
        nlQueryCounters.incrementSuccess();
        return res.json({
          request_id: requestId,
          error_type: null,
          query_kind: queryKind,
          question,
          queryIntent,
          result: cacheResult.data.result,
          answer: cacheResult.data.answer,
          cached: true,
          debug: cachedDebug,
          metadata: {
            llm_latency_ms: llmLatencyMs,
            sql_latency_ms: 0,
            total_latency_ms: totalLatencyMs,
            cache_key: cacheKey,
          },
        });
      }

      // Step 3: Execute query
      const sqlStartTime = Date.now();
      const interpretation = await buildInterpretationResponse({
        pool,
        executor,
        intent: queryIntent,
        raw_question: question,
      });
      const sqlLatencyMs = Date.now() - sqlStartTime;
      metrics.recordSQLLatency(sqlLatencyMs);

      // Check for execution errors
      if ('error' in interpretation.result) {
        const totalLatencyMs = Date.now() - startTime;
        const errorCode = interpretation.result.error as string;
        metrics.incrementError(errorCode);

        logNLQuery({
          request_id: requestId,
          question,
          intent_kind: queryIntent.kind,
          status: 'error',
          cached: false,
          llm_latency_ms: llmLatencyMs,
          sql_latency_ms: sqlLatencyMs,
          total_latency_ms: totalLatencyMs,
          error: interpretation.result.reason,
        });

        // build debug info for error case - sql was still executed
        const errorDebug: ExecutionDebugInfo = {
          intent_cache_hit: false,
          sql_executed: true,
          rows_returned: 0,
          coverage_reason: interpretation.result.reason || null
        };

        metrics.decrementConcurrentRequests();
        const error = buildErrorResponse(
          requestId,
          errorCode,
          interpretation.result.reason as string,
          queryKind,
          {
            details: {
              answer: interpretation.answer,
              fallbacks: interpretation.fallbacks,
              debug: errorDebug,
            },
          }
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      // Step 4: Store in cache (async, don't wait)
      const cacheData = {
        result: interpretation.result,
        answer: interpretation.answer,
        canonical_response: interpretation.canonical_response,
      };
      redisCache.set(cacheKey, cacheData, queryIntent.season).catch((err) => {
        console.warn(`[Redis] Failed to cache result: ${err.message}`);
      });

      // Step 5: Return response
      const totalLatencyMs = Date.now() - startTime;

      logNLQuery({
        request_id: requestId,
        question,
        intent_kind: queryIntent.kind,
        status: 'success',
        cached: false,
        llm_latency_ms: llmLatencyMs,
        sql_latency_ms: sqlLatencyMs,
        total_latency_ms: totalLatencyMs,
      });

      // build debug info from interpretation
      const debug: ExecutionDebugInfo = {
        intent_cache_hit: false,
        sql_executed: true,
        rows_returned: interpretation.result && 'metadata' in interpretation.result
          ? (interpretation.result as any).metadata?.rows ?? 0
          : 0,
        coverage_reason: interpretation.result && 'interpretation' in interpretation.result
          ? (interpretation.result as any).interpretation?.constraints?.rows_excluded_reason ?? null
          : null
      };

      metrics.decrementConcurrentRequests();
      nlQueryCounters.incrementSuccess();
      return res.json({
        request_id: requestId,
        error_type: null,
        query_kind: queryKind,
        question,
        queryIntent: interpretation.intent,
        result: interpretation.result,
        answer: interpretation.answer,
        cached: false,
        fallbacks: interpretation.fallbacks,
        supplemental_results: interpretation.supplemental_results,
        canonical_response: interpretation.canonical_response,
        debug,
        metadata: {
          llm_latency_ms: llmLatencyMs,
          sql_latency_ms: sqlLatencyMs,
          total_latency_ms: totalLatencyMs,
          cache_key: cacheKey,
        },
      });
    } catch (error: any) {
      const totalLatencyMs = Date.now() - startTime;
      metrics.incrementError('internal_error');
      metrics.decrementConcurrentRequests();

      console.error(`[NL Query] Error:`, error);

      logNLQuery({
        request_id: requestId,
        question: req.body?.question || 'unknown',
        status: 'error',
        cached: false,
        total_latency_ms: totalLatencyMs,
        error: error.message,
      });

      // Global safeguard: all uncaught exceptions return structured internal_error
      const structuredError = buildErrorResponse(
        requestId,
        'internal_error',
        'An unexpected error occurred. Please try again.',
        queryKind
      );
      return res.status(getStatusCode(structuredError.error_type)).json(structuredError);
    }
  });

  // Health check for NL endpoint
  router.get('/nl-query/health', async (_req: Request, res: Response) => {
    try {
      await initialize();
      const claudeHealthy = await claudeClient.healthCheck();
      const redisHealthy = await redisCache.healthCheck();

      const status = claudeHealthy ? 'healthy' : 'degraded';

      res.json({
        status,
        claude_api: claudeHealthy ? 'connected' : 'error',
        redis_cache: redisHealthy ? 'connected' : 'unavailable',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(503).json({
        status: 'unhealthy',
        error: error.message,
      });
    }
  });

  // Cache management endpoints
  router.delete('/nl-query/cache', async (_req: Request, res: Response) => {
    try {
      await initialize();
      const cleared = await redisCache.clearAll();
      res.json({
        success: cleared,
        message: cleared ? 'Cache cleared' : 'Cache clear failed or not available',
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get('/nl-query/cache/stats', async (_req: Request, res: Response) => {
    try {
      await initialize();
      const stats = await redisCache.getStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({
        error: error.message,
      });
    }
  });

  // Internal counters for failure tracking
  router.get('/nl-query/stats', (_req: Request, res: Response) => {
    res.json(nlQueryCounters.getStats());
  });

  return router;
}
