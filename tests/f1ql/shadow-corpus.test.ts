import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { F1QLTextModel, translateF1QLQuestion } from '../../src/f1ql/translator';

class StubModel implements F1QLTextModel { constructor(private output: unknown) {} async complete(): Promise<string> { return typeof this.output === 'string' ? this.output : JSON.stringify(this.output); } }
const corpus = JSON.parse(readFileSync('tests/fixtures/f1ql-shadow-corpus.json', 'utf8')) as Array<{ question: string; output: unknown }>;

describe('shadow translation corpus', () => {
  for (const item of corpus) {
    it(item.question, async () => {
      const promise = translateF1QLQuestion(item.question, new StubModel(item.output));
      if (typeof item.output === 'string' || (item.output as { root?: { op?: string } }).root?.op === 'unsupported') await expect(promise).rejects.toThrow();
      else await expect(promise).resolves.toMatchObject({ version: 1 });
    });
  }
});
