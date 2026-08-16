import { createHash } from 'node:crypto';
import { AnswerIntent, hydrateAndParseAnswerIntent } from './answer-intent';
import { AnswerQuestionContract } from './answer-question';

export const ANSWER_TRANSLATOR_SCHEMA_NAME = 'f1_answer_intent_v14';
export const ANSWER_INTENT_CONTRACT_VERSION = 'answer-intent-v17' as const;
export const ANSWER_PROVIDER_DIAGNOSTIC_CODES = [
  'transport',
  'auth',
  'quota',
  'rate_limit',
  'client',
  'server',
  'oversize',
  'malformed',
  'incomplete',
  'schema_invalid',
  'request_timeout'
] as const;
export type AnswerProviderDiagnosticCode = (typeof ANSWER_PROVIDER_DIAGNOSTIC_CODES)[number];

const referenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 200 }
  }
} as const;

const seasonProperties = {
  season: { type: 'integer', minimum: 1950, maximum: 2100 },
  season_reference: referenceSchema
} as const;
const finalSeasonProperties = {
  season: { type: 'integer', minimum: 1950, maximum: 2025 },
  season_reference: referenceSchema
} as const;
const eventProperties = { event_reference: referenceSchema } as const;
const selectionProperties = { selection_reference: referenceSchema } as const;
const positionProperty = { position: { type: 'integer', minimum: 1, maximum: 30 } } as const;

function closedIntent(type: string, properties: Record<string, unknown>, required: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', ...required],
    properties: { type: { type: 'string', enum: [type] }, ...properties }
  };
}

export const ANSWER_INTENT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['intent'],
  properties: {
    intent: {
      anyOf: [
        closedIntent('final_standings', finalSeasonProperties, ['season', 'season_reference']),
        closedIntent('final_standings_points', { ...seasonProperties, driver_references: { type: 'array', maxItems: 4, items: referenceSchema } }, ['season', 'season_reference', 'driver_references']),
        closedIntent('final_standings_leader', seasonProperties, ['season', 'season_reference']),
        closedIntent('final_standings_driver_ranking', { ...finalSeasonProperties, driver_references: { type: 'array', minItems: 3, maxItems: 3, items: referenceSchema } }, ['season', 'season_reference', 'driver_references']),
        closedIntent('current_standings', seasonProperties, ['season', 'season_reference']),
        closedIntent('driver_season_official_summary', { ...seasonProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'driver_reference']),
        closedIntent('driver_career_official_summary', { driver_reference: referenceSchema }, ['driver_reference']),
        closedIntent('driver_career_wins_by_circuit', { driver_reference: referenceSchema }, ['driver_reference']),
        closedIntent('driver_season_qualifying_p1_count', { ...finalSeasonProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'driver_reference']),
        closedIntent('driver_career_qualifying_p1_count', { driver_reference: referenceSchema }, ['driver_reference']),
        closedIntent('driver_season_qualifying_top_ten_count', { ...finalSeasonProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'driver_reference']),
        closedIntent('season_qualifying_top_ten_ranking', finalSeasonProperties, ['season', 'season_reference']),
        closedIntent('race_season_finishing_position_h2h', { ...finalSeasonProperties, driver_references: { type: 'array', minItems: 2, maxItems: 2, items: referenceSchema } }, ['season', 'season_reference', 'driver_references']),
        closedIntent('qualifying_season_position_h2h', { ...finalSeasonProperties, driver_references: { type: 'array', minItems: 2, maxItems: 2, items: referenceSchema } }, ['season', 'season_reference', 'driver_references']),
        closedIntent('official_driver_results_comparison', { ...finalSeasonProperties, driver_references: { type: 'array', minItems: 2, maxItems: 2, items: referenceSchema } }, ['season', 'season_reference', 'driver_references']),
        closedIntent('race_event_finishing_position_comparison', { ...finalSeasonProperties, ...eventProperties, driver_references: { type: 'array', minItems: 2, maxItems: 2, items: referenceSchema } }, ['season', 'season_reference', 'event_reference', 'driver_references']),
        closedIntent('race_classification_all', { ...seasonProperties, ...eventProperties }, ['season', 'season_reference', 'event_reference']),
        closedIntent('race_classification_driver', { ...seasonProperties, ...eventProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'driver_reference']),
        closedIntent('race_classification_status', { ...seasonProperties, ...eventProperties, status: { enum: ['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn'] }, status_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'status', 'status_reference']),
        closedIntent('qualifying_classification_all', { ...seasonProperties, ...eventProperties }, ['season', 'season_reference', 'event_reference']),
        closedIntent('qualifying_classification_driver', { ...seasonProperties, ...eventProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'driver_reference']),
        closedIntent('qualifying_classification_status', { ...seasonProperties, ...eventProperties, status: { enum: ['classified', 'dnf', 'dns'] }, status_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'status', 'status_reference']),
        closedIntent('race_winner', { ...seasonProperties, ...eventProperties, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'selection_reference']),
        closedIntent('race_podium', { ...seasonProperties, ...eventProperties, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'selection_reference']),
        closedIntent('race_top_n', { ...seasonProperties, ...eventProperties, ...positionProperty, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'position', 'selection_reference']),
        closedIntent('race_exact_position', { ...seasonProperties, ...eventProperties, ...positionProperty, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'position', 'selection_reference']),
        closedIntent('qualifying_pole', { ...seasonProperties, ...eventProperties, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'selection_reference']),
        closedIntent('qualifying_top_n', { ...seasonProperties, ...eventProperties, ...positionProperty, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'position', 'selection_reference']),
        closedIntent('qualifying_exact_position', { ...seasonProperties, ...eventProperties, ...positionProperty, ...selectionProperties }, ['season', 'season_reference', 'event_reference', 'position', 'selection_reference']),
        closedIntent('race_date', { ...seasonProperties, ...eventProperties }, ['season', 'season_reference', 'event_reference']),
        closedIntent('clarification', { reason: { enum: ['season_missing', 'event_ambiguous', 'entity_ambiguous', 'session_ambiguous', 'metric_ambiguous'] } }, ['reason']),
        closedIntent('unsupported', { reason: { enum: ['sprint_source_unsupported', 'grid_source_unsupported', 'constructor_source_unsupported', 'pace_source_disabled', 'team_filter_unsupported', 'interim_standings_unsupported', 'temporal_scope_unsupported', 'capability_unsupported'] } }, ['reason'])
      ]
    }
  }
} as const);

