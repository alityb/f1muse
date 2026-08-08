import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
} from './wp12-official-timing-activation-bundle';
import {
  WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256
} from './wp12-official-timing-catalog-target';
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const statusSchema = z.literal('detached_inactive_target');
const implementationStatusSchema = z.literal('contract_expectations_only_not_runtime_implementation');
const WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256 =
  '1b06103fa99c9556484cbba46c1bf83a9fcfaaba2572eed1e012e391dcf053bc';
const WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES = Object.freeze({
  semantic_query: '3b5aa0ea84e1b2397f5768117a85161886ff58a82c5bd6b128686292152f8c0b',
  semantic_evidence: '85cba1dfdf0cf6c7a06b6747a80555f35ed81cc5fb19207beace260d2cd16c96',
  semantic_plan_proof: '65f14e026eca30ee1fafd3fb3bf90cf98b45d571978f906fc7db6e9a9bea201a',
  capability_authorization: 'a29948939f671224fc537de5aae2f514bc68f80a39516cf850424e7d31b45f03',
  result_formatter: '7fd07011b34b79961731e6d92d7a16303a6efe9f8c1cebca99995944d4c5f978'
});
const versionSchema = z.object({
  component: idSchema,
  current: z.union([z.string().min(1), z.number().int().positive()]),
  target: z.union([z.string().min(1), z.number().int().positive()]),
  version_source: z.enum(['activation_bundle', 'candidate_proposal_transition'])
}).strict();

const componentSchema = z.object({
  status: statusSchema,
  implementation_status: implementationStatusSchema,
  version: versionSchema,
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
  components: z.object({
    answer_question: componentSchema,
    candidate_proposal: componentSchema,
    provider_schema: componentSchema,
    fact_space: componentSchema,
    semantic_response_equivalence: componentSchema,
    semantic_answer_compatibility: componentSchema,
    semantic_template_equivalence: componentSchema,
    answer_authorization_code: componentSchema
  }).strict(),
  component_hashes: z.record(z.string(), sha256Schema),
  non_execution: z.object({
    active_runtime_imports_target: z.literal(false),
    database_imports: z.literal(false),
    executor_imports: z.literal(false),
    migration_application: z.literal(false),
    provider_requests: z.literal(0),
    result_execution: z.literal(false),
    translated_execution: z.literal(false)
  }).strict()
}).strict();

function transition(component: string) {
  const item = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions.find(candidate => candidate.component === component);
  if (!item || item.transition !== 'atomic') {
    throw new Error(`WP12 interface target lacks atomic version transition ${component}`);
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

const certifiedScope = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
const metrics = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics;
const outputs = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas;
const resultFixtures = {
  official_non_deleted_non_pit_event_mean_v1:
    'ce1a87db0f28e1b30a39f8744a2bd9e3e728e361096fd3bd6c10b4c04129a198',
  official_non_deleted_non_pit_window_median_v1:
    '972b7d5066e1e2bea768eb3db0a31c44e447dd1b4747db88957b8cf61c99e6c0'
} as const;
const activeTemplateIds = [
  'current_standings', 'driver_career_official_summary', 'driver_career_qualifying_p1_count',
  'driver_career_wins_by_circuit', 'driver_season_official_summary',
  'driver_season_qualifying_p1_count', 'driver_season_qualifying_top_ten_count',
  'final_standings_driver_ranking', 'final_standings_leader', 'final_standings_points',
  'official_driver_results_comparison', 'qualifying_classification_all',
  'qualifying_classification_driver', 'qualifying_classification_position',
  'qualifying_classification_status', 'qualifying_season_position_h2h', 'race_classification_all',
  'race_classification_driver', 'race_classification_position', 'race_classification_status',
  'race_date', 'race_event_finishing_position_comparison', 'race_season_finishing_position_h2h',
  'season_qualifying_top_ten_ranking'
] as const;
const providerVariantSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'operation', 'driver_a_span', 'driver_b_span', 'event_span', 'operation_evidence',
    'season_evidence', 'lap_range_evidence'
  ],
  properties: {
    operation: { const: 'certified_official_timing_compare' },
    driver_a_span: { $ref: '#/$defs/span_ref' },
    driver_b_span: { $ref: '#/$defs/span_ref' },
    event_span: { $ref: '#/$defs/span_ref' },
    operation_evidence: { $ref: '#/$defs/evidence_ref' },
    season_evidence: { $ref: '#/$defs/evidence_ref' },
    lap_range_evidence: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false, required: ['start_span', 'end_span'],
          properties: {
            start_span: { $ref: '#/$defs/span_ref' },
            end_span: { $ref: '#/$defs/span_ref' }
          }
        }
      ]
    }
  }
} as const;
const providerPromptExtension = 'For the exact reviewed official timing grammar only, emit certified_official_timing_compare with two ordered driver spans, one event span, operation and season evidence, and nullable lap-range evidence. Session is server-derived from the verified grammar. Never emit a metric, aggregate, exclusion, identifier, topology, output, integrity rule, SQL, F1QL, or Core.';

