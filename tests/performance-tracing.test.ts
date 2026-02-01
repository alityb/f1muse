import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DebugTracer,
  createTracerFromRequest,
  createTracerFromRequestWithHeaders,
  sanitizeSqlForDebug
} from '../src/execution/debug-tracer';

describe('DebugTracer', () => {
  describe('Performance tracing fields', () => {
    it('tracks SQL execution time', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      tracer.setSqlExecutionMs(42);

      const trace = tracer.finish();
      expect(trace?.sql_execution_ms).toBe(42);
    });

    it('tracks cache lookup time', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      tracer.setCacheLookupMs(5);

      const trace = tracer.finish();
      expect(trace?.cache_lookup_ms).toBe(5);
    });

    it('tracks data source as cache', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      tracer.setDataSource('cache');

      const trace = tracer.finish();
      expect(trace?.source).toBe('cache');
    });

    it('tracks data source as database', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      tracer.setDataSource('database');

      const trace = tracer.finish();
      expect(trace?.source).toBe('database');
    });

    it('tracks query plan', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      const plan = 'Seq Scan on api_query_cache (cost=0.00..1.00 rows=1)';
      tracer.setQueryPlan(plan);

      const trace = tracer.finish();
      expect(trace?.query_plan).toBe(plan);
    });

    it('truncates very long query plans', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      const longPlan = 'A'.repeat(6000);
      tracer.setQueryPlan(longPlan);

      const trace = tracer.finish();
      expect(trace?.query_plan?.length).toBeLessThan(6000);
      expect(trace?.query_plan).toContain('[truncated]');
    });
  });

  describe('startSqlTiming helper', () => {
    it('measures elapsed time', async () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      const stopTiming = tracer.startSqlTiming();
      await new Promise(resolve => setTimeout(resolve, 10));
      stopTiming();

      const trace = tracer.finish();
      expect(trace?.sql_execution_ms).toBeGreaterThanOrEqual(10);
    });

    it('returns no-op function when disabled', () => {
      const tracer = new DebugTracer(false);
      const stopTiming = tracer.startSqlTiming();

      // Should not throw when called
      expect(() => stopTiming()).not.toThrow();

      const trace = tracer.finish();
      expect(trace).toBeUndefined();
    });
  });

  describe('startCacheTiming helper', () => {
    it('measures cache lookup time', async () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      const stopTiming = tracer.startCacheTiming();
      await new Promise(resolve => setTimeout(resolve, 5));
      stopTiming();

      const trace = tracer.finish();
      expect(trace?.cache_lookup_ms).toBeGreaterThanOrEqual(5);
    });

    it('returns no-op function when disabled', () => {
      const tracer = new DebugTracer(false);
      const stopTiming = tracer.startCacheTiming();

      // Should not throw when called
      expect(() => stopTiming()).not.toThrow();

      const trace = tracer.finish();
      expect(trace).toBeUndefined();
    });
  });

  describe('Routing path includes performance steps', () => {
    it('logs SQL execution time in routing path', () => {
      const tracer = new DebugTracer(true);
      tracer.start();
      tracer.setSqlExecutionMs(100);

      const trace = tracer.finish();
      const hasStep = trace?.routing_path.some(s => s.includes('SQL execution: 100ms'));
      expect(hasStep).toBe(true);
    });

    it('logs cache lookup time in routing path', () => {
      const tracer = new DebugTracer(true);
      tracer.start();
      tracer.setCacheLookupMs(3);

      const trace = tracer.finish();
      const hasStep = trace?.routing_path.some(s => s.includes('Cache lookup: 3ms'));
      expect(hasStep).toBe(true);
    });

    it('logs data source in routing path', () => {
      const tracer = new DebugTracer(true);
      tracer.start();
      tracer.setDataSource('database');

      const trace = tracer.finish();
      const hasStep = trace?.routing_path.some(s => s.includes('Data source: database'));
      expect(hasStep).toBe(true);
    });

    it('logs query plan capture in routing path', () => {
      const tracer = new DebugTracer(true);
      tracer.start();
      tracer.setQueryPlan('Seq Scan...');

      const trace = tracer.finish();
      const hasStep = trace?.routing_path.some(s => s.includes('Query plan captured'));
      expect(hasStep).toBe(true);
    });
  });

  describe('Combined trace', () => {
    it('includes all performance fields together', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      tracer.setIntent({ kind: 'test', season: 2025 });
      tracer.setSqlTemplate('test_v1');
      tracer.setCacheLookupMs(2);
      tracer.setSqlExecutionMs(50);
      tracer.setRowsReturned(10);
      tracer.setDataSource('database');

      const trace = tracer.finish();

      expect(trace).toBeDefined();
      expect(trace?.cache_lookup_ms).toBe(2);
      expect(trace?.sql_execution_ms).toBe(50);
      expect(trace?.rows_returned).toBe(10);
      expect(trace?.source).toBe('database');
      expect(trace?.sql_template).toBe('test_v1');
      expect(trace?.execution_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('includes cache hit with source=cache', () => {
      const tracer = new DebugTracer(true);
      tracer.start();

      tracer.setCacheInfo(true, 'cache_key_123', new Date(), new Date(), 5);
      tracer.setDataSource('cache');

      const trace = tracer.finish();

      expect(trace?.cache?.hit).toBe(true);
      expect(trace?.source).toBe('cache');
    });
  });

  describe('Disabled tracer', () => {
    it('does not record performance fields when disabled', () => {
      const tracer = new DebugTracer(false);
      tracer.start();

      tracer.setSqlExecutionMs(100);
      tracer.setCacheLookupMs(5);
      tracer.setDataSource('database');
      tracer.setQueryPlan('plan');

      const trace = tracer.finish();
      expect(trace).toBeUndefined();
    });
  });
});

