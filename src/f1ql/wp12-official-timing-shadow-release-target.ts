import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
} from './wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256 } from './wp12-official-timing-catalog-target';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const statusSchema = z.literal('detached_inactive_target');
const implementationStatusSchema = z.literal('contract_expectations_only_not_runtime_implementation');
const WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256 =
  '1b06103fa99c9556484cbba46c1bf83a9fcfaaba2572eed1e012e391dcf053bc';
const WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256 =
  'ec33aa2ec7e2bdee332aeef309de7b541d9eb5616a0242aeeed80e6553e380e7';
const WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 =
  'ffe01b5cd6d3e6e9666cd663909b8b1960a9a2356d73c24fa6f58cde03c38bf0';
const WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES = Object.freeze({
  answer_question: '82ad5692b643ec161da15e4581c47c96487ffd9ba60084db18658dc27c62390d',
  candidate_proposal: '2dc8438501d701f29e84914766c332dfaaf6caf8c17303e1e8a498c7818792d7',
  provider_schema: '14fbe6a31c018ac3b18c59dfa76382deabdf9e1d1289cd040375a6316d333f0a'
});
const WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES = Object.freeze({
  semantic_query: '3b5aa0ea84e1b2397f5768117a85161886ff58a82c5bd6b128686292152f8c0b',
  semantic_evidence: '85cba1dfdf0cf6c7a06b6747a80555f35ed81cc5fb19207beace260d2cd16c96',
  resolution_evidence: 'f0bc43e22d35e7c287dfbb29f7e2d47833818af48c8e6e91390b740f2c8f9682',
  planner: 'c5c07320de8aee64f67806473499df0669412d15d25e9c1cda1f94aa09aa9371',
  planned_f1ql: '0bdddf254626d33410b7bc38b72c726cd522ecc242ba41c1a538db83607a934a',
  planned_compiler: '69742222607fded3658b4f7b179b575c3837a15451e38b200bc64beb11a48765',
  plan_execution_result: '137b4bc25d64f676dcadc2a7b8af464e64359a5fda192a8fbd7117cce2eec498',
  semantic_plan_proof: '65f14e026eca30ee1fafd3fb3bf90cf98b45d571978f906fc7db6e9a9bea201a',
  capability_authorization: 'a29948939f671224fc537de5aae2f514bc68f80a39516cf850424e7d31b45f03',
  result_formatter: '7fd07011b34b79961731e6d92d7a16303a6efe9f8c1cebca99995944d4c5f978'
});

const versionSchema = z.object({
  component: idSchema,
  current: z.union([z.string().min(1), z.number().int().positive()]),
  target: z.union([z.string().min(1), z.number().int().positive()]),
  version_source: z.literal('activation_bundle')
}).strict();

const componentSchema = z.object({
  status: statusSchema,
  implementation_status: implementationStatusSchema,
  version: versionSchema.nullable(),
  contract: z.unknown(),
  implementation_evidence: z.null()
}).strict();

const subordinateSchema = z.object({
  status: statusSchema,
  implementation_status: implementationStatusSchema,
  activation_target_name: idSchema.nullable(),
  contract: z.unknown(),
  implementation_evidence: z.null()
}).strict();

const targetSchema = z.object({
  version: z.literal(1),
  status: statusSchema,
  implementation_status: implementationStatusSchema,
  activation_bundle_sha256: sha256Schema,
  catalog_target_sha256: sha256Schema,
  semantic_target_sha256: sha256Schema,
  interface_target_sha256: sha256Schema,
  components: z.object({
    shadow_observation: componentSchema,
    shadow_orchestrator: componentSchema,
    shadow_retained_observation: componentSchema,
    release_attestation: componentSchema
  }).strict(),
  subordinate_components: z.object({
    shadow_evidence_collector: subordinateSchema,
    shadow_evidence_report: subordinateSchema,
    shadow_retention_transport: subordinateSchema,
    shadow_production_capture: subordinateSchema,
    shadow_production_metadata_evidence: subordinateSchema
  }).strict(),
  component_hashes: z.record(z.string(), sha256Schema),
  subordinate_component_hashes: z.record(z.string(), sha256Schema),
  activation_target_hash_names: z.array(idSchema),
  non_execution: z.object({
    active_runtime_imports_target: z.literal(false),
    database_imports: z.literal(false),
    executor_imports: z.literal(false),
    migration_application: z.literal(false),
    provider_requests: z.literal(0),
    result_execution: z.literal(false),
    translated_execution: z.literal(false),
    persistent_sink_created: z.literal(false),
    production_capture: z.literal(false)
  }).strict()
}).strict();