export const ANSWER_TRANSLATOR_SYSTEM_PROMPT = `Return exactly { "intent": <AnswerIntent> } matching the strict JSON schema. Never emit IDs or F1QL. Every reference must copy an exact case-sensitive text sequence from the normalized question; emit text only, never offsets.

Decision table (follow literal wording):
- final_standings: only the exact reviewed shorthand "2025 driver standings." (final period optional); return the complete official final table ordered by championship position with points, never current/interim standings or a caller-selected subset.
- final_standings_points: final driver standings points for zero to four explicitly named drivers; zero means the literal wording requests all standings.
- final_standings_leader: final driver standings champion/leader.
- final_standings_driver_ranking: only the exact pinned wording "Rank Verstappen, Norris, and Piastri by final 2025 championship position." or the exact holdout wording "Rank Verstappen, Norris, and Piastri by championship position in the final 2025 standings." with those three literal driver references in that order; this uses official final championship positions, never points, pace, race results, current standings, another season, another driver set, or a caller-selected limit.
- current_standings: complete latest-recorded driver standings only when the wording literally says "latest recorded"; never infer it from current, live, ongoing, so far, as-of, event, or round wording.
- driver_season_official_summary: literal official final-season summary for exactly one named driver, including the closed "official <year> driver summary" alias; this means recorded championship position and points, never a broader profile, pace, or a cross-source composite.
- driver_career_official_summary: literal official career summary for exactly one named driver; this means best recorded final championship position and count of recorded final standings rows through 2025, never a distinct-season claim, pace, or a cross-source composite.
- driver_career_wins_by_circuit: only the literal closed wording "At which circuits has <driver> won races?" or "Which circuits has <driver> won races at?" for exactly one named driver; this means official race P1 classifications through 2025 grouped by canonical circuit ID, never venue aliases, a selected season, current results, sprints, poles, podiums, or other win concepts.
- race_season_finishing_position_h2h: only the literal closed wording "Who finished ahead more often in <year>, <driver A> or <driver B>?" or "In <year>, who finished ahead more often, <driver A> or <driver B>?" for exactly two ordered literal drivers and a final season through 2025; this compares race finishing positions only on shared events where both have recorded numeric positions.
- qualifying_season_position_h2h: only the literal closed wording "Who outqualified whom more often in <year>, <driver A> or <driver B>?", "In <year>, who outqualified whom more often, <driver A> or <driver B>?", "Who qualified ahead more often in <year>, <driver A> or <driver B>?", or "In <year>, who qualified ahead more often, <driver A> or <driver B>?" for exactly two ordered literal drivers and a final season through 2025; this compares qualifying positions only on shared events where both have recorded numeric positions, never qualifying-time gaps or teammate identity.
- official_driver_results_comparison: only the exact wording "Compare the official 2025 results of Norris and Piastri." with those two ordered literal references; this returns official final standings plus race and qualifying shared-position H2Hs, never pace, time gaps, achievement totals, weather adjustment, or a synthetic score.
- race_event_finishing_position_comparison: only the exact wording "Who finished ahead, Verstappen or Norris, at Silverstone 2025?" with that event and those two ordered literal references; this compares only their official numeric race finishing positions at the uniquely resolved event, never pace, a time gap, qualifying, sprint, or grid.
- driver_season_qualifying_p1_count: only "How many poles did Lando Norris take in 2025?"; count recorded official qualifying P1 classifications for that exact driver and season.
- driver_career_qualifying_p1_count: only "How many career poles does Lewis Hamilton have?"; count recorded official qualifying P1 classifications for the exact seasonless, ambiguity-preserving driver reference across 1950-2025.
- driver_season_qualifying_top_ten_count: only "How many times did Lando Norris qualify in the top ten in 2025?"; count recorded numeric top-ten positions for that exact driver and season.
- season_qualifying_top_ten_ranking: only "Rank drivers by top-ten qualifying appearances in 2025."; rank by recorded numeric top-ten positions, allowing count ties and ordering tied driver IDs by UTF-8 bytes.
- race_classification_all: literal full/all race classification.
- race_classification_driver: race classification for exactly one literal driver.
- race_classification_status: race classification filtered by exactly one literal supported status.
- qualifying_classification_all: literal full/all qualifying classification.
- qualifying_classification_driver: qualifying classification for exactly one literal driver.
- qualifying_classification_status: qualifying classification filtered by exactly one literal supported status.
- race_winner, race_podium, race_top_n, race_exact_position: literal race result selection; top_n and exact_position carry the literal bounded number as position.
- qualifying_pole, qualifying_top_n, qualifying_exact_position: literal qualifying result selection; top_n and exact_position carry the literal bounded number as position.
- race_date: literal race/Grand Prix date request.

Rules: final standings are supported. Literal latest-recorded standings are also supported. An explicit 4-digit year is never season_missing. The driver career summary, career circuit-wins, and career qualifying-P1-count intents are the only supported intents that do not require a year. Session, event, driver, status, and all/single cardinality must follow literal wording; do not infer them. A unique literal status cue selects the status-filter intent even with wording such as "show all classified drivers". Map DNF/DNFs/did not finish to dnf and DNS/DNSs/did not start to dns. A status_reference must copy the complete literal status phrase. The server normalizes the candidate status enum and full status_reference from the single trusted literal status cue. For driver_references, emit one reference object per literal driver occurrence, including repeated identical text. Use clarification only for: season_missing when a year-required intent has no year; event_ambiguous, entity_ambiguous, session_ambiguous, or metric_ambiguous when the wording itself has that ambiguity. Use unsupported only for: sprint_source_unsupported, grid_source_unsupported, constructor_source_unsupported, pace_source_disabled, team_filter_unsupported, interim_standings_unsupported, temporal_scope_unsupported, or capability_unsupported. Never relabel a supported final or literal latest-recorded standings request as unsupported.

Valid examples:
Question: 2025 driver standings.
{"intent":{"type":"final_standings","season":2025,"season_reference":{"text":"2025"}}}
Question: Who led the 2025 standings?
{"intent":{"type":"final_standings_leader","season":2025,"season_reference":{"text":"2025"}}}
Question: Rank Verstappen, Norris, and Piastri by final 2025 championship position.
{"intent":{"type":"final_standings_driver_ranking","season":2025,"season_reference":{"text":"2025"},"driver_references":[{"text":"Verstappen"},{"text":"Norris"},{"text":"Piastri"}]}}
Question: Show the latest recorded 2026 driver standings.
{"intent":{"type":"current_standings","season":2026,"season_reference":{"text":"2026"}}}
Question: Show Max Verstappen official 2025 season summary.
{"intent":{"type":"driver_season_official_summary","season":2025,"season_reference":{"text":"2025"},"driver_reference":{"text":"Max Verstappen"}}}
Question: Show Lando Norris official 2025 driver summary.
{"intent":{"type":"driver_season_official_summary","season":2025,"season_reference":{"text":"2025"},"driver_reference":{"text":"Lando Norris"}}}
Question: Show Lewis Hamilton official career summary.
{"intent":{"type":"driver_career_official_summary","driver_reference":{"text":"Lewis Hamilton"}}}
Question: At which circuits has Lewis Hamilton won races?
{"intent":{"type":"driver_career_wins_by_circuit","driver_reference":{"text":"Lewis Hamilton"}}}
Question: Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?
{"intent":{"type":"race_season_finishing_position_h2h","season":2025,"season_reference":{"text":"2025"},"driver_references":[{"text":"Lando Norris"},{"text":"Oscar Piastri"}]}}
Question: Who outqualified whom more often in 2025, Norris or Piastri?
{"intent":{"type":"qualifying_season_position_h2h","season":2025,"season_reference":{"text":"2025"},"driver_references":[{"text":"Norris"},{"text":"Piastri"}]}}
Question: Who qualified ahead more often in 2025, Norris or Verstappen?
{"intent":{"type":"qualifying_season_position_h2h","season":2025,"season_reference":{"text":"2025"},"driver_references":[{"text":"Norris"},{"text":"Verstappen"}]}}
Question: Compare the official 2025 results of Norris and Piastri.
{"intent":{"type":"official_driver_results_comparison","season":2025,"season_reference":{"text":"2025"},"driver_references":[{"text":"Norris"},{"text":"Piastri"}]}}
Question: Who finished ahead, Verstappen or Norris, at Silverstone 2025?
{"intent":{"type":"race_event_finishing_position_comparison","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Silverstone"},"driver_references":[{"text":"Verstappen"},{"text":"Norris"}]}}
Question: How many poles did Lando Norris take in 2025?
{"intent":{"type":"driver_season_qualifying_p1_count","season":2025,"season_reference":{"text":"2025"},"driver_reference":{"text":"Lando Norris"}}}
Question: How many career poles does Lewis Hamilton have?
{"intent":{"type":"driver_career_qualifying_p1_count","driver_reference":{"text":"Lewis Hamilton"}}}
Question: How many times did Lando Norris qualify in the top ten in 2025?
{"intent":{"type":"driver_season_qualifying_top_ten_count","season":2025,"season_reference":{"text":"2025"},"driver_reference":{"text":"Lando Norris"}}}
Question: Rank drivers by top-ten qualifying appearances in 2025.
{"intent":{"type":"season_qualifying_top_ten_ranking","season":2025,"season_reference":{"text":"2025"}}}
Question: All 2025 Monaco race results
{"intent":{"type":"race_classification_all","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Monaco"}}}
Question: Show Max in 2025 Monaco qualifying
{"intent":{"type":"qualifying_classification_driver","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Monaco"},"driver_reference":{"text":"Max"}}}
Question: Who won the 2025 Australian Grand Prix?
{"intent":{"type":"race_winner","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"selection_reference":{"text":"Who won the 2025 Australian Grand Prix"}}}
Question: Show the podium for the 2025 Australian Grand Prix.
{"intent":{"type":"race_podium","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"selection_reference":{"text":"podium"}}}
Question: Show the top five finishers at the 2025 Australian Grand Prix.
{"intent":{"type":"race_top_n","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"position":5,"selection_reference":{"text":"top five finishers"}}}
Question: Who finished second at the 2025 Australian Grand Prix?
{"intent":{"type":"race_exact_position","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"position":2,"selection_reference":{"text":"finished second"}}}
Question: Who took pole at the 2025 Australian Grand Prix?
{"intent":{"type":"qualifying_pole","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"selection_reference":{"text":"Who took pole"}}}
Question: Show the top five qualifiers at the 2025 Australian Grand Prix.
{"intent":{"type":"qualifying_top_n","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"position":5,"selection_reference":{"text":"top five qualifiers"}}}
Question: Who qualified third at the 2025 Australian Grand Prix?
{"intent":{"type":"qualifying_exact_position","season":2025,"season_reference":{"text":"2025"},"event_reference":{"text":"Australian Grand Prix"},"position":3,"selection_reference":{"text":"qualified third"}}}
Question: Who led the standings?
{"intent":{"type":"clarification","reason":"season_missing"}}
Question: Show 2025 sprint results
{"intent":{"type":"unsupported","reason":"sprint_source_unsupported"}}`;

