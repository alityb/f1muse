import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const textSchema = z.string().min(1).max(300);

const activationBundleSchema = z.object({
  version: z.literal(1),
  status: z.literal('inactive_atomic_bundle'),
  bundle_id: z.literal('wp12_official_timing_activation_v1'),
  baseline: z.object({
    lap_candidate_commit: commitSchema,
    event_mean_candidate_commit: commitSchema,
    active_catalog_version: z.number().int().positive(),
    active_catalog_sha256: sha256Schema,
    excluded_family: idSchema,
    answer_policy: z.literal('capability_unsupported')
  }).strict(),
  source: z.object({
    family_id: idSchema,
    source_id: idSchema,
    view: z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/),
    usage: z.literal('answer_fact'),
    governance: z.literal('certified'),
    authority: textSchema,
    classification: z.literal('official_raw_lap_timing'),
    view_security_barrier: z.literal(true),
    grain: z.object({
      kind: z.literal('driver_event_lap'),
      key: z.array(idSchema).min(1).max(5),
      uniqueness: z.literal('required')
    }).strict(),
    certified_scope: z.object({
      season: z.literal(2022),
      round: z.literal(14),
      session_type: z.literal('R'),
      event_name: z.literal('2022 Belgian Grand Prix'),
      dataset_sha256: sha256Schema,
      source_manifest_sha256: sha256Schema,
      identity_map_sha256: sha256Schema,
      identity_fingerprint: sha256Schema,
      fact_fingerprint: sha256Schema,
      race_history_artifact_sha256: sha256Schema,
      final_classification_artifact_sha256: sha256Schema,
      deleted_laps_artifact_sha256: sha256Schema,
      identity_count: z.literal(20),
      fact_count: z.literal(790),
      fact_bearing_driver_count: z.literal(19)
    }).strict(),
    target_view_columns: z.array(idSchema).min(1).max(30),
    inaccessible_columns: z.array(idSchema).min(1).max(10),
    concepts: z.array(z.object({
      id: idSchema,
      kind: z.enum(['dimension', 'measure', 'provenance']),
      physical_type: z.enum(['boolean', 'integer', 'numeric', 'text']),
      semantic_type: z.enum(['boolean', 'driver_id', 'duration_seconds_exact', 'lap', 'provenance', 'round', 'season', 'text']),
      operators: z.array(z.enum(['eq', 'range'])).max(2),
      physical_nullable: z.literal(true),
      nullable: z.literal(false),
      units: z.string().min(1).max(80).nullable(),
      null_meaning: textSchema,
      authority: textSchema,
      language_names: z.array(textSchema).min(1).max(8),
      allowed_values: z.array(textSchema).max(8)
    }).strict()).min(1).max(30),
    coverage: z.object({
      observed: textSchema,
      certified: textSchema,
      freshness: textSchema,
      unsupported: z.array(textSchema).min(1).max(20)
    }).strict(),
    prohibited_claims: z.array(idSchema).min(1).max(20)
  }).strict(),
  relationships: z.array(z.object({
    id: idSchema,
    from_source: idSchema,
    to_source: idSchema,
    from_keys: z.array(idSchema).min(1).max(5),
    to_keys: z.array(idSchema).min(1).max(5),
    cardinality: z.enum(['many_to_many', 'many_to_one']),
    direction: z.enum(['bidirectional', 'from_to']),
    optionality: z.literal('inner'),
    join_stage: z.enum(['resolution', 'row']),
    filter_propagation: z.enum(['resolved_identity', 'same_event']),
    governance: z.literal('verified'),
    required_branch_filters: z.array(idSchema).max(5),
    required_scope_predicates: z.array(z.object({
      side: z.enum(['from', 'to']),
      concept_id: idSchema,
      operator: z.literal('eq_parameter'),
      parameter: z.literal('season')
    }).strict()).max(5),
    required_checks: z.array(idSchema).min(1).max(12),
    integrity_checks: z.array(textSchema).min(1).max(10)
  }).strict()).length(3),
  metrics: z.array(z.object({
    metric_id: idSchema,
    aggregation: z.enum(['arithmetic_mean_integer_milliseconds', 'median_integer_milliseconds']),
    comparison: z.literal('lower_is_faster'),
    scope: z.enum(['one_certified_race_event_inclusive_lap_window', 'one_complete_certified_race_event']),
    complete_requested_window_required: z.boolean(),
    complete_classified_event_required: z.boolean(),
    maximum_inclusive_window_laps: z.number().int().positive().nullable(),
    expected_lap_sequence: z.literal('one_through_classified_laps').nullable(),
    minimum_eligible_laps_per_driver: z.literal(2),
    exclusions: z.array(idSchema).length(2),
    completed_lap_counts_may_differ: z.boolean()
  }).strict()).length(2),
  topologies: z.array(z.object({
    metric_id: idSchema,
    id: z.literal('same_source_scalar_comparison'),
    operator_signature: z.literal('limit(sort(project(compare(aggregate(filter(source)),aggregate(filter(source))))))'),
    source_id: idSchema,
    branch_ids: z.array(z.enum(['driver_a', 'driver_b'])).length(2),
    common_predicates: z.array(textSchema).min(1).max(8),
    window_predicate: textSchema.nullable(),
    pre_eligibility_predicates: z.array(textSchema).max(2),
    comparison: z.object({
      relation: z.literal('lower'),
      delta: z.literal('absolute'),
      winner_on_equal: z.null(),
      decimal_scale: z.literal(4)
    }).strict(),
    integrity_checks: z.array(idSchema).min(1).max(20),
    work: z.object({
      sources: z.literal(1),
      source_scans: z.literal(2),
      joins: z.literal(0),
      comparisons: z.literal(1),
      compositions: z.literal(0),
      requested_rows: z.literal(1)
    }).strict()
  }).strict()).length(2),
  coverage_decision: z.object({
    eligible_type: z.literal('eligible'),
    abstain_type: z.literal('abstain'),
    abstain_reason: z.literal('source_coverage_missing'),
    stage: z.literal('official_timing_coverage'),
    timing: z.literal('before_planning_and_result_execution'),
    integrity_failures_are_coverage: z.literal(false),
    integrity_failure_type: z.literal('abstain'),
    integrity_failure_reason: z.literal('source_integrity_failed'),
    integrity_failure_stage: z.literal('official_timing_integrity')
  }).strict(),
  output_schemas: z.array(z.object({
    metric_id: idSchema,
    field_ids: z.array(idSchema).min(1).max(30),
    exact_decimal_fields: z.array(idSchema).min(1).max(5),
    decimal_representation: z.enum([
      'canonical_exact_decimal_string_seconds_scale_4',
      'canonical_rounded_decimal_string_seconds_scale_4_half_away_from_zero'
    ]),
    field_order: z.literal('closed_emitter_order'),
    internal_only_fields: z.array(idSchema).min(1).max(5),
    required_caveats: z.array(idSchema).min(1).max(10)
  }).strict()).length(2),
  database: z.object({
    required_migrations: z.array(z.string().regex(/^20[0-9]{6}_[a-z0-9_]+\.sql$/)).length(3),
    target_activation_migration: z.string().regex(/^20[0-9]{6}_[a-z0-9_]+\.sql$/),
    target_activation_migration_sha256: sha256Schema,
    answer_role: idSchema,
    exact_select_relations_after_activation: z.array(z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/)).min(1).max(20),
    private_schema_access: z.literal('none'),
    writable_relations: z.literal(0),
    executable_routines: z.literal(0),
    database_temporary: z.literal(false),
    statement_timeout_required: z.literal(true),
    read_only_transaction_required: z.literal(true),
    binding_requirements: z.array(idSchema).min(1).max(20)
  }).strict(),
  versions: z.array(z.object({
    component: idSchema,
    current: z.union([z.string().min(1), z.number().int().positive()]),
    target: z.union([z.string().min(1), z.number().int().positive()]),
    transition: z.enum(['atomic', 'unchanged'])
  }).strict()).min(1).max(30),
  activation_attestation: z.object({
    required_target_hashes: z.array(idSchema).min(1).max(50),
    signed_release_attestation_required: z.literal(true),
    production_database_binding_required: z.literal(true),
    partial_hash_set_rejected: z.literal(true)
  }).strict(),
  non_execution: z.object({
    shadow_result_query_calls: z.literal(0),
    shadow_translated_execution: z.literal(false),
    coverage_query_calls_max: z.literal(1),
    coverage_reads: z.literal('fixed_read_only_timeout_bounded_and_fingerprinted'),
    coverage_queries: z.array(z.object({
      id: idSchema,
      metric_id: idSchema,
      target_relation: z.string().regex(/^f1ql\.[a-z][a-z0-9_]*$/),
      statement_sha256: sha256Schema,
      statement_timeout_ms: z.literal(2000),
      transaction: z.literal('repeatable_read_read_only'),
      maximum_rows: z.literal(2),
      projected_fields: z.array(idSchema).min(1).max(20),
      parameter_order: z.array(idSchema).min(1).max(10)
    }).strict()).length(2),
    forbidden_imports: z.array(textSchema).min(1).max(20),
    throwing_executor_test_required: z.literal(true)
  }).strict(),
  activation_gates: z.array(idSchema).min(1).max(40)
}).strict();