function transition(component: string) {
  const item = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions.find(candidate => candidate.component === component);
  if (!item || item.transition !== 'atomic') {
    throw new Error(`WP12 shadow/release target lacks atomic version transition ${component}`);
  }
  return {
    component: item.component,
    current: item.current,
    target: item.target,
    version_source: 'activation_bundle' as const
  };
}

function component(componentId: string, contract: unknown) {
  return deepFreeze(componentSchema.parse({
    status: 'detached_inactive_target',
    implementation_status: 'contract_expectations_only_not_runtime_implementation',
    version: transition(componentId),
    contract,
    implementation_evidence: null
  }));
}

function subordinate(activationTargetName: string | null, contract: unknown) {
  return deepFreeze(subordinateSchema.parse({
    status: 'detached_inactive_target',
    implementation_status: 'contract_expectations_only_not_runtime_implementation',
    activation_target_name: activationTargetName,
    contract,
    implementation_evidence: null
  }));
}

const activeSourceHashes = {
  observation_v1_source: '1b8103e8b58f6ede69a22ef853d1f028355f5c2ee78ba172ea2275921c7f03cc',
  orchestrator_v6_source: '753bfd884e333fc71078a10042bdc3e2cfc2bf2088c49e903a7bd880269bd45b',
  retained_v2_source: 'd4d252bafaf6ab4c694580ded10efa4be72d98b912d53d38422f722082db23b7',
  report_v1_source: '826de5907d217c71ace161319f0f637b434152f747c358075e729dacc43f41a5',
  semantic_shadow_route_source: 'fa4fd2a4bad988cb5a035fd052fce0bb666f2dc268e4aeea6021c316e7bc3d0a',
  localhost_collector_source: '8772c9b139105f7cec8b880f894f12a24d9b92ae38e9956191dc26d26a8acba9',
  report_cli_source: '8824ee0415158e80c2e5d8618171945d9eec222b7f9f435b8ededf29d100f888',
  production_capture_source: 'd4921f5d4466c662aada2ff5001c81e6e40bdc134c34234219c206a50cad73a5',
  production_evidence_builder_source: '0bf04668aafe6fab3cb1e67e324bfdb073ea8bb6111aa0995e8b52e571da45a8',
  release_attestation_v8_source: 'e0b0a38930039adb453a17106700d3604a56b97d409c9847526136e967bc1368',
  release_builder_source: '909494501cd50e9e66a3059c8a4f7e402593caf7ed875b42d890a77850c37464',
  permanent_program_translate_route_source: '93e9da59bfce8800ce2ef34dddf3ff6647f6445645234c3b32a67132c0204596'
} as const;

const coverageQueries = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries;
const coverageQueryIds = coverageQueries.map(query => query.id);

