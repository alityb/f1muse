import { describe, expect, it } from 'vitest';
import { F1QLTextModel, translateF1QLQuestion } from '../../src/f1ql/translator';

class StubModel implements F1QLTextModel {
  constructor(private readonly output: string) {}

  async complete(): Promise<string> {
    return this.output;
  }
}

describe('constrained F1QL translation', () => {
  it('accepts a schema-valid supported program', async () => {
    await expect(translateF1QLQuestion('Max pace in 2025', new StubModel(JSON.stringify({
      version: 1,
      root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } }
    })))).resolves.toMatchObject({ root: { op: 'pace_summary' } });
  });

  it('rejects non-JSON output without a fallback execution path', async () => {
    await expect(translateF1QLQuestion('Max pace in 2025', new StubModel('SELECT * FROM laps_normalized')))
      .rejects.toThrow('F1QL translation did not return valid JSON');
  });

  it('rejects unsupported or raw-SQL-shaped JSON programs', async () => {
    await expect(translateF1QLQuestion('Do something unsupported', new StubModel(JSON.stringify({
      version: 1,
      root: { op: 'unsupported', sql: 'SELECT 1' }
    })))).rejects.toThrow();
  });
});
