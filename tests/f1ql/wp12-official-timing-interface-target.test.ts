import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANSWER_AUTHORIZATION_VERSION } from '../../src/f1ql/answer-authorization';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { ANSWER_QUESTION_CONTRACT_VERSION } from '../../src/f1ql/answer-question';
import { ANSWER_AUTHORIZATION_CODE_VERSION, ANSWER_RELEASE_ATTESTATION_VERSION } from '../../src/f1ql/answer-release-attestation';
import { ANSWER_TEMPLATE_IDS, ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from '../../src/f1ql/answer-templates';
import { F1QL_FACT_SPACE_VERSION } from '../../src/f1ql/fact-space-version';
import { SEMANTIC_ANSWER_COMPATIBILITY_VERSION } from '../../src/f1ql/semantic-answer-compatibility-version';
import {
  SEMANTIC_CANDIDATE_CATALOG_PROJECTION_SHA256,
  SEMANTIC_CANDIDATE_PROPOSAL_VERSION,
  SEMANTIC_CANDIDATE_SCHEMA_NAME,
  SEMANTIC_CANDIDATE_SCHEMA_SHA256
} from '../../src/f1ql/semantic-candidate-translator';
import { SEMANTIC_RESPONSE_EQUIVALENCE_VERSION } from '../../src/f1ql/semantic-response-equivalence';
import { SEMANTIC_TEMPLATE_EQUIVALENCE, SEMANTIC_TEMPLATE_EQUIVALENCE_VERSION } from '../../src/f1ql/semantic-template-equivalence';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 } from '../../src/f1ql/wp12-official-timing-public-wire-target';
import {
  WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES,
  WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-semantic-target';
import {
  parseWP12OfficialTimingInterfaceTarget,
  WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES,
  WP12_OFFICIAL_TIMING_INTERFACE_TARGET,
  WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-interface-target';

function cloneTarget(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_INTERFACE_TARGET);
}

describe('WP12 detached official timing interface target', () => {
  it('binds the seven bundle transitions and one proposal-derived provider schema version', () => {
    expect(Object.fromEntries(Object.entries(WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components)
      .map(([name, target]) => [name, target.version.target]))).toEqual({
      answer_question: 'answer-question-v28',
      candidate_proposal: 2,
      provider_schema: 2,
      fact_space: 'source-views-v4',
      semantic_response_equivalence: 'semantic-response-equivalence-v5',
      semantic_answer_compatibility: 'semantic-answer-compatibility-v5',
      semantic_template_equivalence: 'semantic-template-equivalence-v10',
      answer_authorization_code: 'answer-authorization-v28'
    });
    expect((WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.provider_schema.contract as any))
      .toMatchObject({
        independent_provider_schema_version_in_activation_bundle: false,
        current_schema_name: 'f1_semantic_candidate_proposals_v1',
        target_schema_name: 'f1_semantic_candidate_proposals_v2'
      });
  });

  it('adds only two exact question contracts while preserving pre-provider refusals', () => {
    const question: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.answer_question.contract;
    expect(question.operations.map((operation: any) => operation.metric_id))
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.metrics.map(metric => metric.metric_id));
    expect(question.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric_id: 'official_non_deleted_non_pit_event_mean_v1', lap_range: { presence: 'forbidden', maximum_inclusive_laps: null } }),
      expect.objectContaining({ metric_id: 'official_non_deleted_non_pit_window_median_v1', lap_range: { presence: 'required', maximum_inclusive_laps: 50 } })
    ]));
    expect(question.pre_provider_refusals).toEqual(expect.arrayContaining([
      'causal_performance', 'clean_air', 'constructor_or_team', 'control_or_instruction_text',
      'fastest_or_single_lap', 'generic_pace', 'interim_or_latest', 'multiseason', 'negation',
      'qualifying', 'same_driver', 'sprint', 'tyre', 'unconsumed_filler'
    ]));
    expect(question.whole_question_consumption_required).toBe(true);
    expect(question.admitted_whole_question_grammars).toHaveLength(2);
    expect(question.admitted_whole_question_grammars.every((grammar: any) =>
      grammar.normalized_patterns.every((pattern: string) => pattern.includes('<driver_a>') &&
        pattern.includes('<driver_b>') && pattern.includes('2022 belgian grand prix')))).toBe(true);
  });

  it('uses a named provider proposal with no generic aggregation or server-owned semantics', () => {
    const proposal: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.candidate_proposal.contract;
    expect(proposal.added_variant).toMatchObject({
      operation: 'certified_official_timing_compare', exact_driver_entity_refs: 2, exact_event_entity_refs: 1
    });
    expect(proposal.server_derived_only).toEqual(expect.arrayContaining([
      'aggregation', 'canonical_ids', 'coverage', 'exclusions', 'integrity_checks', 'sql', 'topology'
    ]));
    expect(proposal.provider_may_supply).toEqual(['exact_literal_spans', 'fixed_operation_discriminator']);
    expect(proposal.server_derived_only).toEqual(expect.arrayContaining([
      'aggregation', 'metric_id', 'source_ref', 'comparison', 'exclusions'
    ]));
    expect(proposal.metric_derived_only_from_verified_question_grammar).toBe(true);
    expect(proposal.added_variant.evidence_only_fields).not.toContain('session_span');
    expect(proposal).toMatchObject({
      maximum_official_timing_candidates: 2, duplicate_candidates: 'reject',
      exact_admitted_candidates: 1, unknown_or_extra_semantics: 'reject'
    });
  });

  it('keeps provider projection language-only and requires generated provider hashes', () => {
    const provider: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.provider_schema.contract;
    expect(provider).toMatchObject({
      strict_schema: true, maximum_response_bytes: 65536, maximum_tokens: 8192, temperature: 0,
      exact_returned_model_identity_required: true, exact_completed_non_refusal_results: 1,
      runtime_zod_validation_after_wire_transform: true,
      provider_controls_no_sql_f1ql_core_or_authorization: true,
      endpoint_credential_and_private_host_guards_preserved: true
    });
    expect(provider.generated_hashes_required).toHaveLength(5);
    expect(provider.official_variant_schema).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: { operation: { const: 'certified_official_timing_compare' } }
    });
    expect(provider.official_variant_schema_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.official_variant_schema.required).not.toContain('session_evidence');
    expect(JSON.stringify(provider.official_variant_schema)).not.toContain('session_evidence');
    expect(provider.generated_artifacts).toEqual({
      status: 'not_generated', catalog_language_projection_sha256: null,
      effective_prompt_sha256: null, openai_compatible_schema_sha256: null,
      anthropic_wire_schema_sha256: null, provider_request_config_sha256: null
    });
    expect(provider.activation_requires_real_generated_hashes).toBe(true);
    expect(provider.predecessor_schema_sha256).toBe(SEMANTIC_CANDIDATE_SCHEMA_SHA256);
    expect(provider.language_projection_excludes).toEqual(expect.arrayContaining([
      'canonical_ids', 'coverage_decisions', 'database_details', 'dataset_pins',
      'integrity_checks', 'physical_fields', 'relationships', 'view_names'
    ]));
  });

  it('binds fact space v4 to the expectations-only database and principal targets', () => {
    const factSpace: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.fact_space.contract;
    expect(factSpace).toMatchObject({
      exact_select_relations: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.database.exact_select_relations_after_activation,
      relation_contract_source: 'database_binding_v2_target',
      signed_database_identity_and_owner_observations_required: true,
      observed_post_migration_uniqueness_required: true,
      private_schema_access: 'none', writable_relations: 0, executable_routines: 0,
      database_temporary: false, observed_evidence: null
    });
  });

  it('keeps legacy fixtures as regression oracles without claiming semantic-v32 equivalence', () => {
    const response: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.semantic_response_equivalence.contract;
    const compatibility: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.semantic_answer_compatibility.contract;
    expect(response.official_timing_overlaps.map((overlap: any) => overlap.legacy_regression_oracle_sha256)).toEqual([
      'ce1a87db0f28e1b30a39f8744a2bd9e3e728e361096fd3bd6c10b4c04129a198',
      '972b7d5066e1e2bea768eb3db0a31c44e447dd1b4747db88957b8cf61c99e6c0'
    ]);
    expect(response.official_timing_overlaps.every((overlap: any) =>
      overlap.exact_one_row && !overlap.has_more_rows && overlap.recompute_delta_and_winner &&
      !overlap.legacy_oracle_is_semantic_v32_evidence && overlap.semantic_v32_fixture_sha256 === null &&
      overlap.equivalence_evidence === null && overlap.status === 'pending_real_semantic_v32_emitter')).toBe(true);
    expect(compatibility.official_timing.every((entry: any) =>
      entry.public_wire_contract_sha256 === WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 &&
      WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 ===
        'ffe01b5cd6d3e6e9666cd663909b8b1960a9a2356d73c24fa6f58cde03c38bf0')).toBe(true);
    expect(compatibility.official_timing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: 'sealed_public_wire_contract', public_wire_envelope: 'f1ql-answer-wire-v2',
        public_wire_contract_sha256: WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256,
        activation_eligible: true,
        activation_blocker: null,
        activation_still_gated_by_release_v9_evidence: true,
        legacy_template_id: null, legacy_answer_envelope_equivalence: false,
        synthetic_legacy_authorization_allowed: false, prose_only_downgrade_allowed: false
      })
    ]));
  });

  it('preserves all legacy template accounting without inventing an official timing template', () => {
    const target: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.semantic_template_equivalence.contract;
    expect(target).toMatchObject({
      predecessor_template_registry_version: 'answer-templates-v13',
      predecessor_template_registry_sha256: 'd6923cd57538c57699de38764382ff42fa4d173955cd1e0a40f7e62fca577cbe',
      template_registry_transition_declared: false
    });
    expect(Object.keys(target.exact_existing_template_statuses).sort()).toEqual([...ANSWER_TEMPLATE_IDS].sort());
    expect(Object.entries(target.exact_existing_template_statuses).filter(([, status]) => status === 'equivalent'))
      .toEqual([['final_standings_points', 'equivalent']]);
    expect(target.official_timing.every((operation: any) =>
      operation.template_id === null && operation.status === 'semantic_only_no_legacy_template')).toBe(true);
  });

  it('requires complete semantic, provider, database, release, and one-time authorization bindings', () => {
    const authorization: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.answer_authorization_code.contract;
    expect(authorization).toMatchObject({
      legacy_authorization_envelope_version: 14, legacy_answer_policy_broadening_allowed: false,
      release_attestation_version: 9, complete_activation_target_hash_set_required: true,
      authorization_ttl_ms_maximum: 5000, release_expiry_caps_authorization: true,
      one_time_consumption_before_database_acquisition: true, replay_rejected: true,
      live_release_and_kill_switch_rechecks_required: true,
      authorization_from_question_provider_or_legacy_ast_alone: false
    });
    expect(authorization.required_runtime_bindings).toEqual(expect.arrayContaining([
      'candidate_set', 'compiled_result', 'core', 'coverage_witness', 'database_binding', 'fact_space',
      'planned_f1ql', 'principal', 'proof', 'provider_schema', 'release', 'resolution',
      'runtime_ceilings', 'semantic_evidence', 'semantic_query', 'topology'
    ]));
    expect(authorization.required_target_hash_names)
      .toEqual(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes);
    expect(authorization).toMatchObject({
      partial_or_extra_target_hash_set_rejected: true,
      compatibility_activation_eligibility_required: true
    });
  });

  it('is deeply frozen and independently hash-binds every expectations-only component', () => {
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_INTERFACE_TARGET)).toBe(true);
    expect(Object.values(WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components).every(component =>
      component.implementation_status === 'contract_expectations_only_not_runtime_implementation' &&
      component.implementation_evidence === null)).toBe(true);
    expect(Object.keys(WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES).sort())
      .toEqual(Object.keys(WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components).sort());
    expect(WP12_OFFICIAL_TIMING_INTERFACE_COMPONENT_HASHES).toEqual({
      answer_question: '82ad5692b643ec161da15e4581c47c96487ffd9ba60084db18658dc27c62390d',
      candidate_proposal: '2dc8438501d701f29e84914766c332dfaaf6caf8c17303e1e8a498c7818792d7',
      provider_schema: 'a6927aed2b27a32c4ad892d1d95b9a01ba20c4f031ad8733c147ea4b64eb41af',
      fact_space: '16963ad9e58b984bc09dcb0dae4f82cd27b4c3ba0b15864d2f47784af2886398',
      semantic_response_equivalence: '275b64ca184f5d2703c63387f0bf9b693bde277ea7780782d5b916a78045d795',
      semantic_answer_compatibility: 'f6765ab6a2b9f23541875e216cae7bd6145603336ef8947814ea6277590daa61',
      semantic_template_equivalence: 'c176da0b086d21c17235bbc03dc9de846e2360f66abfa991e3af131d921c7398',
      answer_authorization_code: '1cdce1f6ddf49fadf04c4bac98b176801a92dc77f26c0121d70a80736824937b'
    });
    expect(WP12_OFFICIAL_TIMING_INTERFACE_TARGET.semantic_target_sha256)
      .toBe(WP12_OFFICIAL_TIMING_SEMANTIC_TARGET_SHA256);
    expect((WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.answer_authorization_code.contract as any)
      .semantic_component_hashes).toEqual(expect.objectContaining({
        semantic_query: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_query,
        semantic_evidence: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_evidence,
        semantic_plan_proof: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.semantic_plan_proof,
        capability_authorization: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.capability_authorization,
        result_formatter: WP12_OFFICIAL_TIMING_SEMANTIC_COMPONENT_HASHES.result_formatter
      }));
    expect(WP12_OFFICIAL_TIMING_INTERFACE_TARGET_SHA256)
      .toBe('3949bb3eaf2afaab3288fc416df2da353461a247d113fbcc48a353ba58a67071');
    expect(parseWP12OfficialTimingInterfaceTarget(cloneTarget())).toEqual(WP12_OFFICIAL_TIMING_INTERFACE_TARGET);
  });

  it.each([
    ['unknown field', (target: any) => { target.extra = true; }],
    ['question event', (target: any) => { target.components.answer_question.contract.operations[0].exact_round = 15; }],
    ['proposal operation', (target: any) => { target.components.candidate_proposal.contract.added_variant.operation = 'aggregate'; }],
    ['provider generic control', (target: any) => { target.components.provider_schema.contract.language_projection_includes.push('generic_mean'); }],
    ['fact relation', (target: any) => { target.components.fact_space.contract.exact_select_relations.pop(); }],
    ['fixture hash', (target: any) => { target.components.semantic_response_equivalence.contract.official_timing_overlaps[0].legacy_regression_oracle_sha256 = '0'.repeat(64); }],
    ['legacy compatibility', (target: any) => { target.components.semantic_answer_compatibility.contract.official_timing[0].legacy_template_id = 'final_standings_points'; }],
    ['template equivalence', (target: any) => { target.components.semantic_template_equivalence.contract.official_timing[0].status = 'equivalent'; }],
    ['authorization binding', (target: any) => { target.components.answer_authorization_code.contract.required_runtime_bindings.pop(); }],
    ['component hash', (target: any) => { target.component_hashes.provider_schema = '0'.repeat(64); }],
    ['undefined alias', (target: any) => { target.components.answer_question.contract.operations[0].lap_range = undefined; }],
    ['negative-zero alias', (target: any) => { target.components.provider_schema.contract.temperature = -0; }]
  ])('rejects %s mutation', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingInterfaceTarget(target)).toThrow();
  });

  it.each([
    ['NaN', (target: any) => { target.components.provider_schema.contract.temperature = Number.NaN; }],
    ['infinity', (target: any) => { target.components.provider_schema.contract.temperature = Number.POSITIVE_INFINITY; }],
    ['symbol', (target: any) => { target[Symbol('hidden')] = true; }],
    ['accessor', (target: any) => { Object.defineProperty(target, 'extra', { enumerable: true, get: () => true }); }],
    ['hidden field', (target: any) => { Object.defineProperty(target, 'hidden', { enumerable: false, value: true }); }],
    ['sparse array', (target: any) => { delete target.components.answer_question.contract.operations[0]; }],
    ['extended array', (target: any) => { Object.defineProperty(target.components.answer_question.contract.operations, 'hidden', { value: true }); }],
    ['cycle', (target: any) => { target.components.answer_question.contract.loop = target; }]
  ])('rejects non-canonical %s', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingInterfaceTarget(target)).toThrow(/FAIL_CLOSED/);
  });

  it.each([
    ['shared reference', (target: any) => {
      target.components.answer_question.contract.alias = target.components.answer_question.contract.operations;
    }],
    ['inherited object', (target: any) => { Object.setPrototypeOf(target, { inherited: true }); }],
    ['array accessor', (target: any) => {
      Object.defineProperty(target.components.answer_question.contract.operations, '0', {
        enumerable: true, get: () => ({})
      });
    }],
    ['depth bound', (target: any) => {
      let cursor = target.components.answer_question.contract;
      for (let depth = 0; depth < 101; depth += 1) {
        cursor.deep = {};
        cursor = cursor.deep;
      }
    }]
  ])('rejects canonical structure violation: %s', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingInterfaceTarget(target)).toThrow(/FAIL_CLOSED/);
  });

  it('leaves active question, provider, fact space, compatibility, policy, and templates unchanged', () => {
    expect(ANSWER_QUESTION_CONTRACT_VERSION).toBe('answer-question-v27');
    expect(SEMANTIC_CANDIDATE_PROPOSAL_VERSION).toBe(1);
    expect(SEMANTIC_CANDIDATE_SCHEMA_NAME).toBe('f1_semantic_candidate_proposals_v1');
    expect(SEMANTIC_CANDIDATE_CATALOG_PROJECTION_SHA256)
      .toBe('8443b0250dec2e1a08d926a0e90aac98cdae1b247f7abebcc1accd0d8ce11a0b');
    expect(F1QL_FACT_SPACE_VERSION).toBe('source-views-v3');
    expect(SEMANTIC_ANSWER_COMPATIBILITY_VERSION).toBe('semantic-answer-compatibility-v4');
    expect(SEMANTIC_RESPONSE_EQUIVALENCE_VERSION).toBe('semantic-response-equivalence-v4');
    expect(SEMANTIC_TEMPLATE_EQUIVALENCE_VERSION).toBe('semantic-template-equivalence-v9');
    expect(Object.values(SEMANTIC_TEMPLATE_EQUIVALENCE).filter(entry => entry.status === 'equivalent')).toHaveLength(1);
    expect(ANSWER_AUTHORIZATION_CODE_VERSION).toBe('answer-authorization-v27');
    expect(ANSWER_AUTHORIZATION_VERSION).toBe(14);
    expect(ANSWER_RELEASE_ATTESTATION_VERSION).toBe(8);
    expect(ANSWER_TEMPLATE_REGISTRY_VERSION).toBe('answer-templates-v13');
    expect(ANSWER_TEMPLATE_REGISTRY_HASH).toBe('d6923cd57538c57699de38764382ff42fa4d173955cd1e0a40f7e62fca577cbe');
    const eventMean = authorizeAnswerProgram({
      version: 1,
      root: {
        op: 'official_event_mean_compare', metric: 'official_non_deleted_non_pit_event_mean_v1',
        season: 2022, round: 14, driver_a_id: 'max-verstappen', driver_b_id: 'fernando-alonso'
      }
    });
    expect(eventMean).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    expect(authorizeAnswerProgram({
      version: 1,
      root: {
        op: 'official_lap_window_median_compare', metric: 'official_non_deleted_non_pit_window_median_v1',
        season: 2022, round: 14, driver_a_id: 'max-verstappen', driver_b_id: 'fernando-alonso',
        lap_start: 3, lap_end: 10
      }
    })).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    expect(authorizeAnswerProgram({
      version: 1,
      root: {
        op: 'event_classification', season: 2025, round: 1, limit: 3,
        filters: { finishing_position: [1, 2, 3] }
      }
    })).toMatchObject({ type: 'approved', capability: { source: 'race_classification', filters: ['position'] } });
    expect(authorizeAnswerProgram({
      version: 1,
      root: {
        op: 'event_classification', season: 2025, round: 1, limit: 1,
        filters: { finishing_position: [1, 2, 3] }
      }
    })).toEqual({ type: 'rejected', reason: 'classification_filter_combination_unsupported' });
    expect(createHash('sha256').update(readFileSync('src/f1ql/answer-policy.ts')).digest('hex'))
      .toBe('4e580f6faf80d5b6bfa61028aa70787ae3676959b9c2e553ba403f6b6611061d');
  });

  it('has no execution/provider implementation imports or inbound production imports', () => {
    const targetPath = 'src/f1ql/wp12-official-timing-interface-target.ts';
    const source = readFileSync(targetPath, 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:answer-authorization|executor|interpreter|pg|provider|route|semantic-plan-execution|semantic-result-format)/);
    expect(sourceFiles('src').filter(path =>
      path !== targetPath && readFileSync(path, 'utf8').includes('wp12-official-timing-interface-target')))
      .toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
