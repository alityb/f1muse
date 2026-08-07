import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
} from './wp12-official-timing-activation-bundle';
import {
  WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256
} from './wp12-official-timing-catalog-target';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const metricSchema = z.enum([
  'official_non_deleted_non_pit_event_mean_v1',
  'official_non_deleted_non_pit_window_median_v1'
]);
const statusSchema = z.literal('detached_inactive_target');

const componentSchema = z.object({
  component: idSchema,
  current: z.union([z.string().min(1), z.number().int().positive()]),
  target: z.union([z.string().min(1), z.number().int().positive()])
}).strict();

const operationSchema = z.object({
  metric_id: metricSchema,
  aggregation: z.enum(['arithmetic_mean_integer_milliseconds', 'median_integer_milliseconds']),
  scope: z.enum(['one_complete_certified_race_event', 'one_certified_race_event_inclusive_lap_window']),
  lap_range: z.enum(['absent', 'inclusive_1_to_50']),
  entity_cardinality: z.literal(2),
  distinct_governed_drivers_required: z.literal(true),
  event_cardinality: z.literal(1),
  comparison: z.literal('lower_is_faster'),
  complete_requested_window_required: z.boolean(),
  complete_classified_event_required: z.boolean(),
  maximum_inclusive_window_laps: z.number().int().positive().nullable(),
  expected_lap_sequence: z.literal('one_through_classified_laps').nullable(),
  minimum_eligible_laps_per_driver: z.literal(2),
  exclusions: z.tuple([z.literal('official_deleted_lap'), z.literal('official_pit_marker')]),
  completed_lap_counts_may_differ: z.boolean(),
  evidence_requirements: z.array(idSchema).min(1),
  prohibited_claims: z.array(idSchema).min(1)
}).strict();

const topologySchema = z.object({
  metric_id: metricSchema,
  id: z.literal('same_source_scalar_comparison'),
  operator_signature: z.literal('limit(sort(project(compare(aggregate(filter(source)),aggregate(filter(source))))))'),
  source_id: z.literal('official_race_lap_timing'),
  relationship_id: z.literal('official_timing_shared_event'),
  branch_ids: z.tuple([z.literal('driver_a'), z.literal('driver_b')]),
  common_predicates: z.array(z.string().min(1)),
  window_predicate: z.string().min(1).nullable(),
  pre_eligibility_predicates: z.tuple([]),
  aggregation: z.enum(['arithmetic_mean_integer_milliseconds', 'median_integer_milliseconds']),
  exclusions: z.tuple([z.literal('official_deleted_lap'), z.literal('official_pit_marker')]),
  comparison: z.object({
    relation: z.literal('lower'), delta: z.literal('absolute'),
    winner_on_equal: z.null(), decimal_scale: z.literal(4)
  }).strict(),
  integrity_checks: z.array(idSchema).min(1),
  work: z.object({
    sources: z.literal(1), source_scans: z.literal(2), joins: z.literal(0),
    comparisons: z.literal(1), compositions: z.literal(0), requested_rows: z.literal(1)
  }).strict()
}).strict();

const outputSchema = z.object({
  metric_id: metricSchema,
  field_ids: z.array(idSchema).min(1),
  exact_decimal_fields: z.array(idSchema).length(3),
  decimal_representation: z.enum([
    'canonical_exact_decimal_string_seconds_scale_4',
    'canonical_rounded_decimal_string_seconds_scale_4_half_away_from_zero'
  ]),
  field_contracts: z.array(z.object({
    field_id: idSchema,
    kind: z.enum([
      'canonical_driver_id', 'fixed_integer', 'fixed_text', 'metric_id', 'nullable_winner_driver_id',
      'safe_nonnegative_integer', 'scale_4_decimal', 'sha256'
    ]),
    nullable: z.boolean(),
    fixed_value: z.union([z.string(), z.number().int()]).nullable()
  }).strict()).min(1),
  internal_only_fields: z.tuple([z.literal('f1ql_integrity_ok')]),
  required_caveats: z.array(idSchema).min(1)
}).strict();

