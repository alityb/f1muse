import { describe, expect, it } from 'vitest';
import { F1QLTextModel, translateF1QLQuestion } from '../../src/f1ql/translator';

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

describe('constrained F1QL translation', () => {
  it('accepts a schema-valid supported program', async () => {
    await expect(translateF1QLQuestion('Max pace in 2025', new StubModel(JSON.stringify({
      type: 'program_candidate',
      program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } }
    })))).resolves.toMatchObject({ type: 'program_candidate', program: { root: { op: 'pace_summary' } } });
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
});
