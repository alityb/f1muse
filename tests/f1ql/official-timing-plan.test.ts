import { describe, expect, it } from 'vitest';
import { parseOfficialTimingQuestion, OfficialTimingQuestionMatch } from '../../src/f1ql/official-timing-question';
import { enumerateOfficialTimingEvidence } from '../../src/f1ql/official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  OfficialTimingResolution,
  OfficialTimingResolutionDependencies
} from '../../src/f1ql/official-timing-resolution';
import {
  costOfficialTimingPlan,
  OFFICIAL_TIMING_PLANNED_COST_VERSION,
  OFFICIAL_TIMING_PLANNED_F1QL_DIALECT,
  OFFICIAL_TIMING_PLANNED_F1QL_VERSION,
  OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION,
  OFFICIAL_TIMING_PLANNER_VERSION,
  OfficialTimingPlannerError,
  planOfficialTimingAnswer,
  verifyOfficialTimingPlan
} from '../../src/f1ql/official-timing-plan';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const DRIVERS: Readonly<Record<string, string>> = {
  'Max Verstappen': 'max-verstappen',
  'Fernando Alonso': 'fernando-alonso'
};
const ELIGIBLE_COVERAGE = {
  type: 'eligible',
  source_id: 'official_race_lap_timing',
  coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[0].statement_sha256,
  query_calls: 1,
  driver_coverage: [
    { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 40, excluded_deleted_laps: 2, excluded_pit_marker_laps: 2 },
    { driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 41, excluded_deleted_laps: 1, excluded_pit_marker_laps: 2 }
  ]
} as const;

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
      ...structuredClone(ELIGIBLE_COVERAGE),
      metric,
      coverage_query_id: metric === 'official_non_deleted_non_pit_event_mean_v1'
        ? 'official_event_coverage_v1'
        : 'official_window_coverage_v1',
      coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[
        metric === 'official_non_deleted_non_pit_event_mean_v1' ? 0 : 1
      ].statement_sha256
    }) as never
  };
}

async function planFor(questionText: string) {
  const question = matched(questionText);
  const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
  const metric = evidence.candidates[0].metric_id;
  const resolution = await collectOfficialTimingResolution(question, evidence, dependenciesFor(metric));
  return { question, evidence, resolution, plan: planOfficialTimingAnswer({ question, evidence, resolution }) };
}

