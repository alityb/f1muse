/**
 * DEBUG TRACER
 *
 * Captures execution trace for debugging when ?debug=true.
 * Provides visibility into query parsing, routing, and execution.
 *
 * Usage:
 *   const tracer = new DebugTracer();
 *   tracer.start();
 *   tracer.addRoutingStep('Validated intent');
 *   tracer.setIntent(parsedIntent);
 *   tracer.setSqlTemplate('teammate_gap_summary_season_v1');
 *   tracer.setRowsReturned(5);
 *   const trace = tracer.finish();
 */

import { DebugTrace } from '../types/api-response';

/**
 * Debug tracer for query execution
 *
 * TIER 1 ENHANCEMENT: Extended with coverage evaluation, identity resolution,
 * SQL parameters, and fallback tracking.
 */
export class DebugTracer {
  private startTime: number = 0;
  private parsedIntent: Record<string, unknown> = {};
  private routingPath: string[] = [];
  private sqlTemplate: string | null = null;
  private sqlQueryPattern: string | undefined;
  private sqlParameters: string[] | undefined;
  private rowsReturned: number | undefined;
  private coverageEvaluation: string | undefined;
  private identityResolution: {
    driver_a?: { input: string; resolved: string };
    driver_b?: { input: string; resolved: string };
    track?: { input: string; resolved: string };
  } | undefined;
  private fallbackInfo: {
    original_season?: number;
    fallback_season?: number;
    reason?: string;
  } | undefined;
  private cacheInfo: {
    hit: boolean;
    cache_key: string;
    created_at?: string | null;
    expires_at?: string | null;
    hit_count?: number | null;
  } | undefined;
  private enabled: boolean;

  // PART 3: Performance tracing fields
  private sqlExecutionMs: number | undefined;
  private cacheLookupMs: number | undefined;
  private dataSource: 'cache' | 'database' | undefined;
  private queryPlan: string | undefined;

  /**
   * Create a new debug tracer
   *
   * @param enabled - Whether tracing is enabled (default: false)
   */
  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  /**
   * Check if tracing is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start timing execution
   */
  start(): void {
    if (!this.enabled) { return; }
    this.startTime = Date.now();
    this.routingPath = [];
    this.addRoutingStep('Trace started');
  }

  /**
   * Add a routing step to the trace
   *
   * @param step - Description of the routing step
   */
  addRoutingStep(step: string): void {
    if (!this.enabled) { return; }
    const elapsed = this.startTime > 0 ? Date.now() - this.startTime : 0;
    this.routingPath.push(`[${elapsed}ms] ${step}`);
  }

  /**
   * Set the parsed intent
   *
   * @param intent - The parsed query intent
   */
  setIntent(intent: Record<string, unknown>): void {
    if (!this.enabled) { return; }
    // Deep clone to avoid mutation
    this.parsedIntent = JSON.parse(JSON.stringify(intent));
    this.addRoutingStep(`Intent parsed: ${(intent as any).kind || 'unknown'}`);
  }

  /**
   * Set the SQL template used
   *
   * @param templateId - The SQL template identifier
   */
  setSqlTemplate(templateId: string): void {
    if (!this.enabled) { return; }
    this.sqlTemplate = templateId;
    this.addRoutingStep(`SQL template selected: ${templateId}`);
  }

  /**
   * Set the SQL query pattern (sanitized, no values)
   *
   * @param pattern - SQL query with placeholders
   */
  setSqlQueryPattern(pattern: string): void {
    if (!this.enabled) { return; }
    // Truncate long queries
    this.sqlQueryPattern = pattern.length > 500
      ? pattern.substring(0, 500) + '... [truncated]'
      : pattern;
  }

  /**
   * Set the number of rows returned
   *
   * @param count - Number of rows
   */
  setRowsReturned(count: number): void {
    if (!this.enabled) { return; }
    this.rowsReturned = count;
    this.addRoutingStep(`Query returned ${count} rows`);
  }

  /**
   * Record an error
   *
   * @param error - Error message
   */
  recordError(error: string): void {
    if (!this.enabled) { return; }
    this.addRoutingStep(`ERROR: ${error}`);
  }

