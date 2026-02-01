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

  // Initialize Redis cache (graceful degradation if unavailable)
  let redisConnected = false;
  if (process.env.REDIS_URL) {
    try {
      const redis = await initRedisCache();
      redisConnected = redis.isAvailable();
      if (redisConnected) {
        console.log(`✓ Redis cache connected`);
      } else {
        console.log('⚠ Redis cache unavailable - operating without cache');
      }
    } catch (err) {
      console.log('⚠ Redis cache connection failed - operating without cache');
    }
  } else {
    console.log('⚠ REDIS_URL not set - operating without Redis cache');
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

  // Register routes
  const routes = createRoutes(replicaPool, primaryPool);
  app.use('/', routes);

  // Register production NL query router (Claude API only)
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    const nlRouter = createProductionNLQueryRouter(replicaPool, primaryPool);
    app.use('/', nlRouter);
    console.log('✓ Natural language query endpoint enabled (/nl-query)');
  } else {
    console.log('⚠ NL query endpoint disabled (set ANTHROPIC_API_KEY or CLAUDE_API_KEY)');
  }

  // Health check endpoint
  app.get('/health', async (_req, res) => {
    const redisCache = getRedisCache();
    const redisHealthy = await redisCache.healthCheck();

    res.json({
      status: 'healthy',
      database: 'connected',
      redis: redisHealthy ? 'connected' : 'unavailable',
      claude_api: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY ? 'configured' : 'not_configured',
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
