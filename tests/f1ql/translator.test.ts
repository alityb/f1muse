import { describe, expect, it, vi } from 'vitest';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { AnthropicF1QLModel, F1QLTextModel, OpenAICompatibleF1QLModel, translateF1QLQuestion } from '../../src/f1ql/translator';

class StubModel implements F1QLTextModel {
  constructor(private readonly output: string) {}

  async complete(): Promise<string> {
    return this.output;
  }
}

class ThrowingModel implements F1QLTextModel {
  async complete(): Promise<string> {
    throw new Error('provider unavailable');
  }
}

class PromptRecordingModel implements F1QLTextModel {
  systemPrompt = '';

  async complete(systemPrompt: string): Promise<string> {
    this.systemPrompt = systemPrompt;
    return JSON.stringify({ type: 'unsupported', reason: 'capability_unsupported' });
  }
}

describe('constrained F1QL translation', () => {
  it('accepts a schema-valid supported program', async () => {
    await expect(translateF1QLQuestion('Max pace in 2025', new StubModel(JSON.stringify({
      type: 'program_candidate',
      program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } }
    })))).resolves.toMatchObject({ type: 'program_candidate', program: { root: { op: 'pace_summary' } } });
  });

  it('constrains answer translation with canonical program shapes and deterministic policy ownership', async () => {
    const model = new PromptRecordingModel();
    await translateF1QLQuestion('Who led the final standings?', model);

    const examples = [...model.systemPrompt.matchAll(/^Required [^:\n]+ program: (.+)$/gm)];
    expect(examples).toHaveLength(8);
    for (const example of examples) {
      expect(() => parseF1QLProgramCandidate(JSON.parse(example[1]))).not.toThrow();
    }
    expect(model.systemPrompt).toContain('"op":"aggregate"');
    expect(model.systemPrompt).toContain('"by":"championship_position","direction":"asc","limit":1');
    expect(model.systemPrompt).toContain('"op":"event_classification"');
    expect(model.systemPrompt).toContain('"op":"qualifying_classification"');
    expect(model.systemPrompt).toContain('"op":"event_metadata"');
    expect(model.systemPrompt).toContain('"op":"official_lap_window_median_compare"');
    expect(model.systemPrompt).toContain('"metric":"official_non_deleted_non_pit_window_median_v1"');
    expect(model.systemPrompt).toContain('The deterministic linker and policy own identity ambiguity and authorization decisions.');
  });

  it('accepts a strict translation-only named event candidate', async () => {
    await expect(translateF1QLQuestion('Belgian GP in 2021', new StubModel(JSON.stringify({
      type: 'program_candidate',
      program: { version: 1, root: { op: 'event_classification', season: 2021, event_name: 'Belgian Grand Prix', limit: 30 } }
    })))).resolves.toMatchObject({ type: 'program_candidate', program: { root: { event_name: 'Belgian Grand Prix' } } });
    await expect(translateF1QLQuestion('Conflicting event', new StubModel(JSON.stringify({
      type: 'program_candidate',
      program: { version: 1, root: { op: 'event_classification', season: 2021, round: 12, event_name: 'Belgian Grand Prix', limit: 30 } }
    })))).resolves.toEqual({ type: 'unsupported', reason: 'program_invalid' });
  });

  it('accepts only the closed translation-only named official lap-window shape', async () => {
    const program = {
      version: 1,
      root: {
        op: 'official_lap_window_median_compare',
        metric: 'official_non_deleted_non_pit_window_median_v1',
        season: 2022,
        event_name: 'Belgian Grand Prix',
        driver_a_id: 'Max Verstappen',
        driver_b_id: 'Fernando Alonso',
        lap_start: 3,
        lap_end: 10
      }
    };
    await expect(translateF1QLQuestion('Belgium laps 3-10', new StubModel(JSON.stringify({ type: 'program_candidate', program }))))
      .resolves.toMatchObject({ type: 'program_candidate', program: { root: { event_name: 'Belgian Grand Prix' } } });

    for (const root of [
      { ...program.root, round: 14 },
      { ...program.root, metric: 'clean_air_gap_2_0s_v1' },
      { ...program.root, lap_start: 0 },
      { ...program.root, lap_start: 10, lap_end: 9 },
      { ...program.root, lap_start: 1, lap_end: 51 }
    ]) {
      await expect(translateF1QLQuestion('invalid historical window', new StubModel(JSON.stringify({
        type: 'program_candidate', program: { version: 1, root }
      })))).resolves.toEqual({ type: 'unsupported', reason: 'program_invalid' });
    }
  });

  it('returns provider_unavailable for non-JSON output without a fallback execution path', async () => {
    await expect(translateF1QLQuestion('Max pace in 2025', new StubModel('SELECT * FROM laps_normalized')))
      .resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response' });
  });

  it('returns typed unsupported and invalid-program outcomes', async () => {
    await expect(translateF1QLQuestion('Do something unsupported', new StubModel(JSON.stringify({
      type: 'unsupported', reason: 'capability_unsupported'
    })))).resolves.toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    await expect(translateF1QLQuestion('Run raw SQL', new StubModel(JSON.stringify({
      type: 'program_candidate', program: { version: 1, root: { op: 'unsupported', sql: 'SELECT 1' } }
    })))).resolves.toEqual({ type: 'unsupported', reason: 'program_invalid' });
  });

  it('returns typed clarification outcomes', async () => {
    await expect(translateF1QLQuestion('Who was better?', new StubModel(JSON.stringify({
      type: 'clarification_required',
      reason: 'metric_ambiguous',
      question: 'Do you mean championship points or race position?',
      options: ['Championship points', 'Race position']
    })))).resolves.toMatchObject({ type: 'clarification_required', reason: 'metric_ambiguous' });
  });

  it('returns provider_unavailable for malformed envelopes and provider failures', async () => {
    await expect(translateF1QLQuestion('Max pace', new StubModel('```json\n{}\n```')))
      .resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response' });
    await expect(translateF1QLQuestion('Max pace', new StubModel('[]')))
      .resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response' });
    await expect(translateF1QLQuestion('Max pace', new ThrowingModel()))
      .resolves.toEqual({ type: 'provider_unavailable', reason: 'provider_error' });
  });

  it('classifies sanitized OpenAI-compatible HTTP failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const model = new OpenAICompatibleF1QLModel('https://provider.invalid', 'secret', 'model');
    for (const [status, diagnostic] of [[401, 'http_auth'], [402, 'http_quota'], [429, 'http_rate_limit'], [400, 'http_client'], [503, 'http_server']] as const) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      const result = await translateF1QLQuestion('question', model);
      expect(result).toEqual({ type: 'provider_unavailable', reason: 'provider_error' });
      expect(result.type === 'provider_unavailable' && result.diagnostic_code).toBe(diagnostic);
    }
    fetchMock.mockRestore();
  });

  it('classifies bounded response and tool-call failures without retaining response content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(65_537)));
    const model = new OpenAICompatibleF1QLModel('https://provider.invalid', 'secret', 'model');
    const oversized = await translateF1QLQuestion('question', model);
    expect(oversized).toEqual({ type: 'provider_unavailable', reason: 'provider_error' });
    expect(oversized.type === 'provider_unavailable' && oversized.diagnostic_code).toBe('response_oversized');
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request?.body as string)).toMatchObject({ max_tokens: 512 });

    fetchMock.mockResolvedValueOnce(new Response('{'));
    await expect(translateF1QLQuestion('question', model)).resolves.toMatchObject({ diagnostic_code: 'response_json_malformed' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: {} }] })));
    await expect(translateF1QLQuestion('question', model)).resolves.toMatchObject({ diagnostic_code: 'tool_call_missing' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: '{}' } }, { function: { arguments: '{}' } }] } }] })));
    await expect(translateF1QLQuestion('question', model)).resolves.toMatchObject({ diagnostic_code: 'tool_call_multiple' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'wrong_tool', arguments: '{}' } }] } }] })));
    await expect(translateF1QLQuestion('question', model)).resolves.toMatchObject({ diagnostic_code: 'tool_name_invalid' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: {} }] })));
    await expect(translateF1QLQuestion('question', model)).resolves.toMatchObject({ diagnostic_code: 'generation_incomplete' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'emit_f1ql_translation', arguments: '{' } }] } }] })));
    const invalidArguments = await translateF1QLQuestion('question', model);
    expect(invalidArguments).toEqual({ type: 'provider_unavailable', reason: 'invalid_response' });
    expect(invalidArguments.type === 'provider_unavailable' && invalidArguments.diagnostic_code).toBe('tool_arguments_invalid');
    fetchMock.mockRestore();
  });

  it('rejects a differently named Anthropic tool call', async () => {
    const model = new AnthropicF1QLModel('fixture-key', 'fixture-model');
    const client = model as unknown as { client: { messages: { create: ReturnType<typeof vi.fn> } } };
    client.client.messages.create = vi.fn().mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'wrong_tool', input: {} }]
    });
    const result = await translateF1QLQuestion('question', model);
    expect(result).toEqual({ type: 'provider_unavailable', reason: 'provider_error' });
    expect(result.type === 'provider_unavailable' && result.diagnostic_code).toBe('tool_name_invalid');
  });
});
