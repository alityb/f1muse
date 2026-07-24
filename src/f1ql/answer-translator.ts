import { createHash } from 'node:crypto';
import { AnswerIntent, parseAnswerIntent } from './answer-intent';
import { AnswerQuestionContract } from './answer-question';

export const ANSWER_TRANSLATOR_SCHEMA_NAME = 'f1_answer_intent_v1';
export const ANSWER_INTENT_CONTRACT_VERSION = 'answer-intent-v1' as const;
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
  required: ['text', 'start', 'end'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 200 },
    start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 1 }
  }
} as const;

const seasonProperties = {
  season: { type: 'integer', minimum: 1950, maximum: 2100 },
  season_reference: referenceSchema
} as const;
const eventProperties = { event_reference: referenceSchema } as const;

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
        closedIntent('final_standings_points', { ...seasonProperties, driver_references: { type: 'array', maxItems: 4, items: referenceSchema } }, ['season', 'season_reference', 'driver_references']),
        closedIntent('final_standings_leader', seasonProperties, ['season', 'season_reference']),
        closedIntent('race_classification_all', { ...seasonProperties, ...eventProperties }, ['season', 'season_reference', 'event_reference']),
        closedIntent('race_classification_driver', { ...seasonProperties, ...eventProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'driver_reference']),
        closedIntent('race_classification_status', { ...seasonProperties, ...eventProperties, status: { enum: ['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn'] }, status_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'status', 'status_reference']),
        closedIntent('qualifying_classification_all', { ...seasonProperties, ...eventProperties }, ['season', 'season_reference', 'event_reference']),
        closedIntent('qualifying_classification_driver', { ...seasonProperties, ...eventProperties, driver_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'driver_reference']),
        closedIntent('qualifying_classification_status', { ...seasonProperties, ...eventProperties, status: { enum: ['classified', 'dnf', 'dns'] }, status_reference: referenceSchema }, ['season', 'season_reference', 'event_reference', 'status', 'status_reference']),
        closedIntent('race_date', { ...seasonProperties, ...eventProperties }, ['season', 'season_reference', 'event_reference']),
        closedIntent('clarification', { reason: { enum: ['season_missing', 'event_ambiguous', 'entity_ambiguous', 'session_ambiguous', 'metric_ambiguous'] } }, ['reason']),
        closedIntent('unsupported', { reason: { enum: ['sprint_source_unsupported', 'grid_source_unsupported', 'constructor_source_unsupported', 'pace_source_disabled', 'team_filter_unsupported', 'interim_standings_unsupported', 'temporal_scope_unsupported', 'capability_unsupported'] } }, ['reason'])
      ]
    }
  }
} as const);

export const ANSWER_TRANSLATOR_SYSTEM_PROMPT = `Return exactly { "intent": <AnswerIntent> } matching the supplied strict JSON schema, with no other top-level keys.
Every season, event or round, driver, and classification-status value must include the exact literal span from the normalized question, measured in Unicode code points. Never emit canonical IDs or F1QL.
Do not guess omitted season, session, metric, status, event, driver, or cardinality semantics. Use clarification or unsupported when the question does not uniquely select one supported answer template.`;

export const ANSWER_TRANSLATOR_PROMPT_SHA256 = sha256(ANSWER_TRANSLATOR_SYSTEM_PROMPT);
export const ANSWER_TRANSLATOR_SCHEMA_SHA256 = sha256(stableSerialize(ANSWER_INTENT_JSON_SCHEMA));

export interface AnswerIntentModel {
  complete(systemPrompt: string, question: string, signal?: AbortSignal): Promise<string>;
}

export type AnswerTranslationResult =
  | { readonly type: 'intent_candidate'; readonly intent: Exclude<AnswerIntent, { type: 'clarification' | 'unsupported' }> }
  | { readonly type: 'clarification_required'; readonly reason: Extract<AnswerIntent, { type: 'clarification' }>['reason'] }
  | { readonly type: 'unsupported'; readonly reason: Extract<AnswerIntent, { type: 'unsupported' }>['reason'] }
  | { readonly type: 'provider_unavailable'; readonly reason: 'provider_error' | 'invalid_response' | 'incomplete_response' | 'unsupported_provider'; readonly diagnostic_code?: AnswerProviderDiagnosticCode };

export class OpenAICompatibleAnswerIntentModel implements AnswerIntentModel {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = validateAnswerEndpoint(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
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
}

interface ConfiguredAnswerModel extends ConfiguredAnswerModelIdentity {
  readonly base_url: string;
  readonly api_key: string;
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
  const apiKey = env.F1QL_ANSWER_LLM_API_KEY ?? env.LLM_API_KEY;
  if (!apiKey) {
    throw new AnswerProviderConfigurationError('Strict answer intent provider is not supported or configured');
  }
  return { provider: provider as ConfiguredAnswerModel['provider'], model_id: model, base_url: validatedBaseUrl, api_key: apiKey };
}

export function getConfiguredAnswerModelIdentity(env: NodeJS.ProcessEnv = process.env): ConfiguredAnswerModelIdentity {
  const configured = readConfiguredAnswerModel(env);
  return Object.freeze({ provider: configured.provider, model_id: configured.model_id });
}

export function createAnswerIntentModel(): AnswerIntentModel {
  const configured = readConfiguredAnswerModel();
  return new OpenAICompatibleAnswerIntentModel(configured.base_url, configured.api_key, configured.model_id);
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
    const intent = parseAnswerIntent(extractAnswerIntentWrapper(parsed), contract);
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