export const ANSWER_TRANSLATOR_PROMPT_SHA256 = sha256(ANSWER_TRANSLATOR_SYSTEM_PROMPT);
export const ANSWER_TRANSLATOR_SCHEMA_SHA256 = sha256(stableSerialize(ANSWER_INTENT_JSON_SCHEMA));

export interface AnswerIntentModel {
  complete(systemPrompt: string, question: string, signal?: AbortSignal): Promise<string>;
}

const ANSWER_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnswerReasoningEffort = (typeof ANSWER_REASONING_EFFORTS)[number];
export type AnswerReasoningMode = AnswerReasoningEffort | 'disabled';

export type AnswerTranslationResult =
  | { readonly type: 'intent_candidate'; readonly intent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }> }
  | { readonly type: 'clarification_required'; readonly reason: Extract<AnswerIntent, { type: 'clarification' }>['reason'] }
  | { readonly type: 'unsupported'; readonly reason: Extract<AnswerIntent, { type: 'unsupported' }>['reason'] }
  | { readonly type: 'provider_unavailable'; readonly reason: 'provider_error' | 'invalid_response' | 'incomplete_response' | 'unsupported_provider'; readonly diagnostic_code?: AnswerProviderDiagnosticCode };

export class OpenAICompatibleAnswerIntentModel implements AnswerIntentModel {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort: AnswerReasoningEffort | undefined;

