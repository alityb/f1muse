import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { F1QLProgram } from './ast';
import { parseF1QLProgram } from './schema';

const SYSTEM_PROMPT = `Classify the user's F1 statistics question and emit one typed F1QL translation result.
Use the emit_f1ql_translation tool exactly once. Never output SQL, prose, markdown, or a legacy query intent.
Return exactly one of:
- {"type":"program_candidate","program":<F1QL program>}
- {"type":"clarification_required","reason":<reason code>,"question":<focused question>,"options":[<supported choices>]}
- {"type":"unsupported","reason":<reason code>}
Supported root operations only:
- aggregate and rank over official driver standings
- pace_summary for one driver's valid race-lap pace
 - pace_delta for the pace difference between two drivers
 - event_classification for an official race result by season and round
 - qualifying_classification for an official qualifying result by season and round
Required pace_summary program: {"version":1,"root":{"op":"pace_summary","driver_id":"max-verstappen","scope":{"season":2025}}}
Required pace_delta program: {"version":1,"root":{"op":"pace_delta","driver_a_id":"max-verstappen","driver_b_id":"lando-norris","scope":{"season":2025}}}
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
  | { type: 'program_candidate'; program: F1QLProgram }
  | { type: 'clarification_required'; reason: z.infer<typeof clarificationReasonSchema>; question: string; options?: string[] }
  | { type: 'unsupported'; reason: z.infer<typeof unsupportedReasonSchema> | 'program_invalid' }
  | { type: 'provider_unavailable'; reason: 'provider_error' | 'invalid_response' };

export interface F1QLTextModel {
  complete(systemPrompt: string, question: string): Promise<string>;
}

export class AnthropicF1QLModel implements F1QLTextModel {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307') {
    this.client = new Anthropic({ apiKey });
  }

  async complete(systemPrompt: string, question: string): Promise<string> {
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
    });
    const toolUse = message.content.find((content) => content.type === 'tool_use');
    return toolUse?.type === 'tool_use' ? JSON.stringify(toolUse.input) : '';
  }
}

export class OpenAICompatibleF1QLModel implements F1QLTextModel {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly model: string) {}

  async complete(systemPrompt: string, question: string): Promise<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }],
        tools: [{ type: 'function', function: { name: 'emit_f1ql_translation', description: 'Emit one typed F1QL translation result.', parameters: { type: 'object', additionalProperties: true } } }],
        tool_choice: { type: 'function', function: { name: 'emit_f1ql_translation' } }
      })
    });
    if (!response.ok) {
      throw new Error('F1QL translation provider unavailable');
    }
    const body = await response.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> };
    return body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? '';
  }
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

export async function translateF1QLQuestion(question: string, model: F1QLTextModel): Promise<F1QLTranslationResult> {
  let raw: string;
  try {
    raw = await model.complete(SYSTEM_PROMPT, question);
  } catch {
    return { type: 'provider_unavailable', reason: 'provider_error' };
  }

  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    return { type: 'provider_unavailable', reason: 'invalid_response' };
  }
  const envelope = translationEnvelopeSchema.safeParse(output);
  if (!envelope.success) {
    return { type: 'provider_unavailable', reason: 'invalid_response' };
  }
  if (envelope.data.type !== 'program_candidate') {
    return envelope.data;
  }
  try {
    return { type: 'program_candidate', program: parseF1QLProgram(envelope.data.program) };
  } catch {
    return { type: 'unsupported', reason: 'program_invalid' };
  }
}