export const WP12_OFFICIAL_TIMING_SHADOW_OBSERVATION_TARGET = component('shadow_observation', {
  predecessor_source_sha256: activeSourceHashes.observation_v1_source,
  admitted_source_set_code: 'official_race_lap_timing',
  admitted_topology_code: 'same_source_scalar_comparison',
  admitted_operator_set_code: 'filter_aggregate_compare_project_sort_limit',
  operator_signature: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.topologies[0].operator_signature,
  added_reasons: ['source_integrity_failed'],
  admitted_reasons: [
    'plan_proven',
    'attachment_ambiguous', 'entity_ambiguous', 'metric_ambiguous', 'output_shape_ambiguous',
    'scope_ambiguous', 'temporal_ambiguous', 'event_ambiguous',
    'candidate_overflow', 'provider_candidate_not_enumerated', 'unknown_language',
    'unsupported_comparison', 'unsupported_concept', 'unsupported_source_combination', 'unsupported_scope',
    'provider_malformed', 'provider_unavailable', 'question_invalid',
    'admission_invalid', 'aggregate_locality_unsupported', 'aggregate_locality_violation',
    'entity_cardinality_mismatch', 'entity_inventory_mismatch', 'grain_mismatch', 'identity_unresolved',
    'join_path_ambiguous', 'ordering_undefined', 'output_alias_collision', 'planned_program_invalid',
    'source_coverage_missing', 'source_graph_disconnected', 'unsafe_join_cardinality',
    'evidence_invalid', 'plan_mismatch', 'resolution_invalid', 'semantic_query_not_unique', 'unsupported_topology',
    'shadow_internal_failure', 'source_integrity_failed'
  ],
  resolver_counts: {
    inventory_reads_max: 1,
    event_reads_max: 1,
    fingerprint_reads: 0,
    inventory_entities_max: 8,
    verified_candidates_max: 2,
    official_coverage_reads_max: 1,
    translated_execution_calls: 0,
    planned_result_execution_calls: 0,
    answer_result_executor_calls: 0,
    result_query_calls: 0
  },
  coverage_binding: {
    stage: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.stage,
    timing: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.timing,
    abstain_reason: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.abstain_reason,
    integrity_failure_reason: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.integrity_failure_reason,
    integrity_failure_stage: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.coverage_decision.integrity_failure_stage,
    query_ids: coverageQueryIds,
    query_calls_max: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_query_calls_max,
    request_hash_required: true,
    coverage_witness_hash_required: true,
    ordered_witness_rows_required: true,
    semantic_query_hash_required: true,
    catalog_hash_required: true,
    coverage_abstention_retains_no_plan_or_result_hashes: true
  },
  hashes_bound: [
    'activation_bundle_sha256', 'catalog_sha256', 'interface_target_sha256', 'semantic_target_sha256',
    'candidate_set_sha256', 'provider_candidate_set_sha256', 'semantic_evidence_sha256', 'semantic_query_sha256',
    'coverage_request_sha256', 'coverage_witness_sha256', 'coverage_query_id', 'coverage_query_sha256',
    'answer_plan_sha256', 'topology_sha256', 'planned_f1ql_sha256', 'core_sha256',
    'compiled_sha256', 'semantic_proof_sha256'
  ].sort(compareText),
  forbidden_retained_content: [
    'question_text', 'raw_sql', 'sql_parameters', 'raw_provider_output', 'canonical_driver_ids',
    'result_rows', 'result_hashes', 'session_spans', 'lap_range_literals'
  ].sort(compareText),
  coverage_abstention_contains_no_plan_fields: true,
  execution_hashes_never_emitted: ['plan_execution_result_sha256', 'result_rows_sha256'],
  question_target_sha256: WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES.answer_question,
  semantic_query_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_query,
  result_execution_prohibited: true,
  translated_execution_prohibited: true
});

