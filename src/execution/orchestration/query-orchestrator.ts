import { Pool } from 'pg';
import { QueryIntent } from '../../types/query-intent';
import {
  QueryResult,
  QueryError,
  Metadata,
  TeammateGapDualComparisonPayload
} from '../../types/results';
import { AnalyticalResponse } from '../../types/api-response';
import { TemplateLoader } from '../template-loader';
import { ResultFormatter } from '../result-formatter';
import { QueryValidator } from '../../validation/query-validator';
import { DriverResolver } from '../../identity/driver-resolver';
import { TrackResolver } from '../../identity/track-resolver';
import { DebugTracer, sanitizeSqlForDebug } from '../debug-tracer';
import { CacheService, createCacheEntry } from '../../cache/query-cache';
import {
  IntentResolver,
  buildParameters,
  selectTemplate,
  buildInterpretation,
  getDataScope,
  buildDualComparisonResponseFromPayload,
  buildDualComparisonErrorResponse
} from '../pipeline';

// debug info attached to every response
export interface ExecutionDebugInfo {
  intent_cache_hit: boolean;
  sql_executed: boolean;
  rows_returned: number;
  coverage_reason: string | null;
  template_id?: string;
}

export interface ExecuteOptions {
  force_refresh?: boolean;
  tracer?: DebugTracer;
}

// execution result with debug info
export interface ExecuteResult {
  result: QueryResult | QueryError;
  debug: ExecutionDebugInfo;
}

export class QueryOrchestrator {
  private templateLoader: TemplateLoader;
  private resultFormatter: ResultFormatter;
  private validator: QueryValidator;
  private intentResolver: IntentResolver;
  private cacheService: CacheService | null;

  constructor(private pool: Pool, templatesDir?: string, cachePool?: Pool) {
    this.templateLoader = new TemplateLoader(templatesDir);
    this.resultFormatter = new ResultFormatter();
    this.validator = new QueryValidator();

    const driverResolver = new DriverResolver(pool);
    const trackResolver = new TrackResolver(pool);
    this.intentResolver = new IntentResolver(pool, driverResolver, trackResolver);

    this.cacheService = cachePool ? new CacheService(cachePool) : null;
    this.templateLoader.preloadAll();
  }

  setCacheService(cacheService: CacheService): void {
    this.cacheService = cacheService;
  }

  async execute(
    intent: QueryIntent,
    tracerOrOptions?: DebugTracer | ExecuteOptions
  ): Promise<QueryResult | QueryError> {
    const { result } = await this.executeWithDebug(intent, tracerOrOptions);
    return result;
  }

  async executeWithDebug(
    intent: QueryIntent,
    tracerOrOptions?: DebugTracer | ExecuteOptions
  ): Promise<ExecuteResult> {
    const options = normalizeOptions(tracerOrOptions);
    const tracer = options.tracer;
    const forceRefresh = options.force_refresh ?? false;

    const debug: ExecutionDebugInfo = {
      intent_cache_hit: false,
      sql_executed: false,
      rows_returned: 0,
      coverage_reason: null
    };

    try {
      tracer?.start();
      tracer?.setIntent(intent as unknown as Record<string, unknown>);

      const validationResult = await this.validateIntent(intent, tracer);
      if (!validationResult.ok) {
        return { result: validationResult.error, debug };
      }

      const resolvedIntent = await this.resolveIntent(intent, tracer);
      if (!resolvedIntent.ok) {
        return { result: resolvedIntent.error, debug };
      }

      const cacheResult = await this.checkCache(resolvedIntent.data, tracer, forceRefresh);
      if (cacheResult) {
        debug.intent_cache_hit = true;
        debug.sql_executed = false;
        debug.rows_returned = cacheResult.metadata?.rows ?? 0;
        return { result: cacheResult, debug };
      }

      const queryResult = await this.executeQuery(resolvedIntent.data, tracer, debug);
      return { result: queryResult, debug };
    } catch (err) {
      tracer?.recordError(String(err));
      return {
        result: {
          error: 'execution_failed',
          reason: `Query execution failed: ${err}`,
          details: { error: String(err) }
        },
        debug
      };
    }
  }

