import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION,
  OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_VERSION,
  OFFICIAL_TIMING_SHADOW_RETAINED_VERSION,
  orchestrateOfficialTimingShadow,
  sanitizeOfficialTimingShadowObservation,
  sanitizeOfficialTimingShadowRetainedObservation
} from '../../src/f1ql/official-timing-shadow';
import { OfficialTimingResolutionDependencies } from '../../src/f1ql/official-timing-resolution';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256
} from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const DRIVERS: Readonly<Record<string, string>> = {
  'Max Verstappen': 'max-verstappen',
  'Fernando Alonso': 'fernando-alonso'
};
const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';

function providerResponseFor(request: { readonly candidates: readonly [{ readonly candidate_id: string }] }) {
  return {
    version: 2,
    candidate_id: request.candidates[0].candidate_id
  };
}

function resolutionDeps(overrides: Partial<OfficialTimingResolutionDependencies> = {}): OfficialTimingResolutionDependencies {
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
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric: 'official_non_deleted_non_pit_event_mean_v1',
      coverage_query_id: 'official_event_coverage_v1',
      coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[0].statement_sha256,
      query_calls: 1,
      driver_coverage: [
        { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 42, excluded_deleted_laps: 1, excluded_pit_marker_laps: 1 },
        { driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 42, excluded_deleted_laps: 1, excluded_pit_marker_laps: 1 }
      ]
    }) as never,
    ...overrides
  };
}

function shadowDeps(overrides: Record<string, unknown> = {}) {
  return {
    proposer: { propose: async (request: Parameters<typeof providerResponseFor>[0]) => providerResponseFor(request) },
    resolution: resolutionDeps(),
    now: (() => { let t = 1000; return () => (t += 10); })(),
    ...overrides
  };
}

