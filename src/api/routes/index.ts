import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { createHealthRoutes } from './health';
import { createDriverRoutes } from './driver';
import { createDebugRoutes } from './debug';
import { createShareRoutes } from './share';
import { createProgramRoutes } from './program';
import { createProgramTranslateRoutes } from './program-translate';
import { createProgramAnswerRoutes, createPublicAnswerRoutes } from './program-answer';
import { createProgramSemanticShadowRoutes } from './program-semantic-shadow';

export function createRoutes(pool: Pool, cachePool?: Pool, answerPool?: Pool): Router {
  const router = Router();

  router.use('/', createHealthRoutes(pool));
  router.use('/', createDriverRoutes(pool));
  router.use('/', createShareRoutes(cachePool ?? pool));
  if (process.env.F1QL_ENABLED === 'true') {
    router.use('/', createProgramRoutes(pool));
  }
  if (process.env.F1QL_TRANSLATION_ENABLED === 'true') {
    router.use('/', createProgramTranslateRoutes(pool));
  }
  router.use('/', createProgramSemanticShadowRoutes(answerPool));
  router.use('/', createProgramAnswerRoutes(answerPool));
  router.use('/', createPublicAnswerRoutes(answerPool));

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
    'GET /share/:id': 'Retrieve shared result (no recomputation)',
    'GET /share-feed': 'Discovery feed (trending + recent shares)',
    'GET /health': 'Health check',
    'GET /health/db': 'Database connection health',
    'GET /health/coverage/teammate-gap': 'Teammate gap coverage stats',
    'GET /driver/:driver_id/profile': 'Driver profile summary',
    'GET /driver/:driver_id/trend': 'Driver trend analysis',
    'GET /': 'API information'
  };

  if (process.env.F1QL_ENABLED === 'true') {
    endpoints['POST /program'] = 'Execute a validated F1QL program';
    endpoints['GET /program/verified'] = 'List curated verified F1QL programs';
    endpoints['POST /program/verified/:id'] = 'Execute a curated verified F1QL program';
  }
  if (process.env.F1QL_ANSWER_ENABLED === 'true' && process.env.F1QL_ANSWER_KILL_SWITCH !== 'true') {
    endpoints['POST /program/answer'] = 'Gated natural-language F1QL answer pipeline';
  }
  if (process.env.F1QL_ANSWER_ENABLED === 'true' && process.env.F1QL_PUBLIC_ANSWER_ENABLED === 'true' && process.env.F1QL_ANSWER_KILL_SWITCH !== 'true') {
    endpoints['POST /nl-query'] = 'Public natural-language F1QL answer pipeline';
  }
  if (process.env.F1QL_SEMANTIC_SHADOW_ENABLED === 'true' &&
      process.env.F1QL_SEMANTIC_SHADOW_KILL_SWITCH !== 'true' &&
      process.env.F1QL_SEMANTIC_SHADOW_STAGE === '0') {
    endpoints['POST /program/semantic-shadow'] = 'Internal non-executing semantic shadow planner';
  }

  // Debug endpoints only in development
  if (process.env.NODE_ENV !== 'production') {
    endpoints['GET /debug/coverage/teammate-gap'] = 'Teammate gap coverage introspection (dev only)';
  }

  return endpoints;
}
