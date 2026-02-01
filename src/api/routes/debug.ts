import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { getTeammateGapCoverage } from '../../observability/teammate-gap-coverage';

export function createDebugRoutes(pool: Pool): Router {
  const router = Router();

  router.get('/debug/coverage/teammate-gap', async (req: Request, res: Response) => {
    try {
      const seasonParam = req.query.season;
      const driverA = req.query.driver_a;
      const driverB = req.query.driver_b;
      const metricParam = req.query.metric;

      const validation = validateParams(seasonParam, driverA, driverB, metricParam);
      if (validation.error) {
        return res.status(400).json({ error: 'validation_failed', reason: validation.reason });
      }

      const coverage = await getTeammateGapCoverage(pool, validation.season!, driverA as string, driverB as string, validation.metric!);
      return res.status(200).json(coverage);
    } catch (err) {
      console.error('Error in /debug/coverage/teammate-gap:', err);
      return res.status(500).json({ error: 'execution_failed', reason: `Unexpected error: ${err}` });
    }
  });

  return router;
}

function validateParams(
  seasonParam: unknown,
  driverA: unknown,
  driverB: unknown,
  metricParam: unknown
): { error: boolean; reason?: string; season?: number; metric?: 'race' | 'qualifying' } {
  if (!seasonParam || typeof seasonParam !== 'string') {
    return { error: true, reason: 'season query parameter is required' };
  }

  if (!driverA || typeof driverA !== 'string') {
    return { error: true, reason: 'driver_a query parameter is required' };
  }

  if (!driverB || typeof driverB !== 'string') {
    return { error: true, reason: 'driver_b query parameter is required' };
  }

  if (metricParam && typeof metricParam !== 'string') {
    return { error: true, reason: 'metric must be "race" or "qualifying"' };
  }

  const season = parseInt(seasonParam, 10);
  if (isNaN(season) || season < 1950 || season > 2100) {
    return { error: true, reason: 'season must be a valid year' };
  }

  const metric = metricParam === 'qualifying' ? 'qualifying' : 'race';
  if (metricParam && metricParam !== 'race' && metricParam !== 'qualifying') {
    return { error: true, reason: 'metric must be "race" or "qualifying"' };
  }

  return { error: false, season, metric };
}