const coverageWitnessSchema = z.object({
  required_type: z.literal('eligible'),
  timing: z.literal('before_planning_and_result_execution'),
  reader_version: z.literal('official-timing-coverage-v1'),
  query_calls: z.literal(1),
  query_id_and_sha256_required: z.literal(true),
  ordered_driver_coverage_required: z.literal(true),
  request_hash_required: z.literal(true),
  semantic_query_hash_required: z.literal(true),
  catalog_hash_required: z.literal(true),
  exact_query_contracts: z.array(z.object({
    id: idSchema,
    metric_id: metricSchema,
    target_relation: z.literal('f1ql.official_race_lap_timing'),
    statement_sha256: sha256Schema,
    statement_timeout_ms: z.literal(2000),
    transaction: z.literal('repeatable_read_read_only'),
    maximum_rows: z.literal(2),
    projected_fields: z.array(idSchema).length(9),
    parameter_order: z.array(idSchema).min(3).max(5)
  }).strict()).length(2),
  integrity_failure_reason: z.literal('source_integrity_failed'),
  integrity_failure_is_coverage: z.literal(false)
}).strict();

const componentTargetSchema = z.object({
  status: statusSchema,
  implementation_status: z.literal('contract_expectations_only_not_runtime_implementation'),
  version: componentSchema,
  contract: z.unknown()
}).strict();

const targetSchema = z.object({
  version: z.literal(1),
  status: statusSchema,
  implementation_status: z.literal('contract_expectations_only_not_runtime_implementation'),
  activation_bundle_sha256: sha256Schema,
  catalog_sha256: sha256Schema,
  database_binding_sha256: sha256Schema,
  principal_audit_sha256: sha256Schema,
  components: z.object({
    semantic_query: componentTargetSchema,
    semantic_evidence: componentTargetSchema,
    resolution_evidence: componentTargetSchema,
    planner: componentTargetSchema,
    plan_work_model: componentTargetSchema,
    planned_f1ql: componentTargetSchema,
    planned_cost: componentTargetSchema,
    planned_pipeline: componentTargetSchema,
    planned_compiler: componentTargetSchema,
    plan_execution_result: componentTargetSchema,
    semantic_plan_proof: componentTargetSchema,
    capability_profile: componentTargetSchema,
    capability_registry: componentTargetSchema,
    capability_authorization: componentTargetSchema,
    result_formatter: componentTargetSchema
  }).strict(),
  component_hashes: z.record(z.string(), sha256Schema),
  non_execution: z.object({
    active_runtime_imports_target: z.literal(false),
    database_imports: z.literal(false),
    executor_imports: z.literal(false),
    provider_imports: z.literal(false),
    result_execution: z.literal(false),
    translated_execution: z.literal(false)
  }).strict()
}).strict();

function transition(component: string) {
  const item = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions.find(candidate => candidate.component === component);
  if (!item || item.transition !== 'atomic') {
    throw new Error(`WP12 semantic target lacks atomic version transition ${component}`);
  }
  return { component: item.component, current: item.current, target: item.target };
}

function component(componentId: string, contract: unknown) {
  return deepFreeze(componentTargetSchema.parse({
    status: 'detached_inactive_target',
    implementation_status: 'contract_expectations_only_not_runtime_implementation',
    version: transition(componentId),
    contract
  }));
}

const operations = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics.map(metric => operationSchema.parse({
  metric_id: metric.metric_id,
  aggregation: metric.aggregation,
  scope: metric.scope,
  lap_range: metric.maximum_inclusive_window_laps === null ? 'absent' : 'inclusive_1_to_50',
  entity_cardinality: 2,
  distinct_governed_drivers_required: true,
  event_cardinality: 1,
  comparison: metric.comparison,
  complete_requested_window_required: metric.complete_requested_window_required,
  complete_classified_event_required: metric.complete_classified_event_required,
  maximum_inclusive_window_laps: metric.maximum_inclusive_window_laps,
  expected_lap_sequence: metric.expected_lap_sequence,
  minimum_eligible_laps_per_driver: metric.minimum_eligible_laps_per_driver,
  exclusions: metric.exclusions,
  completed_lap_counts_may_differ: metric.completed_lap_counts_may_differ,
  evidence_requirements: [
    'exact_operation_span', 'exact_question_hash', 'one_event_literal_span', 'one_season_literal_span',
    'question_ordered_driver_spans',
    ...(metric.maximum_inclusive_window_laps === null ? [] : ['inclusive_lap_range_spans'])
  ].sort(compareText),
  prohibited_claims: [...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.prohibited_claims]
}));

