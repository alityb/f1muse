import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { QueryTranslator } from '../llm/query-translator';
import { MistralIntentClient } from '../llm/mistral-client';
import { QueryExecutor } from '../execution/query-executor';
import { ExecutionDebugInfo } from '../execution/orchestration';
import { QueryIntent } from '../types/query-intent';
import { buildInterpretationResponse } from '../presentation/interpretation-builder';
import { applyConversationContext } from '../conversation/context-resolver';
import { ConversationContext } from '../conversation/context-types';
import {
  buildErrorResponse,
  getStatusCode,
  nlQueryCounters,
} from './nl-query-errors';
import { LLMUnavailableError } from '../llm/concurrency-limiter';
import { nlQueryRateLimiter, MAX_NL_QUERY_LENGTH } from '../middleware/rate-limiter';

/**
 * Natural Language Query Endpoint
 * Accepts questions like "Who was faster at Silverstone, Max or Lando?"
 * and returns F1 analytics results
 *
 * Supports two LLM backends:
 * - Claude API (Anthropic) - if ANTHROPIC_API_KEY is set
 * - Mistral-RS (local) - if MISTRAL_RS_URL is set
 */

type LLMBackend = 'claude' | 'mistral-rs' | 'none';

function detectLLMBackend(): LLMBackend {
  if (process.env.MISTRAL_RS_URL && process.env.MISTRAL_RS_MODEL_ID) {
    return 'mistral-rs';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return 'claude';
  }
  return 'none';
}

/**
 * Create NL query router
 *
 * @param pool - Primary database pool for read queries
 * @param cachePool - Optional separate pool for cache writes (defaults to pool if not provided)
 */
