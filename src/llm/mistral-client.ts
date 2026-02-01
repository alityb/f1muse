import { QueryIntent } from '../types/query-intent';

/**
 * Mistral-RS Intent Parser Client
 *
 * Connects to a local Mistral-RS server to parse natural language queries
 * into QueryIntent candidates. The validator remains the authority - NO SQL
 * runs unless the validator approves.
 *
 * Requirements:
 * - Mistral-RS server must be running (see MISTRAL_RS_SETUP.md)
 * - MISTRAL_RS_URL must be set in environment
 * - MISTRAL_RS_MODEL_ID must specify the loaded model
 */

export interface MistralIntentResponse {
  /** The parsed QueryIntent candidate (may be invalid) */
  candidate: QueryIntent | null;

  /** Raw model output for audit logging */
  rawOutput: string;

  /** Whether parsing succeeded */
  success: boolean;

  /** Error message if parsing failed */
  error?: string;
}

const SYSTEM_PROMPT = `You are an F1 analytics query parser. Convert natural language questions into QueryIntent JSON objects.

STATMUSE-STYLE BEHAVIOR:
- NEVER ask for clarification
- NEVER return ambiguity errors
- ALWAYS select the best deterministic entity
- Season + context always wins

CRITICAL RULES:
1. Output ONLY valid JSON - no markdown, no comments (//), no explanations, no extra text
2. JSON must have NO COMMENTS - comments break JSON parsing
3. Use proper JSON syntax: "key": value (with space after colon)
4. Always extract the year from the question for the "season" field (default to 2025 if not mentioned)
5. Never include duplicate keys
6. Surface extraction is strict: copy exact substrings from the user question. Preserve case and spelling.
7. Set driver_a_id, driver_b_id, driver_id, and track_id to the same exact surface strings

ONLY 8 SUPPORTED QUERY TYPES (check in priority order):

1. race_results_summary - Official race results from F1DB
   Required: kind, track_id, season, raw_query
   NO metric, NO normalization fields
   Trigger: "results of", "race results", "who won", "winner of", "podium"
   Example: "Results of Monza 2025"

2. track_fastest_drivers - Rank all drivers at a specific track
   Required: kind, track_id, season, metric, normalization, clean_air_only, compound_context, session_scope, raw_query
   Example: "Fastest drivers at Monaco 2025"
   Use when: Question asks for ranking/fastest at a SPECIFIC TRACK

3. cross_team_track_scoped_driver_comparison - Compare 2 drivers at a specific track
   Required: kind, track_id, driver_a_id, driver_b_id, season, metric, normalization, clean_air_only, compound_context, session_scope, raw_query
   Example: "Compare Verstappen and Norris at Silverstone 2025"
   Use when: Question mentions a SPECIFIC TRACK and compares 2 drivers

4. teammate_gap_dual_comparison - Qualifying vs race pace comparison
   Required: kind, driver_a_id, driver_b_id, season, raw_query
   Trigger: "qualifying vs race", "quali vs race", "race vs qualifying", "better in quali vs race"
   Example: "Compare qualifying vs race pace for Norris and Piastri 2025"
   Use when: Question explicitly asks to compare qualifying vs race pace between teammates

5. teammate_gap_summary_season - Full-season teammate gap (PRIMARY performance metric)
   Required: kind, season, driver_a_id, driver_b_id, metric, normalization, clean_air_only, compound_context, session_scope, raw_query
   Example: "Compare Norris and Piastri 2025"
   Use when: Question compares 2 drivers for a full season WITHOUT mentioning a specific track
   This is the DEFAULT for driver comparisons (no track mentioned)

6. season_driver_vs_driver - Cross-team season comparison (raw pace, NO normalization)
   Required: kind, driver_a_id, driver_b_id, season, metric, normalization, clean_air_only, compound_context, session_scope, raw_query
   Example: "Compare Verstappen and Norris 2025" (if not teammates)
   Use when: Question compares 2 drivers from DIFFERENT TEAMS WITHOUT mentioning a specific track

7. driver_season_summary - Single driver season statistics
   Required: kind, driver_id, season, metric, normalization, clean_air_only, compound_context, session_scope, raw_query
   Example: "Show Verstappen 2025 season"
   ROUTING RULE: If season is present OR word "season" appears → driver_season_summary

8. driver_career_summary - Career-spanning statistics
   Required: kind, driver_id, season, metric, normalization, clean_air_only, compound_context, session_scope, raw_query
   Example: "Verstappen career summary"
   ROUTING RULE: ONLY if NO season implied and "career"/"all-time" present

Field Rules:
- kind: MUST be one of the 8 types above
- track_id, driver_a_id, driver_b_id, driver_id: Exact substrings from question
- season: Extract year from query, or default to 2025
- metric: "avg_true_pace" (default), "clean_air_pace" (if "clean air" mentioned), "teammate_gap_raw" (for type 5 only)
- normalization: "none" (default), "team_baseline" (type 5 only)
- clean_air_only: false (default), true if "clean air" mentioned
- compound_context: "mixed" (always)
- session_scope: "race" (types 2-3), "all" (types 5-8)
- raw_query: Original question

ROUTING RULES:
1. "Results of X" OR "Who won X" → race_results_summary (NO metric/normalization)
2. "at [TRACK]" OR "in [TRACK]" → track-scoped query (types 2 or 3)
3. "qualifying vs race" → teammate_gap_dual_comparison (type 4)
4. Season present OR word "season" → driver_season_summary (type 7)
5. "career" OR "all-time" → driver_career_summary (type 8)
6. Driver comparison (no track) → teammate_gap_summary_season (type 5)

Examples:

Input: "Results of Monza 2025"
Output:
{"kind":"race_results_summary","track_id":"Monza","season":2025,"raw_query":"Results of Monza 2025"}

Input: "Compare Max and Lando at Silverstone 2025"
Output:
{"kind":"cross_team_track_scoped_driver_comparison","track_id":"Silverstone","driver_a_id":"Max","driver_b_id":"Lando","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"race","raw_query":"Compare Max and Lando at Silverstone 2025"}

Input: "Compare Norris and Piastri 2025"
Output:
{"kind":"teammate_gap_summary_season","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025,"metric":"teammate_gap_raw","normalization":"team_baseline","clean_air_only":false,"compound_context":"mixed","session_scope":"all","raw_query":"Compare Norris and Piastri 2025"}

Input: "Compare qualifying vs race pace for Norris and Piastri 2025"
Output:
{"kind":"teammate_gap_dual_comparison","driver_a_id":"Norris","driver_b_id":"Piastri","season":2025,"raw_query":"Compare qualifying vs race pace for Norris and Piastri 2025"}

Input: "Verstappen 2025 season"
Output:
{"kind":"driver_season_summary","driver_id":"Verstappen","season":2025,"metric":"avg_true_pace","normalization":"none","clean_air_only":false,"compound_context":"mixed","session_scope":"all","raw_query":"Verstappen 2025 season"}`;