export const WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET = component('answer_question', {
  normalization: 'unicode_nfkc_trimmed',
  maximum_unicode_code_points: 1000,
  maximum_utf8_bytes: 3000,
  normalized_question_sha256_required: true,
  exact_unicode_code_point_spans: true,
  preserve_v27_safety_rejections: true,
  whole_question_consumption_required: true,
  admitted_whole_question_grammars: [
    {
      metric_id: 'official_non_deleted_non_pit_event_mean_v1',
      normalized_patterns: [
        'who was faster between <driver_a> and <driver_b> at the 2022 belgian grand prix',
        'compare <driver_a> and <driver_b> by official mean race lap time at the 2022 belgian grand prix',
        'compare <driver_a> and <driver_b> by official average race lap time at the 2022 belgian grand prix'
      ],
      case_handling: 'unicode_case_insensitive',
      punctuation: 'optional_terminal_question_mark_or_period',
      whitespace: 'one_or_more_between_tokens'
    },
    {
      metric_id: 'official_non_deleted_non_pit_window_median_v1',
      normalized_patterns: [
        'compare the official median race lap time of <driver_a> and <driver_b> over laps <lap_start> to <lap_end> at the 2022 belgian grand prix',
        'who was faster by official median race lap time between <driver_a> and <driver_b> over laps <lap_start> to <lap_end> at the 2022 belgian grand prix'
      ],
      case_handling: 'unicode_case_insensitive',
      punctuation: 'optional_terminal_question_mark_or_period',
      whitespace: 'one_or_more_between_tokens'
    }
  ],
  grammar_placeholders_are_exact_nonoverlapping_literal_spans: true,
  operations: metrics.map(metric => ({
    metric_id: metric.metric_id,
    exact_season: certifiedScope.season,
    exact_event_name: certifiedScope.event_name,
    exact_round: certifiedScope.round,
    exact_session_type: certifiedScope.session_type,
    exact_driver_mentions: 2,
    question_ordered_driver_spans: true,
    distinct_resolved_drivers_required: true,
    required_evidence: [
      'exact_operation_span', 'exact_question_hash', 'one_event_literal_span',
      'one_season_literal_span', 'question_ordered_driver_spans',
      ...(metric.maximum_inclusive_window_laps === null ? [] : ['inclusive_lap_range_spans'])
    ].sort(compareText),
    lap_range: metric.maximum_inclusive_window_laps === null
      ? { presence: 'forbidden', maximum_inclusive_laps: null }
      : { presence: 'required', maximum_inclusive_laps: metric.maximum_inclusive_window_laps }
  })),
  pre_provider_refusals: [
    'ambiguous_or_missing_event', 'ambiguous_or_missing_season', 'clean_air', 'classification',
    'causal_performance', 'constructor_or_team', 'contradictory_metric', 'control_or_instruction_text',
    'driver_cardinality_not_two', 'explicit_exclusion_override', 'fastest_or_single_lap', 'fuel',
    'generic_pace', 'grid', 'interim_or_latest', 'malformed_or_oversized_lap_range',
    'multiple_sessions', 'multiseason', 'negation', 'practice', 'qualifying', 'safety_car',
    'same_driver', 'sprint', 'strategy', 'traffic', 'tyre', 'unconsumed_filler', 'weather'
  ].sort(compareText),
  semantic_query_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_query
});