const topologies = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies.map(topology => {
  const metric = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics.find(item => item.metric_id === topology.metric_id)!;
  return topologySchema.parse({
    ...topology,
    relationship_id: 'official_timing_shared_event',
    aggregation: metric.aggregation,
    exclusions: metric.exclusions
  });
});

function outputFieldContract(fieldId: string, metricId: string) {
  const scope = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
  const fixedValues: Readonly<Record<string, string | number>> = {
    metric_id: metricId,
    season: scope.season,
    round: scope.round,
    session_type: scope.session_type,
    event_name: scope.event_name,
    dataset_sha256: scope.dataset_sha256,
    source_manifest_sha256: scope.source_manifest_sha256,
    identity_map_sha256: scope.identity_map_sha256,
    fact_fingerprint: scope.fact_fingerprint
  };
  const fixedValue = fixedValues[fieldId] ?? null;
  let kind: 'canonical_driver_id' | 'fixed_integer' | 'fixed_text' | 'metric_id' |
    'nullable_winner_driver_id' | 'safe_nonnegative_integer' | 'scale_4_decimal' | 'sha256';
  if (fieldId === 'driver_a_id' || fieldId === 'driver_b_id') {kind = 'canonical_driver_id';}
  else if (fieldId === 'winner_driver_id') {kind = 'nullable_winner_driver_id';}
  else if (fieldId === 'metric_id') {kind = 'metric_id';}
  else if (fieldId.endsWith('_sha256') || fieldId.endsWith('_fingerprint')) {kind = 'sha256';}
  else if (fieldId.endsWith('_seconds')) {kind = 'scale_4_decimal';}
  else if (typeof fixedValue === 'number') {kind = 'fixed_integer';}
  else if (typeof fixedValue === 'string') {kind = 'fixed_text';}
  else {kind = 'safe_nonnegative_integer';}
  return { field_id: fieldId, kind, nullable: fieldId === 'winner_driver_id', fixed_value: fixedValue };
}

const outputs = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas.map(output => outputSchema.parse({
  metric_id: output.metric_id,
  field_ids: output.field_ids,
  exact_decimal_fields: output.exact_decimal_fields,
  decimal_representation: output.decimal_representation,
  field_contracts: output.field_ids.map(fieldId => outputFieldContract(fieldId, output.metric_id)),
  internal_only_fields: output.internal_only_fields,
  required_caveats: output.required_caveats
}));

const coverageWitness = coverageWitnessSchema.parse({
  required_type: 'eligible',
  timing: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.timing,
  reader_version: transition('official_timing_coverage_reader').target,
  query_calls: 1,
  query_id_and_sha256_required: true,
  ordered_driver_coverage_required: true,
  request_hash_required: true,
  semantic_query_hash_required: true,
  catalog_hash_required: true,
  exact_query_contracts: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries,
  integrity_failure_reason: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.integrity_failure_reason,
  integrity_failure_is_coverage: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.integrity_failures_are_coverage
});

export const WP12_OFFICIAL_TIMING_SEMANTIC_QUERY_TARGET = component('semantic_query', {
  source_id: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.source_id,
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  candidate_proposal_version: transition('candidate_proposal').target,
  operations,
  generic_aggregations_allowed: [],
  maximum_candidates: 2,
  unknown_or_extra_semantics: 'reject'
});

export const WP12_OFFICIAL_TIMING_SEMANTIC_EVIDENCE_TARGET = component('semantic_evidence', {
  query_target_sha256: hash(WP12_OFFICIAL_TIMING_SEMANTIC_QUERY_TARGET),
  exact_unicode_code_point_spans: true,
  independent_enumeration_required: true,
  exactly_one_admitted_candidate: true,
  runtime_provenance_required: true,
  bound_hashes: ['candidate_set', 'catalog', 'evidence', 'question', 'semantic_query']
});