export function createNLQueryRouter(pool: Pool, cachePool?: Pool): Router {
  const router = Router();

  const backend = detectLLMBackend();

  // Initialize LLM clients based on available configuration
  const claudeTranslator = backend === 'claude' ? new QueryTranslator() : null;
  const mistralClient = backend === 'mistral-rs' ? new MistralIntentClient() : null;

  const executor = new QueryExecutor(pool, undefined, cachePool);
  let conversationContext: ConversationContext | undefined;

  // Log which backend is active
  console.log(`[NL Query] Using LLM backend: ${backend}`);

  router.post('/nl-query', nlQueryRateLimiter.middleware(), async (req: Request, res: Response) => {
    const requestId = uuidv4();
    let queryKind: string | null = null;
    nlQueryCounters.incrementTotal();

    const { question } = req.body;

    if (!question || typeof question !== 'string') {
      const error = buildErrorResponse(
        requestId,
        'missing_question',
        'Please provide a "question" field with your natural language query',
        null,
        {
          suggestion: 'Include a "question" field in your JSON request body',
          details: { example: { question: 'Who was faster at Silverstone, Max or Lando?' } },
        }
      );
      return res.status(getStatusCode(error.error_type)).json(error);
    }

    if (question.length > MAX_NL_QUERY_LENGTH) {
      const error = buildErrorResponse(
        requestId,
        'question_too_long',
        `Question must be ${MAX_NL_QUERY_LENGTH} characters or less`,
        null,
        { suggestion: 'Shorten your question', details: { max_length: MAX_NL_QUERY_LENGTH, actual_length: question.length } }
      );
      return res.status(getStatusCode(error.error_type)).json(error);
    }

    try {
      // Step 1: LLM translates NL → QueryIntent (using appropriate backend)
      console.log(`[${backend.toUpperCase()}] Translating: "${question}"`);

      let queryIntent: QueryIntent;
      let rawLLMOutput = '';
      let fallbackUsed = false;

      if (backend === 'mistral-rs' && mistralClient) {
        const response = await mistralClient.parseIntent(question);

        if (response.success && response.candidate) {
          queryIntent = response.candidate;
          rawLLMOutput = response.rawOutput;
        } else {
          const fallbackIntent = buildFallbackIntent(question);
          if (!fallbackIntent) {
            const error = buildErrorResponse(
              requestId,
              'llm_parsing_failed',
              response.error || 'Mistral-RS failed to parse query',
              null,
              {
                suggestion: 'Try rephrasing your question more clearly.',
                details: { rawOutput: response.rawOutput },
              }
            );
            return res.status(getStatusCode(error.error_type)).json(error);
          }
          fallbackUsed = true;
          queryIntent = fallbackIntent;
        }
      } else if (backend === 'claude' && claudeTranslator) {
        try {
          queryIntent = await claudeTranslator.translate(question);
          console.log(`[NL Query] After translate - normalization: ${(queryIntent as any).normalization}`);
        } catch (err: any) {
          const fallbackIntent = buildFallbackIntent(question);
          if (!fallbackIntent) {
            const error = buildErrorResponse(
              requestId,
              'llm_translation_failed',
              err.message,
              null,
              { suggestion: 'Try rephrasing your question more clearly.' }
            );
            return res.status(getStatusCode(error.error_type)).json(error);
          }
          fallbackUsed = true;
          queryIntent = fallbackIntent;
        }
      } else {
        const fallbackIntent = buildFallbackIntent(question);
        if (!fallbackIntent) {
          const error = buildErrorResponse(
            requestId,
            'llm_not_configured',
            'No LLM backend is configured. Set either MISTRAL_RS_URL or ANTHROPIC_API_KEY.',
            null
          );
          return res.status(503).json(error);
        }
        fallbackUsed = true;
        queryIntent = fallbackIntent;
      }

      console.log(`[${backend.toUpperCase()}] Generated QueryIntent:`, JSON.stringify(queryIntent, null, 2));

      const contextResult = applyConversationContext({
        raw_question: question,
        draft_intent: queryIntent,
        previous: conversationContext
      });

      queryIntent = contextResult.resolved_intent;
      queryIntent.raw_query = question;
      queryKind = queryIntent.kind;
      conversationContext = contextResult.updated_context;

      // Step 2: Execute query with fallback interpretation
      console.log('[F1 Muse] Executing query...');
      const interpretation = await buildInterpretationResponse({
        pool,
        executor,
        intent: queryIntent,
        raw_question: question
      });

      if ('error' in interpretation.result) {
        const errorCode = interpretation.result.error as string;

        // build debug info for error case - sql was still executed
        const errorDebug: ExecutionDebugInfo = {
          intent_cache_hit: false,
          sql_executed: true,  // sql ran but returned error/no data
          rows_returned: 0,
          coverage_reason: interpretation.result.reason || null
        };

        const error = buildErrorResponse(
          requestId,
          errorCode,
          interpretation.result.reason as string,
          queryKind,
          {
            details: {
              answer: interpretation.answer,
              fallbacks: interpretation.fallbacks,
              supplemental_results: interpretation.supplemental_results,
              canonical_response: interpretation.canonical_response,
              debug: errorDebug,
            },
          }
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      const answer = interpretation.answer;
      nlQueryCounters.incrementSuccess();

      // build debug info from interpretation
      const debug: ExecutionDebugInfo = {
        intent_cache_hit: false,  // intent cache is separate from query cache
        sql_executed: !('error' in interpretation.result),
        rows_returned: interpretation.result && 'metadata' in interpretation.result
          ? (interpretation.result as any).metadata?.rows ?? 0
          : 0,
        coverage_reason: interpretation.result && 'interpretation' in interpretation.result
          ? (interpretation.result as any).interpretation?.constraints?.rows_excluded_reason ?? null
          : null
      };

      const response: any = {
        request_id: requestId,
        error_type: null,
        query_kind: queryKind,
        question,
        queryIntent: interpretation.intent,
        result: interpretation.result,
        answer,
        fallbacks: interpretation.fallbacks,
        supplemental_results: interpretation.supplemental_results,
        canonical_response: interpretation.canonical_response,
        debug,
        metadata: {
          llmBackend: backend,
          fallbackUsed
        },
      };

      // Include audit information for Mistral-RS
      if (backend === 'mistral-rs' && rawLLMOutput) {
        response.metadata.rawLLMOutput = rawLLMOutput;
      }

      return res.json(response);
    } catch (err: any) {
      console.error('[Error]', err);

      // llm unavailable (concurrency/queue timeout)
      if (err instanceof LLMUnavailableError) {
        const error = buildErrorResponse(
          requestId,
          'llm_unavailable',
          'LLM service is temporarily unavailable. Please try again later.',
          queryKind
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      // LLM translation error
      if (err.message?.includes('LLM')) {
        const error = buildErrorResponse(
          requestId,
          'llm_translation_failed',
          err.message,
          queryKind,
          { suggestion: 'The AI service failed to understand your question. Try rephrasing it.' }
        );
        return res.status(getStatusCode(error.error_type)).json(error);
      }

      // Global safeguard: all uncaught exceptions return structured internal_error
      const error = buildErrorResponse(
        requestId,
        'internal_error',
        'An unexpected error occurred. Please try again.',
        queryKind
      );
      return res.status(getStatusCode(error.error_type)).json(error);
    }
  });

  // Internal counters for failure tracking
  router.get('/nl-query/stats', (_req: Request, res: Response) => {
    res.json(nlQueryCounters.getStats());
  });

  return router;
}

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;

function extractSeason(question: string): number {
  const match = question.match(YEAR_PATTERN);
  if (!match) {
    return 2025;
  }
  return parseInt(match[0], 10);
}

function stripYear(text: string): string {
  return text.replace(YEAR_PATTERN, '').trim();
}

function normalizeEntity(text: string): string {
  return stripYear(text).replace(/[?.!]/g, '').trim();
}

function extractAfterPattern(question: string, pattern: RegExp): string | null {
  const match = question.match(pattern);
  if (!match || !match[1]) {
    return null;
  }
  const value = normalizeEntity(match[1]);
  return value.length > 0 ? value : null;
}

function buildFallbackIntent(question: string): QueryIntent | null {
  const season = extractSeason(question);
  const raw_query = question;
  const cleanAirOnly = /clean air|without traffic/i.test(question);
  const metric = cleanAirOnly ? 'clean_air_pace' : 'avg_true_pace';

  if (/results of|race results|who won|winner of|podium|\bresults\b/i.test(question)) {
    const track_id =
      extractAfterPattern(question, /results of\s+(.+)$/i) ||
      extractAfterPattern(question, /race results\s+for\s+(.+)$/i) ||
      extractAfterPattern(question, /who won(?:\s+the)?\s+(.+)$/i) ||
      extractAfterPattern(question, /winner of(?:\s+the)?\s+(.+)$/i) ||
      extractAfterPattern(question, /podium at\s+(.+)$/i) ||
      extractAfterPattern(question, /(.+?)\s+\b(19|20)\d{2}\b\s+results\b/i);

    if (!track_id) {
      return null;
    }

    return {
      kind: 'race_results_summary',
      track_id,
      season,
      metric: 'avg_true_pace' as const,
      normalization: 'none' as const,
      clean_air_only: false,
      compound_context: 'mixed' as const,
      session_scope: 'race' as const,
      raw_query
    };
  }

  if (/fastest at|fastest drivers at|fastest driver at|who was fastest at/i.test(question)) {
    const track_id =
      extractAfterPattern(question, /fastest at\s+(.+)$/i) ||
      extractAfterPattern(question, /fastest drivers at\s+(.+)$/i) ||
      extractAfterPattern(question, /fastest driver at\s+(.+)$/i) ||
      extractAfterPattern(question, /who was fastest at\s+(.+)$/i);

    if (!track_id) {
      return null;
    }

    return {
      kind: 'track_fastest_drivers',
      track_id,
      season,
      metric,
      normalization: 'none',
      clean_air_only: cleanAirOnly,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query
    };
  }

  if (/qualify(?:ing)?\s*(?:vs\.?|versus|v\.?)\s*race/i.test(question) ||
      /quali\s*(?:vs\.?|versus|v\.?)\s*race/i.test(question) ||
      /race\s*(?:vs\.?|versus|v\.?)\s*qualify(?:ing)?/i.test(question) ||
      /better in\s+quali(?:fying)?\s*(?:vs\.?|versus|v\.?)\s*race/i.test(question) ||
      /better in\s+race\s*(?:vs\.?|versus|v\.?)\s*qualify(?:ing)?/i.test(question)) {
    const dualMatch = question.match(
      /(?:for|between|of|with|:)?\s*(.+?)\s+(?:and|vs\.?|versus|&)\s+(.+?)(?:\s+(?:in\s+)?(\d{4})|\s*$)/i
    );
    if (dualMatch) {
      const driver_a_id = normalizeEntity(dualMatch[1]);
      const driver_b_id = normalizeEntity(dualMatch[2]);

      return {
        kind: 'teammate_gap_dual_comparison',
        driver_a_id,
        driver_b_id,
        season,
        metric: 'teammate_gap_dual' as const,
        normalization: 'team_baseline' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query
      };
    }
  }

  if (/compare\s+/i.test(question)) {
    const compareMatch = question.match(
      /compare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:\s+at\s+|\s+in\s+|\s+on\s+|\s+)(.+)?$/i
    );
    if (compareMatch) {
      const driver_a_id = normalizeEntity(compareMatch[1]);
      const driver_b_id = normalizeEntity(compareMatch[2]);
      const tail = (compareMatch[3] || '').trim();
      const track_id = normalizeEntity(stripYear(tail));

      if (track_id && track_id.length > 0) {
        return {
          kind: 'cross_team_track_scoped_driver_comparison',
          track_id,
          driver_a_id,
          driver_b_id,
          season,
          metric,
          normalization: 'none',
          clean_air_only: cleanAirOnly,
          compound_context: 'mixed',
          session_scope: 'race',
          raw_query
        };
      }

      return {
        kind: 'teammate_gap_summary_season',
        driver_a_id,
        driver_b_id,
        season,
        metric: 'teammate_gap_raw',
        normalization: 'team_baseline',
        clean_air_only: false,
        compound_context: 'mixed',
        session_scope: 'all',
        raw_query
      };
    }
  }

  if (/career|all-time/i.test(question) && !/season/i.test(question) && !YEAR_PATTERN.test(question)) {
    const driver_id =
      extractAfterPattern(question, /show\s+(.+?)\s+career/i) ||
      extractAfterPattern(question, /(.+?)\s+career summary/i) ||
      extractAfterPattern(question, /career summary for\s+(.+)$/i);

    if (!driver_id) {
      return null;
    }

    return {
      kind: 'driver_career_summary',
      driver_id,
      season,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query
    };
  }

  if (/how did\s+.+\s+do\s+in\s+\d{4}/i.test(question)) {
    const driver_id =
      extractAfterPattern(question, /how did\s+(.+?)\s+do\s+in\s+\d{4}\b/i);

    if (!driver_id) {
      return null;
    }

    return {
      kind: 'driver_season_summary',
      driver_id,
      season,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query
    };
  }

  if (/performance\s*(profile|vector)|strengths and weaknesses|how consistent is/i.test(question)) {
    const driver_id =
      extractAfterPattern(question, /performance\s*(?:profile|vector)\s*(?:for|of)?\s*(.+?)(?:\s+in\s+\d{4}|\s*$)/i) ||
      extractAfterPattern(question, /(.+?)'?s?\s+performance\s*(?:profile|vector)/i) ||
      extractAfterPattern(question, /(.+?)'?s?\s+strengths and weaknesses/i) ||
      extractAfterPattern(question, /how consistent is\s+(.+)/i);

    if (driver_id) {
      return {
        kind: 'driver_performance_vector',
        driver_id,
        season,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'all' as const,
        raw_query
      };
    }
  }

  if (/rank\s+.+\s+by\s+|compare\s+(?:pace|speed|performance)\s+(?:of\s+)?|who is faster between/i.test(question)) {
    const multiMatch = question.match(
      /(?:rank|compare\s+(?:pace|speed|performance)\s+(?:of)?|who is faster between)\s+(.+?)(?:\s+by\s+|\s+on\s+|\s+in\s+\d{4}|$)/i
    );

    if (multiMatch) {
      const driversText = multiMatch[1]
        .replace(/\s+(?:and|&)\s+/gi, ', ')
        .replace(/\s+/g, ', ');

      const driverNames = driversText
        .split(/\s*,\s*/)
        .map(d => d.trim())
        .filter(d => d.length > 0 && !/^(the|in|at|on|by)$/i.test(d));

      if (driverNames.length >= 2 && driverNames.length <= 6) {
        let comparison_metric: 'avg_true_pace' | 'qualifying_pace' | 'consistency' = 'avg_true_pace';
        if (/qualifying|quali/i.test(question)) {
          comparison_metric = 'qualifying_pace';
        } else if (/consistency|consistent/i.test(question)) {
          comparison_metric = 'consistency';
        }

        return {
          kind: 'driver_multi_comparison',
          driver_ids: driverNames,
          comparison_metric,
          season,
          metric: 'avg_true_pace' as const,
          normalization: 'none' as const,
          clean_air_only: false,
          compound_context: 'mixed' as const,
          session_scope: 'all' as const,
          raw_query
        };
      }
    }
  }

  if (/season/i.test(question)) {
    const driver_id =
      extractAfterPattern(question, /show\s+(.+?)\s+season/i) ||
      extractAfterPattern(question, /(.+?)\s+season summary/i);

    if (!driver_id) {
      return null;
    }

    return {
      kind: 'driver_season_summary',
      driver_id,
      season,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query
    };
  }

  const isH2H = /head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test(question);

  if (isH2H) {
    let h2h_metric: 'qualifying_position' | 'race_finish_position' = 'race_finish_position';
    if (/qualif(?:y|ying|ied)?|quali\b/i.test(question)) {
      h2h_metric = 'qualifying_position';
    } else if (/race|finish(?:ed)?|won/i.test(question)) {
      h2h_metric = 'race_finish_position';
    }

    let driver_a_id: string | null = null;
    let driver_b_id: string | null = null;

    const outMatch = question.match(
      /(\w+(?:\s+\w+)?)\s+(?:outqualif(?:y|ied)|outfinish(?:ed)?)\s+(\w+(?:\s+\w+)?)/i
    );
    if (outMatch) {
      driver_a_id = normalizeEntity(outMatch[1]);
      driver_b_id = normalizeEntity(outMatch[2]);
    }

    if (!driver_a_id) {
      const h2hMatch = question.match(
        /(?:head\s*to\s*head|h2h)\s+(\w+(?:\s+\w+)?)\s+(?:vs\.?|versus|v\.?|and|&)\s+(\w+(?:\s+\w+)?)/i
      );
      if (h2hMatch) {
        driver_a_id = normalizeEntity(h2hMatch[1]);
        driver_b_id = normalizeEntity(h2hMatch[2]);
      }
    }

    if (!driver_a_id) {
      const h2hMatchReverse = question.match(
        /(\w+(?:\s+\w+)?)\s+(?:vs\.?|versus|v\.?|and|&)\s+(\w+(?:\s+\w+)?)\s+(?:head\s*to\s*head|h2h)/i
      );
      if (h2hMatchReverse) {
        driver_a_id = normalizeEntity(h2hMatchReverse[1]);
        driver_b_id = normalizeEntity(h2hMatchReverse[2]);
      }
    }

    if (!driver_a_id) {
      const aheadMatch = question.match(
        /finished ahead.*?(?:,|:)?\s*(\w+(?:\s+\w+)?)\s+(?:or|vs\.?|versus)\s+(\w+(?:\s+\w+)?)/i
      );
      if (aheadMatch) {
        driver_a_id = normalizeEntity(aheadMatch[1]);
        driver_b_id = normalizeEntity(aheadMatch[2]);
      }
    }

    if (!driver_a_id) {
      const beatMatch = question.match(
        /(?:who beat|beat count)\s+(\w+(?:\s+\w+)?)\s+(?:vs\.?|versus|v\.?|and|&)\s+(\w+(?:\s+\w+)?)/i
      );
      if (beatMatch) {
        driver_a_id = normalizeEntity(beatMatch[1]);
        driver_b_id = normalizeEntity(beatMatch[2]);
      }
    }

    if (!driver_a_id) {
      const simpleMatch = question.match(
        /(?:qualifying|race|quali)\s+(?:head\s*to\s*head|h2h)?\s*(\w+(?:\s+\w+)?)\s+(\w+(?:\s+\w+)?)/i
      );
      if (simpleMatch) {
        driver_a_id = normalizeEntity(simpleMatch[1]);
        driver_b_id = normalizeEntity(simpleMatch[2]);
      }
    }

    if (driver_a_id && driver_b_id) {
      const filters = extractHeadToHeadFilters(question, h2h_metric);

      const intent: any = {
        kind: 'driver_head_to_head_count',
        driver_a_id,
        driver_b_id,
        h2h_metric,
        h2h_scope: 'field' as const,  // Default to field-wide (cross-team allowed)
        season,
        metric: 'avg_true_pace' as const,
        normalization: 'none' as const,
        clean_air_only: false,
        compound_context: 'mixed' as const,
        session_scope: 'race' as const,
        raw_query
      };

      if (Object.keys(filters).length > 0) {
        intent.filters = filters;
      }

      return intent;
    }
  }

  return null;
}

/**
 * Extract head-to-head filters from natural language query
 */
function extractHeadToHeadFilters(
  question: string,
  metric: 'qualifying_position' | 'race_finish_position'
): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  if (metric === 'qualifying_position') {
    if (/\bQ3\b/i.test(question)) {
      filters.session = 'Q3';
    } else if (/\bQ2\b/i.test(question)) {
      filters.session = 'Q2';
    } else if (/\bQ1\b/i.test(question)) {
      filters.session = 'Q1';
    }
  }

  if (/street\s*circuit/i.test(question) || /street\s*track/i.test(question) || /\bstreet\b/i.test(question)) {
    filters.track_type = 'street';
  } else if (/permanent\s*circuit/i.test(question) || /\bpermanent\b/i.test(question)) {
    filters.track_type = 'permanent';
  }

  if (/\bwet\b|\brain\b|\brainy\b/i.test(question)) {
    filters.weather = 'wet';
  } else if (/\bdry\b/i.test(question)) {
    filters.weather = 'dry';
  } else if (/\bmixed\s*(?:conditions?)?\b/i.test(question)) {
    filters.weather = 'mixed';
  }

  if (/exclud(?:e|ing)\s+dnf/i.test(question) ||
      /without\s+dnf/i.test(question) ||
      /no\s+dnf/i.test(question) ||
      /exclude\s+retirements?/i.test(question)) {
    filters.exclude_dnfs = true;
  }

  const roundMatch = question.match(/round\s*(\d+)/i);
  if (roundMatch) {
    filters.rounds = [parseInt(roundMatch[1], 10)];
  }

  return filters;
}
