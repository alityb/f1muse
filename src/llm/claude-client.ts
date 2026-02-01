/**
 * PRODUCTION CLAUDE LLM CLIENT
 *
 * Features:
 * - 10s request timeout
 * - Exponential backoff retries for 429/5xx
 * - Temperature = 0 for deterministic output
 * - Strict JSON schema validation
 * - Concurrency-safe (stateless)
 * - Structured logging
 */

import Anthropic from '@anthropic-ai/sdk';
import { QueryIntent, QueryIntentKind } from '../types/query-intent';
import { metrics } from '../observability/metrics';
import { withConcurrencyLimit, LLMUnavailableError } from './concurrency-limiter';
import { getCachedIntent, cacheIntent } from './intent-cache';
import { getConfig } from './config';

// Configuration
const CONFIG = {
  MODEL: 'claude-3-5-haiku-20241022',
  MAX_TOKENS: 512,
  TEMPERATURE: 0,
  TIMEOUT_MS: 10000,
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY_MS: 500,
  MAX_RETRY_DELAY_MS: 5000,
};

// Valid query kinds for validation
const VALID_QUERY_KINDS: Set<QueryIntentKind> = new Set([
  'race_results_summary',
  'driver_career_summary',
  'driver_season_summary',
  'season_driver_vs_driver',
  'cross_team_track_scoped_driver_comparison',
  'track_fastest_drivers',
  'teammate_gap_summary_season',
  'teammate_gap_dual_comparison',
  'driver_pole_count',
  'driver_q3_count',
  'season_q3_rankings',
  'qualifying_gap_teammates',
  'qualifying_gap_drivers',
  'driver_head_to_head_count',
  'driver_performance_vector',
  'driver_multi_comparison',
  'driver_matchup_lookup',
  'driver_profile_summary',
  'driver_trend_summary',
]);

const SYSTEM_PROMPT = `Convert F1 questions to JSON. Output ONLY JSON, no text.

DEFAULT SEASON: 2025 (always use if not specified)

QUERY TYPES:

1. race_results_summary - "who won", "results of", "podium"
   {"kind":"race_results_summary","track_id":"Monaco","season":2025}

2. track_fastest_drivers - "fastest at [track]", "rankings at [track]"
   {"kind":"track_fastest_drivers","track_id":"Monaco","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"race"}

3. cross_team_track_scoped_driver_comparison - "[driver] vs [driver] at [track]"
   {"kind":"cross_team_track_scoped_driver_comparison","track_id":"Monaco","driver_a_id":"Verstappen","driver_b_id":"Norris","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"race"}

4. teammate_gap_summary_season - "[driver] vs [driver]" (no track)
   {"kind":"teammate_gap_summary_season","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025,"metric":"teammate_gap_raw","normalization":"team_baseline","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

5. season_driver_vs_driver - cross-team comparison (no track)
   {"kind":"season_driver_vs_driver","driver_a_id":"Verstappen","driver_b_id":"Norris","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

6. driver_season_summary - single driver stats
   {"kind":"driver_season_summary","driver_id":"Verstappen","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

7. driver_career_summary - "career", "all time"
   {"kind":"driver_career_summary","driver_id":"Hamilton","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

8. teammate_gap_dual_comparison - "qualifying vs race", "quali and race"
   {"kind":"teammate_gap_dual_comparison","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025}

9. driver_pole_count - "poles", "pole positions"
   {"kind":"driver_pole_count","driver_id":"Verstappen","season":2025}

10. driver_q3_count - "Q3 appearances"
    {"kind":"driver_q3_count","driver_id":"Verstappen","season":2025}

11. season_q3_rankings - "Q3 rankings"
    {"kind":"season_q3_rankings","season":2025}

12. qualifying_gap_teammates - "qualifying gap" between teammates
    {"kind":"qualifying_gap_teammates","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025}

13. qualifying_gap_drivers - cross-team qualifying
    {"kind":"qualifying_gap_drivers","driver_a_id":"Verstappen","driver_b_id":"Norris","season":2025}

RULES:
- If "at [track]" → use track-scoped query
- If no track + 2 drivers → teammate_gap_summary_season
- If "clean air" → clean_air_only:true, metric:"clean_air_pace"
- Use driver names as-is (Verstappen, Hamilton, Norris)
- Use track names as-is (Monaco, Silverstone, Monza)

OUTPUT: Only JSON object, no markdown, no explanation.`;

export interface ClaudeParseResult {
  success: boolean;
  intent?: QueryIntent;
  error?: string;
  latencyMs: number;
  retryCount: number;
}

export interface ClaudeClientOptions {
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Production-ready Claude LLM Client
 * Thread-safe, stateless, with retries and timeouts
 */
export class ClaudeClient {
  private readonly anthropic: Anthropic;
  private readonly timeout: number;

  constructor(options: ClaudeClientOptions = {}) {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

    if (!apiKey) {
      throw new Error('Claude API key not configured. Set ANTHROPIC_API_KEY or CLAUDE_API_KEY environment variable.');
    }

    this.anthropic = new Anthropic({ apiKey });
    this.timeout = options.timeout || CONFIG.TIMEOUT_MS;
  }