export const WP12_OFFICIAL_TIMING_RESOLUTION_TARGET = component('resolution_evidence', {
  evidence_target_sha256: hash(WP12_OFFICIAL_TIMING_SEMANTIC_EVIDENCE_TARGET),
  relationships: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.relationships
    .filter(relationship => relationship.join_stage === 'resolution'),
  exact_driver_count: 2,
  distinct_driver_ids: true,
  exact_event: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope.event_name,
  exact_season: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope.season,
  exact_round: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope.round,
  exact_session_type: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope.session_type,
  coverage_witness: coverageWitness
});

export const WP12_OFFICIAL_TIMING_PLANNER_TARGET = component('planner', {
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  resolution_target_sha256: hash(WP12_OFFICIAL_TIMING_RESOLUTION_TARGET),
  topologies,
  coverage_before_plan: true,
  physical_joins: 0,
  output_schemas: outputs.map(output => ({ metric_id: output.metric_id, field_ids: output.field_ids }))
});

export const WP12_OFFICIAL_TIMING_PLAN_WORK_MODEL_TARGET = component('plan_work_model', {
  planner_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNER_TARGET),
  source_identity_counted_once: true,
  source_scans_counted_independently: true,
  exact_work: topologies.map(topology => ({ metric_id: topology.metric_id, ...topology.work }))
});

export const WP12_OFFICIAL_TIMING_PLANNED_F1QL_TARGET = component('planned_f1ql', {
  dialect: 'planned_f1ql_v3',
  planner_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNER_TARGET),
  source_id: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.source_id,
  root_operator_signature: topologies[0]!.operator_signature,
  named_metric_aggregates_only: operations.map(operation => ({
    metric_id: operation.metric_id,
    aggregation: operation.aggregation
  })),
  branch_filters: ['driver_id', 'round', 'season', 'session_type'],
  window_filter_metric: 'official_non_deleted_non_pit_window_median_v1',
  exclusions_are_aggregate_local_not_source_filters: true,
  public_output_limit: 1,
  internal_integrity_field: 'f1ql_integrity_ok'
});

export const WP12_OFFICIAL_TIMING_PLANNED_COST_TARGET = component('planned_cost', {
  work_model_target_sha256: hash(WP12_OFFICIAL_TIMING_PLAN_WORK_MODEL_TARGET),
  planned_f1ql_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_F1QL_TARGET),
  exact_work: topologies.map(topology => ({ metric_id: topology.metric_id, ...topology.work })),
  reject_unaccounted_operator: true
});

export const WP12_OFFICIAL_TIMING_PLANNED_PIPELINE_TARGET = component('planned_pipeline', {
  planned_f1ql_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_F1QL_TARGET),
  planned_cost_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_COST_TARGET),
  ordered_gates: [
    'parse', 'catalog_bind', 'coverage_witness', 'cost', 'participation', 'lower',
    'core_validate', 'compile', 'hash_bind'
  ],
  execution_allowed: false
});

export const WP12_OFFICIAL_TIMING_PLANNED_COMPILER_TARGET = component('planned_compiler', {
  pipeline_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_PIPELINE_TARGET),
  target_relation: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.view,
  statement_class: 'one_read_only_parameterized_select',
  operations: operations.map(operation => ({
    ...operation,
    parameter_order: operation.lap_range === 'absent'
      ? ['season', 'round', 'session_type', 'driver_a_id', 'driver_b_id']
      : ['season', 'round', 'session_type', 'driver_a_id', 'driver_b_id', 'lap_start', 'lap_end'],
    output_schema: outputs.find(output => output.metric_id === operation.metric_id),
    required_compiled_integrity_checks: topologies.find(topology => topology.metric_id === operation.metric_id)!
      .integrity_checks
  })),
  arithmetic: {
    source_precision: 'exact_integer_milliseconds',
    event_mean_rounding: 'scale_4_half_away_from_zero',
    window_median_rounding: 'exact_scale_4',
    delta: 'absolute',
    lower_wins: true,
    equal_winner: null
  },
  implementation_evidence: null,
  compiler_imports_executor: false,
  compiler_executes_statement: false
});