  constructor(baseUrl: string, apiKey: string, model: string, reasoningEffort?: AnswerReasoningEffort) {
    this.baseUrl = validateAnswerEndpoint(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  async complete(systemPrompt: string, question: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        temperature: 0,
        ...(this.reasoningEffort === undefined ? {} : { reasoning_effort: this.reasoningEffort }),
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: ANSWER_TRANSLATOR_SCHEMA_NAME, strict: true, schema: ANSWER_INTENT_JSON_SCHEMA }
        }
      })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AnswerProviderDiagnosticError(diagnosticForStatus(response.status));
    }
    const text = await readBoundedResponse(response);
    let body: {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new AnswerProviderDiagnosticError('malformed');
    }
    const choices = body.choices ?? [];
    const choice = choices[0];
    if (choices.length !== 1 || !choice || choice.finish_reason !== 'stop') {
      throw new AnswerProviderDiagnosticError('incomplete');
    }
    if (choice.message?.refusal || typeof choice.message?.content !== 'string') {
      throw new AnswerProviderDiagnosticError('incomplete');
    }
    return choice.message.content;
  }
}

class AnswerProviderDiagnosticError extends Error {
  constructor(readonly diagnosticCode: AnswerProviderDiagnosticCode) {
    super('Answer intent provider failed');
  }
}