  async executeDualComparisonResponse(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
    tracer?: DebugTracer
  ): Promise<AnalyticalResponse<TeammateGapDualComparisonPayload>> {
    const result = await this.execute(intent, tracer);

    if ('error' in result) {
      return buildDualComparisonErrorResponse(intent, result, tracer?.finish());
    }

    const payload = result.result.payload as TeammateGapDualComparisonPayload;
    return buildDualComparisonResponseFromPayload(intent, payload, tracer?.finish());
  }

  buildDualComparisonResponseFromPayload(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
    payload: TeammateGapDualComparisonPayload,
    debug?: AnalyticalResponse<TeammateGapDualComparisonPayload>['debug']
  ): AnalyticalResponse<TeammateGapDualComparisonPayload> {
    return buildDualComparisonResponseFromPayload(intent, payload, debug);
  }

  buildDualComparisonErrorResponse(
    intent: Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
    error: QueryError,
    debug?: AnalyticalResponse<TeammateGapDualComparisonPayload>['debug']
  ): AnalyticalResponse<TeammateGapDualComparisonPayload> {
    return buildDualComparisonErrorResponse(intent, error, debug);
  }

  private async validateIntent(
    intent: QueryIntent,
    tracer?: DebugTracer
  ): Promise<{ ok: true } | { ok: false; error: QueryError }> {
    const validation = await this.validator.validate(intent);

    if (!validation.valid) {
      tracer?.recordError(validation.error?.reason || 'Validation failed');
      return {
        ok: false,
        error: validation.error || { error: 'validation_failed', reason: 'Validation failed' }
      };
    }

    tracer?.addRoutingStep('Intent validated');
    return { ok: true };
  }

  private async resolveIntent(
    intent: QueryIntent,
    tracer?: DebugTracer
  ): Promise<{ ok: true; data: QueryIntent } | { ok: false; error: QueryError }> {
    const identitiesResult = await this.intentResolver.resolveIdentities(intent);
    if (!identitiesResult.ok) {
      tracer?.recordError(identitiesResult.error.reason);
      return identitiesResult;
    }
    tracer?.addRoutingStep('Identities resolved');

    const teammateResult = await this.intentResolver.resolveTeammateGapDrivers(identitiesResult.data);
    if (!teammateResult.ok) {
      tracer?.recordError(teammateResult.error.reason);
      return teammateResult;
    }
    tracer?.addRoutingStep('Teammate pair resolved');

    const constraintsResult = await this.intentResolver.validateTeammateConstraints(teammateResult.data);
    if (!constraintsResult.ok) {
      tracer?.recordError(constraintsResult.error.reason);
      return { ok: false, error: constraintsResult.error };
    }
    tracer?.addRoutingStep('Teammate constraints validated');

    return { ok: true, data: teammateResult.data };
  }

  private async checkCache(
    intent: QueryIntent,
    tracer?: DebugTracer,
    forceRefresh?: boolean
  ): Promise<QueryResult | null> {
    if (!this.cacheService) { return null; }
    if (tracer?.isEnabled()) {
      this.setCacheInfoForDebug(intent, tracer);
      tracer.addRoutingStep('Cache bypassed (debug mode)');
      return null;
    }
    if (forceRefresh) { return null; }

    const cacheKey = this.computeCacheKey(intent);
    const stopCacheTiming = tracer?.startCacheTiming() ?? (() => {});
    const cacheResult = await this.cacheService.get(cacheKey);
    stopCacheTiming();

    if (!cacheResult.hit || !cacheResult.entry) {
      tracer?.setCacheInfo(false, cacheKey, null, null, null);
      return null;
    }

    await this.cacheService.incrementHit(cacheKey);
    tracer?.setCacheInfo(
      true,
      cacheKey,
      cacheResult.entry.created_at,
      cacheResult.entry.expires_at,
      cacheResult.entry.hit_count + 1
    );
    tracer?.setDataSource('cache');
    tracer?.addRoutingStep('Returning cached result');

    return cacheResult.entry.response;
  }