export const WP12_OFFICIAL_TIMING_CANDIDATE_PROPOSAL_TARGET = component('candidate_proposal', {
  question_target_sha256: hash(WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET),
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  preserve_existing_v1_variants: true,
  added_variant: {
    operation: 'certified_official_timing_compare',
    exact_driver_entity_refs: 2,
    exact_event_entity_refs: 1,
    event_mean_lap_range: 'forbidden',
    window_median_lap_range: 'required_inclusive_max_50',
    evidence_only_fields: [
      'driver_spans', 'event_span', 'lap_range_spans', 'operation_span', 'season_span'
    ]
  },
  provider_may_supply: [
    'exact_literal_spans', 'fixed_operation_discriminator'
  ],
  server_derived_only: [
    'aggregation', 'canonical_ids', 'catalog_pins', 'comparison', 'coverage', 'exclusions',
    'integrity_checks', 'metric_id', 'output_fields', 'relationships', 'session_scope', 'source_ref',
    'sql', 'topology'
  ],
  metric_derived_only_from_verified_question_grammar: true,
  maximum_official_timing_candidates: 2,
  duplicate_candidates: 'reject',
  exact_admitted_candidates: 1,
  unknown_or_extra_semantics: 'reject',
  semantic_query_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_query,
  semantic_evidence_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_evidence
});

export const WP12_OFFICIAL_TIMING_PROVIDER_SCHEMA_TARGET = deepFreeze(componentSchema.parse({
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  version: {
    component: 'provider_schema',
    current: transition('candidate_proposal').current,
    target: transition('candidate_proposal').target,
    version_source: 'candidate_proposal_transition'
  },
  contract: {
    independent_provider_schema_version_in_activation_bundle: false,
    current_schema_name: 'f1_semantic_candidate_proposals_v1',
    target_schema_name: 'f1_semantic_candidate_proposals_v2',
    candidate_proposal_target_sha256: hash(WP12_OFFICIAL_TIMING_CANDIDATE_PROPOSAL_TARGET),
    question_target_sha256: hash(WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET),
    catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
    strict_schema: true,
    maximum_response_bytes: 65536,
    maximum_tokens: 8192,
    temperature: 0,
    timeout_ms: { min: 1, max: 30000 },
    exact_returned_model_identity_required: true,
    exact_completed_non_refusal_results: 1,
    runtime_zod_validation_after_wire_transform: true,
    generated_hashes_required: [
      'anthropic_wire_schema', 'catalog_language_projection', 'effective_prompt',
      'openai_compatible_schema', 'provider_request_config'
    ],
    language_projection_excludes: [
      'canonical_ids', 'coverage_decisions', 'database_details', 'dataset_pins', 'identity_inventory',
      'integrity_checks', 'physical_fields', 'physical_types', 'relationships', 'view_names'
    ],
    provider_controls_no_sql_f1ql_core_or_authorization: true,
    endpoint_credential_and_private_host_guards_preserved: true,
    diagnostics_are_closed_finite_and_sanitized: true,
    predecessor_schema_sha256: '013596a11660433746a889f2c692b3d25e324786f1d3817e475c9d3aa82a8ffa',
    extension_construction: 'append_exact_official_variant_to_canonical_v1_candidate_union',
    official_variant_schema: providerVariantSchema,
    official_variant_schema_sha256: hash(providerVariantSchema),
    prompt_extension: providerPromptExtension,
    prompt_extension_sha256: hash(providerPromptExtension),
    language_projection_includes: ['concept_language', 'source_language'],
    generated_artifacts: {
      status: 'generated',
      generator: 'wp12-official-timing-provider-artifacts-v1',
      artifact_file: 'tests/fixtures/wp12-official-timing-provider-artifacts.json',
      catalog_language_projection_sha256: '721dd6db8fbf431a8d5c7ac792312add1eec0596a24e99f9d2e929d3e2523432',
      effective_prompt_sha256: 'd4d70a803f00fc80b9876e02ef75e7fc2293da9c382f680b582263aa25bdfedb',
      openai_compatible_schema_sha256: 'a3ca023d9a8bc3121857e85694d7b02a24f3a97c9f9fe32b98e99245e00c2bda',
      anthropic_wire_schema_sha256: '4af30061acef2a1a6b6ad57c7ca5dc30ddd8a83885c57ff09e1650b52e141cb8',
      provider_request_config_sha256: '9f473f045639cc2ca04d9e1bc403171462fbf761c8fa263d4d9edda01daac58d'
    },
    activation_requires_real_generated_hashes: true
  },
  implementation_evidence: null
}));