  /**
   * Set SQL parameters (sanitized - types only, no values)
   *
   * @param params - Array of parameter values
   */
  setSqlParameters(params: unknown[]): void {
    if (!this.enabled) { return; }
    this.sqlParameters = params.map(p => {
      if (p === null) {
        return 'null';
      }
      if (p === undefined) {
        return 'undefined';
      }
      return typeof p;
    });
    this.addRoutingStep(`SQL parameters: ${this.sqlParameters.length} params`);
  }

  /**
   * Set coverage evaluation result
   *
   * @param evaluation - Coverage evaluation description
   */
  setCoverageEvaluation(evaluation: string): void {
    if (!this.enabled) { return; }
    this.coverageEvaluation = evaluation;
    this.addRoutingStep(`Coverage: ${evaluation}`);
  }

  /**
   * Set identity resolution trace
   *
   * @param type - Type of identity (driver_a, driver_b, track)
   * @param input - Original input string
   * @param resolved - Resolved ID
   */
  setIdentityResolution(
    type: 'driver_a' | 'driver_b' | 'track',
    input: string,
    resolved: string
  ): void {
    if (!this.enabled) { return; }
    if (!this.identityResolution) {
      this.identityResolution = {};
    }
    this.identityResolution[type] = { input, resolved };
    this.addRoutingStep(`Resolved ${type}: "${input}" → "${resolved}"`);
  }

  /**
   * Set fallback information
   *
   * @param originalSeason - Original requested season
   * @param fallbackSeason - Season used as fallback
   * @param reason - Reason for fallback
   */
  setFallbackInfo(originalSeason: number, fallbackSeason: number, reason: string): void {
    if (!this.enabled) { return; }
    this.fallbackInfo = {
      original_season: originalSeason,
      fallback_season: fallbackSeason,
      reason
    };
    this.addRoutingStep(`Fallback: ${originalSeason} → ${fallbackSeason} (${reason})`);
  }

  /**
   * Set cache information
   *
   * @param hit - Whether cache was hit
   * @param cacheKey - The cache key used
   * @param createdAt - When cache entry was created
   * @param expiresAt - When cache entry expires
   * @param hitCount - Number of times cache entry was accessed
   */
  setCacheInfo(
    hit: boolean,
    cacheKey: string,
    createdAt?: Date | null,
    expiresAt?: Date | null,
    hitCount?: number | null
  ): void {
    if (!this.enabled) { return; }
    this.cacheInfo = {
      hit,
      cache_key: cacheKey,
      created_at: createdAt?.toISOString() ?? null,
      expires_at: expiresAt?.toISOString() ?? null,
      hit_count: hitCount
    };
    this.addRoutingStep(hit ? `Cache HIT: ${cacheKey.slice(0, 16)}...` : `Cache MISS: ${cacheKey.slice(0, 16)}...`);
  }

  // === PART 3: PERFORMANCE TRACING METHODS ===

  /**
   * Set SQL execution time
   *
   * @param ms - SQL execution time in milliseconds
   */
  setSqlExecutionMs(ms: number): void {
    if (!this.enabled) { return; }
    this.sqlExecutionMs = ms;
    this.addRoutingStep(`SQL execution: ${ms}ms`);
  }

  /**
   * Set cache lookup time
   *
   * @param ms - Cache lookup time in milliseconds
   */
  setCacheLookupMs(ms: number): void {
    if (!this.enabled) { return; }
    this.cacheLookupMs = ms;
    this.addRoutingStep(`Cache lookup: ${ms}ms`);
  }

  /**
   * Set data source (where the data came from)
   *
   * @param source - "cache" or "database"
   */
  setDataSource(source: 'cache' | 'database'): void {
    if (!this.enabled) { return; }
    this.dataSource = source;
    this.addRoutingStep(`Data source: ${source}`);
  }

  /**
   * Set query plan (from EXPLAIN)
   *
   * @param plan - EXPLAIN output
   */
  setQueryPlan(plan: string): void {
    if (!this.enabled) { return; }
    // Truncate very long plans
    this.queryPlan = plan.length > 5000
      ? plan.substring(0, 5000) + '\n... [truncated]'
      : plan;
    this.addRoutingStep('Query plan captured');
  }

