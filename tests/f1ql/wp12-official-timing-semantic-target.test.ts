import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { SEMANTIC_CAPABILITY_PROFILE_VERSION, SEMANTIC_CAPABILITY_REGISTRY_HASH, SEMANTIC_CAPABILITY_PROFILES } from '../../src/f1ql/semantic-capability-registry';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';
import { SEMANTIC_RESULT_FORMAT_VERSION } from '../../src/f1ql/semantic-result-format';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import {
  parseWP12OfficialTimingSemanticTarget,
  WP12_OFFICIAL_TIMING_CAPABILITY_PROFILE_TARGET,
  WP12_OFFICIAL_TIMING_CAPABILITY_REGISTRY_TARGET,
  WP12_OFFICIAL_TIMING_PLANNED_COMPILER_TARGET,
  WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES,
  WP12_OFFICIAL_TIMING_SEMANTIC_TARGET,
  WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-semantic-target';

function cloneTarget(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET);
}

describe('WP12 detached official timing semantic target', () => {
  it('binds every requested target component to the activation versions', () => {
    const expected = {
      semantic_query: 3,
      semantic_evidence: 3,
      resolution_evidence: 'semantic-resolution-v2',
      planner: 'semantic-planner-v3',
      plan_work_model: 'semantic-plan-work-v2',
      planned_f1ql: 3,
      planned_cost: 'planned-cost-v2',
      planned_pipeline: 'planned-pipeline-v2',
      planned_compiler: 'planned-compiler-v3',
      plan_execution_result: 'semantic-plan-execution-result-v3',
      semantic_plan_proof: 'semantic-plan-proof-v2',
      capability_profile: 34,
      capability_registry: 34,
      capability_authorization: 'semantic-capability-authorization-v34',
      result_formatter: 'semantic-result-format-v32'
    };
    expect(Object.fromEntries(Object.entries(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components)
      .map(([name, target]) => [name, target.version.target]))).toEqual(expected);
    expect(Object.entries(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components)
      .every(([name, target]) => target.version.component === name)).toBe(true);
    expect(Object.values(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components)
      .every(target => target.implementation_status === 'contract_expectations_only_not_runtime_implementation'))
      .toBe(true);
  });

  it('permits only the two named operations and no generic lap aggregation', () => {
    const query: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.semantic_query.contract;
    expect(query.operations.map((operation: any) => operation.metric_id)).toEqual(
      WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics.map(metric => metric.metric_id)
    );
    expect(query.generic_aggregations_allowed).toEqual([]);
    expect(query.operations.find((operation: any) => operation.metric_id.endsWith('event_mean_v1')).lap_range)
      .toBe('absent');
    expect(query.operations.find((operation: any) => operation.metric_id.endsWith('window_median_v1')).lap_range)
      .toBe('inclusive_1_to_50');
    expect(query.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric_id: 'official_non_deleted_non_pit_event_mean_v1',
        complete_classified_event_required: true, complete_requested_window_required: false,
        expected_lap_sequence: 'one_through_classified_laps', minimum_eligible_laps_per_driver: 2,
        completed_lap_counts_may_differ: true, comparison: 'lower_is_faster'
      }),
      expect.objectContaining({
        metric_id: 'official_non_deleted_non_pit_window_median_v1',
        complete_classified_event_required: false, complete_requested_window_required: true,
        maximum_inclusive_window_laps: 50, minimum_eligible_laps_per_driver: 2,
        completed_lap_counts_may_differ: false, comparison: 'lower_is_faster'
      })
    ]));
  });

  it('requires eligible coverage before planning without collapsing integrity into coverage', () => {
    const resolution: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.resolution_evidence.contract;
    expect(resolution.coverage_witness).toMatchObject({
      required_type: 'eligible',
      timing: 'before_planning_and_result_execution',
      reader_version: 'official-timing-coverage-v1',
      query_calls: 1,
      integrity_failure_reason: 'source_integrity_failed',
      integrity_failure_is_coverage: false
    });
    expect(resolution.relationships.map((relationship: any) => relationship.id)).toEqual([
      'official_timing_driver_resolution', 'official_timing_event_resolution'
    ]);
    expect(resolution.coverage_witness.exact_query_contracts)
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries);
  });

  it('models one source, two scans, zero physical joins, and one comparison', () => {
    const planner: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.planner.contract;
    expect(planner.physical_joins).toBe(0);
    for (const topology of planner.topologies) {
      expect(topology).toMatchObject({
        id: 'same_source_scalar_comparison',
        source_id: 'official_race_lap_timing',
        relationship_id: 'official_timing_shared_event',
        branch_ids: ['driver_a', 'driver_b'],
        pre_eligibility_predicates: [],
        work: { sources: 1, source_scans: 2, joins: 0, comparisons: 1, compositions: 0, requested_rows: 1 }
      });
    }
  });

  it('declares named-aggregate compiler expectations without a generic mean or median grant', () => {
    const planned: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.planned_f1ql.contract;
    const compiler: any = WP12_OFFICIAL_TIMING_PLANNED_COMPILER_TARGET.contract;
    expect(planned.exclusions_are_aggregate_local_not_source_filters).toBe(true);
    expect(planned.named_metric_aggregates_only).toEqual([
      { metric_id: 'official_non_deleted_non_pit_event_mean_v1', aggregation: 'arithmetic_mean_integer_milliseconds' },
      { metric_id: 'official_non_deleted_non_pit_window_median_v1', aggregation: 'median_integer_milliseconds' }
    ]);
    expect(compiler).toMatchObject({
      target_relation: 'f1ql.official_race_lap_timing',
      statement_class: 'one_read_only_parameterized_select',
      compiler_imports_executor: false,
      compiler_executes_statement: false,
      implementation_evidence: null
    });
    expect(compiler.operations.every((operation: any) => operation.required_compiled_integrity_checks.length === 9))
      .toBe(true);
  });

  it('defines exactly two complete capability interactions without generic grants', () => {
    const profile: any = WP12_OFFICIAL_TIMING_CAPABILITY_PROFILE_TARGET.contract;
    expect(profile).toMatchObject({
      id: 'semantic_official_timing_comparison_v1',
      source_sets: [['official_race_lap_timing']],
      relationship_ids: ['official_timing_shared_event'],
      topology: ['same_source_scalar_comparison'],
      generic_average_or_median_allowed: false,
      coverage_witness_required: true,
      principal_classes: ['internal', 'internal_canary', 'public'],
      canary_stages: [100],
      result_collection: { version: 'semantic-limit-plus-one-v1', completeness_probe_rows: 0 }
    });
    expect(profile.complete_interactions).toHaveLength(2);
    expect(profile.operators).toEqual(['aggregate', 'compare', 'filter', 'limit', 'project', 'sort', 'source']);
    expect(profile.aggregate_functions).toEqual([
      'arithmetic_mean_integer_milliseconds', 'median_integer_milliseconds'
    ]);
    expect(profile.dimension_ids.every((id: string) => id.startsWith('official_race_lap_timing.'))).toBe(true);
    expect(profile.measure_ids).toEqual(['official_race_lap_timing.lap_time_seconds']);
    expect(profile.interaction_descriptor_version).toBe('semantic-capability-interaction-v34');
    expect(profile.complete_interactions.every((interaction: any) => interaction.predicate_bindings
      .every((binding: string) => binding.startsWith('official_race_lap_timing.')))).toBe(true);
    expect((WP12_OFFICIAL_TIMING_CAPABILITY_REGISTRY_TARGET.contract as any)).toMatchObject({
      version_source: 'capability_profile_transition',
      independent_registry_version_in_activation_bundle: false,
      construction: 'append_exact_predecessor_profiles_then_official_timing_profile',
      append_only: true
    });
  });

  it('binds proof and authorization to coverage, branch, output, database, and principal hashes', () => {
    const proof: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.semantic_plan_proof.contract;
    const authorization: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.capability_authorization.contract;
    expect(proof.required_hash_bindings).toEqual(expect.arrayContaining([
      'branch_binding', 'coverage_query', 'coverage_witness', 'metric_contract', 'output_schema'
    ]));
    expect(authorization.required_bindings).toEqual(expect.arrayContaining([
      'coverage_reader_version', 'database_binding', 'principal', 'release'
    ]));
    expect(authorization.full_target_hash_set_required).toBe(true);
  });

  it('pins exact closed field order, arithmetic, integrity omission, and no empty-fact fallback', () => {
    const formatter: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.result_formatter.contract;
    expect(formatter.output_schemas.map((output: any) => ({
      metric_id: output.metric_id, field_ids: output.field_ids, exact_decimal_fields: output.exact_decimal_fields,
      decimal_representation: output.decimal_representation, internal_only_fields: output.internal_only_fields,
      required_caveats: output.required_caveats
    }))).toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas.map(output => ({
      metric_id: output.metric_id, field_ids: output.field_ids, exact_decimal_fields: output.exact_decimal_fields,
      decimal_representation: output.decimal_representation, internal_only_fields: output.internal_only_fields,
      required_caveats: output.required_caveats
    })));
    expect(formatter.output_schemas.every((output: any) => output.field_contracts.length === output.field_ids.length))
      .toBe(true);
    expect(formatter.output_schemas[0].field_contracts.find((field: any) => field.field_id === 'dataset_sha256'))
      .toMatchObject({ kind: 'sha256', fixed_value: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope.dataset_sha256 });
    expect(formatter).toMatchObject({
      exact_one_dense_plain_row: true,
      has_more_rows: false,
      coverage_count_arithmetic_required: true,
      all_disclosed_counts_equal_ordered_coverage_witness: true,
      request_ordered_distinct_driver_ids_required: true,
      certified_scope_and_provenance_constants_required: true,
      exact_scale_4_decimal_strings_required: true,
      decimal_values_nonnegative: true,
      recompute_absolute_delta_and_winner: true,
      equal_value_winner: null,
      internal_integrity_value: true,
      internal_integrity_publicly_omitted: true,
      missing_rows_are_not_empty_fact: true
    });
  });

  it('requires a verified, bounded, read-only execution result before formatting', () => {
    const execution: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.plan_execution_result.contract;
    const formatter: any = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.result_formatter.contract;
    expect(execution).toMatchObject({
      transaction: 'repeatable_read_read_only', statement_timeout_required: true,
      request_deadline_required: true, rollback_on_failure: true, unsafe_connection_discard_required: true,
      returned_row_limit: 1, observed_row_limit: 1, has_more_rows: false,
      authorization_consumed_once_before_database_acquisition: true, runtime_provenance_required: true,
      implementation_evidence: null
    });
    expect(formatter.execution_result_target_sha256)
      .toBe(WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.plan_execution_result);
  });

  it('is deeply frozen and independently hash-binds every component', () => {
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.planner)).toBe(true);
    expect(Object.keys(WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES).sort()).toEqual(
      Object.keys(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components).sort()
    );
    expect(WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES).toEqual({
      semantic_query: '3b5aa0ea84e1b2397f5768117a85161886ff58a82c5bd6b128686292152f8c0b',
      semantic_evidence: '85cba1dfdf0cf6c7a06b6747a80555f35ed81cc5fb19207beace260d2cd16c96',
      resolution_evidence: 'f0bc43e22d35e7c287dfbb29f7e2d47833818af48c8e6e91390b740f2c8f9682',
      planner: 'c5c07320de8aee64f67806473499df0669412d15d25e9c1cda1f94aa09aa9371',
      plan_work_model: 'f8a73271ea8477c53486dd9192e31df96e8c127a536411a674d06cd620abf0c9',
      planned_f1ql: '0bdddf254626d33410b7bc38b72c726cd522ecc242ba41c1a538db83607a934a',
      planned_cost: '8f8250b268ab26fce4343de9a18f9f9042a4cba5666f8be5d162860de4b30eb4',
      planned_pipeline: '7bf680e12ca4d15b9bc2af47eb4a1819c164904ed13b476b1fa4f213ece084e8',
      planned_compiler: '69742222607fded3658b4f7b179b575c3837a15451e38b200bc64beb11a48765',
      plan_execution_result: '137b4bc25d64f676dcadc2a7b8af464e64359a5fda192a8fbd7117cce2eec498',
      semantic_plan_proof: '65f14e026eca30ee1fafd3fb3bf90cf98b45d571978f906fc7db6e9a9bea201a',
      capability_profile: '2aaf67301dd7f41592229e6f63e533c2c5c52ade5db5f538b2582baf824b4cd9',
      capability_registry: '48e7c9bfb7f5406affffff57b116f275e46f76edcbb3a504303a22fa55b932f8',
      capability_authorization: 'a29948939f671224fc537de5aae2f514bc68f80a39516cf850424e7d31b45f03',
      result_formatter: '7fd07011b34b79961731e6d92d7a16303a6efe9f8c1cebca99995944d4c5f978'
    });
    expect(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256)
      .toBe('1b06103fa99c9556484cbba46c1bf83a9fcfaaba2572eed1e012e391dcf053bc');
    expect(parseWP12OfficialTimingSemanticTarget(cloneTarget())).toEqual(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET);
  });

  it.each([
    ['unknown field', (target: any) => { target.extra = true; }],
    ['query source', (target: any) => { target.components.semantic_query.contract.source_id = 'event_classification'; }],
    ['generic aggregate', (target: any) => { target.components.semantic_query.contract.generic_aggregations_allowed = ['mean']; }],
    ['coverage timing', (target: any) => { target.components.resolution_evidence.contract.coverage_witness.timing = 'after_planning'; }],
    ['topology work', (target: any) => { target.components.planner.contract.topologies[0].work.source_scans = 1; }],
    ['pre-eligibility exclusion', (target: any) => { target.components.planner.contract.topologies[0].pre_eligibility_predicates.push('official_deleted_lap=false'); }],
    ['compiler relation', (target: any) => { target.components.planned_compiler.contract.target_relation = 'f1ql.official_lap_timing'; }],
    ['proof binding', (target: any) => { target.components.semantic_plan_proof.contract.required_hash_bindings.pop(); }],
    ['profile grant', (target: any) => { target.components.capability_profile.contract.generic_average_or_median_allowed = true; }],
    ['formatter field order', (target: any) => { target.components.result_formatter.contract.output_schemas[0].field_ids.reverse(); }],
    ['component hash', (target: any) => { target.component_hashes.planner = '0'.repeat(64); }]
  ])('rejects %s mutation', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingSemanticTarget(target)).toThrow();
  });

  it.each([
    ['undefined alias', (target: any) => { target.components.planner.contract.topologies[0].window_predicate = undefined; }],
    ['non-finite alias', (target: any) => { target.components.planner.contract.physical_joins = Number.NaN; }],
    ['negative-zero alias', (target: any) => { target.components.planner.contract.physical_joins = -0; }],
    ['symbol property', (target: any) => { target[Symbol('hidden')] = true; }],
    ['accessor property', (target: any) => {
      Object.defineProperty(target.components.planner.contract, 'hidden', { enumerable: true, get: () => true });
    }],
    ['array accessor', (target: any) => {
      Object.defineProperty(target.components.planner.contract.topologies, '0', {
        enumerable: true, get: () => WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.planner.contract
      });
    }],
    ['hidden array field', (target: any) => {
      Object.defineProperty(target.components.planner.contract.topologies, 'hidden', {
        enumerable: false, value: true
      });
    }]
  ])('rejects non-canonical %s', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingSemanticTarget(target)).toThrow();
  });

  it('remains detached from active versions, capability profiles, policy, and execution imports', () => {
    expect(SEMANTIC_CATALOG_HASH).toBe('19312969ef88cd85533fbe92d17835c6525ad10c4d6ebe1b34b49fa4c4b3e3f8');
    expect(SEMANTIC_CAPABILITY_PROFILE_VERSION).toBe(33);
    expect(SEMANTIC_CAPABILITY_REGISTRY_HASH).toBe('e0992a92362d2c917970eeed07837a096d259c10130bd67f393b2eebd55599b4');
    expect(SEMANTIC_RESULT_FORMAT_VERSION).toBe('semantic-result-format-v31');
    expect(SEMANTIC_CAPABILITY_PROFILES.some(profile => profile.id === 'semantic_official_timing_comparison_v1' as never)).toBe(false);
    expect(authorizeAnswerProgram({
      version: 1,
      root: {
        op: 'official_event_mean_compare', metric: 'official_non_deleted_non_pit_event_mean_v1',
        season: 2022, round: 14, driver_a_id: 'max-verstappen', driver_b_id: 'fernando-alonso'
      }
    })).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    const source = readFileSync('src/f1ql/wp12-official-timing-semantic-target.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:executor|interpreter|pg|provider|route|semantic-plan-execution|semantic-result-format)/);
    const inboundImports = sourceFiles('src').filter(path =>
      path !== 'src/f1ql/wp12-official-timing-semantic-target.ts' &&
      readFileSync(path, 'utf8').includes('wp12-official-timing-semantic-target'));
    expect(inboundImports).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
