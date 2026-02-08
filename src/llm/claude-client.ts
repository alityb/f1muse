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
  MODEL: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
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
  'qualifying_results_summary',  // Added for qualifying results queries
  'driver_career_summary',
  'driver_season_summary',
  'season_driver_vs_driver',
  'cross_team_track_scoped_driver_comparison',
  'track_fastest_drivers',
  'teammate_gap_summary_season',
  'teammate_gap_dual_comparison',
  'driver_pole_count',
  'driver_career_pole_count',  // Career pole positions
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
  // NEW: Comprehensive comparison types
  'driver_vs_driver_comprehensive',
  'driver_career_wins_by_circuit',
  'teammate_comparison_career',
]);

const SYSTEM_PROMPT = `Convert F1 questions to JSON. Output ONLY JSON, no text.

DEFAULT SEASON: 2025 (always use if not specified)

QUERY TYPES:

1. race_results_summary - "who won", "race results", "podium"
   {"kind":"race_results_summary","track_id":"Monaco","season":2025}

1b. qualifying_results_summary - "who got pole", "qualifying results", "qualifying grid"
   {"kind":"qualifying_results_summary","track_id":"Monaco","season":2025}
   Note: Use this for pole position at a specific track, NOT driver_pole_count

2. track_fastest_drivers - "fastest at [track]", "rankings at [track]"
   {"kind":"track_fastest_drivers","track_id":"Monaco","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"race"}

3. cross_team_track_scoped_driver_comparison - "[driver] vs [driver] at [track]"
   {"kind":"cross_team_track_scoped_driver_comparison","track_id":"Monaco","driver_a_id":"Verstappen","driver_b_id":"Norris","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"race"}

4. teammate_gap_summary_season - "[driver] vs [driver]" (no track)
   {"kind":"teammate_gap_summary_season","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025,"metric":"teammate_gap_raw","normalization":"team_baseline","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

5. season_driver_vs_driver - cross-team comparison (no track)
   {"kind":"season_driver_vs_driver","driver_a_id":"Verstappen","driver_b_id":"Norris","season":2025,"metric":"avg_true_pace","normalization":"session_median_percent","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}
   Note: Use normalization:"session_median_percent" by default for cross-circuit comparable results. Only use "none" if user asks for "raw pace" or "raw lap times".

6. driver_season_summary - single driver stats
   {"kind":"driver_season_summary","driver_id":"Verstappen","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

7. driver_career_summary - "career", "all time"
   {"kind":"driver_career_summary","driver_id":"Hamilton","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"all"}

8. teammate_gap_dual_comparison - "qualifying vs race", "quali and race"
   {"kind":"teammate_gap_dual_comparison","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025}

9. driver_pole_count - "poles in [YEAR]", "pole positions [YEAR]" (season-specific)
   {"kind":"driver_pole_count","driver_id":"Verstappen","season":2025}

9b. driver_career_pole_count - "career poles", "total poles", "how many poles" (no year)
    {"kind":"driver_career_pole_count","driver_id":"Verstappen","season":2025}
    Trigger: "career poles", "total poles", "how many poles does X have" WITHOUT a year

10. driver_q3_count - "Q3 appearances"
    {"kind":"driver_q3_count","driver_id":"Verstappen","season":2025}

11. season_q3_rankings - "Q3 rankings"
    {"kind":"season_q3_rankings","season":2025}

12. qualifying_gap_teammates - "qualifying gap" between teammates
    {"kind":"qualifying_gap_teammates","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025}

13. qualifying_gap_drivers - cross-team qualifying
    {"kind":"qualifying_gap_drivers","driver_a_id":"Verstappen","driver_b_id":"Norris","season":2025}

14. driver_career_wins_by_circuit - "wins by circuit", "where has [driver] won"
    {"kind":"driver_career_wins_by_circuit","driver_id":"Hamilton","season":2025}
    Trigger: "wins by circuit", "circuit victories", "where has won", "which circuits"

15. teammate_comparison_career - "as teammates" (no year), "teammate history"
    {"kind":"teammate_comparison_career","driver_a_id":"Hamilton","driver_b_id":"Russell","season":2025}
    Trigger: "as teammates" WITHOUT explicit year, auto-detects all shared seasons

16. driver_vs_driver_comprehensive - "head to head", "h2h", comprehensive comparison
    {"kind":"driver_vs_driver_comprehensive","driver_a_id":"Norris","driver_b_id":"Piastri","season":2024}
    Trigger: "head to head", "h2h" - returns BOTH qualifying AND race H2H records

RULES:
- If ANY track name appears (Monaco, Monza, Silverstone, Spa, Bahrain, Suzuka, Melbourne, Imola, Miami, Barcelona, Montreal, Spielberg, Budapest, Zandvoort, Baku, Singapore, Austin, COTA, Interlagos, Las Vegas, Qatar, Abu Dhabi, Shanghai, Jeddah) → use track-scoped query (cross_team_track_scoped_driver_comparison or track_fastest_drivers)
- If "at [track]" → use track-scoped query
- If no track + 2 drivers from SAME team → teammate_gap_summary_season
- If no track + 2 drivers from DIFFERENT teams → season_driver_vs_driver
- If "clean air" → clean_air_only:true, metric:"avg_true_pace"
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

    // Extract year from raw query - always trust explicit year in query over LLM parsing
    const yearMatch = rawQuery.match(/\b(20\d{2})\b/);
    if (yearMatch) {
      const explicitYear = parseInt(yearMatch[1], 10);
      // Override if LLM returned different year or no year
      if (!parsed.season || parsed.season !== explicitYear) {
        console.log(`[Claude] Overriding LLM season ${parsed.season} with explicit year ${explicitYear} from query`);
        parsed.season = explicitYear;
      }
    } else if (!parsed.season) {
      parsed.season = 2025; // default season when no year specified
    }

    // Ensure raw_query is set
    parsed.raw_query = rawQuery;

    // Extract track from raw query - upgrade to track-scoped if track detected
    const lowerQuery = rawQuery.toLowerCase();
    const TRACK_PATTERNS: Record<string, string> = {
      'monza': 'Monza',
      'monaco': 'Monaco',
      'silverstone': 'Silverstone',
      'spa': 'Spa',
      'suzuka': 'Suzuka',
      'bahrain': 'Bahrain',
      'jeddah': 'Jeddah',
      'melbourne': 'Melbourne',
      'albert park': 'Melbourne',
      'imola': 'Imola',
      'miami': 'Miami',
      'barcelona': 'Barcelona',
      'montreal': 'Montreal',
      'spielberg': 'Spielberg',
      'red bull ring': 'Spielberg',
      'hungaroring': 'Budapest',
      'budapest': 'Budapest',
      'zandvoort': 'Zandvoort',
      'baku': 'Baku',
      'singapore': 'Singapore',
      'cota': 'Austin',
      'austin': 'Austin',
      'mexico': 'Mexico City',
      'interlagos': 'Interlagos',
      'sao paulo': 'Interlagos',
      'las vegas': 'Las Vegas',
      'qatar': 'Qatar',
      'lusail': 'Qatar',
      'abu dhabi': 'Abu Dhabi',
      'yas marina': 'Abu Dhabi',
      'shanghai': 'Shanghai',
      'china': 'Shanghai',
    };

    let detectedTrack: string | null = null;
    for (const [pattern, trackId] of Object.entries(TRACK_PATTERNS)) {
      if (lowerQuery.includes(pattern)) {
        detectedTrack = trackId;
        break;
      }
    }

    // If track detected and query is season-scoped driver comparison, upgrade to track-scoped
    if (detectedTrack && !parsed.track_id) {
      parsed.track_id = detectedTrack;
      console.log(`[Claude] Detected track "${detectedTrack}" from query, adding to intent`);

      // Upgrade query kind to track-scoped if it was season-scoped
      if (parsed.kind === 'season_driver_vs_driver') {
        parsed.kind = 'cross_team_track_scoped_driver_comparison';
        console.log(`[Claude] Upgraded query kind to cross_team_track_scoped_driver_comparison`);
      }
    }

    // Apply default normalization for season_driver_vs_driver
    // Use session_median_percent unless user explicitly asked for raw pace
    if (parsed.kind === 'season_driver_vs_driver') {
      const wantsRawPace = lowerQuery.includes('raw pace') ||
                          lowerQuery.includes('raw lap') ||
                          lowerQuery.includes('raw times') ||
                          lowerQuery.includes('absolute pace') ||
                          lowerQuery.includes('actual lap time');

      if (!wantsRawPace && (parsed.normalization === 'none' || !parsed.normalization)) {
        parsed.normalization = 'session_median_percent';
      }
    }

    // =================================================================
    // HARD ROUTING OVERRIDES - cannot be bypassed by LLM
    // =================================================================

    // HARD RULE 1: "wins by circuit" → driver_career_wins_by_circuit
    const isWinsByCircuitQuery =
      lowerQuery.includes('wins by circuit') ||
      lowerQuery.includes('wins at each circuit') ||
      lowerQuery.includes('circuit victories') ||
      lowerQuery.includes('track victories') ||
      (lowerQuery.includes('where has') && lowerQuery.includes('won')) ||
      (lowerQuery.includes('where did') && lowerQuery.includes('win'));

    if (isWinsByCircuitQuery && parsed.kind !== 'driver_career_wins_by_circuit') {
      console.log(`[Claude] Hard override: ${parsed.kind} → driver_career_wins_by_circuit`);
      parsed.kind = 'driver_career_wins_by_circuit';
      // Ensure driver_id is set (might be in driver_a_id from wrong routing)
      if (!parsed.driver_id && parsed.driver_a_id) {
        parsed.driver_id = parsed.driver_a_id;
      }
    }

    // HARD RULE 2: "as teammates" without explicit season → teammate_comparison_career
    const isTeammateCareerQuery =
      lowerQuery.includes('as teammates') ||
      lowerQuery.includes('teammate history') ||
      lowerQuery.includes('all seasons together') ||
      lowerQuery.includes('complete teammate') ||
      lowerQuery.includes('all seasons as');

    const hasExplicitSeason = /\b20[1-2]\d\b/.test(rawQuery);

    if (isTeammateCareerQuery && !hasExplicitSeason) {
      if (parsed.kind !== 'teammate_comparison_career') {
        console.log(`[Claude] Hard override: ${parsed.kind} → teammate_comparison_career`);
        parsed.kind = 'teammate_comparison_career';
      }
    }

    // HARD RULE 3: Qualifying results with track context → qualifying_results_summary
    const hasTrackContext = lowerQuery.includes(' at ') ||
      /\b(monaco|silverstone|monza|spa|suzuka|interlagos|bahrain|jeddah|australia|miami|imola|canada|barcelona|austria|hungary|netherlands|singapore|mexico|vegas|qatar|abu dhabi|albert park|shanghai|baku|zandvoort|las vegas|sakhir|yas marina|melbourne|montreal|hungaroring|red bull ring)\b/i.test(lowerQuery);

    const isQualifyingResultsQuery = hasTrackContext && (
      (lowerQuery.includes('qualifying') && (lowerQuery.includes('result') || lowerQuery.includes('grid'))) ||
      lowerQuery.includes('quali result') ||
      lowerQuery.includes('quali grid') ||
      lowerQuery.includes('qualifying grid') ||
      lowerQuery.includes('who got pole') ||
      (lowerQuery.includes('who qualified') && lowerQuery.includes('pole')) ||
      (lowerQuery.includes('pole') && lowerQuery.includes(' at '))
    );

    const isQualifyingExcluded =
      lowerQuery.includes('how many poles') ||
      lowerQuery.includes('pole count') ||
      lowerQuery.includes('poles did') ||
      lowerQuery.includes('qualifying gap') ||
      lowerQuery.includes('outqualified');

    if (isQualifyingResultsQuery && !isQualifyingExcluded && parsed.kind !== 'qualifying_results_summary') {
      console.log(`[Claude] Hard override: ${parsed.kind} → qualifying_results_summary`);
      parsed.kind = 'qualifying_results_summary';
      // Ensure track_id is set
      if (!parsed.track_id && detectedTrack) {
        parsed.track_id = detectedTrack;
      }
    }

    // HARD RULE 4: Generic "head to head" → driver_vs_driver_comprehensive
    const hasHeadToHead =
      lowerQuery.includes('head to head') ||
      lowerQuery.includes('h2h') ||
      lowerQuery.includes('head-to-head');

    const isSpecificH2H =
      lowerQuery.includes('qualifying head to head') ||
      lowerQuery.includes('race head to head') ||
      lowerQuery.includes('outqualified') ||
      lowerQuery.includes('outfinish') ||
      lowerQuery.includes('who finished ahead') ||
      lowerQuery.includes('who qualified ahead');

    if (hasHeadToHead && !isSpecificH2H && parsed.kind !== 'driver_vs_driver_comprehensive') {
      console.log(`[Claude] Hard override: ${parsed.kind} → driver_vs_driver_comprehensive`);
      parsed.kind = 'driver_vs_driver_comprehensive';
    }

    // HARD RULE 4b: Generic "driver vs driver" queries (no track, no specific metric) → driver_vs_driver_comprehensive
    // Pattern: "X vs Y 2024" or "X versus Y" without pace/gap/time keywords
    const isGenericVsQuery = /\b(vs|versus)\b/i.test(lowerQuery);
    const hasSpecificMetric = /\b(pace|gap|time|faster|slower|quicker|speed|lap times?)\b/i.test(lowerQuery);
    const hasTrack = detectedTrack !== null;
    const isTeammateQuery = /\b(teammate|team[- ]?mate)\b/i.test(lowerQuery);

    if (isGenericVsQuery && !hasSpecificMetric && !hasTrack && !isTeammateQuery &&
        parsed.kind === 'season_driver_vs_driver') {
      console.log(`[Claude] Hard override: ${parsed.kind} → driver_vs_driver_comprehensive (generic vs query)`);
      parsed.kind = 'driver_vs_driver_comprehensive';
    }

    // HARD RULE 5: Career pole queries → driver_career_pole_count
    // "how many poles does X have" without year = career query
    const isPoleQuery = /\b(poles?|pole positions?)\b/i.test(lowerQuery) &&
      /\b(how many|total|career|all[- ]time|does.+have|has.+got)\b/i.test(lowerQuery);
    const hasCareerIndicator = /\b(career|all[- ]time|total|in his career|lifetime)\b/i.test(lowerQuery);

    if (isPoleQuery && (!hasExplicitSeason || hasCareerIndicator) && parsed.kind !== 'driver_career_pole_count') {
      console.log(`[Claude] Hard override: ${parsed.kind} → driver_career_pole_count`);
      parsed.kind = 'driver_career_pole_count';
      // Ensure driver_id is set
      if (!parsed.driver_id && parsed.driver_a_id) {
        parsed.driver_id = parsed.driver_a_id;
      }
    }

    // HARD RULE 6: Clean air queries → set clean_air_only=true
    // Triggered by "clean air", "clear air", or "without traffic" in query
    const isCleanAirQuery =
      lowerQuery.includes('clean air') ||
      lowerQuery.includes('clear air') ||
      lowerQuery.includes('without traffic');

    if (isCleanAirQuery) {
      console.log(`[Claude] Clean air query detected: setting clean_air_only=true`);
      parsed.clean_air_only = true;
      // Always override metric to avg_true_pace - the database uses same metric name for clean air laps
      parsed.metric = 'avg_true_pace';
    }

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
