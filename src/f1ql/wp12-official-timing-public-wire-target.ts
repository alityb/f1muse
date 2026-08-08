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
const WP12_OFFICIAL_TIMING_SEMANTIC_FORMATTER_TARGET_SHA256 =
  '7fd07011b34b79961731e6d92d7a16303a6efe9f8c1cebca99995944d4c5f978';
const WP12_OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_TARGET_SHA256 =
  'a29948939f671224fc537de5aae2f514bc68f80a39516cf850424e7d31b45f03';
const WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET_SHA256 =
  '82ad5692b643ec161da15e4581c47c96487ffd9ba60084db18658dc27c62390d';

const targetSchema = z.object({
  version: z.literal(1),
  status: statusSchema,
  implementation_status: implementationStatusSchema,
  wire_contract_id: z.literal('f1ql-answer-wire-v2'),
  predecessor_wire_contract_id: z.literal('f1ql-answer-wire-v1'),
  activation_bundle_sha256: sha256Schema,
  catalog_target_sha256: sha256Schema,
  semantic_formatter_target_sha256: sha256Schema,
  capability_authorization_target_sha256: sha256Schema,
  answer_question_target_sha256: sha256Schema,
  contract: z.object({
    routes: z.array(z.object({
      path: z.enum(['/program/answer', '/nl-query']),
      method: z.literal('POST'),
      principal_classes: z.array(z.enum(['internal', 'internal_canary', 'public'])).min(1),
      request_shape: z.literal('exactly_one_question_string_field'),
      request_rejection: z.object({
        status: z.literal(400),
        body: z.literal('{error:"answer_invalid",reason:"question_invalid"}')
      }).strict(),
      guards_unchanged: z.array(idSchema).min(1)
    }).strict()).length(2),
    additive_only_change: z.literal(true),
    legacy_wire_v1: z.object({
      envelope_mode: z.literal('gated_execution'),
      pre_activation_responses_byte_identical: z.literal(true),
      regression_oracles_pin_existing_templates: z.literal(true),
      official_timing_never_uses_legacy_envelope: z.literal(true)
    }).strict(),
    official_timing_success_envelope: z.object({
      envelope_mode: z.literal('proven_semantic_result'),
      format_version: z.literal('semantic-result-format-v32'),
      http_status: z.literal(200),
      content_type: z.literal('application/json'),
      top_level_fields_in_order: z.array(idSchema).length(8),
      hash_fields_present: z.tuple([
        z.literal('proof_hash'), z.literal('planned_f1ql_hash'), z.literal('core_hash')
      ]),
      hash_fields_are_sha256_strings: z.literal(true),
      answer_shape: z.literal('headline_and_facts'),
      exactly_one_row: z.literal(true),
      metadata_fields: z.array(idSchema).min(1),
      catalog_hash_is_catalog_v2_target: z.literal(true),
      internal_integrity_field_publicly_omitted: z.literal(true),
      forbidden_legacy_fields: z.array(idSchema).min(1),
      no_template_id_or_legacy_authorization_claim: z.literal(true),
      prose_only_downgrade_allowed: z.literal(false),
      synthetic_legacy_authorization_allowed: z.literal(false),
      response_bytes_capped_by_runtime_config: z.literal(true)
    }).strict(),
    metric_row_contracts: z.array(z.object({
      metric_id: idSchema,
      field_order: z.array(idSchema).min(1),
      decimal_fields_scale_4_strings: z.array(idSchema).length(3),
      decimal_representation: z.enum([
        'canonical_exact_decimal_string_seconds_scale_4',
        'canonical_rounded_decimal_string_seconds_scale_4_half_away_from_zero'
      ]),
      nullable_fields: z.tuple([z.literal('winner_driver_id')]),
      fixed_scope_fields: z.array(idSchema).min(1),
      provenance_fields: z.array(idSchema).length(4),
      required_caveats: z.array(idSchema).min(1),
      advisories: z.literal('absent')
    }).strict()).length(2),
    refusal_contract: z.object({
      shapes_unchanged_from_active_route: z.literal(true),
      success_status: z.literal(200),
      mappings: z.array(z.object({
        status: z.number().int(),
        error: z.string().min(1).max(60),
        reasons: z.array(z.string().min(1).max(80)).min(1)
      }).strict()).min(1),
      mappings_cover_representative_shapes_not_full_route_vocabulary: z.literal(true),
      active_reason_vocabularies_preserved_unmodified: z.literal(true),
      official_timing_pre_activation_reason: z.literal('pace_source_disabled'),
      route_specific_reasons: z.object({
        internal_only: z.array(z.string().min(1).max(80)).min(1),
        public_only: z.array(z.string().min(1).max(80)).min(1)
      }).strict(),
      coverage_abstention_maps_to: z.object({
        status: z.literal(422),
        error: z.literal('capability_unsupported'),
        reason: z.literal('source_coverage_missing')
      }).strict(),
      integrity_abstention_maps_to: z.object({
        status: z.literal(422),
        error: z.literal('capability_unsupported'),
        reason: z.literal('source_integrity_failed')
      }).strict(),
      no_new_error_codes_introduced: z.literal(true),
      no_semantic_internals_in_error_bodies: z.literal(true)
    }).strict(),
    authorization: z.object({
      mechanism: z.literal('semantic_capability_authorization_v34_one_time_release_bound'),
      legacy_authorization_envelope_v14_used: z.literal(false),
      release_attestation_version_required: z.literal(9),
      routing_mode_required: z.literal('compositional_profiles'),
      pre_activation_routing_template_only_answers_422: z.literal(true),
      response_contains_no_authorization_material: z.literal(true),
      public_route_requires_public_principal_in_release_allowlist: z.literal(true)
    }).strict()
  }).strict(),
  implementation_evidence: z.null()
}).strict();