export const WP12_OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_TARGET = component('shadow_orchestrator', {
  predecessor_source_sha256: activeSourceHashes.orchestrator_v6_source,
  step_order: [
    'question_contract_v28', 'server_enumeration', 'provider_schema_v2_proposal',
    'exact_admission', 'deterministic_identity_resolution', 'deterministic_event_resolution',
    'official_timing_coverage_read', 'coverage_or_integrity_decision',
    'planning_and_proof_when_eligible', 'sanitized_observation_v2', 'terminal_retention_attempt', 'stop'
  ],
  observation_target_sha256: hash(WP12_OFFICIAL_TIMING_SHADOW_OBSERVATION_TARGET),
  never_performs: [
    'capability_authorization_creation', 'capability_authorization_consumption',
    'plan_execution_result_construction', 'result_formatter_invocation',
    'translated_execution', 'planned_result_execution', 'answer_result_execution',
    'generic_f1ql_execution', 'template_fallback', 'program_route_fallback',
    'provider_authored_coverage_sql', 'provider_authored_f1ql', 'provider_authored_core',
    'persistent_sink_creation', 'production_capture_creation'
  ].sort(compareText),
  coverage_reader_version: transition('official_timing_coverage_reader').target,
  coverage_queries: coverageQueries.map(query => ({
    id: query.id,
    metric_id: query.metric_id,
    target_relation: query.target_relation,
    statement_sha256: query.statement_sha256,
    statement_timeout_ms: query.statement_timeout_ms,
    transaction: query.transaction,
    maximum_rows: query.maximum_rows
  })),
  exactly_one_coverage_read_when_reached: true,
  coverage_read_after_admission_and_before_planning: true,
  coverage_abstention_skips_planning_and_proof: true,
  integrity_abstention_skips_planning_and_proof: true,
  template_dual_lane_not_required_for_official_timing: true,
  template_dual_lane_never_executes: true,
  question_target_sha256: WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES.answer_question,
  candidate_proposal_target_sha256: WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES.candidate_proposal,
  provider_schema_target_sha256: WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES.provider_schema,
  resolution_evidence_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.resolution_evidence,
  planner_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.planner,
  plan_proof_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_plan_proof,
  capability_authorization_never_created: true,
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
});

export const WP12_OFFICIAL_TIMING_SHADOW_RETAINED_OBSERVATION_TARGET = component('shadow_retained_observation', {
  predecessor_source_sha256: activeSourceHashes.retained_v2_source,
  terminal_values: ['operational_failure', 'semantic'],
  exactly_one_terminal_attempt_per_admitted_request: true,
  response_byte_equivalent_to_retained_semantic_observation_after_sanitization: true,
  provider_identity_hashes_only: true,
  added_counters: {
    official_coverage_reads: { min: 0, max: 1 },
    translated_execution_calls: 0,
    planned_result_execution_calls: 0,
    answer_result_executor_calls: 0,
    result_query_calls: 0
  },
  observation_version_required: transition('shadow_observation').target,
  target_envelope_hash_required: true,
  child_component_hashes_required: true,
  execution_counters_literally_zero: true,
  evidence_binding_attempt_hash_algorithm_preserved: true,
  production_capture_limited_to: ['key_id', 'algorithm', 'signature'],
  production_capture_binding_fields: [
    'commit_sha256', 'deployment_id_sha256', 'release_id_sha256', 'capture_nonce_sha256',
    'answer_database_target_sha256', 'answer_database_user_sha256', 'answer_database_name_sha256',
    'resolver_sql_fingerprint_set_sha256', 'coverage_query_sha256_set'
  ].sort(compareText),
  logger_failure_triggers_no_second_terminal_attempt: true,
  logger_error_text_never_retained: true,
  maximum_serialized_line_bytes: 16_384,
  no_rows_sql_parameters_questions_or_provider_raw_output: true,
  added_failure_reasons: [] as string[],
  added_failure_stages: ['coverage', 'integrity']
});

export const WP12_OFFICIAL_TIMING_RELEASE_ATTESTATION_TARGET = component('release_attestation', {
  predecessor_version_source_sha256: activeSourceHashes.release_attestation_v8_source,
  predecessor_builder_source_sha256: activeSourceHashes.release_builder_source,
  signing_required: true,
  ed25519_required: true,
  trusted_key_required: true,
  atomic_complete_target_hash_set_required: true,
  partial_or_extra_target_hash_set_rejected: true,
  required_target_hash_names_exactly:
    [...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes].sort(compareText),
  subordinate_hashes_bound_through_parents: true,
  required_bindings: [
    'activation_migration', 'answer_authorization_code', 'catalog', 'catalog_database_binding',
    'fact_space', 'official_timing_coverage_reader', 'plan_execution_result', 'principal_audit',
    'provider_schema', 'release_attestation', 'result_formatter', 'semantic_answer_compatibility',
    'semantic_query', 'semantic_response_equivalence', 'semantic_template_equivalence',
    'shadow_observation', 'shadow_orchestrator', 'shadow_retained_observation'
  ].sort(compareText),
  required_evidence_non_null_before_pass: [
    'catalog_database_binding_observation', 'coverage_eligibility_fixture', 'generated_provider_artifacts',
    'internal_canary', 'planned_compiler_reference_parity', 'production_database_binding',
    'production_round_trip', 'public_canary', 'release_attestation_artifact',
    'semantic_v32_result_fixture', 'shadow_collector_artifact', 'shadow_report_pass',
    'worst_case_benchmark'
  ].sort(compareText),
  forbidden_until_all_blockers_resolved: true,
  compositional_routing_rejected_before_evidence: true,
  shadow_non_execution_gate_required: true,
  shadow_translated_execution_zero_required: true,
  shadow_result_query_calls_zero_required: true,
  coverage_query_calls_max: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_query_calls_max,
  production_capture_and_metadata_evidence_bound: true,
  statuses_required_all_pass: true,
  migration_application_state_bound: true,
  public_wire_compatibility_required: true,
  public_wire_compatibility_currently_blocked: false,
  public_wire_contract_sha256: WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256,
  answer_routing_mode_target: 'compositional_profiles',
  release_artifact_sha256: null,
  release_signature: null,
  release_artifact: null,
  release_not_constructible_locally: true
});