  private async executeQuery(
    intent: QueryIntent,
    tracer?: DebugTracer,
    debug?: ExecutionDebugInfo
  ): Promise<QueryResult | QueryError> {
    const templateId = selectTemplate(intent);
    tracer?.setSqlTemplate(templateId);
    if (debug) { debug.template_id = templateId; }

    const sql = this.templateLoader.load(templateId);
    tracer?.setSqlQueryPattern(sanitizeSqlForDebug(sql));

    const params = buildParameters(intent);

    const stopSqlTiming = tracer?.startSqlTiming() ?? (() => {});
    const result = await this.pool.query(sql, params);
    stopSqlTiming();

    // always mark sql as executed
    if (debug) {
      debug.sql_executed = true;
      debug.rows_returned = result.rows.length;
    }

    tracer?.setRowsReturned(result.rows.length);
    tracer?.setDataSource('database');

    // 0 rows is a valid result that should not be cached but should return gracefully
    if (result.rows.length === 0) {
      tracer?.recordError('No rows returned');
      if (debug) {
        debug.coverage_reason = 'no data found for query scope';
      }
      // return error but DO NOT cache - this is key
      return {
        error: 'execution_failed',
        reason: 'INSUFFICIENT_DATA: No data found for the specified query. This may indicate insufficient laps or missing data for the requested scope.'
      };
    }

    const payload = this.resultFormatter.format(intent, result.rows);
    const interpretation = buildInterpretation(intent, result.rows);
    const metadata: Metadata = {
      sql_template_id: templateId,
      data_scope: getDataScope(intent),
      rows: result.rows.length
    };

    // capture coverage reason from interpretation for debug
    if (debug && interpretation.constraints.rows_excluded_reason) {
      debug.coverage_reason = interpretation.constraints.rows_excluded_reason;
    }

    const queryResult: QueryResult = {
      intent,
      result: { type: payload.type, payload },
      interpretation,
      metadata
    };

    await this.storeInCache(intent, queryResult, result.rows, tracer);

    return queryResult;
  }

  private async storeInCache(
    intent: QueryIntent,
    queryResult: QueryResult,
    rows: any[],
    tracer?: DebugTracer
  ): Promise<void> {
    if (!this.cacheService) { return; }

    const sharedEvents = extractSharedEvents(rows, intent);
    const cacheEntry = createCacheEntry(this.cacheService, intent, queryResult, sharedEvents);

    if (cacheEntry.confidence_level === 'insufficient') {
      tracer?.addRoutingStep('Result not cached (insufficient coverage)');
      return;
    }

    await this.cacheService.set(cacheEntry);
    tracer?.addRoutingStep(`Result cached (${cacheEntry.confidence_level})`);
  }

  private computeCacheKey(intent: QueryIntent): string {
    if (!this.cacheService) { return ''; }
    const cacheParams = this.cacheService.extractCacheParameters(intent);
    return this.cacheService.computeCacheKey({ kind: intent.kind, parameters: cacheParams });
  }

  private setCacheInfoForDebug(intent: QueryIntent, tracer: DebugTracer): void {
    if (!this.cacheService) { return; }
    const cacheKey = this.computeCacheKey(intent);
    tracer.setCacheInfo(false, cacheKey, null, null, null);
  }
}

function normalizeOptions(tracerOrOptions?: DebugTracer | ExecuteOptions): ExecuteOptions {
  if (tracerOrOptions instanceof DebugTracer) {
    return { tracer: tracerOrOptions };
  }
  return tracerOrOptions || {};
}

function extractSharedEvents(rows: any[], intent: QueryIntent): number | undefined {
  const row = rows[0];
  if (!row) { return undefined; }

  switch (intent.kind) {
    case 'driver_head_to_head_count':
      return parseInt(row.shared_events || '0', 10);
    case 'teammate_gap_summary_season':
    case 'teammate_gap_dual_comparison':
      return parseInt(row.shared_races || row.qualifying_shared_races || '0', 10);
    case 'driver_performance_vector':
      return parseInt(row.race_laps || '0', 10);
    case 'driver_multi_comparison':
      return parseInt(row.laps_considered || '0', 10);
    case 'driver_matchup_lookup':
      return parseInt(row.shared_events || '0', 10);
    default:
      return undefined;
  }
}
