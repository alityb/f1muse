import Anthropic from '@anthropic-ai/sdk';
import { QueryIntent } from '../types/query-intent';

console.error('=== QUERY TRANSLATOR MODULE LOADED v2 (career poles support) ===');
import { withConcurrencyLimit, LLMUnavailableError } from './concurrency-limiter';
import { getCachedIntent, cacheIntent } from './intent-cache';

/**
 * LLM-powered QueryIntent translator
 * Converts natural language questions into structured QueryIntent objects
 */

const SYSTEM_PROMPT = `You are an F1 analytics query translator. Convert natural language questions into QueryIntent JSON.

STATMUSE-STYLE BEHAVIOR:
- NEVER ask for clarification
- NEVER return ambiguity errors
- ALWAYS select the best deterministic entity
- Season + context always wins

## 17 SUPPORTED QUERY TYPES (check in priority order)

### 0. qualifying_results_summary - Official qualifying results from F1DB
   - Trigger: "qualifying results", "who got pole", "pole position", "qualifying grid", "quali results", "who qualified", "grid position"
   - Example: "Who got pole at Monaco 2024?"
   - Example: "Qualifying results of Silverstone 2025"
   - Example: "Monaco 2025 qualifying grid"
   - Fields: kind, track_id, season, raw_query
   - NO metric, NO normalization fields (same as race_results_summary)
   - Use when: Question asks for qualifying results, pole sitter, or qualifying grid
   - IMPORTANT: Do NOT use for "how many poles" → that's driver_pole_count
   - IMPORTANT: Do NOT use for "qualifying gap" → that's qualifying_gap_teammates or qualifying_gap_drivers

### 1. race_results_summary - Official race results from F1DB
   - Trigger: "results of", "race results", "who won", "winner of", "podium"
   - Example: "Results of Monza 2025"
   - Example: "Who won Abu Dhabi 2025?"
   - Fields: kind, track_id, season, raw_query
   - NO metric, NO normalization fields
   - Use when: Question asks for race results, winner, or podium

### 2. track_fastest_drivers - Rank all drivers at a specific track
   - Example: "Fastest drivers at Monaco 2025"
   - Example: "Who was fastest at Suzuka 2025"
   - Fields: kind, track_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only, compound_context: "mixed", session_scope: "race", raw_query
   - Use when: Question asks for ranking/fastest at a SPECIFIC TRACK
   - If "clean air" mentioned: set clean_air_only=true, metric="avg_true_pace"

### 3. cross_team_track_scoped_driver_comparison - Compare 2 drivers at a specific track
   - Example: "Compare Verstappen and Norris at Silverstone 2025"
   - Example: "Max vs Lando Monza 2025"
   - Fields: kind, track_id, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "race", raw_query
   - Use when: Question mentions a SPECIFIC TRACK and compares 2 drivers
   - If "clean air" mentioned: set clean_air_only=true, metric="avg_true_pace"

### 4. teammate_gap_dual_comparison - Qualifying vs race pace comparison
   - Trigger: "qualifying vs race", "quali vs race", "race vs qualifying", "better in quali vs race"
   - Example: "Compare qualifying vs race pace for Norris and Piastri 2025"
   - Fields: kind, driver_a_id, driver_b_id, season, raw_query
   - Use when: Question explicitly asks to compare qualifying vs race pace between teammates

### 5. teammate_gap_summary_season - Full-season teammate gap (PRIMARY performance metric)
   - Example: "Compare Norris and Piastri 2025"
   - Example: "How much faster was Leclerc than Sainz?"
   - Fields: kind, season, driver_a_id, driver_b_id, metric: "teammate_gap_raw", normalization: "team_baseline", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question compares 2 drivers for a full season WITHOUT mentioning a specific track
   - This is the DEFAULT for driver comparisons (no track mentioned)

### 6. season_driver_vs_driver - Cross-team season comparison (session-median normalized)
   - Example: "Compare Verstappen and Norris 2025" (if not teammates)
   - Fields: kind, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "session_median_percent", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question compares 2 drivers from DIFFERENT TEAMS for a full season WITHOUT mentioning a specific track
   - Default normalization is "session_median_percent" (per-lap normalization against session median)
   - ONLY use normalization: "none" if user explicitly asks for "raw pace" or "raw lap times"

### 7. driver_season_summary - Single driver season statistics
   - Example: "Show Verstappen 2025 season"
   - Example: "Verstappen season summary"
   - Fields: kind, driver_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question asks about ONE driver with explicit season reference
   - ROUTING RULE: If season is present OR word "season" appears → driver_season_summary

### 8. driver_career_summary - Career-spanning statistics
   - Example: "Verstappen career summary"
   - Example: "Show Verstappen career"
   - Fields: kind, driver_id, season (default to 2025), metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question asks about "career", "all-time", or driver summary with NO season mentioned
   - ROUTING RULE: ONLY if NO season implied and "career"/"all-time" present

### 9. driver_pole_count - Count pole positions for a driver in a SPECIFIC SEASON (QUALIFYING)
   - Trigger: "how many poles in [YEAR]", "pole count [YEAR]", "poles did [driver] get in [YEAR]"
   - Example: "How many poles did Verstappen get in 2024?"
   - Example: "Norris pole positions 2025"
   - Fields: kind, driver_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "qualifying", raw_query
   - Use when: Question asks HOW MANY poles a driver got IN A SPECIFIC SEASON
   - DO NOT use for "who got pole at X" - that's qualifying_results_summary (type 0)
   - DO NOT use for career poles - that's driver_career_pole_count (type 9b)

### 9b. driver_career_pole_count - CAREER pole positions for a driver (QUALIFYING)
   - Trigger: "career poles", "how many poles does [driver] have", "total poles", "poles in his career", "all-time poles"
   - Example: "How many pole positions does Max Verstappen have in his career?"
   - Example: "Hamilton career poles"
   - Example: "Total poles for Schumacher"
   - Example: "How many poles does verstappen have"
   - Fields: kind, driver_id, raw_query
   - NO season field (career-spanning)
   - Use when: Question asks about CAREER/ALL-TIME poles (no specific season mentioned)
   - IMPORTANT: If "career", "all-time", "total", or "in his career" is mentioned → driver_career_pole_count
   - IMPORTANT: If question asks "how many poles does X have" without a year → driver_career_pole_count

### 10. driver_q3_count - Count Q3 appearances for a driver (QUALIFYING)
   - Trigger: "Q3 appearances", "how many times Q3", "Q3 count", "made Q3"
   - Example: "How many times did Sainz make Q3 in 2025?"
   - Example: "Q3 appearances for Hamilton 2024"
   - Fields: kind, driver_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "qualifying", raw_query
   - Use when: Question asks about Q3 appearances for a specific driver

### 11. season_q3_rankings - Rank drivers by Q3 appearances (QUALIFYING)
   - Trigger: "Q3 rankings", "who made Q3 most", "rank by Q3 appearances"
   - Example: "Q3 rankings 2025"
   - Example: "Who made Q3 the most in 2024?"
   - Fields: kind, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "qualifying", raw_query
   - Use when: Question asks for ranking of all drivers by Q3 count

### 12. qualifying_gap_teammates - Qualifying gap between teammates (QUALIFYING)
   - Trigger: "qualifying gap", "outqualified", "qualifying comparison", "who outqualified"
   - Example: "Qualifying gap between Norris and Piastri 2025"
   - Example: "Who outqualified whom, Verstappen or Perez?"
   - Fields: kind, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "team_baseline", clean_air_only: false, compound_context: "mixed", session_scope: "qualifying", raw_query
   - Use when: Question asks about qualifying performance gap between teammates

### 13. qualifying_gap_drivers - Qualifying gap between any drivers (QUALIFYING)
   - Trigger: "qualifying positions", "who qualifies higher", "qualifying head to head"
   - Example: "Qualifying positions Verstappen vs Leclerc 2025"
   - Example: "Who qualifies higher, Norris or Hamilton?"
   - Fields: kind, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "qualifying", raw_query
   - Use when: Question asks about qualifying position comparison between any two drivers (cross-team)

### 14. driver_vs_driver_comprehensive - Full comparison with pace and achievements (PRIORITY)
   - Trigger: "full comparison", "complete comparison", "head to head", "h2h", "compare all stats", "overall record", "vs" (when comparing two drivers without specific metric)
   - Example: "Verstappen vs Norris full comparison 2024"
   - Example: "Complete head to head Leclerc Hamilton 2023"
   - Example: "head to head Norris Piastri" (shows both race and quali records)
   - Example: "h2h Verstappen Hamilton 2025"
   - Example: "h2h leclerc vs hamilton"
   - Example: "leclerc vs hamilton h2h"
   - Fields: kind, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question asks for head-to-head comparison OR comprehensive comparison including pace, wins, podiums, poles, DNFs, points
   - Returns: Pace data, H2H qualifying counts, H2H race finish counts, season stats (wins, podiums, poles, DNFs, points)
   - IMPORTANT: Use this for ANY query containing "h2h" or "head to head" - it shows BOTH race AND qualifying records
   - IMPORTANT: If query contains "h2h" keyword, ALWAYS use driver_vs_driver_comprehensive (NOT season_driver_vs_driver)

### 15. driver_career_wins_by_circuit - Career wins breakdown by circuit
   - Trigger: "wins by circuit", "where has won", "circuit victories", "track victories"
   - Example: "Hamilton wins by circuit"
   - Example: "Where has Verstappen won?"
   - Fields: kind, driver_id, season (default 2025 - not used), metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question asks about a driver's career wins breakdown by track/circuit
   - Returns: Total wins and list of circuits with win count and last win year

### 16. teammate_comparison_career - Multi-season teammate comparison
   - Trigger: "as teammates", "teammate history", "all seasons together", "complete teammate"
   - Example: "Hamilton vs Russell as teammates"
   - Example: "Norris vs Piastri all seasons"
   - Example: "Verstappen Ricciardo teammate history"
   - Fields: kind, driver_a_id, driver_b_id, season (default 2025 - not used), metric: "teammate_gap_raw", normalization: "team_baseline", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question asks about two drivers' complete teammate history across all seasons
   - Returns: Per-season breakdown with gap data, plus aggregate stats

## CRITICAL ROUTING RULES

0. **Qualifying Results Detection (CHECK FIRST):**
   - "Qualifying results" → qualifying_results_summary
   - "Who got pole at X" → qualifying_results_summary
   - "Who qualified on pole" → qualifying_results_summary
   - "Qualifying grid" → qualifying_results_summary
   - "Quali results" → qualifying_results_summary
   - Do NOT confuse with driver_pole_count (for "how many poles" across a season)
   - Do NOT confuse with qualifying_gap queries (for gap between drivers)

1. **Race Results Detection:**
   - "Results of X" → race_results_summary (unless "qualifying" mentioned)
   - "Who won X" → race_results_summary
   - "X results" → race_results_summary (unless "qualifying" mentioned)
   - "Podium at X" → race_results_summary
   - Do NOT route to pace queries

2. **Season vs Career:**
   - If season is present → driver_season_summary
   - If word "season" appears → driver_season_summary
   - If "career"/"all-time" appears → driver_career_summary
   - Never silently downgrade season to career

3. **Track Queries:**
   - If "at [TRACK]" or "in [TRACK]" mentioned → track-scoped query (types 2 or 3)
   - Track queries ALWAYS use metric="avg_true_pace", normalization="none"

4. **Driver Comparisons:**
   - If "head to head", "h2h" mentioned (without "qualifying h2h" or "race h2h") → driver_vs_driver_comprehensive (type 14) - shows BOTH race AND qualifying records
   - If "qualifying vs race" mentioned → teammate_gap_dual_comparison (type 4)
   - If track mentioned → cross_team_track_scoped_driver_comparison (type 3)
   - If no track mentioned → teammate_gap_summary_season (type 5) as default
   - Use season_driver_vs_driver (type 6) only if explicitly cross-team and no baseline wanted

5. **Default Season:**
   - Always default to 2025 if not mentioned

6. **Clean Air (IMPORTANT):**
   - If query contains "clean air", "clear air", or "without traffic" → you MUST set clean_air_only=true AND metric="avg_true_pace"
   - This applies to ANY query type that has clean_air_only field
   - Example: "verstappen vs norris clean air jeddah 2024" → clean_air_only=true, metric="avg_true_pace"
   - Otherwise → clean_air_only=false, metric="avg_true_pace"

7. **Qualifying Queries:**
   - "who got pole at [TRACK]" or "pole at [TRACK]" → qualifying_results_summary (type 0) - asking about a specific race
   - "how many poles", "pole count", "poles did [DRIVER] get" → driver_pole_count (type 9) - asking about driver's pole count
   - "Q3 appearances", "made Q3", "Q3 count" → driver_q3_count (type 10)
   - "Q3 rankings", "who made Q3 most" → season_q3_rankings (type 11)
   - "qualifying gap", "outqualified", "qualifying comparison" + teammates → qualifying_gap_teammates (type 12)
   - "qualifying positions", "who qualifies higher" + any two drivers → qualifying_gap_drivers (type 13)
   - IMPORTANT: For qualifying teammate gap, drivers MUST be on the same team
   - Cross-team qualifying comparisons use qualifying_gap_drivers (type 13)

## FIELD EXTRACTION RULES

1. **Driver Names:**
   - Extract as-is from question
   - Use first name, last name, or abbreviation
   - Set driver_a_surface, driver_b_surface, driver_surface to exact extracted strings
   - Set driver_a_id, driver_b_id, driver_id to same values
   - Backend will resolve to F1DB IDs

2. **Track Names:**
   - Extract as-is from question
   - Use common names (Silverstone, Monaco, Spa, etc.)
   - Set track_surface to exact extracted string
   - Set track_id to same value
   - Backend will resolve to F1DB IDs

3. **Season:**
   - Extract from question or default to 2025
   - Must be integer

4. **raw_query:**
   - ALWAYS include the original question verbatim

## OUTPUT FORMAT

Return ONLY valid JSON (no markdown, no explanation).

Example (qualifying results):
{
  "kind": "qualifying_results_summary",
  "track_id": "Monaco",
  "season": 2024,
  "raw_query": "Who got pole at Monaco 2024?"
}

Example (race results):
{
  "kind": "race_results_summary",
  "track_id": "Monza",
  "season": 2025,
  "raw_query": "Results of Monza 2025"
}

Example (track comparison):
{
  "kind": "cross_team_track_scoped_driver_comparison",
  "track_id": "Silverstone",
  "driver_a_id": "Max",
  "driver_b_id": "Lando",
  "season": 2025,
  "metric": "avg_true_pace",
  "normalization": "none",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "race",
  "raw_query": "Compare Max and Lando at Silverstone 2025"
}

Example (clean air track comparison - use when "clean air" or "without traffic" mentioned):
{
  "kind": "cross_team_track_scoped_driver_comparison",
  "track_id": "Silverstone",
  "driver_a_id": "Max",
  "driver_b_id": "Lando",
  "season": 2025,
  "metric": "avg_true_pace",
  "normalization": "none",
  "clean_air_only": true,
  "compound_context": "mixed",
  "session_scope": "race",
  "raw_query": "Verstappen vs Norris clean air Silverstone 2025"
}

Example (teammate comparison):
{
  "kind": "teammate_gap_summary_season",
  "driver_a_id": "Norris",
  "driver_b_id": "Piastri",
  "season": 2025,
  "metric": "teammate_gap_raw",
  "normalization": "team_baseline",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "all",
  "raw_query": "Compare Norris and Piastri 2025"
}

Example (qualifying vs race pace comparison):
{
  "kind": "teammate_gap_dual_comparison",
  "driver_a_id": "Norris",
  "driver_b_id": "Piastri",
  "season": 2025,
  "raw_query": "Compare qualifying vs race pace for Norris and Piastri 2025"
}

Example (pole count):
{
  "kind": "driver_pole_count",
  "driver_id": "Verstappen",
  "season": 2024,
  "metric": "avg_true_pace",
  "normalization": "none",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "qualifying",
  "raw_query": "How many poles did Verstappen get in 2024?"
}

Example (Q3 count):
{
  "kind": "driver_q3_count",
  "driver_id": "Sainz",
  "season": 2025,
  "metric": "avg_true_pace",
  "normalization": "none",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "qualifying",
  "raw_query": "How many times did Sainz make Q3 in 2025?"
}

Example (qualifying gap teammates):
{
  "kind": "qualifying_gap_teammates",
  "driver_a_id": "Norris",
  "driver_b_id": "Piastri",
  "season": 2025,
  "metric": "avg_true_pace",
  "normalization": "team_baseline",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "qualifying",
  "raw_query": "Qualifying gap between Norris and Piastri 2025"
}

Example (comprehensive comparison):
{
  "kind": "driver_vs_driver_comprehensive",
  "driver_a_id": "Verstappen",
  "driver_b_id": "Norris",
  "season": 2024,
  "metric": "avg_true_pace",
  "normalization": "none",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "all",
  "raw_query": "Verstappen vs Norris full comparison 2024"
}

Example (wins by circuit):
{
  "kind": "driver_career_wins_by_circuit",
  "driver_id": "Hamilton",
  "season": 2025,
  "metric": "avg_true_pace",
  "normalization": "none",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "all",
  "raw_query": "Hamilton wins by circuit"
}

Example (teammate comparison career):
{
  "kind": "teammate_comparison_career",
  "driver_a_id": "Hamilton",
  "driver_b_id": "Russell",
  "season": 2025,
  "metric": "teammate_gap_raw",
  "normalization": "team_baseline",
  "clean_air_only": false,
  "compound_context": "mixed",
  "session_scope": "all",
  "raw_query": "Hamilton vs Russell as teammates"
}`;