const bundle = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE;
const fixedScopeFields = ['event_name', 'metric_id', 'round', 'season', 'session_type'] as const;
const provenanceFields = ['dataset_sha256', 'fact_fingerprint', 'identity_map_sha256', 'source_manifest_sha256'] as const;

const rawTarget = {
  version: 1,
  status: 'detached_inactive_target',
  implementation_status: 'contract_expectations_only_not_runtime_implementation',
  wire_contract_id: 'f1ql-answer-wire-v2',
  predecessor_wire_contract_id: 'f1ql-answer-wire-v1',
  activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
  catalog_target_sha256: WP12_OFFICIAL_TIMING_CATALOG_TARGET_SHA256,
  semantic_formatter_target_sha256: WP12_OFFICIAL_TIMING_SEMANTIC_FORMATTER_TARGET_SHA256,
  capability_authorization_target_sha256: WP12_OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_TARGET_SHA256,
  answer_question_target_sha256: WP12_OFFICIAL_TIMING_ANSWER_QUESTION_TARGET_SHA256,
  contract: {
    routes: [
      {
        path: '/program/answer',
        method: 'POST',
        principal_classes: ['internal', 'internal_canary'],
        request_shape: 'exactly_one_question_string_field',
        request_rejection: { status: 400, body: '{error:"answer_invalid",reason:"question_invalid"}' },
        guards_unchanged: [
          'admission_control', 'answer_availability', 'internal_bearer_principal', 'kill_switch',
          'rate_limit', 'release_attestation', 'subject_canary', 'template_cohort_canary'
        ].sort(compareText)
      },
      {
        path: '/nl-query',
        method: 'POST',
        principal_classes: ['public'],
        request_shape: 'exactly_one_question_string_field',
        request_rejection: { status: 400, body: '{error:"answer_invalid",reason:"question_invalid"}' },
        guards_unchanged: [
          'admission_control', 'answer_availability', 'kill_switch', 'public_answer_availability',
          'public_ip_principal', 'rate_limit', 'release_attestation', 'subject_canary',
          'template_cohort_canary'
        ].sort(compareText)
      }
    ],
    additive_only_change: true,
    legacy_wire_v1: {
      envelope_mode: 'gated_execution',
      pre_activation_responses_byte_identical: true,
      regression_oracles_pin_existing_templates: true,
      official_timing_never_uses_legacy_envelope: true
    },
    official_timing_success_envelope: {
      envelope_mode: 'proven_semantic_result',
      format_version: 'semantic-result-format-v32',
      http_status: 200,
      content_type: 'application/json',
      top_level_fields_in_order: [
        'mode', 'format_version', 'proof_hash', 'planned_f1ql_hash', 'core_hash', 'answer', 'rows', 'metadata'
      ],
      hash_fields_present: ['proof_hash', 'planned_f1ql_hash', 'core_hash'],
      hash_fields_are_sha256_strings: true,
      answer_shape: 'headline_and_facts',
      exactly_one_row: true,
      metadata_fields: [
        'aggregations', 'catalog_hash', 'caveats', 'columns', 'coverage', 'ordering', 'scope', 'sources'
      ].sort(compareText),
      catalog_hash_is_catalog_v2_target: true,
      internal_integrity_field_publicly_omitted: true,
      forbidden_legacy_fields: [
        'compiler_version', 'definitions_version', 'fact_space_version', 'program',
        'program_hash', 'rendering', 'template_id'
      ].sort(compareText),
      no_template_id_or_legacy_authorization_claim: true,
      prose_only_downgrade_allowed: false,
      synthetic_legacy_authorization_allowed: false,
      response_bytes_capped_by_runtime_config: true
    },
    metric_row_contracts: bundle.output_schemas.map(output => ({
      metric_id: output.metric_id,
      field_order: output.field_ids,
      decimal_fields_scale_4_strings: output.exact_decimal_fields,
      decimal_representation: output.decimal_representation,
      nullable_fields: ['winner_driver_id'],
      fixed_scope_fields: [...fixedScopeFields],
      provenance_fields: [...provenanceFields],
      required_caveats: output.required_caveats,
      advisories: 'absent'
    })),
    refusal_contract: {
      shapes_unchanged_from_active_route: true,
      success_status: 200,
      mappings: [
        { status: 400, error: 'answer_invalid', reasons: ['question_invalid'] },
        { status: 401, error: 'answer_unauthorized', reasons: ['answer_authentication_required'] },
        { status: 422, error: 'capability_unsupported', reasons: [
          'aggregate_locality_unsupported', 'source_coverage_missing', 'source_integrity_failed',
          'unsupported_comparison', 'unsupported_concept', 'unsupported_scope', 'unsupported_topology'
        ].sort(compareText) },
        { status: 422, error: 'clarification_required', reasons: [
          'entity_ambiguous', 'event_ambiguous', 'metric_ambiguous', 'season_missing', 'session_ambiguous'
        ].sort(compareText) },
        { status: 422, error: 'answer_bound_exceeded', reasons: [
          'response_bytes', 'rows', 'work_units'
        ].sort(compareText) },
        { status: 429, error: 'answer_unavailable', reasons: ['rate_limit_exceeded'] },
        { status: 499, error: 'answer_unavailable', reasons: ['request_cancelled'] },
        { status: 500, error: 'answer_failed', reasons: [
          'authorization_envelope_failed', 'budget_estimation_failed', 'execution_failed', 'unexpected_error'
        ].sort(compareText) },
        { status: 503, error: 'answer_unavailable', reasons: [
          'answer_auth_not_configured', 'answer_busy', 'answer_database_not_configured', 'answer_disabled',
          'canary_control', 'kill_switch_active', 'linking_unavailable', 'public_answer_disabled',
          'release_not_approved'
        ].sort(compareText) },
        { status: 504, error: 'answer_unavailable', reasons: ['request_timeout', 'statement_timeout'] }
      ],
      mappings_cover_representative_shapes_not_full_route_vocabulary: true,
      active_reason_vocabularies_preserved_unmodified: true,
      official_timing_pre_activation_reason: 'pace_source_disabled',
      route_specific_reasons: {
        internal_only: ['answer_auth_not_configured', 'answer_authentication_required'],
        public_only: ['public_answer_disabled']
      },
      coverage_abstention_maps_to: {
        status: 422,
        error: 'capability_unsupported',
        reason: 'source_coverage_missing'
      },
      integrity_abstention_maps_to: {
        status: 422,
        error: 'capability_unsupported',
        reason: 'source_integrity_failed'
      },
      no_new_error_codes_introduced: true,
      no_semantic_internals_in_error_bodies: true
    },
    authorization: {
      mechanism: 'semantic_capability_authorization_v34_one_time_release_bound',
      legacy_authorization_envelope_v14_used: false,
      release_attestation_version_required: 9,
      routing_mode_required: 'compositional_profiles',
      pre_activation_routing_template_only_answers_422: true,
      response_contains_no_authorization_material: true,
      public_route_requires_public_principal_in_release_allowlist: true
    }
  },
  implementation_evidence: null
} as const;
const canonicalTarget = stableSerialize(rawTarget);

export type WP12OfficialTimingPublicWireTarget = z.infer<typeof targetSchema>;

export function parseWP12OfficialTimingPublicWireTarget(input: unknown): WP12OfficialTimingPublicWireTarget {
  assertCanonicalData(input, 'target');
  const parsed = targetSchema.parse(input);
  if (stableSerialize(parsed) !== canonicalTarget) {
    throw new Error('FAIL_CLOSED: WP12 official timing public-wire target differs from the reviewed derivation');
  }
  return deepFreeze(parsed);
}

export const WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET = parseWP12OfficialTimingPublicWireTarget(rawTarget);
export const WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 = hash(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET);

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
