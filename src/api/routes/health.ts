import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { getTeammateGapCoverageSummary } from '../../observability/teammate-gap-coverage';

export function createHealthRoutes(pool: Pool): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      return res.status(200).json({
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      return res.status(503).json({
        status: 'unhealthy',
        database: 'disconnected',
        error: String(err),
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/health/db', async (_req: Request, res: Response) => {
    let connInfo = { host: 'unknown', ssl: false };
    try {
      const poolModule = await import('../../db/pool');
      if (poolModule.getConnectionInfo) {
        connInfo = poolModule.getConnectionInfo();
      }
    } catch {
      // ignore import errors
    }

    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      const latencyMs = Date.now() - start;

      return res.status(200).json({
        connected: true,
        host: connInfo.host,
        ssl: connInfo.ssl,
        latency_ms: latencyMs
      });
    } catch (err) {
      return res.status(503).json({
        connected: false,
        host: connInfo.host,
        ssl: connInfo.ssl,
        latency_ms: 0,
        error: String(err)
      });
    }
  });

  router.get('/health/coverage/teammate-gap', async (req: Request, res: Response) => {
    try {
      const seasonParam = req.query.season;
      const metricParam = req.query.metric;

      if (!seasonParam || typeof seasonParam !== 'string') {
        return res.status(400).json({
          error: 'validation_failed',
          reason: 'season query parameter is required'
        });
      }

      if (metricParam && typeof metricParam !== 'string') {
        return res.status(400).json({
          error: 'validation_failed',
          reason: 'metric must be "race" or "qualifying"'
        });
      }

      const season = parseInt(seasonParam, 10);
      if (isNaN(season) || season < 1950 || season > 2100) {
        return res.status(400).json({
          error: 'validation_failed',
          reason: 'season must be a valid year'
        });
      }

      const metric = metricParam === 'qualifying' ? 'qualifying' : 'race';
      if (metricParam && metricParam !== 'race' && metricParam !== 'qualifying') {
        return res.status(400).json({
          error: 'validation_failed',
          reason: 'metric must be "race" or "qualifying"'
        });
      }

      const coverage = await getTeammateGapCoverageSummary(pool, season, metric);
      return res.status(200).json(coverage);
    } catch (err) {
      console.error('Error in /health/coverage/teammate-gap:', err);
      return res.status(500).json({
        error: 'execution_failed',
        reason: `Unexpected error: ${err}`
      });
    }
  });

  return router;
}
