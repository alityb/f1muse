import 'dotenv/config';
import express from 'express';
import {
  createPrimaryPool,
  createReplicaPool,
  getPoolConnectionInfo
} from './db/pool';
import { createRoutes } from './api/routes';
import { createProductionNLQueryRouter } from './api/nl-query-production';
import { startCacheMaintenanceInterval } from './cache/maintenance';
import { startAutoSyncInterval, runSync, getSyncStatus, stopAutoSync } from './sync/auto-sync';
import { initRedisCache, getRedisCache } from './cache/redis-cache';
import { createMetricsRouter, metricsMiddleware } from './observability/metrics';
import {
  apiRateLimiter,
  requestTimeout,
  configureCORS,
  requestLogger,
  logError
} from './api/middleware/production-safety';
import { getConfig } from './llm/config';
import { isLLMConfigured } from './llm/claude-client';
import { logInvariantMode } from './execution/invariants';
import { requireAdmin } from './api/middleware/admin-auth';

/**
 * F1 Muse API - Production Entry Point
 *
 * Features:
 * - Claude API for NL parsing (no local LLM)
 * - Redis caching layer
 * - Prometheus-compatible metrics
 * - Rate limiting
 * - Request timeout (15s for API, allows for Claude latency)
 * - Graceful shutdown
 */
async function main() {
  const app = express();
  const port = process.env.PORT || 3000;

  // log llm config at startup
  const llmConfig = getConfig();
  console.log('LLM configuration:');
  console.log(`  Concurrency limit: ${llmConfig.maxConcurrency}`);
  console.log(`  Queue timeout: ${llmConfig.queueTimeoutMs}ms`);
  console.log(`  Max retries: ${llmConfig.maxRetries}`);
  if (llmConfig.corpusTestMode) {
    console.log('  ⚠️  CORPUS TEST MODE ENABLED');
    console.log(`  Inter-call delay: ${llmConfig.corpusTestDelayMs}ms`);
  }

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
  app.use('/query', apiRateLimiter);
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

  // Start background cache maintenance (Postgres cache, every 60 minutes)
  let maintenanceInterval: NodeJS.Timeout | null = null;
  try {
    maintenanceInterval = startCacheMaintenanceInterval(primaryPool, 60 * 60 * 1000, {
      max_entries: 250_000,
      verbose: true
    });
    console.log('✓ Cache maintenance scheduled (every 60 minutes)');
  } catch (err) {
    logError(err, { context: 'cache_maintenance_startup_failed' });
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

  // Clear all derived query data after an ingestion or methodology correction.
  app.delete('/admin/cache', requireAdmin, async (_req, res) => {
    try {
      const [queryCache, redisCleared] = await Promise.all([
        primaryPool.query('DELETE FROM api_query_cache'),
        getRedisCache().clearAll(),
      ]);
      res.json({
        ok: true,
        postgres_entries_deleted: queryCache.rowCount ?? 0,
        redis_cleared: redisCleared,
      });
    } catch (err) {
      logError(err, { context: 'admin_cache_clear_failed' });
      res.status(500).json({ ok: false, error: 'cache_clear_failed' });
    }
  });

  // Register routes
  const routes = createRoutes(replicaPool, primaryPool);
  app.use('/', routes);

  // Register production NL query router when either supported provider is configured.
  if (isLLMConfigured()) {
    const nlRouter = createProductionNLQueryRouter(replicaPool, primaryPool);
    app.use('/', nlRouter);
    console.log('✓ Natural language query endpoint enabled (/nl-query)');
  } else {
    console.log('⚠ NL query endpoint disabled (configure Anthropic or an OpenAI-compatible LLM)');
  }

  // Health check endpoint
  app.get('/health', async (_req, res) => {
    const redisCache = getRedisCache();
    const redisHealthy = await redisCache.healthCheck();

    res.json({
      status: 'healthy',
      database: 'connected',
      redis: redisHealthy ? 'connected' : 'unavailable',
      llm: isLLMConfigured() ? 'configured' : 'not_configured',
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
    console.log(`  POST /query       - Execute QueryIntent`);
    console.log(`  POST /nl-query    - Natural language query (Claude-powered)`);
    console.log(`  GET  /health      - Health check`);
    console.log(`  GET  /metrics     - Prometheus metrics`);
    console.log(`  GET  /metrics/json - JSON metrics`);
    console.log(`  GET  /capabilities - API capabilities`);
    console.log(`  GET  /suggestions  - Query suggestions`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Stop accepting new connections
    server.close();

    // Clear maintenance interval
    if (maintenanceInterval) {
      clearInterval(maintenanceInterval);
    }

    // Clear auto-sync interval
    if (autoSyncInterval) {
      clearInterval(autoSyncInterval);
    }
    stopAutoSync();

    // Close Redis
    const redisCache = getRedisCache();
    await redisCache.disconnect();

    // Close database pools
    await Promise.all([replicaPool.end(), primaryPool.end()]);

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
