import { performance } from 'node:perf_hooks';
import { compileF1QL } from '../src/f1ql/compiler';
import { CoreDeltaNode, CorePipelineNode, CoreProgram, CoreSourceNode } from '../src/f1ql/core';
import { EventClassificationRow, EventMetadataRow, interpretEventClassification, interpretEventMetadata, interpretLapPaceProgram, interpretQualifyingClassification, PaceLapRow, QualifyingClassificationRow, StandingsRow, interpretStandingsProgram } from '../src/f1ql/interpreter';
import { lowerF1QL } from '../src/f1ql/lower';
import { parseF1QLProgram } from '../src/f1ql/schema';
import { validateCoreProgram, validateF1QLProgram } from '../src/f1ql/validation';
import { goldenCorpus } from '../tests/fixtures/f1ql-golden-corpus';

const WARMUP_PASSES = 25;
const MEASURED_PASSES = 200;

const standingsRows: StandingsRow[] = [
  { season: 2025, driver_id: 'max-verstappen', championship_position: 1, points: 25, championship_won: false },
  { season: 2025, driver_id: 'lando-norris', championship_position: 2, points: 18, championship_won: false }
];
const paceRows: PaceLapRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 100, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 102, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 101, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 103, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' }
];
const eventRows: EventClassificationRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', team_id: 'red-bull', finishing_position: 1, points: 25, classification_status: 'classified', status_reason: null },
  { season: 2025, round: 1, driver_id: 'lando-norris', team_id: 'mclaren', finishing_position: null, points: 0, classification_status: 'dnf', status_reason: 'Engine' }
];
const qualifyingRows: QualifyingClassificationRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', team_id: 'red-bull', qualifying_position: 1, best_time_ms: 80000, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
  { season: 2025, round: 1, driver_id: 'lando-norris', team_id: 'mclaren', qualifying_position: null, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'dns' }
];
const metadataRows: EventMetadataRow[] = [
  { season: 2025, round: 1, event_id: 'australian-grand-prix', event_name: 'Australian Grand Prix', circuit_id: 'albert-park', date: '2025-03-16' }
];

function sourceFor(node: CorePipelineNode | CoreDeltaNode): CoreSourceNode['source'] {
  if (node.op === 'source') return node.source;
  if (node.op === 'delta') return sourceFor(node.input.input.left);
  return sourceFor(node.input);
}

function executeFixture(program: CoreProgram): number {
  switch (sourceFor(program.root)) {
    case 'standings': return interpretStandingsProgram(program, standingsRows).length;
    case 'lap_pace': return interpretLapPaceProgram(program, paceRows).length;
    case 'event_classification': return interpretEventClassification(program, eventRows).length;
    case 'qualifying_classification': return interpretQualifyingClassification(program, qualifyingRows).length;
    case 'event_metadata': return interpretEventMetadata(program, metadataRows).length;
  }
}

function compilationPass(): number {
  let compiled = 0;
  for (const testCase of goldenCorpus) {
    try {
      const program = parseF1QLProgram(testCase.program);
      validateF1QLProgram(program);
      const core = lowerF1QL(program);
      validateCoreProgram(core);
      compileF1QL(core);
      compiled += 1;
    } catch {
      // The corpus deliberately includes invalid schema and validation cases.
    }
  }
  return compiled;
}

function fixturePass(programs: CoreProgram[]): number {
  return programs.reduce((rows, program) => rows + executeFixture(program), 0);
}

function measure(action: () => number): number[] {
  for (let index = 0; index < WARMUP_PASSES; index += 1) action();
  return Array.from({ length: MEASURED_PASSES }, () => {
    const started = performance.now();
    action();
    return performance.now() - started;
  });
}

function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentileValue) - 1];
}

const compiledPrograms = goldenCorpus.flatMap((testCase) => {
  try {
    const program = parseF1QLProgram(testCase.program);
    validateF1QLProgram(program);
    const core = lowerF1QL(program);
    validateCoreProgram(core);
    return [core];
  } catch {
    return [];
  }
});
const compiledPerPass = compilationPass();
const fixtureRowsPerPass = fixturePass(compiledPrograms);

if (compiledPerPass === 0 || compiledPrograms.length === 0 || fixtureRowsPerPass === 0) {
  throw new Error('F1QL benchmark requires non-empty accepted corpus programs and fixture output');
}

const compileSamples = measure(compilationPass);
const fixtureSamples = measure(() => fixturePass(compiledPrograms));

process.stdout.write(`${JSON.stringify({
  benchmark: 'f1ql_local_compiler_fixture',
  database: 'none',
  corpus_cases: goldenCorpus.length,
  accepted_programs_per_pass: compiledPerPass,
  fixture_rows_per_pass: fixtureRowsPerPass,
  warmup_passes: WARMUP_PASSES,
  measured_passes: MEASURED_PASSES,
  compile_lower_validate_ms_per_corpus_pass: { p50: percentile(compileSamples, 0.5), p95: percentile(compileSamples, 0.95) },
  fixture_execution_ms_per_corpus_pass: { p50: percentile(fixtureSamples, 0.5), p95: percentile(fixtureSamples, 0.95) }
})}\n`);
