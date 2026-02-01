import Anthropic from '@anthropic-ai/sdk';
import { QueryIntent } from '../types/query-intent';
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

## 13 SUPPORTED QUERY TYPES (check in priority order)

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
   - If "clean air" mentioned: set clean_air_only=true, metric="clean_air_pace"

### 3. cross_team_track_scoped_driver_comparison - Compare 2 drivers at a specific track
   - Example: "Compare Verstappen and Norris at Silverstone 2025"
   - Example: "Max vs Lando Monza 2025"
   - Fields: kind, track_id, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "race", raw_query
   - Use when: Question mentions a SPECIFIC TRACK and compares 2 drivers
   - If "clean air" mentioned: set clean_air_only=true, metric="clean_air_pace"

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

### 6. season_driver_vs_driver - Cross-team season comparison (raw pace, NO normalization)
   - Example: "Compare Verstappen and Norris 2025" (if not teammates)
   - Fields: kind, driver_a_id, driver_b_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "all", raw_query
   - Use when: Question compares 2 drivers from DIFFERENT TEAMS for a full season WITHOUT mentioning a specific track
   - IMPORTANT: Answer must state "This comparison does not normalize for car performance"

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

### 9. driver_pole_count - Count pole positions for a driver (QUALIFYING)
   - Trigger: "pole positions", "poles", "how many poles", "pole count"
   - Example: "How many poles did Verstappen get in 2024?"
   - Example: "Norris pole positions 2025"
   - Fields: kind, driver_id, season, metric: "avg_true_pace", normalization: "none", clean_air_only: false, compound_context: "mixed", session_scope: "qualifying", raw_query
   - Use when: Question asks about pole positions for a specific driver

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

## CRITICAL ROUTING RULES

1. **Race Results Detection:**
   - "Results of X" → race_results_summary
   - "Who won X" → race_results_summary
   - "X results" → race_results_summary
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
   - If "qualifying vs race" mentioned → teammate_gap_dual_comparison (type 4)
   - If track mentioned → cross_team_track_scoped_driver_comparison (type 3)
   - If no track mentioned → teammate_gap_summary_season (type 5) as default
   - Use season_driver_vs_driver (type 6) only if explicitly cross-team and no baseline wanted

5. **Default Season:**
   - Always default to 2025 if not mentioned

6. **Clean Air:**
   - If "clean air" or "without traffic" mentioned → set clean_air_only=true, metric="clean_air_pace"
   - Otherwise → clean_air_only=false, metric="avg_true_pace"

7. **Qualifying Queries:**
   - "pole", "poles", "pole positions" → driver_pole_count (type 9)
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
}`;

export class QueryTranslator {
  private anthropic: Anthropic;

  constructor(apiKey?: string) {
    this.anthropic = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async translate(naturalLanguageQuery: string): Promise<QueryIntent> {
    // check cache first
    const cached = await getCachedIntent(naturalLanguageQuery);
    if (cached) {
      console.log('[QueryTranslator] Cache hit');
      return cached;
    }

    // use concurrency limiter for llm call
    try {
      const intent = await withConcurrencyLimit(async () => {
        return this.executeTranslation(naturalLanguageQuery);
      });

      // cache successful result
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
        model: 'claude-3-5-haiku-20241022',
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

      // Parse JSON
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