export const WP12_OFFICIAL_TIMING_PLAN_PROOF_TARGET = component('semantic_plan_proof', {
  planner_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNER_TARGET),
  pipeline_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_PIPELINE_TARGET),
  compiler_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_COMPILER_TARGET),
  independently_reconstructs_branches: true,
  runtime_provenance_required: true,
  required_hash_bindings: [
    'branch_binding', 'catalog', 'compiled_statement', 'coverage_query', 'coverage_witness',
    'metric_contract', 'output_schema', 'plan', 'planned_core', 'planned_f1ql', 'semantic_query'
  ],
  topologies
});

export const WP12_OFFICIAL_TIMING_CAPABILITY_PROFILE_TARGET = component('capability_profile', {
  id: 'semantic_official_timing_comparison_v1',
  version: transition('capability_profile').target,
  catalog_hash: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  topology: ['same_source_scalar_comparison'],
  source_sets: [[WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.source_id]],
  relationship_ids: ['official_timing_shared_event'],
  operator_signatures: [topologies[0]!.operator_signature],
  interaction_descriptor_version: 'semantic-capability-interaction-v34',
  operators: ['aggregate', 'compare', 'filter', 'limit', 'project', 'sort', 'source'],
  filter_operators: ['eq', 'range'],
  aggregate_functions: operations.map(operation => operation.aggregation).sort(compareText),
  output_kinds: ['certified_metric_result'],
  sort_directions: ['asc'],
  null_orders: ['last'],
  dimension_ids: [
    'official_race_lap_timing.driver_id', 'official_race_lap_timing.lap_number',
    'official_race_lap_timing.round', 'official_race_lap_timing.season',
    'official_race_lap_timing.session_type'
  ],
  measure_ids: ['official_race_lap_timing.lap_time_seconds'],
  complete_interactions: topologies.map(topology => ({
    metric_id: topology.metric_id,
    entity_count: { min: 2, max: 2 },
    season_values: [2022],
    event_count: 1,
    predicate_bindings: [
      'official_race_lap_timing.driver_id:eq', 'official_race_lap_timing.driver_id:eq',
      'official_race_lap_timing.round:eq', 'official_race_lap_timing.round:eq',
      'official_race_lap_timing.season:eq', 'official_race_lap_timing.season:eq',
      'official_race_lap_timing.session_type:eq', 'official_race_lap_timing.session_type:eq',
      ...(topology.window_predicate === null
        ? []
        : ['official_race_lap_timing.lap_number:range', 'official_race_lap_timing.lap_number:range'])
    ].sort(compareText),
    aggregate_bindings: [
      `official_race_lap_timing.lap_time_seconds:${topology.aggregation}->driver_a_metric`,
      `official_race_lap_timing.lap_time_seconds:${topology.aggregation}->driver_b_metric`
    ],
    group_bindings: [],
    output_bindings: outputs.find(output => output.metric_id === topology.metric_id)!.field_ids
      .map(fieldId => `certified_metric_result:${topology.metric_id}.${fieldId}->${fieldId}`),
    sort_bindings: ['metric_id:asc:last'],
    requested_rows: 1,
    integrity_checks: topology.integrity_checks,
    work: topology.work
  })),
  generic_average_or_median_allowed: false,
  coverage_witness_required: true,
  principal_classes: ['internal', 'internal_canary', 'public'],
  canary_stages: [100],
  scope: 'certified_immutable_historical',
  result_collection: { version: 'semantic-limit-plus-one-v1', completeness_probe_rows: 0 },
  limits: {
    sources: 1, source_scans: 2, joins: 0, comparisons: 1, depth: 7, outputs: 24,
    groups: 0, entities: 2, events: 1, seasons: 1, rows: 1, work_units: 10
  }
});

export const WP12_OFFICIAL_TIMING_CAPABILITY_REGISTRY_TARGET = deepFreeze(componentTargetSchema.parse({
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  version: {
    component: 'capability_registry',
    current: transition('capability_profile').current,
    target: transition('capability_profile').target
  },
  contract: {
    version_source: 'capability_profile_transition',
    independent_registry_version_in_activation_bundle: false,
    predecessor_registry_sha256: 'e0992a92362d2c917970eeed07837a096d259c10130bd67f393b2eebd55599b4',
    added_profile_contract_sha256: hash(WP12_OFFICIAL_TIMING_CAPABILITY_PROFILE_TARGET.contract),
    construction: 'append_exact_predecessor_profiles_then_official_timing_profile',
    append_only: true
  }
}));

