import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseWP12OfficialTimingPublicWireTarget,
  WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET,
  WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-public-wire-target';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';

function cloneTarget(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET);
}

describe('WP12 detached official timing public-wire target', () => {
  it('declares a separately versioned additive wire contract', () => {
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.wire_contract_id).toBe('f1ql-answer-wire-v2');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.predecessor_wire_contract_id).toBe('f1ql-answer-wire-v1');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.additive_only_change).toBe(true);
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.legacy_wire_v1).toEqual({
      envelope_mode: 'gated_execution',
      pre_activation_responses_byte_identical: true,
      regression_oracles_pin_existing_templates: true,
      official_timing_never_uses_legacy_envelope: true
    });
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.implementation_status)
      .toBe('contract_expectations_only_not_runtime_implementation');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.implementation_evidence).toBeNull();
  });

  it('seals both routes with unchanged request shape and guards', () => {
    const routes = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.routes;
    expect(routes.map(route => route.path)).toEqual(['/program/answer', '/nl-query']);
    const internal = routes[0];
    const publicRoute = routes[1];
    expect(internal.principal_classes).toEqual(['internal', 'internal_canary']);
    expect(publicRoute.principal_classes).toEqual(['public']);
    for (const route of routes) {
      expect(route.method).toBe('POST');
      expect(route.request_shape).toBe('exactly_one_question_string_field');
      expect(route.request_rejection).toEqual({
        status: 400,
        body: '{error:"answer_invalid",reason:"question_invalid"}'
      });
    }
    expect(internal.guards_unchanged).toContain('internal_bearer_principal');
    expect(publicRoute.guards_unchanged).toContain('public_ip_principal');
    expect(publicRoute.guards_unchanged).toContain('public_answer_availability');
    for (const route of routes) {
      for (const guard of [
        'kill_switch', 'release_attestation', 'subject_canary', 'template_cohort_canary', 'rate_limit'
      ]) {
        expect(route.guards_unchanged).toContain(guard);
      }
    }
  });

  it('seals the semantic success envelope and forbids every legacy field', () => {
    const envelope = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.official_timing_success_envelope;
    expect(envelope.envelope_mode).toBe('proven_semantic_result');
    expect(envelope.format_version).toBe('semantic-result-format-v32');
    expect(envelope.http_status).toBe(200);
    expect(envelope.content_type).toBe('application/json');
    expect(envelope.top_level_fields_in_order).toEqual([
      'mode', 'format_version', 'proof_hash', 'planned_f1ql_hash', 'core_hash', 'answer', 'rows', 'metadata'
    ]);
    expect(envelope.hash_fields_present).toEqual(['proof_hash', 'planned_f1ql_hash', 'core_hash']);
    expect(envelope.hash_fields_are_sha256_strings).toBe(true);
    expect(envelope.exactly_one_row).toBe(true);
    expect(envelope.internal_integrity_field_publicly_omitted).toBe(true);
    expect(envelope.catalog_hash_is_catalog_v2_target).toBe(true);
    expect(envelope.forbidden_legacy_fields).toEqual([
      'compiler_version', 'definitions_version', 'fact_space_version', 'program',
      'program_hash', 'rendering', 'template_id'
    ]);
    expect(envelope.no_template_id_or_legacy_authorization_claim).toBe(true);
    expect(envelope.prose_only_downgrade_allowed).toBe(false);
    expect(envelope.synthetic_legacy_authorization_allowed).toBe(false);
    expect(envelope.response_bytes_capped_by_runtime_config).toBe(true);
  });

  it('binds per-metric row contracts exactly to the activation bundle output schemas', () => {
    const rows = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.metric_row_contracts;
    expect(rows).toHaveLength(2);
    for (const [index, output] of WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas.entries()) {
      expect(rows[index].metric_id).toBe(output.metric_id);
      expect(rows[index].field_order).toEqual(output.field_ids);
      expect(rows[index].decimal_fields_scale_4_strings).toEqual(output.exact_decimal_fields);
      expect(rows[index].decimal_representation).toBe(output.decimal_representation);
      expect(rows[index].required_caveats).toEqual(output.required_caveats);
      expect(rows[index].nullable_fields).toEqual(['winner_driver_id']);
      expect(rows[index].provenance_fields).toEqual([
        'dataset_sha256', 'fact_fingerprint', 'identity_map_sha256', 'source_manifest_sha256'
      ]);
      expect(rows[index].advisories).toBe('absent');
      expect(output.internal_only_fields).toEqual(['f1ql_integrity_ok']);
      expect(rows[index].field_order).not.toContain('f1ql_integrity_ok');
    }
  });

  it('maps coverage and integrity abstentions to the closed 422 capability_unsupported shape', () => {
    const refusal = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.refusal_contract;
    expect(refusal.coverage_abstention_maps_to).toEqual({
      status: 422, error: 'capability_unsupported', reason: 'source_coverage_missing'
    });
    expect(refusal.integrity_abstention_maps_to).toEqual({
      status: 422, error: 'capability_unsupported', reason: 'source_integrity_failed'
    });
    expect(refusal.no_new_error_codes_introduced).toBe(true);
    expect(refusal.no_semantic_internals_in_error_bodies).toBe(true);
    expect(refusal.shapes_unchanged_from_active_route).toBe(true);
    expect(refusal.mappings_cover_representative_shapes_not_full_route_vocabulary).toBe(true);
    expect(refusal.active_reason_vocabularies_preserved_unmodified).toBe(true);
    expect(refusal.official_timing_pre_activation_reason).toBe('pace_source_disabled');
    expect(refusal.route_specific_reasons).toEqual({
      internal_only: ['answer_auth_not_configured', 'answer_authentication_required'],
      public_only: ['public_answer_disabled']
    });
    const statuses = refusal.mappings.map(mapping => mapping.status);
    expect(statuses).toEqual([400, 401, 422, 422, 422, 429, 499, 500, 503, 504]);
    const capability = refusal.mappings.find(mapping => mapping.error === 'capability_unsupported')!;
    expect(capability.reasons).toContain('source_coverage_missing');
    expect(capability.reasons).toContain('source_integrity_failed');
    const unavailable = refusal.mappings.find(mapping => mapping.status === 503)!;
    expect(unavailable.reasons).toContain('answer_busy');
    expect(refusal.mappings.find(mapping => mapping.status === 429)?.reasons)
      .toEqual(['rate_limit_exceeded']);
  });

  it('requires semantic capability authorization and forbids the legacy envelope', () => {
    const authorization = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.authorization;
    expect(authorization).toEqual({
      mechanism: 'semantic_capability_authorization_v34_one_time_release_bound',
      legacy_authorization_envelope_v14_used: false,
      release_attestation_version_required: 9,
      routing_mode_required: 'compositional_profiles',
      pre_activation_routing_template_only_answers_422: true,
      response_contains_no_authorization_material: true,
      public_route_requires_public_principal_in_release_allowlist: true
    });
  });

  it('binds upstream target hashes as literals matching the pinned composite hashes', () => {
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.activation_bundle_sha256)
      .toBe('e02ea6b00b55fbc8774c735b34eb04bf92177373fb31cd9c66079d8bb3f219aa');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.catalog_target_sha256)
      .toBe('46da8fc3918e9b0d8b948336f0cb52a5bac28436caf7455c894b360d6fba4b39');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.semantic_formatter_target_sha256)
      .toBe('7fd07011b34b79961731e6d92d7a16303a6efe9f8c1cebca99995944d4c5f978');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.capability_authorization_target_sha256)
      .toBe('a29948939f671224fc537de5aae2f514bc68f80a39516cf850424e7d31b45f03');
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.answer_question_target_sha256)
      .toBe('82ad5692b643ec161da15e4581c47c96487ffd9ba60084db18658dc27c62390d');
  });

  it('is detached from execution code and deeply frozen', () => {
    const source = readFileSync('src/f1ql/wp12-official-timing-public-wire-target.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:executor|interpreter|route|translator|semantic-plan-execution|semantic-result-format|result-database|answer-authorization|wp12-official-timing-interface-target|wp12-official-timing-semantic-target|wp12-official-timing-shadow-release-target|wp12-official-timing-migration-target)/);
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.metric_row_contracts)).toBe(true);
  });

  it('round-trips through the fail-closed parser', () => {
    expect(parseWP12OfficialTimingPublicWireTarget(cloneTarget()))
      .toEqual(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET);
    expect(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256)
      .toBe('ffe01b5cd6d3e6e9666cd663909b8b1960a9a2356d73c24fa6f58cde03c38bf0');
  });

  it.each([
    ['unknown target field', (target: any) => { target.extra = true; }],
    ['wire version', (target: any) => { target.wire_contract_id = 'f1ql-answer-wire-v3'; }],
    ['envelope mode', (target: any) => { target.contract.official_timing_success_envelope.envelope_mode = 'gated_execution'; }],
    ['forbidden legacy fields', (target: any) => { target.contract.official_timing_success_envelope.forbidden_legacy_fields.pop(); }],
    ['synthetic authorization', (target: any) => { target.contract.official_timing_success_envelope.synthetic_legacy_authorization_allowed = true; }],
    ['row contract order', (target: any) => { target.contract.metric_row_contracts[0].field_order.reverse(); }],
    ['coverage mapping', (target: any) => { target.contract.refusal_contract.coverage_abstention_maps_to.status = 503; }],
    ['authorization mechanism', (target: any) => { target.contract.authorization.legacy_authorization_envelope_v14_used = true; }],
    ['route removed', (target: any) => { target.contract.routes.pop(); }],
    ['implementation evidence', (target: any) => { target.implementation_evidence = {}; }]
  ])('rejects %s mutation', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingPublicWireTarget(target)).toThrow();
  });
});
