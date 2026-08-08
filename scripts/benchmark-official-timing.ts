import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  OFFICIAL_TIMING_EVENT_MEAN_STATEMENT,
  OFFICIAL_TIMING_WINDOW_MEDIAN_STATEMENT
} from '../src/f1ql/official-timing-compiler';
import { WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL } from '../src/f1ql/wp12-official-timing-activation-bundle';

export const OFFICIAL_TIMING_BENCHMARK_EMITTER = 'wp12-official-timing-benchmark-v1' as const;
const EXPECTED_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const ITERATIONS = 25;

const STATEMENTS = {
  official_event_coverage_v1: WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL,
  official_event_mean_v3: OFFICIAL_TIMING_EVENT_MEAN_STATEMENT,
  official_window_median_v3: OFFICIAL_TIMING_WINDOW_MEDIAN_STATEMENT
} as const;

const PARAMETERS: Record<keyof typeof STATEMENTS, readonly unknown[]> = {
  official_event_coverage_v1: [2022, 14, ['max-verstappen', 'fernando-alonso']],
  official_event_mean_v3: [2022, 14, 'R', 'max-verstappen', 'fernando-alonso'],
  official_window_median_v3: [2022, 14, 'R', 'max-verstappen', 'fernando-alonso', 1, 44]
};

export async function collectOfficialTimingBenchmark(pool: Pool) {
  const statements = [];
  for (const [id, statement] of Object.entries(STATEMENTS)) {
    const durations: number[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const started = performance.now();
      await pool.query(statement, [...PARAMETERS[id as keyof typeof STATEMENTS]]);
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    statements.push({
      statement_id: id,
      iterations: ITERATIONS,
      p50_ms: round3(durations[Math.floor(durations.length * 0.5)]),
      p95_ms: round3(durations[Math.ceil(durations.length * 0.95) - 1]),
      max_ms: round3(durations[durations.length - 1])
    });
  }
  return {
    emitter: OFFICIAL_TIMING_BENCHMARK_EMITTER,
    target: 'localhost_disposable_docker',
    sealed_fact_count: 790,
    iterations_per_statement: ITERATIONS,
    statements
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl !== EXPECTED_TEST_DATABASE_URL) {
    throw new Error('FAIL_CLOSED: official timing benchmark requires the exact disposable localhost test database');
  }
  const pool = new Pool({ connectionString: EXPECTED_TEST_DATABASE_URL, options: '-c role=f1ql_answer', max: 1 });
  try {
    const evidence = await collectOfficialTimingBenchmark(pool);
    writeFileSync('tests/fixtures/wp12-official-timing-benchmark.json', `${JSON.stringify(evidence, null, 2)}\n`);
    console.log('collected official timing benchmark');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('benchmark-official-timing.ts')) {
  void main();
}
