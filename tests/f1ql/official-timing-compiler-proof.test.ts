import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseOfficialTimingQuestion, OfficialTimingQuestionMatch } from '../../src/f1ql/official-timing-question';
import { enumerateOfficialTimingEvidence } from '../../src/f1ql/official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  OfficialTimingResolutionDependencies
} from '../../src/f1ql/official-timing-resolution';
import { planOfficialTimingAnswer } from '../../src/f1ql/official-timing-plan';
import {
  compileOfficialTimingPlan,
  OFFICIAL_TIMING_PLANNED_COMPILER_VERSION,
  OFFICIAL_TIMING_PLANNED_PIPELINE_VERSION,
  OfficialTimingCompilerError,
  runOfficialTimingPlannedPipeline,
  verifyOfficialTimingCompiledStatement,
  verifyOfficialTimingPipeline
} from '../../src/f1ql/official-timing-compiler';
import {
  OFFICIAL_TIMING_PLAN_PROOF_VERSION,
  OfficialTimingProofError,
  proveOfficialTimingPlan,
  verifyOfficialTimingProof
} from '../../src/f1ql/official-timing-proof';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const DRIVERS: Readonly<Record<string, string>> = {
  'Max Verstappen': 'max-verstappen',
  'Fernando Alonso': 'fernando-alonso'
};
const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';
const WINDOW_MEDIAN_QUESTION = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 10 to 20 at the 2022 Belgian Grand Prix';

function matched(question: string): OfficialTimingQuestionMatch {
  const result = parseOfficialTimingQuestion(question);
  if (result.type !== 'matched') {throw new Error(`expected match, got ${result.reason}`);}
  return result;
}

function dependenciesFor(metric: string): OfficialTimingResolutionDependencies {
  return {
    database: { connect: () => { throw new Error('no database in unit tests'); } } as never,
    catalog: CATALOG_V2,
    driver_resolver: {
      resolveUnambiguous: async (alias: string) => {
        const id = DRIVERS[alias];
        return id
          ? { success: true, f1db_driver_id: id, candidates: [id], match_mode: 'literal' }
          : { success: false, error: 'unknown_driver' };
      }
    },
    event_resolver: {
      resolveRound: async (season: number, round: number) =>
        season === 2022 && round === 14 ? { type: 'resolved', season, round } : { type: 'missing' }
    },
    coverage_reader: async () => ({
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric,
      coverage_query_id: metric === 'official_non_deleted_non_pit_event_mean_v1'
        ? 'official_event_coverage_v1' : 'official_window_coverage_v1',
      coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[
        metric === 'official_non_deleted_non_pit_event_mean_v1' ? 0 : 1
      ].statement_sha256,
      query_calls: 1,
      driver_coverage: [
        { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 40, excluded_deleted_laps: 2, excluded_pit_marker_laps: 2 },
        { driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 41, excluded_deleted_laps: 1, excluded_pit_marker_laps: 2 }
      ]
    }) as never
  };
}

async function pipelineFor(questionText: string) {
  const question = matched(questionText);
  const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
  const metric = evidence.candidates[0].metric_id;
  const resolution = await collectOfficialTimingResolution(question, evidence, dependenciesFor(metric));
  const plan = planOfficialTimingAnswer({ question, evidence, resolution });
  const pipeline = runOfficialTimingPlannedPipeline(plan);
  return { question, evidence, resolution, plan, pipeline };
}