export const WP12_OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_TARGET = component('capability_authorization', {
  profile_target_sha256: hash(WP12_OFFICIAL_TIMING_CAPABILITY_PROFILE_TARGET),
  registry_target_sha256: hash(WP12_OFFICIAL_TIMING_CAPABILITY_REGISTRY_TARGET),
  proof_target_sha256: hash(WP12_OFFICIAL_TIMING_PLAN_PROOF_TARGET),
  catalog_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  database_binding_target_sha256: WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  principal_target_sha256: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  interaction_descriptor_version: 'semantic-capability-interaction-v34',
  required_bindings: [
    'branch_binding', 'catalog', 'coverage_query', 'coverage_reader_version', 'coverage_witness',
    'database_binding', 'metric_contract', 'output_schema', 'principal', 'proof', 'release',
    'request', 'result_collection'
  ],
  one_time_consumption: true,
  release_attestation_version: transition('release_attestation').target,
  full_target_hash_set_required: true
});

export const WP12_OFFICIAL_TIMING_PLAN_EXECUTION_RESULT_TARGET = component('plan_execution_result', {
  proof_target_sha256: hash(WP12_OFFICIAL_TIMING_PLAN_PROOF_TARGET),
  authorization_target_sha256: hash(WP12_OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_TARGET),
  compiler_target_sha256: hash(WP12_OFFICIAL_TIMING_PLANNED_COMPILER_TARGET),
  result_collection_version: 'semantic-limit-plus-one-v1',
  authorization_consumed_once_before_database_acquisition: true,
  transaction: 'repeatable_read_read_only',
  statement_timeout_required: true,
  request_deadline_required: true,
  rollback_on_failure: true,
  unsafe_connection_discard_required: true,
  returned_row_limit: 1,
  observed_row_limit: 1,
  has_more_rows: false,
  required_hash_bindings: [
    'authorization', 'collection_compiled', 'compiled', 'planned_core', 'planned_f1ql',
    'rows', 'semantic_plan_proof'
  ],
  runtime_provenance_required: true,
  implementation_evidence: null
});

export const WP12_OFFICIAL_TIMING_RESULT_FORMAT_TARGET = component('result_formatter', {
  proof_target_sha256: hash(WP12_OFFICIAL_TIMING_PLAN_PROOF_TARGET),
  authorization_target_sha256: hash(WP12_OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_TARGET),
  execution_result_target_sha256: hash(WP12_OFFICIAL_TIMING_PLAN_EXECUTION_RESULT_TARGET),
  output_schemas: outputs,
  exact_one_dense_plain_row: true,
  has_more_rows: false,
  reject_accessors_symbols_inherited_extra_or_missing_fields: true,
  coverage_count_arithmetic_required: true,
  all_disclosed_counts_equal_ordered_coverage_witness: true,
  request_ordered_distinct_driver_ids_required: true,
  certified_scope_and_provenance_constants_required: true,
  event_completed_counts_equal_coverage_required: true,
  window_requested_count_equals_inclusive_range_required: true,
  minimum_eligible_laps_per_driver: 2,
  exact_scale_4_decimal_strings_required: true,
  decimal_values_nonnegative: true,
  recompute_absolute_delta_and_winner: true,
  equal_value_winner: null,
  internal_integrity_value: true,
  internal_integrity_publicly_omitted: true,
  source_coverage_status: 'sufficient',
  missing_rows_are_not_empty_fact: true,
  compatibility_version: transition('semantic_answer_compatibility').target
});

