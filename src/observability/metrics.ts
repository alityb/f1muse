/**
 * PRODUCTION OBSERVABILITY - METRICS COLLECTION
 *
 * Lightweight metrics collection for F1 Muse API
 * Exposes Prometheus-compatible /metrics endpoint
 *
 * Collected metrics:
 * - NL parse latency histogram
 * - SQL execution latency
 * - Total request latency
 * - Cache hit/miss rates
 * - Error counts by type
 * - Requests per query kind
 */

import { Router, Request, Response } from 'express';

// Histogram bucket boundaries (milliseconds)
const LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface HistogramData {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

// CounterData interface reserved for future labeled counter support
// interface CounterData {
//   value: number;
//   labels: Map<string, number>;
// }

/**
 * Metrics collector singleton
 */
class MetricsCollector {
  // Histograms
  private nlParseLatency: HistogramData;
  private sqlExecutionLatency: HistogramData;
  private formattingLatency: HistogramData;
  private totalRequestLatency: HistogramData;

  // Counters
  private cacheHits: number = 0;
  private cacheMisses: number = 0;
  private nlParseSuccess: number = 0;
  private nlParseFailures: Map<string, number> = new Map();
  private requestsByQueryKind: Map<string, number> = new Map();
  private errorsByType: Map<string, number> = new Map();

  // Gauges
  private activeConcurrentRequests: number = 0;
  private peakConcurrentRequests: number = 0;

  // LLM pressure metrics
  private llmQueueDepth: number = 0;
  private llmWaitTime: HistogramData;
  private intentCacheHits: number = 0;
  private intentCacheMisses: number = 0;

  constructor() {
    this.nlParseLatency = this.createHistogram();
    this.sqlExecutionLatency = this.createHistogram();
    this.formattingLatency = this.createHistogram();
    this.totalRequestLatency = this.createHistogram();
    this.llmWaitTime = this.createHistogram();
  }

  private createHistogram(): HistogramData {
    const buckets = new Map<number, number>();
    LATENCY_BUCKETS.forEach(b => buckets.set(b, 0));
    buckets.set(Infinity, 0);
    return { buckets, sum: 0, count: 0 };
  }

  private recordHistogram(histogram: HistogramData, value: number): void {
    histogram.sum += value;
    histogram.count += 1;

    for (const bucket of LATENCY_BUCKETS) {
      if (value <= bucket) {
        histogram.buckets.set(bucket, (histogram.buckets.get(bucket) || 0) + 1);
      }
    }
    histogram.buckets.set(Infinity, (histogram.buckets.get(Infinity) || 0) + 1);
  }

  // NL Parse metrics
  recordNLParseLatency(ms: number): void {
    this.recordHistogram(this.nlParseLatency, ms);
  }

  incrementNLParseSuccess(): void {
    this.nlParseSuccess++;
  }

  incrementNLParseFailure(reason: string): void {
    const key = reason.substring(0, 50); // Truncate long reasons
    this.nlParseFailures.set(key, (this.nlParseFailures.get(key) || 0) + 1);
  }

  // SQL metrics
  recordSQLLatency(ms: number): void {
    this.recordHistogram(this.sqlExecutionLatency, ms);
  }

  // Formatting metrics
  recordFormattingLatency(ms: number): void {
    this.recordHistogram(this.formattingLatency, ms);
  }

  // Request metrics
  recordRequestLatency(ms: number): void {
    this.recordHistogram(this.totalRequestLatency, ms);
  }

  incrementRequestCount(queryKind: string): void {
    this.requestsByQueryKind.set(queryKind, (this.requestsByQueryKind.get(queryKind) || 0) + 1);
  }

  incrementError(errorType: string): void {
    this.errorsByType.set(errorType, (this.errorsByType.get(errorType) || 0) + 1);
  }

  // Cache metrics
  incrementCacheHit(): void {
    this.cacheHits++;
  }

  incrementCacheMiss(): void {
    this.cacheMisses++;
  }

  // Concurrency tracking
  incrementConcurrentRequests(): void {
    this.activeConcurrentRequests++;
    if (this.activeConcurrentRequests > this.peakConcurrentRequests) {
      this.peakConcurrentRequests = this.activeConcurrentRequests;
    }
  }

  decrementConcurrentRequests(): void {
    this.activeConcurrentRequests = Math.max(0, this.activeConcurrentRequests - 1);
  }

  // LLM pressure metrics
  setLLMQueueDepth(depth: number): void {
    this.llmQueueDepth = depth;
  }

  recordLLMWaitTime(ms: number): void {
    this.recordHistogram(this.llmWaitTime, ms);
  }

  incrementIntentCacheHit(): void {
    this.intentCacheHits++;
  }

  incrementIntentCacheMiss(): void {
    this.intentCacheMisses++;
  }

  getIntentCacheHitRate(): number {
    const total = this.intentCacheHits + this.intentCacheMisses;
    return total > 0 ? this.intentCacheHits / total : 0;
  }

  // Get cache hit rate
  getCacheHitRate(): number {
    const total = this.cacheHits + this.cacheMisses;
    return total > 0 ? this.cacheHits / total : 0;
  }

  // Format histogram for Prometheus
  private formatHistogram(name: string, histogram: HistogramData, help: string): string {
    const lines: string[] = [];
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} histogram`);

    let cumulative = 0;
    for (const bucket of LATENCY_BUCKETS) {
      cumulative += histogram.buckets.get(bucket) || 0;
      lines.push(`${name}_bucket{le="${bucket}"} ${cumulative}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
    lines.push(`${name}_sum ${histogram.sum}`);
    lines.push(`${name}_count ${histogram.count}`);

    return lines.join('\n');
  }

  // Generate Prometheus-compatible metrics output
  toPrometheus(): string {
    const sections: string[] = [];

    // NL Parse latency
    sections.push(this.formatHistogram(
      'f1muse_nl_parse_latency_ms',
      this.nlParseLatency,
      'Natural language parsing latency in milliseconds'
    ));

    // SQL execution latency
    sections.push(this.formatHistogram(
      'f1muse_sql_execution_latency_ms',
      this.sqlExecutionLatency,
      'SQL query execution latency in milliseconds'
    ));

    // Formatting latency
    sections.push(this.formatHistogram(
      'f1muse_formatting_latency_ms',
      this.formattingLatency,
      'Response formatting latency in milliseconds'
    ));

    // Total request latency
    sections.push(this.formatHistogram(
      'f1muse_request_latency_ms',
      this.totalRequestLatency,
      'Total request latency in milliseconds'
    ));

    // Cache metrics
    sections.push(`# HELP f1muse_cache_hits_total Total cache hits`);
    sections.push(`# TYPE f1muse_cache_hits_total counter`);
    sections.push(`f1muse_cache_hits_total ${this.cacheHits}`);

    sections.push(`# HELP f1muse_cache_misses_total Total cache misses`);
    sections.push(`# TYPE f1muse_cache_misses_total counter`);
    sections.push(`f1muse_cache_misses_total ${this.cacheMisses}`);

    sections.push(`# HELP f1muse_cache_hit_rate Cache hit rate (0-1)`);
    sections.push(`# TYPE f1muse_cache_hit_rate gauge`);
    sections.push(`f1muse_cache_hit_rate ${this.getCacheHitRate().toFixed(4)}`);

    // NL Parse success/failure
    sections.push(`# HELP f1muse_nl_parse_success_total Total successful NL parses`);
    sections.push(`# TYPE f1muse_nl_parse_success_total counter`);
    sections.push(`f1muse_nl_parse_success_total ${this.nlParseSuccess}`);

    sections.push(`# HELP f1muse_nl_parse_failures_total Total NL parse failures by reason`);
    sections.push(`# TYPE f1muse_nl_parse_failures_total counter`);
    for (const [reason, count] of this.nlParseFailures) {
      sections.push(`f1muse_nl_parse_failures_total{reason="${reason.replace(/"/g, '\\"')}"} ${count}`);
    }
    if (this.nlParseFailures.size === 0) {
      sections.push(`f1muse_nl_parse_failures_total 0`);
    }

    // Requests by query kind
    sections.push(`# HELP f1muse_requests_by_kind_total Requests by query kind`);
    sections.push(`# TYPE f1muse_requests_by_kind_total counter`);
    for (const [kind, count] of this.requestsByQueryKind) {
      sections.push(`f1muse_requests_by_kind_total{kind="${kind}"} ${count}`);
    }

    // Errors by type
    sections.push(`# HELP f1muse_errors_total Errors by type`);
    sections.push(`# TYPE f1muse_errors_total counter`);
    for (const [type, count] of this.errorsByType) {
      sections.push(`f1muse_errors_total{type="${type}"} ${count}`);
    }

    // Concurrency
    sections.push(`# HELP f1muse_concurrent_requests Current concurrent requests`);
    sections.push(`# TYPE f1muse_concurrent_requests gauge`);
    sections.push(`f1muse_concurrent_requests ${this.activeConcurrentRequests}`);

    sections.push(`# HELP f1muse_peak_concurrent_requests Peak concurrent requests`);
    sections.push(`# TYPE f1muse_peak_concurrent_requests gauge`);
    sections.push(`f1muse_peak_concurrent_requests ${this.peakConcurrentRequests}`);

    // LLM pressure metrics
    sections.push(`# HELP f1muse_llm_queue_depth Current LLM queue depth`);
    sections.push(`# TYPE f1muse_llm_queue_depth gauge`);
    sections.push(`f1muse_llm_queue_depth ${this.llmQueueDepth}`);

    sections.push(this.formatHistogram(
      'f1muse_llm_wait_time_ms',
      this.llmWaitTime,
      'Time spent waiting for LLM permit in milliseconds'
    ));

    sections.push(`# HELP f1muse_intent_cache_hits_total Intent cache hits`);
    sections.push(`# TYPE f1muse_intent_cache_hits_total counter`);
    sections.push(`f1muse_intent_cache_hits_total ${this.intentCacheHits}`);

    sections.push(`# HELP f1muse_intent_cache_misses_total Intent cache misses`);
    sections.push(`# TYPE f1muse_intent_cache_misses_total counter`);
    sections.push(`f1muse_intent_cache_misses_total ${this.intentCacheMisses}`);

    sections.push(`# HELP f1muse_intent_cache_hit_rate Intent cache hit rate (0-1)`);
    sections.push(`# TYPE f1muse_intent_cache_hit_rate gauge`);
    sections.push(`f1muse_intent_cache_hit_rate ${this.getIntentCacheHitRate().toFixed(4)}`);

    return sections.join('\n\n') + '\n';
  }

  // Get summary for JSON endpoint
  toJSON(): Record<string, any> {
    return {
      nl_parse: {
        success_count: this.nlParseSuccess,
        failure_count: Array.from(this.nlParseFailures.values()).reduce((a, b) => a + b, 0),
        failures_by_reason: Object.fromEntries(this.nlParseFailures),
        latency: {
          count: this.nlParseLatency.count,
          sum_ms: this.nlParseLatency.sum,
          avg_ms: this.nlParseLatency.count > 0
            ? Math.round(this.nlParseLatency.sum / this.nlParseLatency.count)
            : 0,
        },
      },
      sql_execution: {
        count: this.sqlExecutionLatency.count,
        sum_ms: this.sqlExecutionLatency.sum,
        avg_ms: this.sqlExecutionLatency.count > 0
          ? Math.round(this.sqlExecutionLatency.sum / this.sqlExecutionLatency.count)
          : 0,
      },
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hit_rate: this.getCacheHitRate(),
      },
      requests_by_kind: Object.fromEntries(this.requestsByQueryKind),
      errors_by_type: Object.fromEntries(this.errorsByType),
      concurrency: {
        current: this.activeConcurrentRequests,
        peak: this.peakConcurrentRequests,
      },
      llm_pressure: {
        queue_depth: this.llmQueueDepth,
        wait_time: {
          count: this.llmWaitTime.count,
          sum_ms: this.llmWaitTime.sum,
          avg_ms: this.llmWaitTime.count > 0
            ? Math.round(this.llmWaitTime.sum / this.llmWaitTime.count)
            : 0,
        },
      },
      intent_cache: {
        hits: this.intentCacheHits,
        misses: this.intentCacheMisses,
        hit_rate: this.getIntentCacheHitRate(),
      },
    };
  }

  // Reset all metrics (for testing)
  reset(): void {
    this.nlParseLatency = this.createHistogram();
    this.sqlExecutionLatency = this.createHistogram();
    this.formattingLatency = this.createHistogram();
    this.totalRequestLatency = this.createHistogram();
    this.llmWaitTime = this.createHistogram();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.nlParseSuccess = 0;
    this.nlParseFailures.clear();
    this.requestsByQueryKind.clear();
    this.errorsByType.clear();
    this.activeConcurrentRequests = 0;
    this.peakConcurrentRequests = 0;
    this.llmQueueDepth = 0;
    this.intentCacheHits = 0;
    this.intentCacheMisses = 0;
  }
}

// Singleton instance
export const metrics = new MetricsCollector();

/**
 * Create metrics router
 */
export function createMetricsRouter(): Router {
  const router = Router();

  // Prometheus-compatible metrics endpoint
  router.get('/metrics', (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.toPrometheus());
  });

  // JSON metrics endpoint
  router.get('/metrics/json', (_req: Request, res: Response) => {
    res.json(metrics.toJSON());
  });

  return router;
}

/**
 * Middleware to track request metrics
 */
export function metricsMiddleware() {
  return (_req: any, res: any, next: any) => {
    const startTime = Date.now();
    metrics.incrementConcurrentRequests();

    res.on('finish', () => {
      metrics.decrementConcurrentRequests();
      const latency = Date.now() - startTime;
      metrics.recordRequestLatency(latency);
    });

    next();
  };
}
