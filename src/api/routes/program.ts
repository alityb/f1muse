import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { ZodError } from 'zod';
import { executeF1QL } from '../../f1ql/executor';

export function createProgramRoutes(pool: Pool): Router {
  const router = Router();

  router.post('/program', async (req: Request, res: Response) => {
    try {
      const result = await executeF1QL(pool, req.body);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: 'validation_failed',
          reason: error.issues.map((issue) => issue.message).join('; ')
        });
      }

      return res.status(500).json({
        error: 'execution_failed',
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return router;
}