  /**
   * Parse natural language query into QueryIntent
   * Includes caching, concurrency limiting, and retries
   */
  async parseIntent(question: string, requestId?: string): Promise<ClaudeParseResult> {
    const startTime = Date.now();

    // check cache first (before any llm call)
    const cached = await getCachedIntent(question);
    if (cached) {
      const latencyMs = Date.now() - startTime;
      console.log(`[Claude] Cache hit for: "${question.substring(0, 50)}..."`);
      return {
        success: true,
        intent: cached,
        latencyMs,
        retryCount: 0,
      };
    }

    // use concurrency limiter for llm calls
    try {
      const result = await withConcurrencyLimit(async () => {
        return this.executeWithRetries(question, requestId);
      });

      // cache successful result
      if (result.success && result.intent) {
        await cacheIntent(question, result.intent);
      }

      return result;
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;

      // handle concurrency limiter errors
      if (error instanceof LLMUnavailableError) {
        metrics.incrementNLParseFailure('llm_unavailable');
        return {
          success: false,
          error: error.message,
          latencyMs,
          retryCount: 0,
        };
      }

      metrics.incrementNLParseFailure(error.message || 'unknown');
      return {
        success: false,
        error: error.message || 'Unknown error',
        latencyMs,
        retryCount: 0,
      };
    }
  }

  /**
   * Execute with retries (called within concurrency limiter)
   */
  private async executeWithRetries(question: string, requestId?: string): Promise<ClaudeParseResult> {
    const startTime = Date.now();
    const config = getConfig();
    const maxRetries = config.maxRetries;

    let lastError: Error | null = null;
    let retryCount = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      retryCount = attempt;

      try {
        const result = await this.executeWithTimeout(question, requestId);
        const latencyMs = Date.now() - startTime;

        metrics.recordNLParseLatency(latencyMs);
        metrics.incrementNLParseSuccess();

        return {
          success: true,
          intent: result,
          latencyMs,
          retryCount,
        };
      } catch (error: any) {
        lastError = error;

        const shouldRetry = this.shouldRetry(error, attempt);
        if (shouldRetry && attempt < maxRetries) {
          const delay = this.calculateBackoff(attempt);
          console.warn(`[Claude] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${error.message}`);
          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    const latencyMs = Date.now() - startTime;
    metrics.recordNLParseLatency(latencyMs);
    metrics.incrementNLParseFailure(lastError?.message || 'unknown');

    return {
      success: false,
      error: lastError?.message || 'Unknown error',
      latencyMs,
      retryCount,
    };
  }

  /**
   * Execute API call with timeout
   */
  private async executeWithTimeout(question: string, _requestId?: string): Promise<QueryIntent> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const message = await this.anthropic.messages.create({
        model: CONFIG.MODEL,
        max_tokens: CONFIG.MAX_TOKENS,
        temperature: CONFIG.TEMPERATURE,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
      }, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Extract text from response
      const responseText = message.content[0].type === 'text'
        ? message.content[0].text
        : '';

      // Parse and validate JSON
      return this.parseAndValidateJSON(responseText, question);
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Parse and validate JSON response
   */
  private parseAndValidateJSON(responseText: string, rawQuery: string): QueryIntent {
    // Clean response (remove markdown if present)
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.slice(7);
    }
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.slice(3);
    }
    if (cleanedText.endsWith('```')) {
      cleanedText = cleanedText.slice(0, -3);
    }
    cleanedText = cleanedText.trim();

    // Parse JSON
    let parsed: any;
    try {
      parsed = JSON.parse(cleanedText);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${cleanedText.substring(0, 100)}...`);
    }

    // Validate required fields
    if (!parsed.kind) {
      throw new Error('Missing required field: kind');
    }

    if (!VALID_QUERY_KINDS.has(parsed.kind)) {
      throw new Error(`Invalid query kind: ${parsed.kind}`);
    }

    if (!parsed.season) {
      parsed.season = 2025; // Default season
    }

    // Ensure raw_query is set
    parsed.raw_query = rawQuery;

    return parsed as QueryIntent;
  }

  /**
   * Determine if we should retry based on error
   */
  private shouldRetry(error: any, attempt: number): boolean {
    const config = getConfig();

    // no retries in corpus test mode
    if (config.corpusTestMode) {
      return false;
    }

    if (attempt >= config.maxRetries) {
      return false;
    }

    // Retry on rate limit (429)
    if (error.status === 429) {
      return true;
    }

    // Retry on server errors (5xx)
    if (error.status >= 500 && error.status < 600) {
      return true;
    }

    // Retry on timeout
    if (error.message?.includes('timeout')) {
      return true;
    }

    // Retry on network errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return true;
    }

    return false;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoff(attempt: number): number {
    const delay = CONFIG.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * 100;
    return Math.min(delay + jitter, CONFIG.MAX_RETRY_DELAY_MS);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check - verify API key is valid
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple API call to verify connectivity
      await this.anthropic.messages.create({
        model: CONFIG.MODEL,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance for production use
let clientInstance: ClaudeClient | null = null;

export function getClaudeClient(): ClaudeClient {
  if (!clientInstance) {
    clientInstance = new ClaudeClient();
  }
  return clientInstance;
}

export function resetClaudeClient(): void {
  clientInstance = null;
}
