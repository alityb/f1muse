import { readFileSync, writeFileSync } from 'node:fs';
import { lowerF1QL } from '../src/f1ql/lower';
import { parseF1QLProgram } from '../src/f1ql/schema';

const corpus = JSON.parse(readFileSync('tests/fixtures/f1ql-shadow-corpus.json', 'utf8')) as Array<{ question: string; output: unknown }>;
const snapshots = corpus.flatMap(({ question, output }) => {
  try {
    return [{ question, core_program: lowerF1QL(parseF1QLProgram(output)) }];
  } catch {
    return [];
  }
});

writeFileSync('tests/fixtures/f1ql-lowering-golden.json', `${JSON.stringify(snapshots, null, 2)}\n`);
