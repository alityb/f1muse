import fs from 'fs';
import { emitOfficialEventMeanF1QL } from './snapshot-phase8-belgium-2022-f1ql';
import { getTestDatabaseUrl } from '../src/test/setup';

const OUTPUT_PATH = 'data/phase9-belgium-2022-event-mean-result.json';

async function main(): Promise<void> {
  const output = await emitOfficialEventMeanF1QL(getTestDatabaseUrl());
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) void main();
