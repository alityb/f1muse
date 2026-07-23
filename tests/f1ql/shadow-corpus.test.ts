import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { F1QLTextModel, translateF1QLQuestion } from '../../src/f1ql/translator';

class StubModel implements F1QLTextModel { constructor(private output: unknown) {} async complete(): Promise<string> { return typeof this.output === 'string' ? this.output : JSON.stringify(this.output); } }
const corpus = JSON.parse(readFileSync('tests/fixtures/f1ql-shadow-corpus.json', 'utf8')) as Array<{ question: string; output: unknown }>;

describe('shadow translation corpus', () => {
  for (const item of corpus) {
    it(item.question, async () => {
      const unsupported = (item.output as { root?: { op?: string } }).root?.op === 'unsupported';
      const output = typeof item.output === 'string'
        ? item.output
        : unsupported
          ? { type: 'unsupported', reason: 'capability_unsupported' }
          : { type: 'program_candidate', program: item.output };
      const result = await translateF1QLQuestion(item.question, new StubModel(output));
      if (typeof item.output === 'string') expect(result).toEqual({ type: 'provider_unavailable', reason: 'invalid_response' });
      else if (unsupported) expect(result).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
      else expect(result).toMatchObject({ type: 'program_candidate', program: { version: 1 } });
    });
  }
});
