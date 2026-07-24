import { describe, expect, it, vi } from 'vitest';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { F1QLTextModel, OpenAICompatibleF1QLModel, translateF1QLQuestion } from '../../src/f1ql/translator';

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
    expect(examples).toHaveLength(7);
    for (const example of examples) {
      expect(() => parseF1QLProgramCandidate(JSON.parse(example[1]))).not.toThrow();
    }
    expect(model.systemPrompt).toContain('"op":"aggregate"');
    expect(model.systemPrompt).toContain('"by":"championship_position","direction":"asc","limit":1');
    expect(model.systemPrompt).toContain('"op":"event_classification"');
    expect(model.systemPrompt).toContain('"op":"qualifying_classification"');
    expect(model.systemPrompt).toContain('"op":"event_metadata"');
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

  it('bounds OpenAI-compatible output tokens and response bytes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(65_537)));
    const model = new OpenAICompatibleF1QLModel('https://provider.invalid', 'secret', 'model');
    await expect(model.complete('system', 'question')).rejects.toThrow('response exceeded limit');
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request?.body as string)).toMatchObject({ max_tokens: 512 });
    fetchMock.mockRestore();
  });
});
