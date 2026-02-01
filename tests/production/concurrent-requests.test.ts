import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metrics } from '../../src/observability/metrics';

/**
 * Concurrent Request Safety Tests
 *
 * Verifies the system can safely handle multiple concurrent requests
 */

describe('Concurrent Request Safety', () => {
  beforeEach(() => {
    metrics.reset();
  });

  describe('Metrics Thread Safety', () => {
    it('should safely track concurrent requests', async () => {
      // Simulate 100 concurrent requests
      const concurrentRequests = 100;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < concurrentRequests; i++) {
        promises.push(
          (async () => {
            metrics.incrementConcurrentRequests();
            // Simulate some processing time
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            metrics.decrementConcurrentRequests();
          })()
        );
      }

      await Promise.all(promises);

      // After all requests complete, concurrent count should be 0
      const json = metrics.toJSON();
      expect(json.concurrency.current).toBe(0);
      expect(json.concurrency.peak).toBeGreaterThan(0);
      expect(json.concurrency.peak).toBeLessThanOrEqual(concurrentRequests);
    });

    it('should safely increment cache hits from multiple threads', async () => {
      const hitCount = 1000;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < hitCount; i++) {
        promises.push(
          (async () => {
            metrics.incrementCacheHit();
          })()
        );
      }

      await Promise.all(promises);

      const json = metrics.toJSON();
      expect(json.cache.hits).toBe(hitCount);
    });

    it('should safely record latencies from multiple threads', async () => {
      const recordCount = 1000;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < recordCount; i++) {
        promises.push(
          (async () => {
            metrics.recordNLParseLatency(Math.random() * 500);
            metrics.recordSQLLatency(Math.random() * 100);
            metrics.recordRequestLatency(Math.random() * 1000);
          })()
        );
      }

      await Promise.all(promises);

      const json = metrics.toJSON();
      expect(json.nl_parse.latency.count).toBe(recordCount);
      expect(json.sql_execution.count).toBe(recordCount);
    });

    it('should safely track requests by query kind', async () => {
      const queryKinds = [
        'driver_season_summary',
        'race_results_summary',
        'teammate_gap_summary_season',
        'track_fastest_drivers',
        'driver_career_summary',
      ];
      const requestsPerKind = 200;
      const promises: Promise<void>[] = [];

      for (const kind of queryKinds) {
        for (let i = 0; i < requestsPerKind; i++) {
          promises.push(
            (async () => {
              metrics.incrementRequestCount(kind);
            })()
          );
        }
      }

      await Promise.all(promises);

      const json = metrics.toJSON();
      for (const kind of queryKinds) {
        expect(json.requests_by_kind[kind]).toBe(requestsPerKind);
      }
    });

    it('should safely track errors by type', async () => {
      const errorTypes = [
        'validation_failed',
        'execution_failed',
        'llm_parsing_failed',
        'internal_error',
      ];
      const errorsPerType = 100;
      const promises: Promise<void>[] = [];

      for (const errorType of errorTypes) {
        for (let i = 0; i < errorsPerType; i++) {
          promises.push(
            (async () => {
              metrics.incrementError(errorType);
            })()
          );
        }
      }

      await Promise.all(promises);

      const json = metrics.toJSON();
      for (const errorType of errorTypes) {
        expect(json.errors_by_type[errorType]).toBe(errorsPerType);
      }
    });
  });

  describe('Prometheus Output', () => {
    it('should generate valid Prometheus format', () => {
      // Add some metrics
      metrics.incrementCacheHit();
      metrics.incrementCacheMiss();
      metrics.recordNLParseLatency(250);
      metrics.recordSQLLatency(50);
      metrics.incrementRequestCount('driver_season_summary');

      const prometheus = metrics.toPrometheus();

      // Should contain required Prometheus format elements
      expect(prometheus).toContain('# HELP');
      expect(prometheus).toContain('# TYPE');
      expect(prometheus).toContain('f1muse_cache_hits_total');
      expect(prometheus).toContain('f1muse_cache_misses_total');
      expect(prometheus).toContain('f1muse_nl_parse_latency_ms');
      expect(prometheus).toContain('_bucket{le=');
      expect(prometheus).toContain('_sum');
      expect(prometheus).toContain('_count');
    });

    it('should include histogram buckets', () => {
      metrics.recordNLParseLatency(100);
      metrics.recordNLParseLatency(200);
      metrics.recordNLParseLatency(500);

      const prometheus = metrics.toPrometheus();

      // Should have buckets at expected boundaries
      expect(prometheus).toContain('le="100"');
      expect(prometheus).toContain('le="250"');
      expect(prometheus).toContain('le="500"');
      expect(prometheus).toContain('le="+Inf"');
    });
  });

  describe('JSON Output', () => {
    it('should generate valid JSON metrics', () => {
      metrics.incrementCacheHit();
      metrics.incrementCacheMiss();
      metrics.recordNLParseLatency(250);
      metrics.incrementNLParseSuccess();
      metrics.incrementNLParseFailure('test error');

      const json = metrics.toJSON();

      expect(json).toHaveProperty('nl_parse');
      expect(json).toHaveProperty('sql_execution');
      expect(json).toHaveProperty('cache');
      expect(json).toHaveProperty('requests_by_kind');
      expect(json).toHaveProperty('errors_by_type');
      expect(json).toHaveProperty('concurrency');
    });

    it('should calculate cache hit rate correctly', () => {
      metrics.incrementCacheHit();
      metrics.incrementCacheHit();
      metrics.incrementCacheMiss();
      metrics.incrementCacheMiss();
      metrics.incrementCacheMiss();

      const json = metrics.toJSON();

      // 2 hits / 5 total = 0.4
      expect(json.cache.hit_rate).toBeCloseTo(0.4);
    });

    it('should calculate average latency correctly', () => {
      metrics.recordNLParseLatency(100);
      metrics.recordNLParseLatency(200);
      metrics.recordNLParseLatency(300);

      const json = metrics.toJSON();

      // (100 + 200 + 300) / 3 = 200
      expect(json.nl_parse.latency.avg_ms).toBe(200);
    });
  });

  describe('Reset functionality', () => {
    it('should reset all metrics to initial state', () => {
      // Add various metrics
      metrics.incrementCacheHit();
      metrics.incrementCacheMiss();
      metrics.recordNLParseLatency(250);
      metrics.incrementNLParseSuccess();
      metrics.incrementNLParseFailure('test');
      metrics.incrementRequestCount('driver_season_summary');
      metrics.incrementError('test_error');
      metrics.incrementConcurrentRequests();

      // Reset
      metrics.reset();

      const json = metrics.toJSON();

      expect(json.cache.hits).toBe(0);
      expect(json.cache.misses).toBe(0);
      expect(json.nl_parse.success_count).toBe(0);
      expect(json.nl_parse.failure_count).toBe(0);
      expect(json.nl_parse.latency.count).toBe(0);
      expect(Object.keys(json.requests_by_kind)).toHaveLength(0);
      expect(Object.keys(json.errors_by_type)).toHaveLength(0);
      expect(json.concurrency.current).toBe(0);
      expect(json.concurrency.peak).toBe(0);
    });
  });
});
