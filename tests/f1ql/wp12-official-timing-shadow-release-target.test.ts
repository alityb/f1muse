import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseWP12OfficialTimingShadowReleaseTarget,
  WP12_OFFICIAL_TIMING_SHADOW_RELEASE_COMPONENT_HASHES,
  WP12_OFFICIAL_TIMING_SHADOW_RELEASE_SUBORDINATE_HASHES,
  WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET,
  WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET_SHA256
} from '../../src/f1ql/wp12-official-timing-shadow-release-target';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256 } from '../../src/f1ql/wp12-official-timing-public-wire-target';
import { SEMANTIC_SHADOW_OBSERVATION_VERSION } from '../../src/f1ql/semantic-shadow-observations';
import { SEMANTIC_SHADOW_ORCHESTRATOR_VERSION } from '../../src/f1ql/semantic-shadow-planner';
import { SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION } from '../../src/f1ql/semantic-shadow-retained-observation';
import { SEMANTIC_SHADOW_REPORT_VERSION } from '../../src/f1ql/semantic-shadow-report';
import { ANSWER_RELEASE_ATTESTATION_VERSION } from '../../src/f1ql/answer-release-attestation';

function cloneTarget(): any {
  return structuredClone(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET);
}

describe('WP12 detached official timing shadow/release target', () => {
  it('derives every version transition from the activation bundle', () => {
    const expected = {
      shadow_observation: { current: 'semantic-shadow-observation-v1', target: 'semantic-shadow-observation-v2' },
      shadow_orchestrator: { current: 'semantic-shadow-planner-v6', target: 'semantic-shadow-planner-v7' },
      shadow_retained_observation: { current: 'semantic-shadow-retained-v2', target: 'semantic-shadow-retained-v3' },
      release_attestation: { current: 8, target: 9 }
    } as const;
    for (const [name, versions] of Object.entries(expected)) {
      const component = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET
        .components[name as keyof typeof WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components];
      expect(component.version).toMatchObject(versions);
      const bundleEntry = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.versions.find(v => v.component === name)!;
      expect(bundleEntry.transition).toBe('atomic');
    }
  });

  it('keeps active shadow and release versions unchanged', () => {
    expect(SEMANTIC_SHADOW_OBSERVATION_VERSION).toBe('semantic-shadow-observation-v1');
    expect(SEMANTIC_SHADOW_ORCHESTRATOR_VERSION).toBe('semantic-shadow-planner-v6');
    expect(SEMANTIC_SHADOW_RETAINED_OBSERVATION_VERSION).toBe('semantic-shadow-retained-v2');
    expect(SEMANTIC_SHADOW_REPORT_VERSION).toBe('semantic-shadow-report-v1');
    expect(ANSWER_RELEASE_ATTESTATION_VERSION).toBe(8);
  });

  it('seals the shadow non-execution invariants from the activation bundle', () => {
    const observation = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components.shadow_observation.contract as any;
    expect(observation.resolver_counts).toMatchObject({
      fingerprint_reads: 0,
      official_coverage_reads_max: 1,
      translated_execution_calls: 0,
      planned_result_execution_calls: 0,
      answer_result_executor_calls: 0,
      result_query_calls: 0
    });
    expect(observation.result_execution_prohibited).toBe(true);
    expect(observation.translated_execution_prohibited).toBe(true);
    expect(observation.coverage_binding.query_ids).toEqual(
      WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries.map(query => query.id)
    );
    expect(observation.coverage_binding.query_calls_max).toBe(1);
    expect(observation.coverage_abstention_contains_no_plan_fields).toBe(true);
    const orchestrator = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components.shadow_orchestrator.contract as any;
    expect(orchestrator.capability_authorization_never_created).toBe(true);
    expect(orchestrator.coverage_queries).toHaveLength(2);
    expect(orchestrator.exactly_one_coverage_read_when_reached).toBe(true);
    expect(orchestrator.coverage_read_after_admission_and_before_planning).toBe(true);
    expect(orchestrator.template_dual_lane_never_executes).toBe(true);
    expect(orchestrator.never_performs).toEqual(expect.arrayContaining([
      'translated_execution', 'planned_result_execution', 'result_formatter_invocation',
      'plan_execution_result_construction', 'persistent_sink_creation'
    ]));
  });

  it('retains only hashed evidence with literally zero execution counters', () => {
    const retained = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components.shadow_retained_observation.contract as any;
    expect(retained.exactly_one_terminal_attempt_per_admitted_request).toBe(true);
    expect(retained.observation_version_required).toBe('semantic-shadow-observation-v2');
    expect(retained.added_counters).toMatchObject({
      translated_execution_calls: 0,
      planned_result_execution_calls: 0,
      answer_result_executor_calls: 0,
      result_query_calls: 0
    });
    expect(retained.added_counters.official_coverage_reads).toEqual({ min: 0, max: 1 });
    expect(retained.logger_failure_triggers_no_second_terminal_attempt).toBe(true);
    expect(retained.no_rows_sql_parameters_questions_or_provider_raw_output).toBe(true);
    expect(retained.maximum_serialized_line_bytes).toBe(16_384);
  });

  it('forbids every application-owned persistent sink', () => {
    const transport = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET
      .subordinate_components.shadow_retention_transport.contract as any;
    expect(transport.application_owned_persistent_sink_created).toBe(false);
    for (const forbidden of ['database_log_table', 'database_dml_for_retention', 'file_append_sink',
      'redis_or_cache_sink', 'http_or_object_store_sink', 'background_queue_or_retry']) {
      expect(transport[forbidden]).toBe('forbidden');
    }
    expect(transport.persistent_sink_approval_absent).toBe(true);
    expect(transport.migration_grant_table_trigger_or_durable_application_log_introduced).toBe(false);
    expect(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.non_execution.persistent_sink_created).toBe(false);
    expect(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.non_execution.production_capture).toBe(false);
  });

  it('requires the exact activation target-name set for release attestation with no omissions or extras', () => {
    const release = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components.release_attestation.contract as any;
    const bundleNames = [...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.activation_attestation.required_target_hashes].sort();
    expect(release.required_target_hash_names_exactly).toEqual(bundleNames);
    expect(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.activation_target_hash_names).toEqual(bundleNames);
    expect(release.atomic_complete_target_hash_set_required).toBe(true);
    expect(release.partial_or_extra_target_hash_set_rejected).toBe(true);
    expect(release.release_artifact).toBeNull();
    expect(release.release_artifact_sha256).toBeNull();
    expect(release.release_signature).toBeNull();
    expect(release.release_not_constructible_locally).toBe(true);
    expect(release.public_wire_compatibility_required).toBe(true);
    expect(release.public_wire_compatibility_currently_blocked).toBe(false);
    expect(release.public_wire_contract_sha256)
      .toBe('ffe01b5cd6d3e6e9666cd663909b8b1960a9a2356d73c24fa6f58cde03c38bf0');
    expect(release.public_wire_contract_sha256).toBe(WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET_SHA256);
    expect(release.shadow_translated_execution_zero_required).toBe(true);
    expect(release.shadow_result_query_calls_zero_required).toBe(true);
    expect(release.compositional_routing_rejected_before_evidence).toBe(true);
  });

  it('keeps every subordinate evidence artifact absent', () => {
    const sub = WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.subordinate_components;
    expect((sub.shadow_evidence_collector.contract as any).collector_artifact).toBeNull();
    expect((sub.shadow_evidence_collector.contract as any).collector_artifact_sha256).toBeNull();
    expect((sub.shadow_evidence_collector.contract as any).wp12_corpus_sha256).toBeNull();
    expect((sub.shadow_evidence_collector.contract as any).wp12_snapshot_sha256).toBeNull();
    expect((sub.shadow_evidence_collector.contract as any).current_50_case_corpus_is_predecessor_evidence_only).toBe(true);
    expect((sub.shadow_evidence_report.contract as any).report_artifact).toBeNull();
    expect((sub.shadow_evidence_report.contract as any).report_artifact_sha256).toBeNull();
    expect((sub.shadow_evidence_report.contract as any).empty_or_absent_evidence_is_insufficient_never_pass).toBe(true);
    expect((sub.shadow_evidence_report.contract as any).any_nonzero_execution_counter_is_hard_failure).toBe(true);
    expect((sub.shadow_production_capture.contract as any).capture_artifact).toBeNull();
    expect((sub.shadow_production_capture.contract as any).capture_artifact_sha256).toBeNull();
    expect((sub.shadow_production_capture.contract as any).status).toBe('not_created');
    expect((sub.shadow_production_metadata_evidence.contract as any).evidence_artifact).toBeNull();
    expect((sub.shadow_production_metadata_evidence.contract as any).evidence_artifact_sha256).toBeNull();
    expect((sub.shadow_production_metadata_evidence.contract as any).status).toBe('not_created');
    for (const value of Object.values(sub)) {
      expect(value.implementation_evidence).toBeNull();
    }
    for (const value of Object.values(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components)) {
      expect(value.implementation_evidence).toBeNull();
      expect(value.implementation_status).toBe('contract_expectations_only_not_runtime_implementation');
    }
  });

  it('is detached from execution code and deeply frozen', () => {
    const source = readFileSync('src/f1ql/wp12-official-timing-shadow-release-target.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:executor|interpreter|route|translator|semantic-plan-execution|answer-policy|answer-release-attestation|semantic-shadow-planner|semantic-shadow-observations|semantic-shadow-retained|semantic-shadow-report|semantic-result-format|result-database|answer-authorization|wp12-official-timing-interface-target|wp12-official-timing-semantic-target)/);
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components)).toBe(true);
    expect(Object.isFrozen(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.subordinate_components)).toBe(true);
    for (const component of Object.values(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components)) {
      expect(Object.isFrozen(component)).toBe(true);
    }
  });

  it('round-trips through the fail-closed parser', () => {
    expect(parseWP12OfficialTimingShadowReleaseTarget(cloneTarget()))
      .toEqual(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET);
    expect(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET_SHA256)
      .toBe('8c0ab5273787757e8c32066cdd7cd1175a5011b3405188e3b799c2668dc14638');
    expect(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_COMPONENT_HASHES).toEqual({
      shadow_observation: 'a5c55ed458be04674052f6f9e20b8dc28783502b4dc25dbd3c2bebe84960af7e',
      shadow_orchestrator: 'a0afc894440ad60188333afc7a012df91865b9097cd37734e78bd99175c372fc',
      shadow_retained_observation: 'a8f95fe91a4da7789d04ccc57d30eeaca6d2834a6b420d098a8edd1a36692bf7',
      release_attestation: '74941a0bc9eeb2a7dc23867f0b1c7223a9414a6d07f24c6d8d1ea5e84a3e3e9d'
    });
    expect(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_SUBORDINATE_HASHES).toEqual({
      shadow_evidence_collector: '8b50508bfb139e10d90369f967466cdfd501dabaaac22c68f45dab88a0d8e0c0',
      shadow_evidence_report: 'd8586a5e74f2f284aab41a029fb4824e856e120309dda0ae828b5818ae040042',
      shadow_retention_transport: '6b99a1283717ce76c36b589cfbee0db1b15de609f0bba36c70a06e93d20b313a',
      shadow_production_capture: 'ee0f9edc5179f9afefe743119d3eacd25cc4790434d2a0a24a45618bf5e90199',
      shadow_production_metadata_evidence: '206dad479779bc0b47c13974824badd39557a86a253e59925e2c6e0e04757e7f'
    });
    expect(Object.keys(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_COMPONENT_HASHES).sort())
      .toEqual(Object.keys(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.components).sort());
    expect(Object.keys(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_SUBORDINATE_HASHES).sort())
      .toEqual(Object.keys(WP12_OFFICIAL_TIMING_SHADOW_RELEASE_TARGET.subordinate_components).sort());
  });

  it.each([
    ['unknown target field', (target: any) => { target.extra = true; }],
    ['observation execution counter', (target: any) => { target.components.shadow_observation.contract.resolver_counts.translated_execution_calls = 1; }],
    ['orchestrator never_performs', (target: any) => { target.components.shadow_orchestrator.contract.never_performs.pop(); }],
    ['retained counter', (target: any) => { target.components.shadow_retained_observation.contract.added_counters.result_query_calls = 1; }],
    ['release artifact present', (target: any) => { target.components.release_attestation.contract.release_artifact = {}; }],
    ['release target names', (target: any) => { target.components.release_attestation.contract.required_target_hash_names_exactly.pop(); }],
    ['transport sink', (target: any) => { target.subordinate_components.shadow_retention_transport.contract.application_owned_persistent_sink_created = true; }],
    ['collector artifact present', (target: any) => { target.subordinate_components.shadow_evidence_collector.contract.collector_artifact = {}; }],
    ['component hash', (target: any) => { target.component_hashes.shadow_observation = '0'.repeat(64); }],
    ['subordinate hash', (target: any) => { target.subordinate_component_hashes.shadow_evidence_collector = '0'.repeat(64); }]
  ])('rejects %s mutation', (_name, mutate) => {
    const target = cloneTarget();
    mutate(target);
    expect(() => parseWP12OfficialTimingShadowReleaseTarget(target)).toThrow();
  });
});