function activationConcept(
  id: string,
  kind: 'dimension' | 'measure' | 'provenance',
  physicalType: 'boolean' | 'integer' | 'numeric' | 'text',
  semanticType: 'boolean' | 'driver_id' | 'duration_seconds_exact' | 'lap' | 'provenance' | 'round' | 'season' | 'text',
  operators: Array<'eq' | 'range'>,
  units: string | null,
  languageNames: string[],
  allowedValues: string[] = []
) {
  return {
    id, kind, physical_type: physicalType, semantic_type: semanticType, operators,
    physical_nullable: true as const, nullable: false as const, units,
    null_meaning: `A null ${id} is outside the certified official timing contract.`,
    authority: 'Pinned sealed FIA Belgian 2022 official timing evidence.',
    language_names: languageNames,
    allowed_values: allowedValues
  };
}

export const WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL = `SELECT
  driver_id,
  COUNT(*)::integer AS completed_laps,
  COUNT(*) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker)::integer AS eligible_laps,
  COUNT(*) FILTER (WHERE official_deleted_lap)::integer AS deleted_laps,
  COUNT(*) FILTER (WHERE official_pit_marker)::integer AS pit_marker_laps,
  MIN(lap_number)::integer AS first_lap,
  MAX(lap_number)::integer AS last_lap,
  COUNT(DISTINCT lap_number)::integer AS distinct_laps,
  COUNT(DISTINCT dataset_sha256)::integer AS dataset_count
FROM f1ql.official_race_lap_timing
WHERE season = $1
  AND round = $2
  AND session_type = 'R'
  AND driver_id = ANY($3::text[])
GROUP BY driver_id
ORDER BY driver_id COLLATE "C" ASC`;