export class MistralIntentClient {
  private mistralUrl: string;
  private modelId: string;

  constructor(mistralUrl?: string, modelId?: string) {
    this.mistralUrl = mistralUrl || process.env.MISTRAL_RS_URL || 'http://localhost:1234';
    this.modelId = modelId || process.env.MISTRAL_RS_MODEL_ID || 'mistral-7b-instruct';

    if (!this.mistralUrl) {
      throw new Error('MISTRAL_RS_URL must be set');
    }

    if (!this.modelId) {
      throw new Error('MISTRAL_RS_MODEL_ID must be set');
    }
  }

  /**
   * Parse natural language query into QueryIntent candidate
   *
   * IMPORTANT: The returned candidate may be invalid. The validator
   * is the authority - it will reject invalid or ambiguous intents.
   */
  async parseIntent(userQuery: string): Promise<MistralIntentResponse> {
    try {
      // Call Mistral-RS server
      const rawOutput = await this.callMistralRS(userQuery);

      // Parse JSON safely
      const parseResult = this.parseJSON(rawOutput);

      if (!parseResult.success) {
        return {
          candidate: null,
          rawOutput,
          success: false,
          error: parseResult.error,
        };
      }

      const candidate = parseResult.data as QueryIntent;

      return {
        candidate,
        rawOutput,
        success: true,
      };
    } catch (error: any) {
      return {
        candidate: null,
        rawOutput: '',
        success: false,
        error: `Mistral-RS call failed: ${error.message}`,
      };
    }
  }

  /**
   * Call Mistral-RS server via HTTP API
   *
   * Mistral-RS supports OpenAI-compatible API format
   */
  private async callMistralRS(userQuery: string): Promise<string> {
    // Mistral models don't support system messages - combine into user message
    const combinedPrompt = `${SYSTEM_PROMPT}

User query: ${userQuery}

Output (JSON only):`;

    const requestBody = {
      model: this.modelId,
      messages: [
        {
          role: 'user',
          content: combinedPrompt,
        },
      ],
      temperature: 0.1, // Low temperature for deterministic output
      max_tokens: 512,
      // Note: response_format not supported by Mistral-RS, using prompt engineering instead
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 3 min for local LLM on CPU

    const response = await fetch(`${this.mistralUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Mistral-RS server error (${response.status}): ${errorText}`
      );
    }

    const data = await response.json() as any;

    // Extract content from OpenAI-compatible response
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Mistral-RS returned empty response');
    }

    return content;
  }

  /**
   * Parse JSON safely without modifying or inferring values
   */
  private parseJSON(rawOutput: string): {
    success: boolean;
    data?: any;
    error?: string;
  } {
    try {
      // Strip markdown code blocks if present (some models add them despite instructions)
      let cleaned = rawOutput.trim();

      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }

      // Replace hex-encoded newlines with actual newlines
      cleaned = cleaned.replace(/<0x0A>/g, '\n');

      // Remove JSON comments (// ...) which some models add
      cleaned = cleaned.replace(/\/\/.*$/gm, '');

      // Remove duplicate/malformed keys like "seaso":null followed by "season": 2025
      // This is a band-aid fix - the model should not generate this
      cleaned = cleaned.replace(/"seaso"\s*:\s*null\s*,?\s*/g, '');

      const parsed = JSON.parse(cleaned);

      // Validate it's an object
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          success: false,
          error: 'Model output is not a valid object',
        };
      }

      return {
        success: true,
        data: parsed,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `JSON parse error: ${error.message}`,
      };
    }
  }

  // No ambiguity analysis; validator + resolvers decide outcome.

  /**
   * Test connection to Mistral-RS server
   */
  async testConnection(): Promise<{ connected: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.mistralUrl}/v1/models`);

      if (!response.ok) {
        return {
          connected: false,
          error: `Server returned ${response.status}`,
        };
      }

      return { connected: true };
    } catch (error: any) {
      return {
        connected: false,
        error: error.message,
      };
    }
  }
}