export const WP12_OFFICIAL_TIMING_FACT_SPACE_TARGET = component('fact_space', {
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  database_binding_target_sha256: WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  principal_target_sha256: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  activation_migration: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration,
  activation_migration_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.target_activation_migration_sha256,
  exact_select_relations: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.exact_select_relations_after_activation,
  relation_contract_source: 'database_binding_v2_target',
  signed_database_identity_and_owner_observations_required: true,
  observed_post_migration_uniqueness_required: true,
  private_schema_access: 'none',
  writable_relations: 0,
  executable_routines: 0,
  database_temporary: false,
  legacy_compiler_version: 'core-v11',
  legacy_definitions_version: 'v10',
  observed_evidence: null
});

export const WP12_OFFICIAL_TIMING_RESPONSE_EQUIVALENCE_TARGET = component('semantic_response_equivalence', {
  formatter_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.result_formatter,
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  fact_space_target_sha256: hash(WP12_OFFICIAL_TIMING_FACT_SPACE_TARGET),
  preserve_final_standings_equivalence: true,
  official_timing_overlaps: outputs.map(output => ({
    metric_id: output.metric_id,
    legacy_regression_oracle_sha256: resultFixtures[output.metric_id as keyof typeof resultFixtures],
    legacy_oracle_is_semantic_v32_evidence: false,
    semantic_v32_fixture_sha256: '8cba0bc9d3a680a0a636501ec3183ef0f4b30c96ca590f9673f28ab06fbbc65d',
    semantic_v32_fixture_file: 'tests/fixtures/f1ql-official-timing-semantic-results.json',
    semantic_v32_emitter: 'localhost_sealed_official_timing_semantic_v32_v1',
    equivalence_evidence: 'legacy_oracle_value_equality_verified_in_wrapped_suite',
    status: 'real_emitter_fixture_verified_against_legacy_oracle',
    exact_field_order: output.field_ids,
    exact_decimal_fields: output.exact_decimal_fields,
    decimal_representation: output.decimal_representation,
    required_caveats: output.required_caveats,
    exact_one_row: true,
    has_more_rows: false,
    ordered_driver_identities: true,
    coverage_witness_counts_required: true,
    fixed_scope_and_provenance_required: true,
    recompute_delta_and_winner: true,
    internal_integrity_true_and_publicly_omitted: true
  })),
  canonical_input_rejections: [
    'accessor', 'cycle', 'extra_field', 'hidden_field', 'inherited_field', 'missing_field',
    'negative_zero', 'non_finite_number', 'non_plain_object', 'reordered_field', 'sparse_array', 'symbol'
  ].sort(compareText),
  regression_execution_allowed: false
});

const WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 =
  'ffe01b5cd6d3e6e9666cd663909b8b1960a9a2356d73c24fa6f58cde03c38bf0';

