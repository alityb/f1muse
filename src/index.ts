import 'dotenv/config';
import express from 'express';
import {
  createPrimaryPool,
  createReplicaPool,
  createAnswerPool,
  getPoolConnectionInfo
} from './db/pool';
import { createRoutes } from './api/routes';
import { startAutoSyncInterval, runSync, getSyncStatus, stopAutoSync } from './sync/auto-sync';
import { initRedisCache, getRedisCache } from './cache/redis-cache';
import { createMetricsRouter, metricsMiddleware } from './observability/metrics';
import {
  apiRateLimiter,
  nlQueryRateLimiter,
  requestTimeout,
  configureCORS,
  requestLogger,
  logError
} from './api/middleware/production-safety';
import { logInvariantMode } from './execution/invariants';
import { requireAdmin } from './api/middleware/admin-auth';

/**
 * F1 Muse API - Production Entry Point
 *
 * Features:
 * - Deterministic F1QL natural-language answers
 * - Redis caching layer
 * - Prometheus-compatible metrics
 * - Rate limiting
 * - Request timeout (15s for API, allows for Claude latency)
 * - Graceful shutdown
 */
async function main() {
  const app = express();
  // Railway terminates one proxy hop before the application; preserve client IP rate-limit keys.
  app.set('trust proxy', 1);
  const port = process.env.PORT || 3000;

  // Log invariant enforcement mode
  logInvariantMode();

  // Metrics middleware (must be first to capture all requests)
  app.use(metricsMiddleware());

  // Request logging
  app.use(requestLogger);

  // Request timeout (15s - allows for Claude API latency)
  app.use(requestTimeout(15000));

  // Parse JSON bodies (16KB limit for cost protection)
  app.use(express.json({ limit: '16kb' }));

  // Production-safe CORS
  app.use(configureCORS());

  // Rate limiting
  app.use('/program', apiRateLimiter);
  app.use('/program/translate', nlQueryRateLimiter);
  app.use('/nl-query', apiRateLimiter);

  // Metrics endpoint (no rate limiting)
  app.use('/', createMetricsRouter());

  // Log connection attempt
  const poolInfo = getPoolConnectionInfo();
  console.log('Database configuration:');
  console.log(`  Primary: ${poolInfo.primary.host} (SSL: ${poolInfo.primary.ssl ? 'enabled' : 'disabled'})`);
  if (poolInfo.using_replica) {
    console.log(`  Replica: ${poolInfo.replica.host} (SSL: ${poolInfo.replica.ssl ? 'enabled' : 'disabled'})`);
  } else {
    console.log('  Replica: using primary (DATABASE_URL_REPLICA not set)');
  }

  // Create database pools
  const replicaPool = createReplicaPool();
  const primaryPool = createPrimaryPool();
  const answerPool = process.env.F1QL_ANSWER_DATABASE_URL ? createAnswerPool() : undefined;

  // Test replica connection
  try {
    await replicaPool.query('SELECT 1');
    console.log(`✓ Connected to replica: ${poolInfo.replica.host} (READ-ONLY mode)`);
  } catch (err) {
    logError(err, {
      context: 'replica_connection_failed',
      host: poolInfo.replica.host
    });
    console.error('\nTroubleshooting:');
    console.error('  - Check if DATABASE_URL or DATABASE_URL_REPLICA is correct');
    console.error('  - Verify network connectivity to the database host');
    console.error('  - For Supabase: check if the project is active (not paused)');
    process.exit(1);
  }

  // Test primary connection (for writes)
  try {
    await primaryPool.query('SELECT 1');
    console.log(`✓ Connected to primary: ${poolInfo.primary.host} (WRITE access)`);
  } catch (err) {
    logError(err, {
      context: 'primary_connection_failed',
      host: poolInfo.primary.host,
      note: 'Cache writes will be disabled'
    });
    console.error('⚠ Primary database connection failed - cache writes disabled');
  }

  // Initialize Redis cache (optional - graceful degradation if unavailable)
  let redisConnected = false;
  if (process.env.REDIS_URL) {
    try {
      const redis = await initRedisCache();
      redisConnected = redis.isAvailable();
      if (redisConnected) {
        console.log('✓ Redis cache connected');
      } else {
        console.log('✓ Redis cache: disabled (connection unavailable)');
      }
    } catch (err) {
      console.log('✓ Redis cache: disabled (connection failed)');
    }
  } else {
    // Only show warning in development - in production, this is an intentional configuration
    if (process.env.NODE_ENV !== 'production') {
      console.log('✓ Redis cache: disabled (REDIS_URL not set)');
    } else {
      console.log('✓ Redis cache: disabled');
    }
  }

  // Start auto-sync (Jolpica race results + standings, every 2 hours)
  // Lap data (FastF1 Python ETL) still needs to be triggered manually after each race.
  let autoSyncInterval: NodeJS.Timeout | null = null;
  if (process.env.AUTO_SYNC !== 'false') {
    try {
      autoSyncInterval = startAutoSyncInterval(primaryPool);
    } catch (err) {
      logError(err, { context: 'auto_sync_startup_failed' });
    }
  }

  // Manual sync trigger (also used by Railway Cron for FastF1 ETL)
  app.post('/admin/sync', requireAdmin, async (_req, res) => {
    const status = getSyncStatus();
    if (status.inProgress) {
      res.json({ ok: false, message: 'sync already in progress' });
      return;
    }
    // Fire-and-forget — respond immediately, sync runs in background
    runSync(primaryPool).catch(console.error);
    res.json({ ok: true, message: 'sync started', lastSyncAt: status.lastSyncAt });
  });

  // Sync status endpoint
  app.get('/admin/sync/status', requireAdmin, (_req, res) => {
    res.json(getSyncStatus());
  });

  // Register routes
  const routes = createRoutes(replicaPool, primaryPool, answerPool);
  app.use('/', routes);

  // Health check endpoint
  app.get('/health', async (_req, res) => {
    const redisCache = getRedisCache();
    const redisHealthy = await redisCache.healthCheck();

    res.json({
      status: 'healthy',
      database: 'connected',
      redis: redisHealthy ? 'connected' : 'unavailable',
      answer: process.env.F1QL_ANSWER_ENABLED === 'true' && process.env.F1QL_ANSWER_KILL_SWITCH !== 'true' ? 'enabled' : 'disabled',
      timestamp: new Date().toISOString()
    });
  });

  // Readiness probe (for Kubernetes)
  app.get('/ready', async (_req, res) => {
    try {
      await replicaPool.query('SELECT 1');
      res.status(200).send('OK');
    } catch {
      res.status(503).send('NOT READY');
    }
  });

  // Liveness probe (for Kubernetes)
  app.get('/live', (_req, res) => {
    res.status(200).send('OK');
  });

  // Start server
  const server = app.listen(port, () => {
    console.log(`\nF1 Muse API listening on port ${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /nl-query    - Natural-language F1QL answer`);
    console.log(`  GET  /health      - Health check`);
    console.log(`  GET  /metrics     - Prometheus metrics`);
    console.log(`  GET  /metrics/json - JSON metrics`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Stop accepting new connections
    server.close();

    // Clear auto-sync interval
    if (autoSyncInterval) {
      clearInterval(autoSyncInterval);
    }
    stopAutoSync();

    // Close Redis
    const redisCache = getRedisCache();
    await redisCache.disconnect();

    // Close database pools
    await Promise.all([replicaPool.end(), primaryPool.end(), answerPool?.end()]);

    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

// Run
main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
