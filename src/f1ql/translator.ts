import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { F1QLProgramCandidate, parseF1QLProgramCandidate } from './translation-schema';

const SYSTEM_PROMPT = `Classify the user's F1 statistics question and emit one typed F1QL translation result.
Use the emit_f1ql_translation tool exactly once. Never output SQL, prose, markdown, or a legacy query intent.
Return exactly one of:
- {"type":"program_candidate","program":<F1QL program>}
- {"type":"clarification_required","reason":<reason code>,"question":<focused question>,"options":[<supported choices>]}
- {"type":"unsupported","reason":<reason code>}
For a named event, use event_name plus season instead of round; deterministic code resolves it to one round.
Supported root operations only:
- aggregate and rank over official driver standings
- pace_summary for one driver's valid race-lap pace
- pace_delta for the pace difference between two drivers
- event_classification for an official race result by season and round
- qualifying_classification for an official qualifying result by season and round
- event_metadata for an official race or qualifying date by season and round
- official_lap_window_median_compare for exactly two drivers over one inclusive official race-lap window; only metric official_non_deleted_non_pit_window_median_v1 is supported
Required final-standings points program: {"version":1,"root":{"op":"aggregate","input":{"op":"filter","input":{"op":"source","source":"standings"},"where":{"season":2025,"driver_id":["lando-norris","oscar-piastri"]}},"group_by":["driver_id"],"measures":[{"as":"points","function":"max","field":"points"}]}}
Required final-standings leader program: {"version":1,"root":{"op":"rank","input":{"op":"aggregate","input":{"op":"filter","input":{"op":"source","source":"standings"},"where":{"season":2025}},"group_by":["driver_id"],"measures":[{"as":"championship_position","function":"min","field":"championship_position"},{"as":"points","function":"max","field":"points"}]},"by":"championship_position","direction":"asc","limit":1}}
Required named race-classification program: {"version":1,"root":{"op":"event_classification","season":2025,"event_name":"Australian Grand Prix","limit":30,"filters":{"driver_id":"max-verstappen"}}}
Required named qualifying-classification program: {"version":1,"root":{"op":"qualifying_classification","season":2025,"event_name":"Australian Grand Prix","limit":20}}
Required named race-date program: {"version":1,"root":{"op":"event_metadata","season":2025,"event_name":"Australian Grand Prix","session_scope":"race"}}
Required pace_summary program: {"version":1,"root":{"op":"pace_summary","driver_id":"max-verstappen","scope":{"season":2025}}}
Required pace_delta program: {"version":1,"root":{"op":"pace_delta","driver_a_id":"max-verstappen","driver_b_id":"lando-norris","scope":{"season":2025}}}
Required named official lap-window program: {"version":1,"root":{"op":"official_lap_window_median_compare","metric":"official_non_deleted_non_pit_window_median_v1","season":2022,"event_name":"Belgian Grand Prix","driver_a_id":"max-verstappen","driver_b_id":"fernando-alonso","lap_start":3,"lap_end":10}}
Use championship_position ascending, never points descending, to identify the official final standings leader.
Always include a season filter in standings programs. Use a driver_id array when comparing named drivers.
Emit a structurally valid program_candidate for representable requests even if pace, an interim season, a team filter, or the requested entity count may be rejected later by deterministic policy. The deterministic linker and policy own identity ambiguity and authorization decisions.
Never use driver, year, season_year, or free-form keys.
Use canonical lowercase hyphenated driver IDs. Never invent an unsupported F1QL operation.
Clarification reason codes: metric_ambiguous, session_ambiguous, season_missing, event_ambiguous, entity_ambiguous.
Unsupported reason codes: temporal_scope_unsupported, sprint_source_unsupported, grid_source_unsupported, constructor_source_unsupported, pace_source_disabled, source_coverage_missing, capability_unsupported.`;