describe('official timing planned compiler v3', () => {
  it('compiles the event-mean plan to one parameterized read-only select', async () => {
    const { pipeline } = await pipelineFor(EVENT_MEAN_QUESTION);
    const compiled = pipeline.compiled;
    expect(compiled.kind).toBe('official_timing_compiled_statement');
    expect(compiled.compiler_version).toBe(OFFICIAL_TIMING_PLANNED_COMPILER_VERSION);
    expect(compiled.statement_class).toBe('one_read_only_parameterized_select');
    expect(compiled.target_relation).toBe('f1ql.official_race_lap_timing');
    expect(compiled.statement).toContain('FROM f1ql.official_race_lap_timing');
    expect(compiled.statement.match(/FROM f1ql\.official_race_lap_timing/g)).toHaveLength(2);
    expect(compiled.statement).toContain('NOT official_deleted_lap');
    expect(compiled.statement).toContain('NOT official_pit_marker');
    expect(compiled.statement).not.toContain('lap_number BETWEEN');
    expect(compiled.parameters).toEqual([2022, 14, 'R', 'max-verstappen', 'fernando-alonso']);
    expect(compiled.parameter_order).toEqual(['season', 'round', 'session_type', 'driver_a_id', 'driver_b_id']);
    expect(compiled.maximum_rows).toBe(1);
    expect(compiled.transaction).toBe('repeatable_read_read_only');
    expect(compiled.statement_timeout_ms_required).toBe(true);
    expect(compiled.statement_sha256).toBe(
      createHash('sha256').update(compiled.statement).digest('hex')
    );
    expect(compiled.compiled_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('compiles the window-median plan with the lap range parameters', async () => {
    const { pipeline } = await pipelineFor(WINDOW_MEDIAN_QUESTION);
    const compiled = pipeline.compiled;
    expect(compiled.statement).toContain('lap_number BETWEEN $6 AND $7');
    expect(compiled.statement).toContain('ARRAY_AGG');
    expect(compiled.parameters).toEqual([2022, 14, 'R', 'max-verstappen', 'fernando-alonso', 10, 20]);
    expect(compiled.parameter_order).toEqual([
      'season', 'round', 'session_type', 'driver_a_id', 'driver_b_id', 'lap_start', 'lap_end'
    ]);
  });

  it('runs the sealed pipeline gates in order without execution', async () => {
    const { pipeline } = await pipelineFor(EVENT_MEAN_QUESTION);
    expect(pipeline.pipeline_version).toBe(OFFICIAL_TIMING_PLANNED_PIPELINE_VERSION);
    expect(pipeline.gates).toEqual([
      'parse', 'catalog_bind', 'coverage_witness', 'cost', 'participation',
      'lower', 'core_validate', 'compile', 'hash_bind'
    ]);
    expect(pipeline.planned_core_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(pipeline.pipeline_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyOfficialTimingPipeline(pipeline)).toBe(pipeline);
    expect(verifyOfficialTimingCompiledStatement(pipeline.compiled)).toBe(pipeline.compiled);
  });

  it('rejects foreign plans, compiled statements, and pipelines', async () => {
    const { plan, pipeline } = await pipelineFor(EVENT_MEAN_QUESTION);
    expect(() => runOfficialTimingPlannedPipeline(structuredClone(plan)))
      .toThrowError(expect.objectContaining({ reason: 'plan_invalid' }));
    expect(() => compileOfficialTimingPlan(structuredClone(plan)))
      .toThrowError(expect.objectContaining({ reason: 'planned_program_invalid' }));
    expect(() => verifyOfficialTimingPipeline(structuredClone(pipeline)))
      .toThrowError(expect.objectContaining({ reason: 'plan_invalid' }));
    expect(() => verifyOfficialTimingCompiledStatement(structuredClone(pipeline.compiled)))
      .toThrowError(OfficialTimingCompilerError);
  });

  it('is deterministic across repeated compilation', async () => {
    const first = await pipelineFor(EVENT_MEAN_QUESTION);
    const second = await pipelineFor(EVENT_MEAN_QUESTION);
    expect(first.pipeline.pipeline_hash).toBe(second.pipeline.pipeline_hash);
    expect(first.pipeline.compiled).toEqual(second.pipeline.compiled);
  });
});

describe('official timing plan proof v2', () => {
  it('independently reconstructs branches and binds every artifact hash', async () => {
    const context = await pipelineFor(EVENT_MEAN_QUESTION);
    const proof = proveOfficialTimingPlan(context);
    expect(proof.version).toBe(OFFICIAL_TIMING_PLAN_PROOF_VERSION);
    expect(proof.question_sha256).toBe(context.question.question_sha256);
    expect(proof.catalog_sha256).toBe(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256);
    expect(proof.plan_sha256).toBe(context.plan.answer_plan_hash);
    expect(proof.planned_f1ql_sha256).toBe(context.plan.planned_f1ql_hash);
    expect(proof.planned_core_sha256).toBe(context.pipeline.planned_core_hash);
    expect(proof.compiled_statement_sha256).toBe(context.pipeline.compiled.compiled_sha256);
    expect(proof.coverage_query_id).toBe('official_event_coverage_v1');
    expect(proof.coverage_witness_sha256).toBe(context.plan.coverage_witness_hash);
    expect(proof.branch_binding_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.proof_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyOfficialTimingProof(proof, context)).toBe(proof);
  });

  it('proves the window-median plan with the window parameters', async () => {
    const context = await pipelineFor(WINDOW_MEDIAN_QUESTION);
    const proof = proveOfficialTimingPlan(context);
    expect(proof.coverage_query_id).toBe('official_window_coverage_v1');
    expect(context.pipeline.compiled.parameters.slice(5)).toEqual([10, 20]);
    expect(verifyOfficialTimingProof(proof, context)).toBe(proof);
  });

  it('rejects tampered parameters, branches, and bindings', async () => {
    const context = await pipelineFor(EVENT_MEAN_QUESTION);
    const wrongDriver = await pipelineFor(
      'Who was faster between Fernando Alonso and Max Verstappen at the 2022 Belgian Grand Prix?'
    );
    expect(() => proveOfficialTimingPlan({ ...context, plan: wrongDriver.plan }))
      .toThrowError(OfficialTimingProofError);
    expect(() => proveOfficialTimingPlan({ ...context, pipeline: wrongDriver.pipeline }))
      .toThrowError(OfficialTimingProofError);
    expect(() => verifyOfficialTimingProof(structuredClone(proveOfficialTimingPlan(context)), context))
      .toThrowError(expect.objectContaining({ reason: 'proof_provenance_invalid' }));
    const tamperedParameters = structuredClone(context.pipeline);
    (tamperedParameters.compiled as { parameters: unknown[] }).parameters = [2022, 14, 'R', 'fernando-alonso', 'max-verstappen'];
    expect(() => proveOfficialTimingPlan({ ...context, pipeline: tamperedParameters }))
      .toThrowError(expect.objectContaining({ reason: 'proof_provenance_invalid' }));
  });

  it('rejects a plan proven against a different question with the same drivers', async () => {
    const contextA = await pipelineFor(EVENT_MEAN_QUESTION);
    const contextB = await pipelineFor(
      'Compare Max Verstappen and Fernando Alonso by official mean race lap time at the 2022 Belgian Grand Prix'
    );
    expect(contextA.question.question_sha256).not.toBe(contextB.question.question_sha256);
    expect(() => proveOfficialTimingPlan({
      question: contextB.question,
      evidence: contextB.evidence,
      resolution: contextB.resolution,
      plan: contextA.plan,
      pipeline: contextA.pipeline
    })).toThrowError(expect.objectContaining({ reason: 'binding_mismatch' }));
  });

  it('fails closed when the coverage witness is rebound', async () => {
    const context = await pipelineFor(EVENT_MEAN_QUESTION);
    const tamperedPlan = structuredClone(context.plan) as any;
    tamperedPlan.coverage_witness_hash = '0'.repeat(64);
    expect(() => proveOfficialTimingPlan({ ...context, plan: tamperedPlan }))
      .toThrowError(expect.objectContaining({ reason: 'proof_provenance_invalid' }));
  });
});
