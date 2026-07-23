import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { QueryExecutor } from '../../execution/query-executor';
import { QueryLogger } from '../../execution/query-logger';
import { createNLQueryRouter } from '../nl-query';
import { createHealthRoutes } from './health';
import { createCapabilitiesRoutes } from './capabilities';
import { createQueryRoutes } from './query';
import { createDriverRoutes } from './driver';
import { createDebugRoutes } from './debug';
import { createShareRoutes } from './share';
import { createProgramRoutes } from './program';
import { createProgramTranslateRoutes } from './program-translate';
import { isLLMConfigured } from '../../llm/claude-client';

export function createRoutes(pool: Pool, cachePool?: Pool): Router {
  const router = Router();
  const executor = new QueryExecutor(pool, undefined, cachePool);
  const logger = new QueryLogger();

  const hasLocalLLM = process.env.MISTRAL_RS_URL && process.env.MISTRAL_RS_MODEL_ID;
  if (hasLocalLLM) {
    const nlQueryRouter = createNLQueryRouter(pool, cachePool);
    router.use('/', nlQueryRouter);
    console.log('[NL Query] Using LLM backend: mistral-rs (deprecated - use ANTHROPIC_API_KEY instead)');
  }

  router.use('/', createHealthRoutes(pool));
  router.use('/', createCapabilitiesRoutes());
  router.use('/', createQueryRoutes(pool, executor, logger));
  router.use('/', createDriverRoutes(pool));
  router.use('/', createShareRoutes(pool, executor, cachePool));
  if (process.env.F1QL_ENABLED === 'true') {
    router.use('/', createProgramRoutes(pool));
  }
  if (process.env.F1QL_TRANSLATION_ENABLED === 'true') {
    router.use('/', createProgramTranslateRoutes(pool));
  }

  // Debug routes only in development
  if (process.env.NODE_ENV !== 'production') {
    router.use('/', createDebugRoutes(pool));
  }

  router.get('/', (_req: Request, res: Response) => {
    const endpoints = buildEndpointList();
    return res.status(200).json({
      name: 'F1 Analytics API',
      description: 'Deterministic F1 analytics query validation and execution',
      version: '1.0.0',
      endpoints
    });
  });

  return router;
}

function buildEndpointList(): Record<string, string> {
  const endpoints: Record<string, string> = {
    'POST /query': 'Execute a validated QueryIntent',
    'POST /share': 'Create shareable link from query result',
    'GET /share/:id': 'Retrieve shared result (no recomputation)',
    'GET /share-feed': 'Discovery feed (trending + recent shares)',
    'GET /health': 'Health check',
    'GET /health/db': 'Database connection health',
    'GET /health/coverage/teammate-gap': 'Teammate gap coverage stats',
    'GET /capabilities': 'System capabilities',
    'GET /suggestions': 'Query suggestions',
    'GET /driver/:driver_id/profile': 'Driver profile summary',
    'GET /driver/:driver_id/trend': 'Driver trend analysis',
    'GET /': 'API information'
  };

  if (process.env.F1QL_ENABLED === 'true') {
    endpoints['POST /program'] = 'Execute a validated F1QL program';
    endpoints['GET /program/verified'] = 'List curated verified F1QL programs';
    endpoints['POST /program/verified/:id'] = 'Execute a curated verified F1QL program';
  }

  // Debug endpoints only in development
  if (process.env.NODE_ENV !== 'production') {
    endpoints['GET /debug/coverage/teammate-gap'] = 'Teammate gap coverage introspection (dev only)';
  }

  const llmConfigured = isLLMConfigured() ||
                        (process.env.MISTRAL_RS_URL && process.env.MISTRAL_RS_MODEL_ID);

  if (llmConfigured) {
    let backend = 'Claude';
    if (process.env.MISTRAL_RS_URL && process.env.MISTRAL_RS_MODEL_ID) {
      backend = 'Mistral-RS';
    } else if (process.env.LLM_PROVIDER === 'openai-compatible') {
      backend = 'compatible inference provider';
    }
    endpoints['POST /nl-query'] = `Natural language query (powered by ${backend})`;
  }

  return endpoints;
}