export class QueryTranslator {
  private anthropic: Anthropic;

  constructor(apiKey?: string) {
    this.anthropic = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async translate(naturalLanguageQuery: string): Promise<QueryIntent> {
    console.error(`=== [TRANSLATE DEBUG] START: "${naturalLanguageQuery}" ===`);

    // check cache first
    const cached = await getCachedIntent(naturalLanguageQuery);
    if (cached) {
      console.log('[QueryTranslator] Cache hit - applying defaults to cached intent');
      // Apply defaults even to cached intents to ensure consistency
      return this.applyIntentDefaults(cached, naturalLanguageQuery);
    }

    // use concurrency limiter for llm call
    try {
      console.log('[QueryTranslator] Cache miss - calling LLM');
      const rawIntent = await withConcurrencyLimit(async () => {
        return this.executeTranslation(naturalLanguageQuery);
      });

      // Apply defaults and routing overrides AFTER LLM generation
      const intent = this.applyIntentDefaults(rawIntent, naturalLanguageQuery);

      // cache successful result (with overrides applied)
      await cacheIntent(naturalLanguageQuery, intent);
      return intent;
    } catch (error: any) {
      if (error instanceof LLMUnavailableError) {
        throw error; // propagate as-is for proper error handling
      }
      throw error;
    }
  }

  private async executeTranslation(naturalLanguageQuery: string): Promise<QueryIntent> {
    try {
      const message = await this.anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: naturalLanguageQuery,
          },
        ],
      });

      // Extract text from response
      const responseText =
        message.content[0].type === 'text' ? message.content[0].text : '';

      // Parse JSON and return raw intent (defaults applied in translate())
      const queryIntent = JSON.parse(responseText) as QueryIntent;
      return queryIntent;
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        throw new Error(`LLM returned invalid JSON: ${error.message}`);
      }
      throw new Error(`LLM translation failed: ${error.message}`);
    }
  }

  /**
   * Apply default values to the intent after LLM generation.
   * This ensures consistent defaults regardless of what the LLM returns.
   */
  private applyIntentDefaults(intent: QueryIntent, rawQuery: string): QueryIntent {
    console.error(`[QueryTranslator] applyIntentDefaults called: kind=${intent.kind}, rawQuery="${rawQuery}"`);
    const updated = { ...intent } as any;
    const lowerQuery = rawQuery.toLowerCase();

    // HARD ROUTING OVERRIDES - cannot be bypassed by LLM

    // HARD RULE 0: Qualifying results queries → qualifying_results_summary
    const isQualifyingQuery = this.isQualifyingResultsQuery(lowerQuery);
    console.log(`[QueryTranslator] isQualifyingResultsQuery("${lowerQuery}"): ${isQualifyingQuery}, current kind: ${updated.kind}`);
    if (isQualifyingQuery && updated.kind !== 'qualifying_results_summary') {
      console.log(`[QueryTranslator] Hard override: ${updated.kind} → qualifying_results_summary`);
      updated.kind = 'qualifying_results_summary';
    }

    const isWinsQuery = this.isWinsByCircuitQuery(lowerQuery);
    console.log(`[QueryTranslator] isWinsByCircuitQuery=${isWinsQuery} for "${lowerQuery}"`);

    // HARD RULE 1: "wins by circuit" → driver_career_wins_by_circuit
    if (isWinsQuery && updated.kind !== 'driver_career_wins_by_circuit') {
      console.log(`[QueryTranslator] Hard override: ${updated.kind} → driver_career_wins_by_circuit`);
      updated.kind = 'driver_career_wins_by_circuit';
      // Ensure driver_id is set (might be in driver_a_id from wrong routing)
      if (!updated.driver_id && updated.driver_a_id) {
        updated.driver_id = updated.driver_a_id;
      }
    }

    // HARD RULE 2: "as teammates" without explicit season → teammate_comparison_career
    if (this.isTeammateCareerQuery(lowerQuery) && !this.hasExplicitSeason(lowerQuery)) {
      if (updated.kind !== 'teammate_comparison_career') {
        console.log(`[QueryTranslator] Hard override: ${updated.kind} → teammate_comparison_career`);
        updated.kind = 'teammate_comparison_career';
      }
    }

    // HARD RULE 3: Generic "head to head" without specific metric → driver_vs_driver_comprehensive
    if (this.isGenericHeadToHeadQuery(lowerQuery) && updated.kind !== 'driver_vs_driver_comprehensive') {
      console.log(`[QueryTranslator] Hard override: ${updated.kind} → driver_vs_driver_comprehensive`);
      updated.kind = 'driver_vs_driver_comprehensive';
      // Ensure driver_a_id and driver_b_id are set (might be named differently in original intent)
      if (!updated.driver_a_id && updated.driver_primary_id) {
        updated.driver_a_id = updated.driver_primary_id;
      }
      if (!updated.driver_b_id && updated.driver_secondary_id) {
        updated.driver_b_id = updated.driver_secondary_id;
      }
    }

    // HARD RULE 4: Career pole queries → driver_career_pole_count
    if (this.isCareerPoleQuery(lowerQuery) && updated.kind !== 'driver_career_pole_count') {
      console.log(`[QueryTranslator] Hard override: ${updated.kind} → driver_career_pole_count`);
      updated.kind = 'driver_career_pole_count';
      // Keep season as 2025 (unused for career queries but needed for type compatibility)
      updated.season = 2025;
    }

    // HARD RULE 5: Clean air queries → set clean_air_only=true (metric stays avg_true_pace)
    const isCleanAirQuery = lowerQuery.includes('clean air') ||
                            lowerQuery.includes('clear air') ||
                            lowerQuery.includes('without traffic');
    if (isCleanAirQuery) {
      console.error(`[QueryTranslator] Clean air query detected: setting clean_air_only=true, current kind=${updated.kind}`);
      updated.clean_air_only = true;
      // Keep metric as 'avg_true_pace' - the database stores clean air laps with the same metric name
      if (!updated.metric || updated.metric === 'clean_air_pace') {
        updated.metric = 'avg_true_pace';
      }
    }

    // For season_driver_vs_driver, use session_median_percent as default normalization
    // Only use 'none' if the user explicitly requested "raw pace" or "raw lap times"
    if (updated.kind === 'season_driver_vs_driver') {
      const wantsRawPace = lowerQuery.includes('raw pace') ||
                          lowerQuery.includes('raw lap') ||
                          lowerQuery.includes('raw times') ||
                          lowerQuery.includes('absolute pace') ||
                          lowerQuery.includes('actual lap time');

      console.log(`[QueryTranslator] season_driver_vs_driver: normalization=${updated.normalization}, wantsRawPace=${wantsRawPace}`);

      if (!wantsRawPace && (updated.normalization === 'none' || !updated.normalization)) {
        console.log('[QueryTranslator] Applying session_median_percent normalization');
        updated.normalization = 'session_median_percent';
      }
    }

    return updated as QueryIntent;
  }

  /**
   * Detect qualifying results queries (pole, qualifying grid)
   * NOT the same as "how many poles" (driver_pole_count) or "qualifying gap"
   */
  private isQualifyingResultsQuery(query: string): boolean {
    // Must have a track context to be qualifying results
    const hasTrackContext = query.includes(' at ') ||
                           query.includes(' of ') ||
                           /\b(monaco|silverstone|monza|spa|suzuka|interlagos|bahrain|jeddah|australia|miami|imola|canada|barcelona|austria|hungary|netherlands|singapore|mexico|vegas|qatar|abu dhabi|albert park|shanghai|baku|zandvoort|las vegas|sakhir|yas marina|melbourne|montreal|hungaroring|red bull ring|paul ricard|hockenheim|nurburgring|magny cours|sepang|buddh|yeongam|sochi|portimao|mugello|losail|british|italian|belgian|japanese|brazilian|australian|austrian|hungarian|dutch|spanish|chinese|mexican|canadian|saudi|emilia|romagna)\b/i.test(query);

    // Check for qualifying results patterns - WHO got pole at X is asking for qualifying results
    // Use regex for more robust matching
    const isQualifying = /qualifying\s*(results?|grid)/i.test(query) ||
                        /quali\s*(results?|grid)/i.test(query) ||
                        // "who got pole at X" - asking about a specific race's qualifying
                        (/who\s+(got|took|had)\s+pole/i.test(query) && hasTrackContext) ||
                        (/who\s+qualified.*pole/i.test(query)) ||
                        // "pole at X" or "pole position at X" - asking about specific race
                        (/pole\s+(position\s+)?at\s+/i.test(query));

    // Exclude patterns that should go to other query types
    const isExcluded = /how many poles/i.test(query) ||
                      /pole count/i.test(query) ||
                      /poles did/i.test(query) ||  // "how many poles did X get"
                      /qualifying gap/i.test(query) ||
                      /outqualified/i.test(query);

    console.log(`[QueryTranslator] isQualifyingResultsQuery debug: hasTrackContext=${hasTrackContext}, isQualifying=${isQualifying}, isExcluded=${isExcluded}`);

    // For qualifying results, we need the qualifying keyword but NOT necessarily a track context
    // "qualifying results silverstone 2024" has qualifying keyword AND track context
    return isQualifying && !isExcluded;
  }

  /**
   * Detect "wins by circuit" type queries
   */
  private isWinsByCircuitQuery(query: string): boolean {
    return query.includes('wins by circuit') ||
           query.includes('wins at each circuit') ||
           query.includes('which circuits') ||
           query.includes('circuit victories') ||
           query.includes('track victories') ||
           (query.includes('where has') && query.includes('won')) ||
           (query.includes('where did') && query.includes('win'));
  }

  /**
   * Detect generic head-to-head queries (should show both race and qualifying records)
   * NOT specific to just qualifying or just race
   */
  private isGenericHeadToHeadQuery(query: string): boolean {
    // Use regex for more robust matching (handles word boundaries better)
    const hasHeadToHead = /head\s*to\s*head|h2h|head-to-head/i.test(query);

    // Exclude if specifically asking for just qualifying or just race
    const isSpecific = /qualifying\s+head\s*to\s*head|race\s+head\s*to\s*head|outqualified|outfinish|who finished ahead|who qualified ahead/i.test(query);

    const result = hasHeadToHead && !isSpecific;
    console.log(`[QueryTranslator] isGenericHeadToHeadQuery("${query}"): hasHeadToHead=${hasHeadToHead}, isSpecific=${isSpecific}, result=${result}`);
    return result;
  }

  /**
   * Detect teammate career queries (multi-season)
   */
  private isTeammateCareerQuery(query: string): boolean {
    return query.includes('as teammates') ||
           query.includes('teammate history') ||
           query.includes('all seasons together') ||
           query.includes('complete teammate') ||
           query.includes('all seasons as');
  }

  /**
   * Check if query contains an explicit season year
   */
  private hasExplicitSeason(query: string): boolean {
    // Match years 2010-2029
    return /\b20[1-2]\d\b/.test(query);
  }

  /**
   * Detect career pole position queries (not season-specific)
   */
  private isCareerPoleQuery(query: string): boolean {
    // Must be about poles
    const isPoleQuery = /\b(poles?|pole positions?)\b/i.test(query) &&
                        /\b(how many|total|career|all[- ]time|does.+have|has.+got)\b/i.test(query);

    // Must NOT have a specific season
    const hasExplicitYear = this.hasExplicitSeason(query);

    // Career indicators
    const hasCareerIndicator = /\b(career|all[- ]time|total|in his career|lifetime)\b/i.test(query);

    // "how many poles does X have" without year = career query
    const isGenericPoleCount = /how many (pole positions?|poles) (does|has|did)/i.test(query) && !hasExplicitYear;

    const result = isPoleQuery && (!hasExplicitYear || hasCareerIndicator);
    console.error(`[QueryTranslator] isCareerPoleQuery("${query}"): isPoleQuery=${isPoleQuery}, hasExplicitYear=${hasExplicitYear}, hasCareerIndicator=${hasCareerIndicator}, isGenericPoleCount=${isGenericPoleCount}, result=${result}`);
    return result;
  }

  /**
   * Translate with retry on validation errors
   */
  async translateWithRetry(
    naturalLanguageQuery: string,
    validationError?: string,
    maxRetries = 2
  ): Promise<QueryIntent> {
    const prompt = validationError
      ? `${naturalLanguageQuery}

Previous attempt failed with error: "${validationError}"
Please generate a corrected QueryIntent.`
      : naturalLanguageQuery;

    try {
      return await this.translate(prompt);
    } catch (error: any) {
      if (maxRetries > 0) {
        console.warn(`Translation failed, retrying... (${maxRetries} left)`);
        return this.translateWithRetry(
          naturalLanguageQuery,
          error.message,
          maxRetries - 1
        );
      }
      throw error;
    }
  }
}