const components = {
  semantic_query: WP12_OFFICIAL_TIMING_SEMANTIC_QUERY_TARGET,
  semantic_evidence: WP12_OFFICIAL_TIMING_SEMANTIC_EVIDENCE_TARGET,
  resolution_evidence: WP12_OFFICIAL_TIMING_RESOLUTION_TARGET,
  planner: WP12_OFFICIAL_TIMING_PLANNER_TARGET,
  plan_work_model: WP12_OFFICIAL_TIMING_PLAN_WORK_MODEL_TARGET,
  planned_f1ql: WP12_OFFICIAL_TIMING_PLANNED_F1QL_TARGET,
  planned_cost: WP12_OFFICIAL_TIMING_PLANNED_COST_TARGET,
  planned_pipeline: WP12_OFFICIAL_TIMING_PLANNED_PIPELINE_TARGET,
  planned_compiler: WP12_OFFICIAL_TIMING_PLANNED_COMPILER_TARGET,
  plan_execution_result: WP12_OFFICIAL_TIMING_PLAN_EXECUTION_RESULT_TARGET,
  semantic_plan_proof: WP12_OFFICIAL_TIMING_PLAN_PROOF_TARGET,
  capability_profile: WP12_OFFICIAL_TIMING_CAPABILITY_PROFILE_TARGET,
  capability_registry: WP12_OFFICIAL_TIMING_CAPABILITY_REGISTRY_TARGET,
  capability_authorization: WP12_OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_TARGET,
  result_formatter: WP12_OFFICIAL_TIMING_RESULT_FORMAT_TARGET
} as const;

export const WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES = deepFreeze(Object.fromEntries(
  Object.entries(components).map(([name, value]) => [name, hash(value)])
));

const rawTarget = {
  version: 1,
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  database_binding_sha256: WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  principal_audit_sha256: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  components,
  component_hashes: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES,
  non_execution: {
    active_runtime_imports_target: false,
    database_imports: false,
    executor_imports: false,
    provider_imports: false,
    result_execution: false,
    translated_execution: false
  }
} as const;
const canonicalTarget = stableSerialize(rawTarget);

export type WP12OfficialTimingSemanticTarget = z.infer<typeof targetSchema>;

export function parseWP12OfficialTimingSemanticTarget(input: unknown): WP12OfficialTimingSemanticTarget {
  assertCanonicalData(input, 'target');
  const parsed = targetSchema.parse(input);
  for (const [name, value] of Object.entries(parsed.components)) {
    if (value.version.component !== name || parsed.component_hashes[name] !== hash(value)) {
      throw new Error(`FAIL_CLOSED: WP12 semantic component hash differs for ${name}`);
    }
  }
  if (Object.keys(parsed.component_hashes).sort(compareText).join(',') !==
      Object.keys(parsed.components).sort(compareText).join(',') || stableSerialize(parsed) !== canonicalTarget) {
    throw new Error('FAIL_CLOSED: WP12 official timing semantic target differs from the reviewed derivation');
  }
  return deepFreeze(parsed);
}

export const WP12_OFFICIAL_TIMING_SEMANTIC_TARGET = parseWP12OfficialTimingSemanticTarget(rawTarget);
export const WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET);

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  assertCanonicalData(value, 'value');
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalData(value: unknown, path: string): asserts value is null | boolean | number | string | object {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {return;}
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`FAIL_CLOSED: non-canonical number at ${path}`);
    }
    return;
  }
  if (typeof value !== 'object') {throw new Error(`FAIL_CLOSED: non-canonical value at ${path}`);}
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`FAIL_CLOSED: symbol property at ${path}`);
  }
  if (Array.isArray(value)) {
    assertCanonicalArray(value, path);
    return;
  }
  assertCanonicalObject(value, path);
}

function assertCanonicalArray(value: unknown[], path: string): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`FAIL_CLOSED: non-standard array prototype at ${path}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1 || !descriptors.length) {
    throw new Error(`FAIL_CLOSED: sparse or extended array at ${path}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`FAIL_CLOSED: sparse or accessor array at ${path}`);
    }
    assertCanonicalData(descriptor.value, `${path}[${index}]`);
  }
}

function assertCanonicalObject(value: object, path: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`FAIL_CLOSED: non-plain object at ${path}`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`FAIL_CLOSED: accessor or hidden property at ${path}.${key}`);
    }
    assertCanonicalData(descriptor.value, `${path}.${key}`);
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
