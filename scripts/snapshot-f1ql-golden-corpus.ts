import { writeFileSync } from 'node:fs';
import { lowerF1QL } from '../src/f1ql/lower';
import { parseF1QLProgram } from '../src/f1ql/schema';
import { goldenCorpus } from '../tests/fixtures/f1ql-golden-corpus';

const snapshots = goldenCorpus.flatMap(({ question, program }) => {
  try {
    return [{ question, core_program: lowerF1QL(parseF1QLProgram(program)) }];
  } catch {
    return [];
  }
});

writeFileSync('tests/fixtures/f1ql-golden-corpus-programs.json', `${JSON.stringify(snapshots, null, 2)}\n`);
