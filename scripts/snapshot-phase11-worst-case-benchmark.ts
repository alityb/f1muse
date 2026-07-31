import { writeFileSync } from 'node:fs';
import {
  createWorstCaseBenchmarkDefinitionSeed,
  deriveWorstCaseBenchmarkHashes,
  WORST_CASE_BENCHMARK_METADATA_PATH
} from './benchmark-phase11-worst-case';

export const WORST_CASE_BENCHMARK_METADATA_EMITTER_VERSION = 'phase11-worst-case-emitter-v1' as const;

export async function emitWorstCaseBenchmarkMetadata(): Promise<string> {
  const seed = createWorstCaseBenchmarkDefinitionSeed();
  const hashes = await deriveWorstCaseBenchmarkHashes(seed);
  const metadata = {
    ...seed,
    emitter: {
      version: WORST_CASE_BENCHMARK_METADATA_EMITTER_VERSION,
      script: 'scripts/snapshot-phase11-worst-case-benchmark.ts'
    },
    workloads: seed.workloads.map(workload => ({
      ...workload,
      expected: { ...workload.expected, hashes: hashes[workload.id] }
    }))
  };
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

if (require.main === module) {
  emitWorstCaseBenchmarkMetadata().then(output => {
    writeFileSync(WORST_CASE_BENCHMARK_METADATA_PATH, output);
    process.stdout.write(`Wrote ${WORST_CASE_BENCHMARK_METADATA_PATH}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'benchmark metadata emission failed'}\n`);
    process.exitCode = 1;
  });
}