const clarificationReasonSchema = z.enum([
  'metric_ambiguous',
  'session_ambiguous',
  'season_missing',
  'event_ambiguous',
  'entity_ambiguous'
]);
const unsupportedReasonSchema = z.enum([
  'temporal_scope_unsupported',
  'sprint_source_unsupported',
  'grid_source_unsupported',
  'constructor_source_unsupported',
  'pace_source_disabled',
  'source_coverage_missing',
  'capability_unsupported'
]);
const translationEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('program_candidate'), program: z.unknown() }).strict(),
  z.object({
    type: z.literal('clarification_required'),
    reason: clarificationReasonSchema,
    question: z.string().min(1).max(300),
    options: z.array(z.string().min(1).max(100)).min(1).max(5).optional()
  }).strict(),
  z.object({ type: z.literal('unsupported'), reason: unsupportedReasonSchema }).strict()
]);

export type F1QLTranslationResult =
  | { type: 'program_candidate'; program: F1QLProgramCandidate }
  | { type: 'clarification_required'; reason: z.infer<typeof clarificationReasonSchema>; question: string; options?: string[] }
  | { type: 'unsupported'; reason: z.infer<typeof unsupportedReasonSchema> | 'program_invalid' }
  | { type: 'provider_unavailable'; reason: 'provider_error' | 'invalid_response'; diagnostic_code?: ProviderDiagnosticCode };

export const PROVIDER_DIAGNOSTIC_CODES = [
  'transport_error',
  'http_auth',
  'http_quota',
  'http_rate_limit',
  'http_client',
  'http_server',
  'response_oversized',
  'response_json_malformed',
  'tool_call_missing',
  'tool_call_multiple',
  'tool_name_invalid',
  'tool_arguments_invalid',
  'generation_incomplete',
  'request_timeout'
] as const;

export type ProviderDiagnosticCode = (typeof PROVIDER_DIAGNOSTIC_CODES)[number];

function providerUnavailable(
  reason: 'provider_error' | 'invalid_response',
  diagnosticCode: ProviderDiagnosticCode
): Extract<F1QLTranslationResult, { type: 'provider_unavailable' }> {
  const result: Extract<F1QLTranslationResult, { type: 'provider_unavailable' }> = { type: 'provider_unavailable', reason };
  Object.defineProperty(result, 'diagnostic_code', { value: diagnosticCode, enumerable: false });
  return result;
}

class ProviderDiagnosticError extends Error {
  constructor(readonly diagnosticCode: ProviderDiagnosticCode) {
    super('F1QL translation provider failed');
  }
}

export interface F1QLTextModel {
  complete(systemPrompt: string, question: string, signal?: AbortSignal): Promise<string>;
}

export class AnthropicF1QLModel implements F1QLTextModel {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307') {
    this.client = new Anthropic({ apiKey });
  }

  async complete(systemPrompt: string, question: string, signal?: AbortSignal): Promise<string> {
    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
        tools: [{
          name: 'emit_f1ql_translation',
          description: 'Emit exactly one typed F1QL translation result.',
          input_schema: {
            type: 'object',
            additionalProperties: true
          }
        }],
        tool_choice: { type: 'tool', name: 'emit_f1ql_translation' }
      }, signal ? { signal } : undefined);
      if (message.stop_reason === 'max_tokens') {
        throw new ProviderDiagnosticError('generation_incomplete');
      }
      const toolUses = message.content.filter((content) => content.type === 'tool_use');
      if (toolUses.length === 0) {
        throw new ProviderDiagnosticError('tool_call_missing');
      }
      if (toolUses.length > 1) {
        throw new ProviderDiagnosticError('tool_call_multiple');
      }
      if (toolUses[0].name !== 'emit_f1ql_translation') {
        throw new ProviderDiagnosticError('tool_name_invalid');
      }
      return JSON.stringify(toolUses[0].input);
    } catch (error) {
      if (error instanceof ProviderDiagnosticError) {
        throw error;
      }
      throw new ProviderDiagnosticError(diagnosticForProviderError(error));
    }
  }
}