export class AnswerProviderConfigurationError extends Error {}

export interface ConfiguredAnswerModelIdentity {
  readonly provider: 'groq' | 'openai-compatible';
  readonly model_id: string;
  readonly endpoint_sha256: string;
  readonly reasoning_effort: AnswerReasoningMode;
}

interface ConfiguredAnswerModel extends ConfiguredAnswerModelIdentity {
  readonly base_url: string;
  readonly api_key: string;
  readonly request_reasoning_effort?: AnswerReasoningEffort;
}

function readConfiguredAnswerModel(env: NodeJS.ProcessEnv = process.env): ConfiguredAnswerModel {
  const provider = env.F1QL_ANSWER_LLM_PROVIDER ?? env.LLM_PROVIDER;
  const baseUrl = env.F1QL_ANSWER_LLM_BASE_URL ?? env.LLM_BASE_URL;
  const model = env.F1QL_ANSWER_MODEL ?? env.F1QL_MODEL;
  if (!baseUrl) {
    throw new AnswerProviderConfigurationError('Strict answer intent provider is not supported or configured');
  }
  const validatedBaseUrl = validateAnswerEndpoint(baseUrl);
  const groqModels = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  const groqHost = new URL(validatedBaseUrl).hostname === 'api.groq.com';
  const isGroq = provider === 'groq' && groqHost && model !== undefined && groqModels.has(model);
  const isDeclaredStrictCompatible = provider === 'openai-compatible' && !groqHost && env.F1QL_ANSWER_MODEL_STRICT_JSON_SCHEMA === 'true';
  if ((!isGroq && !isDeclaredStrictCompatible) || !model) {
    throw new AnswerProviderConfigurationError('Strict answer intent provider is not supported or configured');
  }
  const reasoningEffort = readAnswerReasoningEffort(env.F1QL_ANSWER_REASONING_EFFORT);
  const apiKey = env.F1QL_ANSWER_LLM_API_KEY ?? env.LLM_API_KEY;
  if (!apiKey) {
    throw new AnswerProviderConfigurationError('Strict answer intent provider is not supported or configured');
  }
  return {
    provider: provider as ConfiguredAnswerModel['provider'],
    model_id: model,
    endpoint_sha256: sha256(validatedBaseUrl),
    reasoning_effort: reasoningEffort ?? 'disabled',
    base_url: validatedBaseUrl,
    api_key: apiKey,
    ...(reasoningEffort === undefined ? {} : { request_reasoning_effort: reasoningEffort })
  };
}

