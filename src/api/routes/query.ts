import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { QueryExecutor } from '../../execution/query-executor';
import { QueryLogger } from '../../execution/query-logger';
import { QueryIntent } from '../../types/query-intent';
import { QueryError } from '../../types/results';
import { buildInterpretationResponse } from '../../presentation/interpretation-builder';

export function createQueryRoutes(pool: Pool, executor: QueryExecutor, logger: QueryLogger): Router {
  const router = Router();

  router.post('/query', async (req: Request, res: Response) => {
    try {
      const proposedIntent = req.body as QueryIntent;
      console.log('Received query intent:', JSON.stringify(proposedIntent, null, 2));

      const interpretation = await buildInterpretationResponse({
        pool,
        executor,
        intent: proposedIntent
      });

      if ('error' in interpretation.result) {
        console.log('Execution failed:', interpretation.result.reason);
        logFailure(logger, proposedIntent, interpretation.result as QueryError);

        const status = interpretation.result.error === 'execution_failed' ? 500 : 400;
        return res.status(status).json({
          ...interpretation.result,
          answer: interpretation.answer,
          fallbacks: interpretation.fallbacks,
          supplemental_results: interpretation.supplemental_results,
          canonical_response: interpretation.canonical_response
        });
      }

      logger.logSuccess(proposedIntent, interpretation.result);
      console.log('Query executed successfully');

      return res.status(200).json({
        ...interpretation.result,
        answer: interpretation.answer,
        fallbacks: interpretation.fallbacks,
        supplemental_results: interpretation.supplemental_results,
        canonical_response: interpretation.canonical_response
      });
    } catch (err) {
      console.error('Unexpected error in /query:', err);
      return res.status(500).json({
        error: 'execution_failed',
        reason: `Unexpected server error: ${err}`
      } as QueryError);
    }
  });

  return router;
}

function logFailure(logger: QueryLogger, intent: QueryIntent, error: QueryError): void {
  if (error.error === 'validation_failed' || error.error === 'intent_resolution_failed') {
    logger.logValidationFailure(intent, error);
  } else {
    logger.logExecutionFailure(intent, error);
  }
}