  /**
   * Start timing SQL execution (returns a function to stop timing)
   *
   * Usage:
   *   const stopTiming = tracer.startSqlTiming();
   *   await pool.query(sql, params);
   *   stopTiming();
   */
  startSqlTiming(): () => void {
    if (!this.enabled) { return () => {}; }
    const startMs = Date.now();
    return () => {
      const elapsed = Date.now() - startMs;
      this.setSqlExecutionMs(elapsed);
    };
  }

  /**
   * Start timing cache lookup (returns a function to stop timing)
   *
   * Usage:
   *   const stopTiming = tracer.startCacheTiming();
   *   const result = await cacheService.get(key);
   *   stopTiming();
   */
  startCacheTiming(): () => void {
    if (!this.enabled) { return () => {}; }
    const startMs = Date.now();
    return () => {
      const elapsed = Date.now() - startMs;
      this.setCacheLookupMs(elapsed);
    };
  }

  /**
   * Finish tracing and return the debug trace object
   *
   * @returns DebugTrace object or undefined if tracing is disabled
   */
  finish(): DebugTrace | undefined {
    if (!this.enabled) { return undefined; }

    this.addRoutingStep('Trace complete');

    const executionTimeMs = this.startTime > 0
      ? Date.now() - this.startTime
      : 0;

    const trace: DebugTrace = {
      parsed_intent: this.parsedIntent,
      routing_path: this.routingPath,
      sql_template: this.sqlTemplate,
      execution_time_ms: executionTimeMs,
      sql_query_pattern: this.sqlQueryPattern,
      rows_returned: this.rowsReturned
    };

    // Add extended fields if present
    if (this.sqlParameters) {
      trace.sql_parameters = this.sqlParameters;
    }
    if (this.coverageEvaluation) {
      trace.coverage_evaluation = this.coverageEvaluation;
    }
    if (this.identityResolution) {
      trace.identity_resolution = this.identityResolution;
    }
    if (this.fallbackInfo) {
      trace.fallback_info = this.fallbackInfo;
    }
    if (this.cacheInfo) {
      trace.cache = this.cacheInfo;
    }

    // PART 3: Performance tracing fields
    if (this.sqlExecutionMs !== undefined) {
      trace.sql_execution_ms = this.sqlExecutionMs;
    }
    if (this.cacheLookupMs !== undefined) {
      trace.cache_lookup_ms = this.cacheLookupMs;
    }
    if (this.dataSource) {
      trace.source = this.dataSource;
    }
    if (this.queryPlan) {
      trace.query_plan = this.queryPlan;
    }

    return trace;
  }
}

/**
 * Create a debug tracer from request query params
 *
 * @param query - Express request query object
 * @returns DebugTracer instance
 */
export function createTracerFromRequest(query: Record<string, unknown>): DebugTracer {
  const debugParam = query.debug;
  const enabled = debugParam === 'true' || debugParam === '1';
  return new DebugTracer(enabled);
}

/**
 * Create a debug tracer from request (checks both query params and X-Debug header)
 *
 * TIER 1: Supports X-Debug header for debug mode activation.
 *
 * @param query - Express request query object
 * @param headers - Express request headers object
 * @returns DebugTracer instance
 */
export function createTracerFromRequestWithHeaders(
  query: Record<string, unknown>,
  headers: Record<string, unknown>
): DebugTracer {
  const debugParam = query.debug;
  const debugHeader = headers['x-debug'] || headers['X-Debug'];

  const enabled =
    debugParam === 'true' ||
    debugParam === '1' ||
    debugHeader === 'true' ||
    debugHeader === '1';

  return new DebugTracer(enabled);
}

/**
 * Utility to sanitize SQL for debug output
 *
 * Replaces parameter values with placeholders.
 *
 * @param sql - Raw SQL query
 * @returns Sanitized SQL pattern
 */
export function sanitizeSqlForDebug(sql: string): string {
  // Replace string literals
  let sanitized = sql.replace(/'[^']*'/g, "'<value>'");

  // Replace numbers after = or IN
  sanitized = sanitized.replace(/=\s*\d+/g, '= <number>');

  // Truncate if too long
  if (sanitized.length > 1000) {
    sanitized = sanitized.substring(0, 1000) + '\n... [truncated]';
  }

  return sanitized;
}