export const WP12_OFFICIAL_TIMING_ANSWER_COMPATIBILITY_TARGET = component('semantic_answer_compatibility', {
  response_equivalence_target_sha256: hash(WP12_OFFICIAL_TIMING_RESPONSE_EQUIVALENCE_TARGET),
  formatter_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.result_formatter,
  preserve_final_standings_legacy_compatibility: true,
  official_timing: metrics.map(metric => ({
    metric_id: metric.metric_id,
    disposition: 'sealed_public_wire_contract',
    public_wire_envelope: 'f1ql-answer-wire-v2',
    public_wire_contract_sha256: WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256,
    activation_eligible: true,
    activation_blocker: null,
    activation_still_gated_by_release_v9_evidence: true,
    legacy_template_id: null,
    legacy_answer_envelope_equivalence: false,
    synthetic_legacy_authorization_allowed: false,
    prose_only_downgrade_allowed: false,
    exact_rows_metadata_caveats_and_provenance_required: true
  })),
  legacy_answer_policy_broadening_allowed: false
});

export const WP12_OFFICIAL_TIMING_TEMPLATE_EQUIVALENCE_TARGET = component('semantic_template_equivalence', {
  compatibility_target_sha256: hash(WP12_OFFICIAL_TIMING_ANSWER_COMPATIBILITY_TARGET),
  response_equivalence_target_sha256: hash(WP12_OFFICIAL_TIMING_RESPONSE_EQUIVALENCE_TARGET),
  predecessor_template_registry_version: 'answer-templates-v13',
  predecessor_template_registry_sha256: 'd6923cd57538c57699de38764382ff42fa4d173955cd1e0a40f7e62fca577cbe',
  exact_existing_template_statuses: Object.fromEntries(activeTemplateIds.map(templateId => [
    templateId,
    templateId === 'final_standings_points' ? 'equivalent' : 'unmapped'
  ])),
  template_registry_transition_declared: false,
  official_timing: metrics.map(metric => ({
    metric_id: metric.metric_id,
    template_id: null,
    status: 'semantic_only_no_legacy_template',
    legacy_regression_oracle_sha256: resultFixtures[metric.metric_id as keyof typeof resultFixtures],
    semantic_v32_fixture_sha256: null,
    forbidden_equivalences: ['classification', 'fastest_lap', 'generic_aggregate', 'legacy_pace']
  }))
});

const precedingComponentHashes = {
  answer_question: hash(WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET),
  candidate_proposal: hash(WP12_OFFICIAL_TIMING_CANDIDATE_PROPOSAL_TARGET),
  provider_schema: hash(WP12_OFFICIAL_TIMING_PROVIDER_SCHEMA_TARGET),
  fact_space: hash(WP12_OFFICIAL_TIMING_FACT_SPACE_TARGET),
  semantic_response_equivalence: hash(WP12_OFFICIAL_TIMING_RESPONSE_EQUIVALENCE_TARGET),
  semantic_answer_compatibility: hash(WP12_OFFICIAL_TIMING_ANSWER_COMPATIBILITY_TARGET),
  semantic_template_equivalence: hash(WP12_OFFICIAL_TIMING_TEMPLATE_EQUIVALENCE_TARGET)
} as const;