export const WP12_OFFICIAL_TIMING_SHADOW_COLLECTOR_TARGET = subordinate('shadow_orchestrator', {
  identity: 'wp12-official-timing-shadow-collector-v1',
  predecessor_source_sha256: activeSourceHashes.localhost_collector_source,
  environment: 'localhost_disposable_docker_only',
  exact_disposable_database_url_required: true,
  wp12_corpus_sha256: null,
  wp12_snapshot_sha256: null,
  question_groups: 2,
  repetitions_per_group: 3,
  expected_attempts: 6,
  sequential_provider_calls: true,
  one_active_attempt_at_a_time: true,
  fixed_identity_event_and_coverage_fixtures: true,
  throwing_translated_executor_call_count_zero: true,
  throwing_planned_result_executor_call_count_zero: true,
  fail_on: [
    'duplicate_attempt', 'extra_retention', 'missing_attempt', 'operational_failure', 'oracle_drift',
    'provider_drift', 'result_query_execution', 'translated_execution'
  ].sort(compareText),
  emit_nothing_on_incomplete_run: true,
  output_artifact_mode: 0o600,
  output_artifact_flags: ['O_EXCL', 'O_NOFOLLOW'],
  output_artifact_location: 'os_temporary_directory_only',
  forbidden_outputs: [
    'append_mode', 'database_table', 'http_upload', 'object_store', 'production_target', 'redis', 'repository_path'
  ].sort(compareText),
  current_50_case_corpus_is_predecessor_evidence_only: true,
  current_corpus_semantic_sha256: 'e65fb08627e4645e173f2172e7460f9003ff139a1b699cc77a3af05a5a9b1466',
  collector_artifact_sha256: null,
  collector_artifact: null
});

export const WP12_OFFICIAL_TIMING_SHADOW_REPORT_TARGET = subordinate('shadow_orchestrator', {
  identity: 'semantic-shadow-report-v2',
  predecessor_source_sha256: activeSourceHashes.report_v1_source,
  predecessor_cli_source_sha256: activeSourceHashes.report_cli_source,
  input: 'bounded_no_follow_regular_file',
  encoding: 'utf8_fatal',
  duplicate_keys_rejected_recursively: true,
  accepted_retained_version: transition('shadow_retained_observation').target,
  malformed_retained_family_line_fails_report: true,
  required_corpus_sha256: null,
  required_question_groups: 2,
  required_repetitions_per_group: 3,
  required_attempts: 6,
  one_provider_identity_required: true,
  target_hashes_must_match: true,
  coverage_behavior_must_match: true,
  zero_operational_failures_required: true,
  separate_execution_counters: [
    'answer_result_executor_calls', 'coverage_reads', 'planned_result_execution_calls',
    'resolver_reads', 'result_query_calls', 'translated_execution_calls'
  ].sort(compareText),
  any_nonzero_execution_counter_is_hard_failure: true,
  empty_or_absent_evidence_is_insufficient_never_pass: true,
  output: 'single_sanitized_json_object_stdout_only',
  no_output_file_or_persistence: true,
  report_omits_question_hashes_and_provider_identity_hashes: true,
  report_artifact_sha256: null,
  report_artifact: null
});

