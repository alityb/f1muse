import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lowerF1QL } from '../../src/f1ql/lower';
import { parseF1QLProgram } from '../../src/f1ql/schema';

const corpus = JSON.parse(readFileSync('tests/fixtures/f1ql-shadow-corpus.json', 'utf8')) as Array<{ question: string; output: unknown }>;
const golden = JSON.parse(readFileSync('tests/fixtures/f1ql-lowering-golden.json', 'utf8')) as Array<{ question: string; core_program: unknown }>;

describe('F1QL lowering golden snapshots', () => {
  it('matches the real lowering output for every schema-valid corpus program', () => {
    const emitted = corpus.flatMap(({ question, output }) => {
      try {
        return [{ question, core_program: lowerF1QL(parseF1QLProgram(output)) }];
      } catch {
        return [];
      }
    });
    expect(emitted).toEqual(golden);
  });
});