describe('createTracerFromRequest', () => {
  it('creates enabled tracer when debug=true', () => {
    const tracer = createTracerFromRequest({ debug: 'true' });
    expect(tracer.isEnabled()).toBe(true);
  });

  it('creates enabled tracer when debug=1', () => {
    const tracer = createTracerFromRequest({ debug: '1' });
    expect(tracer.isEnabled()).toBe(true);
  });

  it('creates disabled tracer when debug not set', () => {
    const tracer = createTracerFromRequest({});
    expect(tracer.isEnabled()).toBe(false);
  });
});

describe('createTracerFromRequestWithHeaders', () => {
  it('creates enabled tracer from X-Debug header', () => {
    const tracer = createTracerFromRequestWithHeaders({}, { 'x-debug': 'true' });
    expect(tracer.isEnabled()).toBe(true);
  });

  it('creates enabled tracer from X-Debug header (uppercase)', () => {
    const tracer = createTracerFromRequestWithHeaders({}, { 'X-Debug': 'true' });
    expect(tracer.isEnabled()).toBe(true);
  });

  it('prefers query param over header', () => {
    const tracer = createTracerFromRequestWithHeaders({ debug: 'true' }, {});
    expect(tracer.isEnabled()).toBe(true);
  });
});

describe('sanitizeSqlForDebug', () => {
  it('replaces string literals', () => {
    const sql = "SELECT * FROM users WHERE name = 'john'";
    const sanitized = sanitizeSqlForDebug(sql);
    expect(sanitized).toContain("'<value>'");
    expect(sanitized).not.toContain("'john'");
  });

  it('replaces numbers after equals', () => {
    const sql = 'SELECT * FROM users WHERE id = 123';
    const sanitized = sanitizeSqlForDebug(sql);
    expect(sanitized).toContain('= <number>');
    expect(sanitized).not.toContain('123');
  });

  it('truncates long queries', () => {
    const sql = 'SELECT ' + 'a'.repeat(2000);
    const sanitized = sanitizeSqlForDebug(sql);
    expect(sanitized.length).toBeLessThan(sql.length);
    expect(sanitized).toContain('[truncated]');
  });
});