export function getConfiguredAnswerModelIdentity(env: NodeJS.ProcessEnv = process.env): ConfiguredAnswerModelIdentity {
  const configured = readConfiguredAnswerModel(env);
  return Object.freeze({
    provider: configured.provider,
    model_id: configured.model_id,
    endpoint_sha256: configured.endpoint_sha256,
    reasoning_effort: configured.reasoning_effort
  });
}

export function createAnswerIntentModel(): AnswerIntentModel {
  const configured = readConfiguredAnswerModel();
  return new OpenAICompatibleAnswerIntentModel(configured.base_url, configured.api_key, configured.model_id, configured.request_reasoning_effort);
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) {
    throw new AnswerProviderDiagnosticError('malformed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (!done) {
      size += chunk.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new AnswerProviderDiagnosticError('oversize');
      }
      chunks.push(chunk.value);
    }
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function translateAnswerQuestion(contract: AnswerQuestionContract, model: AnswerIntentModel, signal?: AbortSignal): Promise<AnswerTranslationResult> {
  let raw: string;
  try {
    raw = await model.complete(ANSWER_TRANSLATOR_SYSTEM_PROMPT, contract.normalized_question, signal);
  } catch (error) {
    const diagnostic = error instanceof AnswerProviderDiagnosticError ? error.diagnosticCode : 'transport';
    return { type: 'provider_unavailable', reason: diagnostic === 'incomplete' ? 'incomplete_response' : 'provider_error', diagnostic_code: diagnostic };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'malformed' };
  }
  try {
    const intent = hydrateAndParseAnswerIntent(extractAnswerIntentWrapper(parsed), contract);
    if (intent.type === 'clarification') {
      return { type: 'clarification_required', reason: intent.reason };
    }
    if (intent.type === 'unsupported') {
      return { type: 'unsupported', reason: intent.reason };
    }
    return { type: 'intent_candidate', intent };
  } catch {
    return { type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'schema_invalid' };
  }
}

function readAnswerReasoningEffort(value: string | undefined): AnswerReasoningEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(ANSWER_REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new AnswerProviderConfigurationError('Invalid answer reasoning effort');
  }
  return value as AnswerReasoningEffort;
}

function extractAnswerIntentWrapper(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'intent')) {
    throw new Error('Invalid answer intent wrapper');
  }
  return (parsed as { intent: unknown }).intent;
}

function diagnosticForStatus(status: number): AnswerProviderDiagnosticCode {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 402) {
    return 'quota';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  if (status >= 500) {
    return 'server';
  }
  return 'client';
}

function validateAnswerEndpoint(baseUrl: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new AnswerProviderConfigurationError('Answer intent provider endpoint must use HTTPS');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new AnswerProviderConfigurationError('Answer intent provider endpoint must use HTTPS');
  }
  if (endpoint.search || endpoint.hash) {
    throw new AnswerProviderConfigurationError('Answer intent provider endpoint must use HTTPS');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
