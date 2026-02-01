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
  router.use('/', createDebugRoutes(pool));
  router.use('/', createShareRoutes(pool, executor, cachePool));

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
    'GET /debug/coverage/teammate-gap': 'Teammate gap coverage introspection',
    'GET /driver/:driver_id/profile': 'Driver profile summary',
    'GET /driver/:driver_id/trend': 'Driver trend analysis',
    'GET /': 'API information'
  };

  const llmConfigured = process.env.ANTHROPIC_API_KEY ||
                        process.env.CLAUDE_API_KEY ||
                        (process.env.MISTRAL_RS_URL && process.env.MISTRAL_RS_MODEL_ID);

  if (llmConfigured) {
    const backend = (process.env.MISTRAL_RS_URL && process.env.MISTRAL_RS_MODEL_ID) ? 'Mistral-RS' : 'Claude';
    endpoints['POST /nl-query'] = `Natural language query (powered by ${backend})`;
  }

  return endpoints;
}
