import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { championshipScoringRulesRegistry } from '../src/scoring/rules';

writeFileSync(
  resolve(process.cwd(), 'tests/fixtures/scoring-rules-golden.json'),
  `${JSON.stringify(championshipScoringRulesRegistry, null, 2)}\n`
);