describe('official timing shadow orchestrator v7', () => {
  it('plans and proves a matched question without any execution', async () => {
    const observation = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps());
    expect(observation.version).toBe(OFFICIAL_TIMING_SHADOW_OBSERVATION_VERSION);
    expect(observation.outcome).toBe('answer');
    expect(observation.reason).toBe('plan_proven');
    expect(observation.topology_code).toBe('same_source_scalar_comparison');
    expect(observation.source_set_code).toBe('official_race_lap_timing');
    expect(observation.operator_set_code).toBe('filter_aggregate_compare_project_sort_limit');
    expect(observation.candidate_counts).toEqual({
      enumerated: 1, proposed: 1, matched: 1, omitted: 0, extraneous: 0, comparison: 'exact'
    });
    expect(observation.resolver_counts).toEqual({
      driver_inventory_reads: 2, event_reads: 1, fingerprint_reads: 0, official_coverage_reads: 1
    });
    expect(observation.execution_counters).toEqual({
      translated_execution_calls: 0,
      planned_result_execution_calls: 0,
      answer_result_executor_calls: 0,
      result_query_calls: 0
    });
    expect(observation.template_dual).toEqual({ enabled: false, status: 'not_applicable' });
    expect(observation.versions.orchestrator).toBe(OFFICIAL_TIMING_SHADOW_ORCHESTRATOR_VERSION);
    expect(observation.hashes.activation_bundle_sha256).toBe(WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256);
    for (const field of ['answer_plan_sha256', 'planned_f1ql_sha256', 'planned_core_sha256', 'compiled_sha256', 'semantic_proof_sha256', 'coverage_witness_sha256'] as const) {
      expect(observation.hashes[field]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(observation)).not.toContain('Max Verstappen');
    expect(JSON.stringify(observation)).not.toContain('max-verstappen');
    expect(JSON.stringify(observation)).not.toContain('SELECT');
  });

  it('refuses grammar-rejected questions with mapped shadow reasons', async () => {
    const tyre = await orchestrateOfficialTimingShadow(
      'Who was faster on soft tyres between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?',
      shadowDeps()
    );
    expect(tyre.outcome).toBe('abstain');
    expect(tyre.reason).toBe('unsupported_concept');
    expect(tyre.hashes.answer_plan_sha256).toBeUndefined();
    expect(tyre.resolver_counts.official_coverage_reads).toBe(0);
    const invalid = await orchestrateOfficialTimingShadow(42, shadowDeps());
    expect(invalid.outcome).toBe('abstain');
    expect(invalid.reason).toBe('question_invalid');
  });

  it('maps provider failure and proposal drift to closed outcomes', async () => {
    const unavailable = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps({
      proposer: { propose: async () => { throw new Error('upstream down'); } }
    }));
    expect(unavailable.outcome).toBe('unavailable');
    expect(unavailable.reason).toBe('provider_unavailable');
    expect(unavailable.candidate_counts.comparison).toBe('not_comparable');
    const malformed = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps({
      proposer: { propose: async () => ({ operation: 'wrong' }) }
    }));
    expect(malformed.outcome).toBe('unavailable');
    expect(malformed.reason).toBe('provider_malformed');
    const drifted = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps({
      proposer: {
        propose: async () => ({ version: 2, candidate_id: 'f'.repeat(64) })
      }
    }));
    expect(drifted.outcome).toBe('abstain');
    expect(drifted.reason).toBe('provider_candidate_not_enumerated');
    expect(drifted.candidate_counts.comparison).toBe('extraneous');
    expect(drifted.hashes.provider_candidate_set_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(drifted.hashes.answer_plan_sha256).toBeUndefined();
  });

  it('rejects extra response properties as malformed', async () => {
    const padded = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps({
      proposer: {
        propose: async (request: Parameters<typeof providerResponseFor>[0]) =>
          ({ ...providerResponseFor(request), extra: true })
      }
    }));
    expect(padded.outcome).toBe('unavailable');
    expect(padded.reason).toBe('provider_malformed');
    expect(padded.candidate_counts.comparison).toBe('not_comparable');
  });

  it('server-enumerates lap-range semantics before candidate selection', async () => {
    const medianQuestion = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 3 to 10 at the 2022 Belgian Grand Prix';
    let providerRequest: unknown;
    const medianDeps = shadowDeps({
      proposer: {
        propose: async (request: Parameters<typeof providerResponseFor>[0]) => {
          providerRequest = request;
          return providerResponseFor(request);
        }
      },
      resolution: resolutionDeps({
        coverage_reader: async () => ({
          type: 'eligible',
          source_id: 'official_race_lap_timing',
          metric: 'official_non_deleted_non_pit_window_median_v1',
          coverage_query_id: 'official_window_coverage_v1',
          coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[1].statement_sha256,
          query_calls: 1,
          driver_coverage: [
            { driver_id: 'max-verstappen', completed_laps: 8, eligible_laps: 8, excluded_deleted_laps: 0, excluded_pit_marker_laps: 0 },
            { driver_id: 'fernando-alonso', completed_laps: 8, eligible_laps: 8, excluded_deleted_laps: 0, excluded_pit_marker_laps: 0 }
          ]
        }) as never
      })
    });
    const admitted = await orchestrateOfficialTimingShadow(medianQuestion, medianDeps);
    expect(admitted.outcome).toBe('answer');
    expect(admitted.hashes.coverage_query_id).toBe('official_window_coverage_v1');
    expect(providerRequest).toMatchObject({
      version: 2,
      semantic_query_version: 3,
      candidates: [{ semantic_query: { metric_id: 'official_non_deleted_non_pit_window_median_v1' } }]
    });
  });

  it('retains coverage abstention hashes without plan hashes', async () => {
    const observation = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps({
      resolution: resolutionDeps({
        coverage_reader: async () => ({
          type: 'abstain', reason: 'source_coverage_missing', stage: 'official_timing_coverage', query_calls: 1
        }) as never
      })
    }));
    expect(observation.outcome).toBe('abstain');
    expect(observation.reason).toBe('source_coverage_missing');
    expect(observation.resolver_counts.official_coverage_reads).toBe(1);
    expect(observation.hashes.coverage_query_id).toBe('official_event_coverage_v1');
    expect(observation.hashes.coverage_witness_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.hashes.answer_plan_sha256).toBeUndefined();
    expect(observation.hashes.compiled_sha256).toBeUndefined();
    expect(observation.plan_work).toBeUndefined();
    expect(observation.topology_code).toBeUndefined();
  });

  it('fails closed on resolution errors with mapped reasons', async () => {
    const observation = await orchestrateOfficialTimingShadow(EVENT_MEAN_QUESTION, shadowDeps({
      resolution: resolutionDeps({
        driver_resolver: { resolveUnambiguous: async () => ({ success: false, error: 'unknown_driver' }) }
      })
    }));
    expect(observation.outcome).toBe('abstain');
    expect(observation.reason).toBe('identity_unresolved');
  });

  it('sanitizes observations and rejects plan-field inconsistency', () => {
    const base = {
      outcome: 'abstain',
      reason: 'unsupported_concept',
      candidate_counts: { enumerated: 0, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable' },
      hashes: { activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256 },
      latencies: { total_ms: 5 },
      versions: {
        orchestrator: 'semantic-shadow-planner-v7',
        observation: 'semantic-shadow-observation-v2',
        question_parser: 'official-timing-question-parser-v1',
        semantic_query: 3,
        resolution: 'semantic-resolution-v2',
        planner: 'semantic-planner-v3',
        planned_f1ql: 3,
        planned_compiler: 'planned-compiler-v3',
        proof: 'semantic-plan-proof-v2',
        coverage_reader: 'official-timing-coverage-v1'
      },
      resolver_counts: { driver_inventory_reads: 0, event_reads: 0, fingerprint_reads: 0, official_coverage_reads: 0 }
    };
    const sanitized = sanitizeOfficialTimingShadowObservation(base);
    expect(sanitized.version).toBe('semantic-shadow-observation-v2');
    expect(sanitized.execution_counters.result_query_calls).toBe(0);
    expect(Object.isFrozen(sanitized)).toBe(true);
    expect(() => sanitizeOfficialTimingShadowObservation({
      ...base,
      outcome: 'answer',
      reason: 'plan_proven'
    })).toThrow();
    expect(() => sanitizeOfficialTimingShadowObservation({
      ...base,
      execution_counters: { translated_execution_calls: 1, planned_result_execution_calls: 0, answer_result_executor_calls: 0, result_query_calls: 0 }
    })).toThrow();
  });

  it('sanitizes retained observations with terminal consistency and zero execution', () => {
    const retained = sanitizeOfficialTimingShadowRetainedObservation({
      version: 'semantic-shadow-retained-v3',
      timestamp: new Date().toISOString(),
      mode: 'semantic_shadow',
      rollout_stage: 0,
      terminal: 'operational_failure',
      failure: { reason: 'request_timeout', stage: 'coverage', total_ms: 10 },
      provider_identity: {
        provider: 'openai-compatible',
        endpoint_sha256: 'a'.repeat(64),
        model_sha256: 'b'.repeat(64),
        catalog_projection_sha256: 'c'.repeat(64),
        prompt_sha256: 'd'.repeat(64),
        schema_sha256: 'e'.repeat(64),
        request_config_sha256: 'f'.repeat(64)
      },
      resolver_transaction_counters: {
        statement_count: 1, returned_row_count: 2, driver_inventory_reads: 2, event_reads: 1, official_coverage_reads: 1
      },
      execution_counters: {
        translated_execution_calls: 0, planned_result_execution_calls: 0, answer_result_executor_calls: 0, result_query_calls: 0
      },
      target_hashes: {
        activation_bundle_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE_SHA256,
        shadow_target_sha256: '0'.repeat(64)
      }
    });
    expect(retained.version).toBe(OFFICIAL_TIMING_SHADOW_RETAINED_VERSION);
    expect(retained.failure?.stage).toBe('coverage');
    expect(Object.isFrozen(retained)).toBe(true);
    expect(() => sanitizeOfficialTimingShadowRetainedObservation({
      ...structuredClone(retained),
      terminal: 'semantic'
    })).toThrow();
    expect(() => sanitizeOfficialTimingShadowRetainedObservation({
      ...structuredClone(retained),
      execution_counters: { translated_execution_calls: 1, planned_result_execution_calls: 0, answer_result_executor_calls: 0, result_query_calls: 0 }
    })).toThrow();
  });
});