export const WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL = `SELECT
  driver_id,
  COUNT(*)::integer AS completed_laps,
  COUNT(*) FILTER (WHERE NOT official_deleted_lap AND NOT official_pit_marker)::integer AS eligible_laps,
  COUNT(*) FILTER (WHERE official_deleted_lap)::integer AS deleted_laps,
  COUNT(*) FILTER (WHERE official_pit_marker)::integer AS pit_marker_laps,
  MIN(lap_number)::integer AS first_lap,
  MAX(lap_number)::integer AS last_lap,
  COUNT(DISTINCT lap_number)::integer AS distinct_laps,
  COUNT(DISTINCT dataset_sha256)::integer AS dataset_count
FROM f1ql.official_race_lap_timing
WHERE season = $1
  AND round = $2
  AND session_type = 'R'
  AND driver_id = ANY($3::text[])
  AND lap_number BETWEEN $4 AND $5
GROUP BY driver_id
ORDER BY driver_id COLLATE "C" ASC`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const rawActivationBundle = {
  version: 1,
  status: 'inactive_atomic_bundle',
  bundle_id: 'wp12_official_timing_activation_v1',
  baseline: {
    lap_candidate_commit: 'e2ce639c9071fe966a2ebf6936d04a2590c7cd6d',
    event_mean_candidate_commit: '947214471d7c5fcd9d3e74b465cdeb2a63cd8e50',
    active_catalog_version: 1,
    active_catalog_sha256: '19312969ef88cd85533fbe92d17835c6525ad10c4d6ebe1b34b49fa4c4b3e3f8',
    excluded_family: 'official_historical_laps',
    answer_policy: 'capability_unsupported'
  },
  source: {
    family_id: 'official_historical_laps',
    source_id: 'official_race_lap_timing',
    view: 'f1ql.official_race_lap_timing',
    usage: 'answer_fact',
    governance: 'certified',
    authority: 'FIA official race timing documents',
    classification: 'official_raw_lap_timing',
    view_security_barrier: true,
    grain: {
      kind: 'driver_event_lap',
      key: ['season', 'round', 'driver_id', 'lap_number'],
      uniqueness: 'required'
    },
    certified_scope: {
      season: 2022,
      round: 14,
      session_type: 'R',
      event_name: '2022 Belgian Grand Prix',
      dataset_sha256: '81b7db4e84433ef879c1c6e0bfe08a1d7b36476d9d7f5a7b4cf414a5a0fbc37b',
      source_manifest_sha256: '491c7a7b01c9aa32742cfbf5b1b2cf3704e2ec7b48b84fbc08cdf2ea4df4caab',
      identity_map_sha256: '1b177167217c5ead145bbfb2669dde66e0c39296c09051a9d514a3ad1cc75cbd',
      identity_fingerprint: 'edc4d51451b2cd2cdaf87f9a0d8ee65a55cc10502345d7642731b389057682f3',
      fact_fingerprint: 'f31adb2eebb906017b9aaea2a63329e142012da7ed312cdfe26d19c7dce30d8f',
      race_history_artifact_sha256: '30f7db339b437cea5fd73f0a7bf6a3a16783119b3b62d07c5793934e2b26d105',
      final_classification_artifact_sha256: '85d9d3dc512d95b668377ca2b4167a7fe4218cd35bf30170764435e3f02b74df',
      deleted_laps_artifact_sha256: '112bfb62c955ec88971bf215280a94b500ddcdad02dcd79ebe0a8c07c44c1e52',
      identity_count: 20,
      fact_count: 790,
      fact_bearing_driver_count: 19
    },
    target_view_columns: [
      'authority', 'contract_version', 'dataset_sha256', 'driver_id', 'event_name', 'fact_fingerprint',
      'identity_fingerprint', 'identity_map_sha256', 'lap_number', 'lap_time_seconds',
      'official_deleted_lap', 'official_pit_marker', 'round', 'season', 'session_type',
      'source_artifact_sha256', 'source_manifest_sha256'
    ],
    inaccessible_columns: ['leader_gap_seconds', 'official_name', 'racing_number'],
    concepts: [
      activationConcept('authority', 'provenance', 'text', 'provenance', [], null, ['authority'], ['FIA']),
      activationConcept('contract_version', 'provenance', 'text', 'provenance', [], null, ['dataset contract']),
      activationConcept('dataset_sha256', 'provenance', 'text', 'provenance', [], null, ['dataset fingerprint']),
      activationConcept('driver_id', 'dimension', 'text', 'driver_id', ['eq'], null, ['driver']),
      activationConcept('event_name', 'dimension', 'text', 'text', [], null, ['race event']),
      activationConcept('fact_fingerprint', 'provenance', 'text', 'provenance', [], null, ['fact fingerprint']),
      activationConcept('identity_fingerprint', 'provenance', 'text', 'provenance', [], null, ['identity fingerprint']),
      activationConcept('identity_map_sha256', 'provenance', 'text', 'provenance', [], null, ['identity map fingerprint']),
      activationConcept('lap_number', 'dimension', 'integer', 'lap', ['range'], 'lap', ['lap number']),
      activationConcept('lap_time_seconds', 'measure', 'numeric', 'duration_seconds_exact', [], 'seconds at exact millisecond precision', ['official lap time']),
      activationConcept('official_deleted_lap', 'dimension', 'boolean', 'boolean', [], null, ['officially deleted lap']),
      activationConcept('official_pit_marker', 'dimension', 'boolean', 'boolean', [], null, ['explicit pit lap']),
      activationConcept('round', 'dimension', 'integer', 'round', ['eq'], 'round', ['round']),
      activationConcept('season', 'dimension', 'integer', 'season', ['eq'], 'season', ['season']),
      activationConcept('session_type', 'dimension', 'text', 'text', ['eq'], null, ['race session'], ['R']),
      activationConcept('source_artifact_sha256', 'provenance', 'text', 'provenance', [], null, ['source artifact fingerprint']),
      activationConcept('source_manifest_sha256', 'provenance', 'text', 'provenance', [], null, ['source manifest fingerprint'])
    ],
    coverage: {
      observed: 'Exactly 790 sealed completed-lap facts over 19 fact-bearing identities and 20 reviewed identities.',
      certified: 'Only FIA Belgian 2022 round 14 race timing under the exact pinned dataset and artifact hashes.',
      freshness: 'Immutable historical evidence; no latest-recorded or live semantics.',
      unsupported: ['Every other event or session.', 'Generic pace and unreviewed race-state context.']
    },
    prohibited_claims: [
      'causal_performance', 'clean_air', 'fastest_lap', 'fuel', 'generic_average', 'generic_median',
      'generic_pace', 'safety_car', 'strategy', 'traffic', 'tyre', 'weather'
    ]
  },
  relationships: [
    {
      id: 'official_timing_driver_resolution',
      from_source: 'answer_driver_identity',
      to_source: 'official_race_lap_timing',
      from_keys: ['driver_id'],
      to_keys: ['driver_id'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['certified_scope_pin', 'deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one canonical governed driver before applying an official timing fact filter.']
    },
    {
      id: 'official_timing_event_resolution',
      from_source: 'answer_event_identity',
      to_source: 'official_race_lap_timing',
      from_keys: ['season', 'round'],
      to_keys: ['season', 'round'],
      cardinality: 'many_to_many',
      direction: 'from_to',
      optionality: 'inner',
      join_stage: 'resolution',
      filter_propagation: 'resolved_identity',
      governance: 'verified',
      required_branch_filters: [],
      required_scope_predicates: [],
      required_checks: ['certified_scope_pin', 'deduplicate_keys', 'single_resolved_key'],
      integrity_checks: ['Resolve exactly one certified season-round key before applying official timing fact filters.']
    },
    {
      id: 'official_timing_shared_event',
      from_source: 'official_race_lap_timing',
      to_source: 'official_race_lap_timing',
      from_keys: ['dataset_sha256', 'season', 'round'],
      to_keys: ['dataset_sha256', 'season', 'round'],
      cardinality: 'many_to_many',
      direction: 'bidirectional',
      optionality: 'inner',
      join_stage: 'row',
      filter_propagation: 'same_event',
      governance: 'verified',
      required_branch_filters: ['driver_id'],
      required_scope_predicates: [],
      required_checks: ['certified_scope_pin', 'source_presence', 'unique_filtered_branch'],
      integrity_checks: ['Filter each branch to one distinct driver.', 'Require complete unique driver-event-lap grain under one certified dataset.']
    }
  ],
  metrics: [
    {
      metric_id: 'official_non_deleted_non_pit_event_mean_v1',
      aggregation: 'arithmetic_mean_integer_milliseconds',
      comparison: 'lower_is_faster',
      scope: 'one_complete_certified_race_event',
      complete_requested_window_required: false,
      complete_classified_event_required: true,
      maximum_inclusive_window_laps: null,
      expected_lap_sequence: 'one_through_classified_laps',
      minimum_eligible_laps_per_driver: 2,
      exclusions: ['official_deleted_lap', 'official_pit_marker'],
      completed_lap_counts_may_differ: true
    },
    {
      metric_id: 'official_non_deleted_non_pit_window_median_v1',
      aggregation: 'median_integer_milliseconds',
      comparison: 'lower_is_faster',
      scope: 'one_certified_race_event_inclusive_lap_window',
      complete_requested_window_required: true,
      complete_classified_event_required: false,
      maximum_inclusive_window_laps: 50,
      expected_lap_sequence: null,
      minimum_eligible_laps_per_driver: 2,
      exclusions: ['official_deleted_lap', 'official_pit_marker'],
      completed_lap_counts_may_differ: false
    }
  ],
  topologies: [
    {
      metric_id: 'official_non_deleted_non_pit_event_mean_v1',
      id: 'same_source_scalar_comparison',
      operator_signature: 'limit(sort(project(compare(aggregate(filter(source)),aggregate(filter(source))))))',
      source_id: 'official_race_lap_timing',
      branch_ids: ['driver_a', 'driver_b'],
      common_predicates: ['driver_id:eq:branch_local', 'round:eq:14', 'season:eq:2022', 'session_type:eq:R'],
      window_predicate: null,
      pre_eligibility_predicates: [],
      comparison: { relation: 'lower', delta: 'absolute', winner_on_equal: null, decimal_scale: 4 },
      integrity_checks: [
        'certified_scope_pin', 'complete_classified_event', 'distinct_branch_entities',
        'exact_integer_milliseconds', 'exactly_one_dataset', 'exactly_one_scalar_per_branch',
        'non_overlapping_exclusions', 'source_presence', 'unique_grain'
      ],
      work: { sources: 1, source_scans: 2, joins: 0, comparisons: 1, compositions: 0, requested_rows: 1 }
    },
    {
      metric_id: 'official_non_deleted_non_pit_window_median_v1',
      id: 'same_source_scalar_comparison',
      operator_signature: 'limit(sort(project(compare(aggregate(filter(source)),aggregate(filter(source))))))',
      source_id: 'official_race_lap_timing',
      branch_ids: ['driver_a', 'driver_b'],
      common_predicates: ['driver_id:eq:branch_local', 'round:eq:14', 'season:eq:2022', 'session_type:eq:R'],
      window_predicate: 'lap_number:range:inclusive:max_50',
      pre_eligibility_predicates: [],
      comparison: { relation: 'lower', delta: 'absolute', winner_on_equal: null, decimal_scale: 4 },
      integrity_checks: [
        'certified_scope_pin', 'complete_requested_window', 'distinct_branch_entities',
        'exact_integer_milliseconds', 'exactly_one_dataset', 'exactly_one_scalar_per_branch',
        'non_overlapping_exclusions', 'source_presence', 'unique_grain'
      ],
      work: { sources: 1, source_scans: 2, joins: 0, comparisons: 1, compositions: 0, requested_rows: 1 }
    }
  ],
  coverage_decision: {
    eligible_type: 'eligible',
    abstain_type: 'abstain',
    abstain_reason: 'source_coverage_missing',
    stage: 'official_timing_coverage',
    timing: 'before_planning_and_result_execution',
    integrity_failures_are_coverage: false,
    integrity_failure_type: 'abstain',
    integrity_failure_reason: 'source_integrity_failed',
    integrity_failure_stage: 'official_timing_integrity'
  },
  output_schemas: [
    {
      metric_id: 'official_non_deleted_non_pit_event_mean_v1',
      field_ids: [
        'driver_a_id', 'driver_b_id', 'metric_id', 'season', 'round', 'session_type', 'event_name',
        'driver_a_completed_laps', 'driver_b_completed_laps', 'driver_a_eligible_laps', 'driver_b_eligible_laps',
        'driver_a_excluded_deleted_laps', 'driver_b_excluded_deleted_laps',
        'driver_a_excluded_pit_marker_laps', 'driver_b_excluded_pit_marker_laps',
        'driver_a_mean_lap_time_seconds', 'driver_b_mean_lap_time_seconds', 'mean_delta_seconds',
        'winner_driver_id', 'dataset_sha256', 'source_manifest_sha256', 'identity_map_sha256', 'fact_fingerprint'
      ],
      exact_decimal_fields: ['driver_a_mean_lap_time_seconds', 'driver_b_mean_lap_time_seconds', 'mean_delta_seconds'],
      decimal_representation: 'canonical_rounded_decimal_string_seconds_scale_4_half_away_from_zero',
      field_order: 'closed_emitter_order',
      internal_only_fields: ['f1ql_integrity_ok'],
      required_caveats: [
        'all_completed_laps_per_driver_with_asymmetric_counts_disclosed', 'fia_official_raw_race_lap_timing',
        'not_clean_air_or_causal_pace', 'official_deleted_and_explicit_pit_rows_excluded',
        'race_state_effects_included'
      ]
    },
    {
      metric_id: 'official_non_deleted_non_pit_window_median_v1',
      field_ids: [
        'driver_a_id', 'driver_b_id', 'metric_id', 'season', 'round', 'session_type', 'event_name',
        'lap_start', 'lap_end', 'requested_laps_per_driver', 'driver_a_eligible_laps', 'driver_b_eligible_laps',
        'driver_a_excluded_deleted_laps', 'driver_b_excluded_deleted_laps',
        'driver_a_excluded_pit_marker_laps', 'driver_b_excluded_pit_marker_laps',
        'driver_a_median_lap_time_seconds', 'driver_b_median_lap_time_seconds', 'median_delta_seconds',
        'winner_driver_id', 'dataset_sha256', 'source_manifest_sha256', 'identity_map_sha256', 'fact_fingerprint'
      ],
      exact_decimal_fields: ['driver_a_median_lap_time_seconds', 'driver_b_median_lap_time_seconds', 'median_delta_seconds'],
      decimal_representation: 'canonical_exact_decimal_string_seconds_scale_4',
      field_order: 'closed_emitter_order',
      internal_only_fields: ['f1ql_integrity_ok'],
      required_caveats: [
        'fia_official_raw_race_lap_timing', 'not_clean_air_or_causal_pace',
        'official_deleted_and_explicit_pit_rows_excluded', 'race_state_effects_included'
      ]
    }
  ],
  database: {
    required_migrations: [
      '20260801_official_timing_historical_laps.sql',
      '20260802_f1ql_official_lap_timing.sql',
      '20260807_f1ql_official_race_lap_timing_activation.sql'
    ],
    target_activation_migration: '20260807_f1ql_official_race_lap_timing_activation.sql',
    target_activation_migration_sha256: 'f4807adeea81b8555e750e0950efd62745c56665d4d63b6641273fb027381735',
    answer_role: 'f1ql_answer',
    exact_select_relations_after_activation: [
      'f1ql.answer_driver_identity', 'f1ql.answer_event_identity', 'f1ql.answer_season_participation',
      'f1ql.driver_standings', 'f1ql.event_classification', 'f1ql.event_metadata',
      'f1ql.official_race_lap_timing', 'f1ql.qualifying_classification'
    ],
    private_schema_access: 'none',
    writable_relations: 0,
    executable_routines: 0,
    database_temporary: false,
    statement_timeout_required: true,
    read_only_transaction_required: true,
    binding_requirements: [
      'certified_dataset_pins', 'column_names', 'column_nullability', 'column_types', 'definition_sha256',
      'exact_principal_relations', 'grain_uniqueness', 'owner', 'relation_options', 'security_barrier'
    ]
  },
  versions: [
    { component: 'answer_authorization_code', current: 'answer-authorization-v27', target: 'answer-authorization-v28', transition: 'atomic' },
    { component: 'answer_question', current: 'answer-question-v27', target: 'answer-question-v28', transition: 'atomic' },
    { component: 'candidate_proposal', current: 1, target: 2, transition: 'atomic' },
    { component: 'catalog', current: 1, target: 2, transition: 'atomic' },
    { component: 'capability_authorization', current: 'semantic-capability-authorization-v33', target: 'semantic-capability-authorization-v34', transition: 'atomic' },
    { component: 'capability_profile', current: 33, target: 34, transition: 'atomic' },
    { component: 'fact_space', current: 'source-views-v3', target: 'source-views-v4', transition: 'atomic' },
    { component: 'legacy_compiler', current: 'core-v11', target: 'core-v11', transition: 'unchanged' },
    { component: 'legacy_definitions', current: 'v10', target: 'v10', transition: 'unchanged' },
    { component: 'plan_work_model', current: 'semantic-plan-work-v1', target: 'semantic-plan-work-v2', transition: 'atomic' },
    { component: 'planned_compiler', current: 'planned-compiler-v2', target: 'planned-compiler-v3', transition: 'atomic' },
    { component: 'planned_cost', current: 'planned-cost-v1', target: 'planned-cost-v2', transition: 'atomic' },
    { component: 'planned_f1ql', current: 2, target: 3, transition: 'atomic' },
    { component: 'planned_pipeline', current: 'planned-pipeline-v1', target: 'planned-pipeline-v2', transition: 'atomic' },
    { component: 'planner', current: 'semantic-planner-v2', target: 'semantic-planner-v3', transition: 'atomic' },
    { component: 'plan_execution_result', current: 'semantic-plan-execution-result-v2', target: 'semantic-plan-execution-result-v3', transition: 'atomic' },
    { component: 'principal_audit', current: 4, target: 5, transition: 'atomic' },
    { component: 'release_attestation', current: 8, target: 9, transition: 'atomic' },
    { component: 'resolution_evidence', current: 'semantic-resolution-v1', target: 'semantic-resolution-v2', transition: 'atomic' },
    { component: 'result_collection', current: 'semantic-limit-plus-one-v1', target: 'semantic-limit-plus-one-v1', transition: 'unchanged' },
    { component: 'result_formatter', current: 'semantic-result-format-v31', target: 'semantic-result-format-v32', transition: 'atomic' },
    { component: 'semantic_evidence', current: 2, target: 3, transition: 'atomic' },
    { component: 'semantic_answer_compatibility', current: 'semantic-answer-compatibility-v4', target: 'semantic-answer-compatibility-v5', transition: 'atomic' },
    { component: 'semantic_plan_proof', current: 'semantic-plan-proof-v1', target: 'semantic-plan-proof-v2', transition: 'atomic' },
    { component: 'semantic_query', current: 2, target: 3, transition: 'atomic' },
    { component: 'semantic_response_equivalence', current: 'semantic-response-equivalence-v4', target: 'semantic-response-equivalence-v5', transition: 'atomic' },
    { component: 'semantic_template_equivalence', current: 'semantic-template-equivalence-v9', target: 'semantic-template-equivalence-v10', transition: 'atomic' },
    { component: 'shadow_observation', current: 'semantic-shadow-observation-v1', target: 'semantic-shadow-observation-v2', transition: 'atomic' },
    { component: 'shadow_orchestrator', current: 'semantic-shadow-planner-v6', target: 'semantic-shadow-planner-v7', transition: 'atomic' },
    { component: 'shadow_retained_observation', current: 'semantic-shadow-retained-v2', target: 'semantic-shadow-retained-v3', transition: 'atomic' }
  ],
  activation_attestation: {
    required_target_hashes: [
      'activation_migration', 'answer_authorization_code', 'answer_question', 'candidate_proposal',
      'capability_authorization', 'capability_profile', 'capability_registry', 'catalog', 'catalog_database_binding',
      'fact_space', 'plan_execution_result', 'plan_work_model', 'planned_compiler', 'planned_cost',
      'planned_f1ql', 'planned_pipeline', 'planner', 'principal_audit', 'provider_schema',
      'release_attestation', 'resolution_evidence', 'result_formatter', 'semantic_answer_compatibility',
      'semantic_evidence', 'semantic_plan_proof', 'semantic_query', 'semantic_response_equivalence',
      'semantic_template_equivalence', 'shadow_observation', 'shadow_orchestrator',
      'shadow_retained_observation'
    ],
    signed_release_attestation_required: true,
    production_database_binding_required: true,
    partial_hash_set_rejected: true
  },
  non_execution: {
    shadow_result_query_calls: 0,
    shadow_translated_execution: false,
    coverage_query_calls_max: 1,
    coverage_reads: 'fixed_read_only_timeout_bounded_and_fingerprinted',
    coverage_queries: [
      {
        id: 'official_event_coverage_v1',
        metric_id: 'official_non_deleted_non_pit_event_mean_v1',
        target_relation: 'f1ql.official_race_lap_timing',
        statement_sha256: sha256(WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL),
        statement_timeout_ms: 2000,
        transaction: 'repeatable_read_read_only',
        maximum_rows: 2,
        projected_fields: [
          'driver_id', 'completed_laps', 'eligible_laps', 'deleted_laps', 'pit_marker_laps',
          'first_lap', 'last_lap', 'distinct_laps', 'dataset_count'
        ],
        parameter_order: ['season', 'round', 'driver_ids']
      },
      {
        id: 'official_window_coverage_v1',
        metric_id: 'official_non_deleted_non_pit_window_median_v1',
        target_relation: 'f1ql.official_race_lap_timing',
        statement_sha256: sha256(WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL),
        statement_timeout_ms: 2000,
        transaction: 'repeatable_read_read_only',
        maximum_rows: 2,
        projected_fields: [
          'driver_id', 'completed_laps', 'eligible_laps', 'deleted_laps', 'pit_marker_laps',
          'first_lap', 'last_lap', 'distinct_laps', 'dataset_count'
        ],
        parameter_order: ['season', 'round', 'driver_ids', 'lap_start', 'lap_end']
      }
    ],
    forbidden_imports: [
      'answer_authorization', 'executor', 'interpreter', 'pg', 'program_answer_route',
      'result_database', 'semantic_plan_execution', 'semantic_result_format'
    ],
    throwing_executor_test_required: true
  },
  activation_gates: [
    'answer_policy_release_binding', 'atomic_version_transition', 'catalog_database_binding',
    'catalog_source_and_relationships', 'closed_compiler_regression', 'coverage_abstention',
    'database_migrations_applied', 'deterministic_provider_admission', 'formatter_exact_row_contract',
    'immutable_dataset_ingested', 'internal_canary', 'least_privilege_principal', 'mutation_suite',
    'planned_compiler_reference_parity', 'production_round_trip', 'proof_and_authorization',
    'provider_evidence', 'public_canary', 'release_attestation', 'shadow_non_execution',
    'source_integrity', 'worst_case_benchmark'
  ]
} as const;

export type WP12OfficialTimingActivationBundle = z.infer<typeof activationBundleSchema>;

const canonicalActivationSerialization = stableSerialize(rawActivationBundle);

export function parseWP12OfficialTimingActivationBundle(input: unknown): WP12OfficialTimingActivationBundle {
  const parsed = activationBundleSchema.parse(input);
  if (stableSerialize(parsed) !== canonicalActivationSerialization) {
    throw new Error('FAIL_CLOSED: WP12 official timing activation bundle differs from the reviewed contract');
  }
  return deepFreeze(parsed);
}

export const WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE = parseWP12OfficialTimingActivationBundle(rawActivationBundle);
export const WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256 = createHash('sha256')
  .update(canonicalActivationSerialization)
  .digest('hex');

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