describe('official timing planner v3 and planned F1QL v3', () => {
  it('plans the event-mean comparison with exact work accounting', async () => {
    const { plan } = await planFor(EVENT_MEAN_QUESTION);
    expect(plan.kind).toBe('official_timing_plan');
    expect(plan.planner_version).toBe(OFFICIAL_TIMING_PLANNER_VERSION);
    expect(plan.planner_version).toBe('semantic-planner-v3');
    expect(plan.work_model_version).toBe(OFFICIAL_TIMING_PLAN_WORK_MODEL_VERSION);
    expect(plan.cost_version).toBe(OFFICIAL_TIMING_PLANNED_COST_VERSION);
    expect(plan.metric_id).toBe('official_non_deleted_non_pit_event_mean_v1');
    expect(plan.topology).toBe('same_source_scalar_comparison');
    expect(plan.drivers).toEqual([
      { branch: 'driver_a', driver_id: 'max-verstappen' },
      { branch: 'driver_b', driver_id: 'fernando-alonso' }
    ]);
    expect(plan.window).toBeNull();
    expect(plan.work).toEqual({
      model: 'semantic-plan-work-v2',
      sources: 1, source_scans: 2, joins: 0, comparisons: 1, compositions: 0,
      requested_rows: 1, operator_depth: 7, resolver_reads: 3, coverage_reads: 1
    });
    expect(plan.integrity_checks).toEqual(
      WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies[0].integrity_checks
    );
    expect(plan.answer_plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.planned_f1ql_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('materializes the closed planned F1QL v3 IR with aggregate-local exclusions', async () => {
    const { plan } = await planFor(EVENT_MEAN_QUESTION);
    const program = plan.planned_f1ql;
    expect(program.version).toBe(OFFICIAL_TIMING_PLANNED_F1QL_VERSION);
    expect(program.dialect).toBe(OFFICIAL_TIMING_PLANNED_F1QL_DIALECT);
    expect(program.catalog_hash).toBe(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256);
    expect(program.root).toMatchObject({ op: 'limit', count: 1 });
    const sort = program.root.input;
    expect(sort).toMatchObject({ op: 'sort', keys: [{ output_id: 'metric_id', direction: 'asc', nulls: 'last' }] });
    const project = sort.input;
    expect(project.op).toBe('project');
    expect(project.outputs.map(output => output.as))
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas[0].field_ids);
    const compare = project.input;
    expect(compare).toMatchObject({
      op: 'compare', relation: 'lower', delta: 'absolute', winner_on_equal: null, decimal_scale: 4
    });
    for (const [aggregate, branch, driverId] of [
      [compare.left, 'driver_a', 'max-verstappen'],
      [compare.right, 'driver_b', 'fernando-alonso']
    ] as const) {
      expect(aggregate.branch).toBe(branch);
      expect(aggregate.group_by).toEqual([]);
      expect(aggregate.measures[0]).toMatchObject({
        concept: 'lap_time_seconds',
        function: 'arithmetic_mean_integer_milliseconds',
        as: `${branch}_metric`
      });
      expect(aggregate.measures[0].exclude_predicates).toEqual([
        { concept: 'official_deleted_lap', operator: 'eq', value: false },
        { concept: 'official_pit_marker', operator: 'eq', value: false }
      ]);
      const filter = aggregate.input;
      expect(filter.input).toEqual({
        op: 'source', source_id: 'official_race_lap_timing', view: 'f1ql.official_race_lap_timing'
      });
      expect(filter.predicates).toEqual([
        { concept: 'season', operator: 'eq', value: 2022 },
        { concept: 'round', operator: 'eq', value: 14 },
        { concept: 'session_type', operator: 'eq', value: 'R' },
        { concept: 'driver_id', operator: 'eq', value: driverId }
      ]);
      // Exclusions stay aggregate-local; the source filter must not contain them.
      expect(filter.predicates.some(predicate => predicate.concept.startsWith('official_'))).toBe(false);
    }
  });

  it('adds the inclusive lap range filter only for window median', async () => {
    const { plan } = await planFor(WINDOW_MEDIAN_QUESTION);
    expect(plan.metric_id).toBe('official_non_deleted_non_pit_window_median_v1');
    expect(plan.window).toEqual({ lap_start: 10, lap_end: 20 });
    const compare = plan.planned_f1ql.root.input.input.input;
    for (const aggregate of [compare.left, compare.right]) {
      expect(aggregate.measures[0].function).toBe('median_integer_milliseconds');
      expect(aggregate.input.predicates.at(-1))
        .toEqual({ concept: 'lap_number', operator: 'range', min: 10, max: 20 });
    }
  });

  it('refuses to plan over a coverage abstention', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const deps = dependenciesFor('official_non_deleted_non_pit_event_mean_v1');
    deps.coverage_reader = async () => ({
      type: 'abstain', reason: 'source_integrity_failed', stage: 'official_timing_integrity', query_calls: 1
    }) as never;
    const resolution = await collectOfficialTimingResolution(question, evidence, deps);
    expect(resolution.type).toBe('abstained');
    expect(() => planOfficialTimingAnswer({ question, evidence, resolution }))
      .toThrowError(expect.objectContaining({ reason: 'coverage_not_eligible' }));
  });

  it('rejects foreign plans and stale resolutions', async () => {
    const { plan, question, evidence } = await planFor(EVENT_MEAN_QUESTION);
    expect(verifyOfficialTimingPlan(plan)).toBe(plan);
    expect(() => verifyOfficialTimingPlan(structuredClone(plan)))
      .toThrowError(OfficialTimingPlannerError);
    const stale = structuredClone(plan) as any;
    stale.work.source_scans = 3;
    expect(() => costOfficialTimingPlan(stale)).toThrowError(expect.objectContaining({ reason: 'work_mismatch' }));
    expect(question.question_sha256).toBe(plan.question_sha256);
    expect(evidence.catalog_hash).toBe(plan.catalog_hash);
  });

  it('cost accounting rejects unaccounted operators and cross-source plans', async () => {
    const { plan } = await planFor(EVENT_MEAN_QUESTION);
    const withJoin = structuredClone(plan) as any;
    withJoin.planned_f1ql.root.input.input.input.left.input.op = 'join';
    expect(() => costOfficialTimingPlan(withJoin))
      .toThrowError(expect.objectContaining({ reason: 'planned_program_invalid' }));
    const tampered = structuredClone(plan) as any;
    tampered.planned_f1ql.root.input.input.input.left.input.input.source_id = 'event_classification';
    expect(() => costOfficialTimingPlan(tampered)).toThrow();
  });

  it('cost gate rejects every tampered IR invariant the builder seals', async () => {
    const { plan } = await planFor(EVENT_MEAN_QUESTION);
    const comparePath = (draft: any) => draft.planned_f1ql.root.input.input.input;
    const mutations: Array<(draft: any) => void> = [
      draft => { comparePath(draft).left.input.predicates.push({ concept: 'official_pit_marker', operator: 'eq', value: 0 }); },
      draft => { comparePath(draft).left.input.predicates[0].value = 2023; },
      draft => { comparePath(draft).left.measures[0].function = 'median_integer_milliseconds'; },
      draft => { comparePath(draft).left.input.predicates.push({ concept: 'lap_number', operator: 'range', min: 1, max: 5 }); },
      draft => { comparePath(draft).left.input.predicates.reverse(); },
      draft => { draft.planned_f1ql.root.input.input.outputs[0].as = 'foreign_field'; },
      draft => { draft.planned_f1ql.root.input.input.outputs.pop(); },
      draft => { draft.work.resolver_reads = 99; },
      draft => { draft.work.model = 'semantic-plan-work-v1'; }
    ];
    for (const mutate of mutations) {
      const draft = structuredClone(plan) as any;
      mutate(draft);
      expect(() => costOfficialTimingPlan(draft)).toThrow();
    }
    const medianPlan = (await planFor(WINDOW_MEDIAN_QUESTION)).plan;
    const missingWindow = structuredClone(medianPlan) as any;
    for (const side of ['left', 'right']) {
      missingWindow.planned_f1ql.root.input.input.input[side].input.predicates =
        missingWindow.planned_f1ql.root.input.input.input[side].input.predicates
          .filter((predicate: any) => predicate.concept !== 'lap_number');
    }
    expect(() => costOfficialTimingPlan(missingWindow)).toThrow();
  });

  it('is deterministic across repeated planning of the same question', async () => {
    const first = await planFor(EVENT_MEAN_QUESTION);
    const second = await planFor(EVENT_MEAN_QUESTION);
    expect(first.plan.answer_plan_hash).toBe(second.plan.answer_plan_hash);
    expect(first.plan.planned_f1ql_hash).toBe(second.plan.planned_f1ql_hash);
    expect(first.plan).toEqual(second.plan);
  });

  it('produces distinct plans for distinct driver pairs and windows', async () => {
    const a = await planFor(EVENT_MEAN_QUESTION);
    const b = await planFor('Who was faster between Fernando Alonso and Max Verstappen at the 2022 Belgian Grand Prix?');
    const c = await planFor(WINDOW_MEDIAN_QUESTION);
    expect(a.plan.answer_plan_hash).not.toBe(b.plan.answer_plan_hash);
    expect(a.plan.answer_plan_hash).not.toBe(c.plan.answer_plan_hash);
    expect(b.plan.drivers[0].driver_id).toBe('fernando-alonso');
  });
});