export class OpenAICompatibleF1QLModel implements F1QLTextModel {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly model: string) {}

  async complete(systemPrompt: string, question: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 512,
          temperature: 0,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }],
          tools: [{ type: 'function', function: { name: 'emit_f1ql_translation', description: 'Emit one typed F1QL translation result.', parameters: { type: 'object', additionalProperties: true } } }],
          tool_choice: { type: 'function', function: { name: 'emit_f1ql_translation' } }
        })
      });
    } catch {
      throw new ProviderDiagnosticError('transport_error');
    }
    if (!response.ok) {
      throw new ProviderDiagnosticError(diagnosticForHttpStatus(response.status));
    }
    const body = await readBoundedJsonResponse(response) as { choices?: Array<{ finish_reason?: string; message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new ProviderDiagnosticError('generation_incomplete');
    }
    const toolCalls = choice?.message?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      throw new ProviderDiagnosticError('tool_call_missing');
    }
    if (toolCalls.length > 1) {
      throw new ProviderDiagnosticError('tool_call_multiple');
    }
    if (toolCalls[0].function?.name !== 'emit_f1ql_translation') {
      throw new ProviderDiagnosticError('tool_name_invalid');
    }
    const argumentsValue = toolCalls[0].function?.arguments;
    if (typeof argumentsValue !== 'string') {
      throw new ProviderDiagnosticError('tool_arguments_invalid');
    }
    return argumentsValue;
  }
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const maximumBytes = 65_536;
  if (!response.body) {
    throw new ProviderDiagnosticError('response_json_malformed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  do {
    const result = await reader.read();
    done = result.done;
    if (!done) {
      const value = result.value;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ProviderDiagnosticError('response_oversized');
      }
      chunks.push(value);
    }
  } while (!done);
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new ProviderDiagnosticError('response_json_malformed');
  }
}

function diagnosticForHttpStatus(status: number): ProviderDiagnosticCode {
  if (status === 401 || status === 403) {
    return 'http_auth';
  }
  if (status === 402) {
    return 'http_quota';
  }
  if (status === 429) {
    return 'http_rate_limit';
  }
  if (status >= 500) {
    return 'http_server';
  }
  return 'http_client';
}

function diagnosticForProviderError(error: unknown): ProviderDiagnosticCode {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return diagnosticForHttpStatus(error.status);
  }
  return 'transport_error';
}

export function createF1QLTextModel(): F1QLTextModel {
  if (process.env.LLM_PROVIDER === 'openai-compatible') {
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    const model = process.env.F1QL_MODEL || process.env.ANTHROPIC_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new Error('F1QL translation provider is not configured');
    }
    return new OpenAICompatibleF1QLModel(baseUrl, apiKey, model);
  }
  return new AnthropicF1QLModel(process.env.ANTHROPIC_API_KEY ?? '');
}

export async function translateF1QLQuestion(question: string, model: F1QLTextModel, signal?: AbortSignal): Promise<F1QLTranslationResult> {
  let raw: string;
  try {
    raw = await model.complete(SYSTEM_PROMPT, question, signal);
  } catch (error) {
    return providerUnavailable('provider_error', error instanceof ProviderDiagnosticError ? error.diagnosticCode : 'transport_error');
  }

  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    return providerUnavailable('invalid_response', 'tool_arguments_invalid');
  }
  const envelope = translationEnvelopeSchema.safeParse(output);
  if (!envelope.success) {
    return providerUnavailable('invalid_response', 'tool_arguments_invalid');
  }
  if (envelope.data.type !== 'program_candidate') {
    return envelope.data;
  }
  try {
    return { type: 'program_candidate', program: parseF1QLProgramCandidate(envelope.data.program) };
  } catch {
    return { type: 'unsupported', reason: 'program_invalid' };
  }
}
