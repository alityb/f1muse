import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { ZodError } from 'zod';
import { executeF1QL, F1QLCostLimitError } from '../../f1ql/executor';
import { metrics } from '../../observability/metrics';

export function createProgramRoutes(pool: Pool): Router {
  const router = Router();

  router.post('/program', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const operation = getOperation(req.body);
    try {
      const result = await executeF1QL(pool, req.body);
      metrics.recordF1QL(operation, 'success', Date.now() - startedAt);
      console.log('[F1QL]', JSON.stringify({ operation, status: 'success', rows_returned: result.rows.length }));
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof ZodError) {
        metrics.recordF1QL(operation, 'rejected', Date.now() - startedAt);
        console.log('[F1QL]', JSON.stringify({ operation, status: 'rejected', reason: 'validation_failed' }));
        return res.status(400).json({
          error: 'validation_failed',
          reason: error.issues.map((issue) => issue.message).join('; ')
        });
      }

      if (error instanceof F1QLCostLimitError) {
        metrics.recordF1QL(operation, 'rejected', Date.now() - startedAt);
        console.log('[F1QL]', JSON.stringify({ operation, status: 'rejected', reason: error.message }));
        return res.status(400).json({ error: 'cost_limit_exceeded', reason: error.message });
      }

      metrics.recordF1QL(operation, 'failed', Date.now() - startedAt);
      console.log('[F1QL]', JSON.stringify({ operation, status: 'failed' }));
      return res.status(500).json({
        error: 'execution_failed',
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return router;
}

function getOperation(body: unknown): 'aggregate' | 'rank' | 'pace_delta' | 'pace_summary' | 'invalid' {
  const operation = (body as { root?: { op?: unknown } })?.root?.op;
  return operation === 'aggregate' || operation === 'rank' || operation === 'pace_delta' || operation === 'pace_summary'
    ? operation
    : 'invalid';
}
