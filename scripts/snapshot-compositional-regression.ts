import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { compositionalRegressionCorpusInput } from '../tests/fixtures/compositional-regression-corpus';
import { runCompositionalRegressionCorpus } from '../tests/support/compositional-regression';

export const COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  'tests/fixtures/compositional-regression.snapshot.json'
);

export async function emitCompositionalRegressionSnapshot(): Promise<string> {
  const result = await runCompositionalRegressionCorpus(compositionalRegressionCorpusInput);
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (require.main === module) {
  emitCompositionalRegressionSnapshot().then(output => {
    writeFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, output);
    console.log(`Wrote ${COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH}`);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