export const WP12_OFFICIAL_TIMING_SHADOW_RETENTION_TRANSPORT_TARGET = subordinate('shadow_retained_observation', {
  identity: 'semantic-shadow-platform-log-v1',
  predecessor_route_source_sha256: activeSourceHashes.semantic_shadow_route_source,
  application_owned_persistent_sink_created: false,
  database_log_table: 'forbidden',
  database_dml_for_retention: 'forbidden',
  file_append_sink: 'forbidden',
  redis_or_cache_sink: 'forbidden',
  http_or_object_store_sink: 'forbidden',
  background_queue_or_retry: 'forbidden',
  runtime_transport: 'one_injected_sanitized_line_logger_defaulting_to_process_stdout',
  railway_platform_retention_is_external_infrastructure: true,
  collector_temporary_artifact_is_operator_invoked_not_runtime_log_sink: true,
  persistent_sink_approval_absent: true,
  migration_grant_table_trigger_or_durable_application_log_introduced: false
});

export const WP12_OFFICIAL_TIMING_SHADOW_PRODUCTION_CAPTURE_TARGET = subordinate(null, {
  identity: 'wp12-official-timing-production-capture-v1',
  predecessor_source_sha256: activeSourceHashes.production_capture_source,
  status: 'not_created',
  append_only_signature_and_hashed_runtime_context: true,
  signing_key: 'production_evidence_ed25519',
  capture_fields: [
    'answer_database_name_sha256', 'answer_database_target_sha256', 'answer_database_user_sha256',
    'capture_nonce_sha256', 'commit_sha256', 'coverage_query_sha256_set', 'deployment_id_sha256',
    'release_id_sha256', 'resolver_sql_fingerprint_set_sha256'
  ].sort(compareText),
  no_question_text_sql_parameters_rows_or_raw_provider_output: true,
  capture_artifact_sha256: null,
  capture_artifact: null
});

export const WP12_OFFICIAL_TIMING_SHADOW_PRODUCTION_METADATA_EVIDENCE_TARGET = subordinate(null, {
  identity: 'wp12-official-timing-production-metadata-evidence-v1',
  predecessor_builder_source_sha256: activeSourceHashes.production_evidence_builder_source,
  status: 'not_created',
  bound_to: [
    'capture_signature', 'commit_sha', 'coverage_query_hashes', 'deployment_id', 'principal_audit',
    'release_id', 'runtime_context_hashes', 'semantic_catalog_database_binding', 'shadow_run'
  ].sort(compareText),
  zero_translated_and_result_execution_required: true,
  evidence_artifact_sha256: null,
  evidence_artifact: null
});

const components = {
  shadow_observation: WP12_OFFICIAL_TIMING_SHADOW_OBSERVATION_TARGET,
  shadow_orchestrator: WP12_OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_TARGET,
  shadow_retained_observation: WP12_OFFICIAL_TIMING_SHADOW_RETAINED_OBSERVATION_TARGET,
  release_attestation: WP12_OFFICIAL_TIMING_RELEASE_ATTESTATION_TARGET
} as const;

const subordinateComponents = {
  shadow_evidence_collector: WP12_OFFICIAL_TIMING_SHADOW_COLLECTOR_TARGET,
  shadow_evidence_report: WP12_OFFICIAL_TIMING_SHADOW_REPORT_TARGET,
  shadow_retention_transport: WP12_OFFICIAL_TIMING_SHADOW_RETENTION_TRANSPORT_TARGET,
  shadow_production_capture: WP12_OFFICIAL_TIMING_SHADOW_PRODUCTION_CAPTURE_TARGET,
  shadow_production_metadata_evidence: WP12_OFFICIAL_TIMING_SHADOW_PRODUCTION_METADATA_EVIDENCE_TARGET
} as const;

export const WP12_OFFICIAL_TIMING_SHADOW_RELEASE_COMPONENT_HASHES = deepFreeze(Object.fromEntries(
  Object.entries(components).map(([name, value]) => [name, hash(value)])
));