export const WP12_OFFICIAL_TIMING_ANSWER_AUTHORIZATION_CODE_TARGET = component('answer_authorization_code', {
  legacy_authorization_envelope_version: 14,
  legacy_answer_policy_broadening_allowed: false,
  legacy_policy_contract: {
    predecessor_policy_source_sha256: '4e580f6faf80d5b6bfa61028aa70787ae3676959b9c2e553ba403f6b6611061d',
    predecessor_authorization_code_version: 'answer-authorization-v27',
    preservation_scope: 'entire_v27_policy_implementation',
    approved_sentinel: 'event_classification_position_filter_2025_round_1_top_3',
    rejected_sentinel: 'event_classification_position_filter_limit_1',
    official_event_mean_compare: 'capability_unsupported',
    official_lap_window_median_compare: 'capability_unsupported'
  },
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  semantic_capability_authorization_target_sha256:
    WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.capability_authorization,
  semantic_plan_proof_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_plan_proof,
  catalog_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_CATALOG_TARGET_SHA256,
  database_binding_target_sha256: WP12_OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  principal_target_sha256: WP12_OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  interface_component_hashes: precedingComponentHashes,
  semantic_component_hashes: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES,
  required_runtime_bindings: [
    'audience', 'branch_binding', 'candidate_set', 'canary_stage', 'canary_subject', 'catalog',
    'compiled_result', 'core', 'coverage_query', 'coverage_reader_version', 'coverage_request',
    'coverage_witness', 'database_binding', 'deployment', 'fact_space', 'metric_contract',
    'output_schema', 'planned_f1ql', 'principal', 'profile', 'proof', 'provider_schema', 'release',
    'request', 'resolution', 'result_collection', 'runtime_ceilings', 'semantic_evidence',
    'semantic_query', 'topology'
  ].sort(compareText),
  required_target_hash_names: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes,
  release_attestation_version: transition('release_attestation').target,
  complete_activation_target_hash_set_required: true,
  partial_or_extra_target_hash_set_rejected: true,
  compatibility_activation_eligibility_required: true,
  authorization_ttl_ms_maximum: 5000,
  release_expiry_caps_authorization: true,
  one_time_consumption_before_database_acquisition: true,
  replay_rejected: true,
  live_release_and_kill_switch_rechecks_required: true,
  authorization_from_question_provider_or_legacy_ast_alone: false
});

const components = {
  answer_question: WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET,
  candidate_proposal: WP12_OFFICIAL_TIMING_CANDIDATE_PROPOSAL_TARGET,
  provider_schema: WP12_OFFICIAL_TIMING_PROVIDER_SCHEMA_TARGET,
  fact_space: WP12_OFFICIAL_TIMING_FACT_SPACE_TARGET,
  semantic_response_equivalence: WP12_OFFICIAL_TIMING_RESPONSE_EQUIVALENCE_TARGET,
  semantic_answer_compatibility: WP12_OFFICIAL_TIMING_ANSWER_COMPATIBILITY_TARGET,
  semantic_template_equivalence: WP12_OFFICIAL_TIMING_TEMPLATE_EQUIVALENCE_TARGET,
  answer_authorization_code: WP12_OFFICIAL_TIMING_ANSWER_AUTHORIZATION_CODE_TARGET
} as const;

export const WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES = deepFreeze(Object.fromEntries(
  Object.entries(components).map(([name, value]) => [name, hash(value)])
));

const rawTarget = {
  version: 1,
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  catalog_target_sha256: WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256,
  semantic_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256,
  components,
  component_hashes: WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES,
  non_execution: {
    active_runtime_imports_target: false,
    database_imports: false,
    executor_imports: false,
    migration_application: false,
    provider_requests: 0,
    result_execution: false,
    translated_execution: false
  }
} as const;
const canonicalTarget = stableSerialize(rawTarget);

export type WP12OfficialTimingInterfaceTarget = z.infer<typeof targetSchema>;

export function parseWP12OfficialTimingInterfaceTarget(input: unknown): WP12OfficialTimingInterfaceTarget {
  assertCanonicalData(input, 'target');
  const parsed = targetSchema.parse(input);
  for (const [name, value] of Object.entries(parsed.components)) {
    if (value.version.component !== name || parsed.component_hashes[name] !== hash(value)) {
      throw new Error(`FAIL_CLOSED: WP12 interface component hash differs for ${name}`);
    }
  }
  if (Object.keys(parsed.component_hashes).sort(compareText).join(',') !==
      Object.keys(parsed.components).sort(compareText).join(',') || stableSerialize(parsed) !== canonicalTarget) {
    throw new Error('FAIL_CLOSED: WP12 official timing interface target differs from the reviewed derivation');
  }
  return deepFreeze(parsed);
}

export const WP12_OFFICIAL_TIMING_INTERFACE_TARGET = parseWP12OfficialTimingInterfaceTarget(rawTarget);
export const WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_INTERFACE_TARGET);

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
