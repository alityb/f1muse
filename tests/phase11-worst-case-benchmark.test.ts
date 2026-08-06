import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveWorstCaseBenchmarkHashes,
  loadWorstCaseBenchmarkDefinitions,
  parseWorstCaseBenchmarkDefinitions,
  prepareWorstCaseBenchmark,
  runWorstCaseBenchmark
} from '../scripts/benchmark-phase11-worst-case';
import { emitWorstCaseBenchmarkMetadata } from '../scripts/snapshot-phase11-worst-case-benchmark';

describe('Phase 11 worst-case legal benchmark contract', () => {
  it('covers all plan families and attains current row, work, and resolver limits', async () => {
    const loaded = loadWorstCaseBenchmarkDefinitions();
    const preparation = await prepareWorstCaseBenchmark(loaded.definitions, loaded.definitions_sha256);

    expect(Object.isFrozen(loaded.definitions)).toBe(true);
    expect(preparation).toMatchObject({
      workload_count: 4,
      fixture_rows_total: 211,
      workloads: [
        {
          family: 'single_source', topology: 'single_source_rows', work_units: 1,
          requested_rows: 100, resolver_candidates: 0, reference_rows: 100
        },
        {
          family: 'safe_dimension_join', topology: 'row_dimension_join', work_units: 2,
          requested_rows: 100, resolver_candidates: 1, reference_rows: 100
        },
        {
          family: 'single_source', topology: 'single_source_aggregate', work_units: 30,
          requested_rows: 10, resolver_candidates: 0, reference_rows: 10
        },
        {
          family: 'aggregate_locality', topology: 'scalar_aggregate_compose', work_units: 60,
          requested_rows: 1, resolver_candidates: 100, reference_rows: 1
        }
      ]
    });
    expect(preparation.definitions.legal_limits).toEqual({
      maximum_work_units: 60,
      maximum_rows: 100,
      maximum_resolver_candidates_per_mention: 100
    });
  });

  it('exactly matches the real benchmark metadata emitter and deterministic hashes', async () => {
    const source = readFileSync('metadata/phase11-wp7-worst-case-benchmark.json', 'utf8');
    const loaded = loadWorstCaseBenchmarkDefinitions();
    const first = await prepareWorstCaseBenchmark(loaded.definitions, loaded.definitions_sha256);
    const second = await prepareWorstCaseBenchmark(loaded.definitions, loaded.definitions_sha256);
    const derived = await deriveWorstCaseBenchmarkHashes(loaded.definitions);

    expect(await emitWorstCaseBenchmarkMetadata()).toBe(source);
    expect(first.deterministic_sha256).toBe(second.deterministic_sha256);
    for (const workload of loaded.definitions.workloads) {
      expect(derived[workload.id]).toEqual(workload.expected.hashes);
    }
  });

  it('rejects empty, family-incomplete, drifting, over-limit, and extended definitions', () => {
    const source = JSON.parse(readFileSync('metadata/phase11-wp7-worst-case-benchmark.json', 'utf8'));

    const empty = structuredClone(source);
    empty.workloads = [];
    expect(() => parseWorstCaseBenchmarkDefinitions(empty)).toThrow();

    const repeatedFamily = structuredClone(source);
    repeatedFamily.workloads[1].family = 'single_source';
    expect(() => parseWorstCaseBenchmarkDefinitions(repeatedFamily)).toThrow();

    const changedLimit = structuredClone(source);
    changedLimit.legal_limits.maximum_rows = 101;
    expect(() => parseWorstCaseBenchmarkDefinitions(changedLimit)).toThrow();

    const overLimit = structuredClone(source);
    overLimit.workloads[2].expected.resolver_candidates = 101;
    expect(() => parseWorstCaseBenchmarkDefinitions(overLimit)).toThrow();

    const extended = structuredClone(source);
    extended.workloads[0].database_query = 'SELECT 1';
    expect(() => parseWorstCaseBenchmarkDefinitions(extended)).toThrow();
  });

  it('reports honest combined API timings as local observational safety data only', async () => {
    const loaded = loadWorstCaseBenchmarkDefinitions();
    const shortRun = structuredClone(loaded.definitions) as any;
    shortRun.warmup_passes = 1;
    shortRun.measured_passes = 2;
    const report = await runWorstCaseBenchmark(shortRun);

    expect(report).toMatchObject({
      database: 'none',
      timing_scope: 'local_observational_safety_only',
      production_capability_threshold: 'not_evaluated'
    });
    expect(Object.keys(report.timings_ms_per_workload_set)).toEqual([
      'semantic_enumeration_verification_admission_apis',
      'resolution_and_planning_apis',
      'whole_plan_proof_api',
      'proof_parent_verification_and_compiler_apis',
      'proof_parent_verification_reference_interpreter_and_formatter_revalidation_apis'
    ]);
    for (const timing of Object.values(report.timings_ms_per_workload_set)) {
      expect(timing.p50).toBeGreaterThanOrEqual(0);
      expect(timing.p95).toBeGreaterThanOrEqual(timing.p50);
      expect(timing.p95).toBeLessThanOrEqual(report.safety_ceiling_ms_per_stage_pass);
    }
  });

  it('has guarded npm commands and no live database dependency', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const source = readFileSync('scripts/benchmark-phase11-worst-case.ts', 'utf8');
    const support = readFileSync('scripts/support/semantic-plan-execution.ts', 'utf8');

    expect(packageJson.scripts['golden:snapshot:phase11:worst-case-benchmark'])
      .toBe('tsx scripts/snapshot-phase11-worst-case-benchmark.ts');
    expect(packageJson.scripts['benchmark:phase11:worst-case']).toBe('tsx scripts/benchmark-phase11-worst-case.ts');
    expect(source).toContain("from './support/semantic-plan-execution'");
    expect(source).not.toMatch(/executeF1QL|new\s+Pool|\.query\s*\(/u);
    expect(support).not.toMatch(/DATABASE_URL|new\s+Pool/u);
    expect(support).toContain('executeAuthorizedSemanticPlan');
  });
});