export const WP12_OFFICIAL_TIMING_SHADOW_RELEASE_SUBORDINATE_HASHES = deepFreeze(Object.fromEntries(
  Object.entries(subordinateComponents).map(([name, value]) => [name, hash(value)])
));

const rawTarget = {
  version: 1,
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  catalog_target_sha256: WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256,
  semantic_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256,
  interface_target_sha256: WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256,
  components,
  subordinate_components: subordinateComponents,
  component_hashes: WP12_OFFICIAL_TIMING_SHADOW_RELEASE_COMPONENT_HASHES,
  subordinate_component_hashes: WP12_OFFICIAL_TIMING_SHADOW_RELEASE_SUBORDINATE_HASHES,
  activation_target_hash_names:
    [...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes].sort(compareText),
  non_execution: {
    active_runtime_imports_target: false,
    database_imports: false,
    executor_imports: false,
    migration_application: false,
    provider_requests: 0,
    result_execution: false,
    translated_execution: false,
    persistent_sink_created: false,
    production_capture: false
  }
} as const;
const canonicalTarget = stableSerialize(rawTarget);

export type WP12OfficialTimingShadowReleaseTarget = z.infer<typeof targetSchema>;

export function parseWP12OfficialTimingShadowReleaseTarget(input: unknown): WP12OfficialTimingShadowReleaseTarget {
  assertCanonicalData(input, 'target');
  const parsed = targetSchema.parse(input);
  for (const [name, value] of Object.entries(parsed.components)) {
    if (value.version?.component !== name || parsed.component_hashes[name] !== hash(value)) {
      throw new Error(`FAIL_CLOSED: WP12 shadow/release component hash differs for ${name}`);
    }
  }
  for (const [name, value] of Object.entries(parsed.subordinate_components)) {
    if (parsed.subordinate_component_hashes[name] !== hash(value)) {
      throw new Error(`FAIL_CLOSED: WP12 shadow/release subordinate hash differs for ${name}`);
    }
  }
  if (Object.keys(parsed.component_hashes).sort(compareText).join(',') !==
      Object.keys(parsed.components).sort(compareText).join(',') ||
      Object.keys(parsed.subordinate_component_hashes).sort(compareText).join(',') !==
      Object.keys(parsed.subordinate_components).sort(compareText).join(',') ||
      stableSerialize(parsed) !== canonicalTarget) {
    throw new Error('FAIL_CLOSED: WP12 official timing shadow/release target differs from the reviewed derivation');
  }
  return deepFreeze(parsed);
}

export const WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET = parseWP12OfficialTimingShadowReleaseTarget(rawTarget);
export const WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET);

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

function assertCanonicalData(
  value: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): asserts value is null | boolean | number | string | object {
  if (depth > 100) {throw new Error(`FAIL_CLOSED: canonical depth exceeded at ${path}`);}
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {return;}
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`FAIL_CLOSED: non-canonical number at ${path}`);
    }
    return;
  }
  if (typeof value !== 'object') {throw new Error(`FAIL_CLOSED: non-canonical value at ${path}`);}
  if (seen.has(value)) {throw new Error(`FAIL_CLOSED: cyclic or shared reference at ${path}`);}
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {throw new Error(`FAIL_CLOSED: symbol property at ${path}`);}
  if (Array.isArray(value)) {
    assertCanonicalArray(value, path, seen, depth);
    return;
  }
  assertCanonicalObject(value, path, seen, depth);
}

function assertCanonicalArray(value: unknown[], path: string, seen: WeakSet<object>, depth: number): void {
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
    assertCanonicalData(descriptor.value, `${path}[${index}]`, seen, depth + 1);
  }
}

function assertCanonicalObject(value: object, path: string, seen: WeakSet<object>, depth: number): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`FAIL_CLOSED: non-plain object at ${path}`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`FAIL_CLOSED: accessor or hidden property at ${path}.${key}`);
    }
    assertCanonicalData(descriptor.value, `${path}.${key}`, seen, depth + 1);
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
