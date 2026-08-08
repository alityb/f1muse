import { describe, expect, it } from 'vitest';
import { parseOfficialTimingQuestion, OfficialTimingQuestionMatch } from '../../src/f1ql/official-timing-question';
import { enumerateOfficialTimingEvidence } from '../../src/f1ql/official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  OfficialTimingResolutionDependencies
} from '../../src/f1ql/official-timing-resolution';
import { planOfficialTimingAnswer } from '../../src/f1ql/official-timing-plan';
import { runOfficialTimingPlannedPipeline } from '../../src/f1ql/official-timing-compiler';
import { proveOfficialTimingPlan } from '../../src/f1ql/official-timing-proof';
import {
  authorizeOfficialTimingCapability,
  OfficialTimingReleaseBinding
} from '../../src/f1ql/official-timing-authorization';
import { executeOfficialTimingPlan } from '../../src/f1ql/official-timing-execution';
import {
  formatOfficialTimingResult,
  OFFICIAL_TIMING_RESULT_FORMAT_VERSION,
  OfficialTimingFormatError
} from '../../src/f1ql/official-timing-format';
import { OFFICIAL_TIMING_CAPABILITY_PROFILE_ID, OFFICIAL_TIMING_CATALOG_V2_SHA256 } from '../../src/f1ql/official-timing-capability';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';
import { WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET } from '../../src/f1ql/wp12-official-timing-public-wire-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const DRIVERS: Readonly<Record<string, string>> = {
  'Max Verstappen': 'max-verstappen',
  'Fernando Alonso': 'fernando-alonso'
};
const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';
const WINDOW_MEDIAN_QUESTION = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 3 to 10 at the 2022 Belgian Grand Prix';

function matched(question: string): OfficialTimingQuestionMatch {
  const result = parseOfficialTimingQuestion(question);
  if (result.type !== 'matched') {throw new Error(`expected match, got ${result.reason}`);}
  return result;
}

function releaseBinding(): OfficialTimingReleaseBinding {
  return {
    release_version: 9,
    release_id: 'test-release-9',
    commit_sha: 'a'.repeat(40),
    audience: 'f1muse-answer',
    deployment_id: 'test-deployment',
    expires_at: new Date(NOW + 300_000).toISOString(),
    routing_mode: 'compositional_profiles',
    allowed_capability_profile_ids: [OFFICIAL_TIMING_CAPABILITY_PROFILE_ID],
    allowed_principal_classes: ['internal', 'internal_canary', 'public'],
    catalog_hash: OFFICIAL_TIMING_CATALOG_V2_SHA256,
    release_attestation_sha256: 'b'.repeat(64)
  };
}

const WITNESS = {
  completed_laps: 44, eligible_laps: 42, excluded_deleted_laps: 1, excluded_pit_marker_laps: 1
};

function coverageFor(metric: string, witness?: typeof WITNESS) {
  const isEvent = metric === 'official_non_deleted_non_pit_event_mean_v1';
  const scoped = witness ?? (isEvent
    ? WITNESS
    : { completed_laps: 8, eligible_laps: 8, excluded_deleted_laps: 0, excluded_pit_marker_laps: 0 });
  return async () => ({
    type: 'eligible',
    source_id: 'official_race_lap_timing',
    metric,
    coverage_query_id: isEvent ? 'official_event_coverage_v1' : 'official_window_coverage_v1',
    coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[isEvent ? 0 : 1].statement_sha256,
    query_calls: 1,
    driver_coverage: [
      { driver_id: 'max-verstappen', ...scoped },
      { driver_id: 'fernando-alonso', ...scoped }
    ]
  }) as never;
}

function dependenciesFor(metric: string, witness?: typeof WITNESS): OfficialTimingResolutionDependencies {
  return {
    database: { connect: () => { throw new Error('coverage uses injected reader'); } } as never,
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
    coverage_reader: coverageFor(metric, witness)
  };
}

function fakePool(rows: Record<string, unknown>[]) {
  const client = {
    query: async (sql: string) => ({ rows: sql.startsWith('WITH') ? rows : [] }),
    release: () => undefined
  };
  return { connect: async () => client } as never;
}

async function formattedChain(questionText: string, rows: Record<string, unknown>[], witness?: typeof WITNESS) {
  const question = matched(questionText);
  const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
  const metric = evidence.candidates[0].metric_id;
  const resolution = await collectOfficialTimingResolution(question, evidence, dependenciesFor(metric, witness));
  const plan = planOfficialTimingAnswer({ question, evidence, resolution });
  const pipeline = runOfficialTimingPlannedPipeline(plan);
  const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
  const authorization = authorizeOfficialTimingCapability({
    question, evidence, resolution, plan, pipeline, proof,
    request_id: 'request-1',
    principal_class: 'internal',
    canary: { stage: 100, subject_id: 'subject-1' },
    release: releaseBinding(),
    now_ms: NOW
  });
  const execution = await executeOfficialTimingPlan(
    fakePool(rows), authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash,
    {
      request_id: 'request-1', principal_class: 'internal', statement_timeout_ms: 2000,
      deadline_ms: NOW + 5000, is_kill_switch_active: () => false, now_ms: NOW + 100
    }
  );
  return { question, evidence, resolution, plan, pipeline, proof, execution };
}

// Event mean: driver A total 3,780,000 ms over 42 laps = 90.0000s; driver B 3,781,260 ms over 42 = 90.0300s.
const MEAN_ROWS = [{
  driver_a_eligible_laps: 42, driver_a_total_ms: '3780000',
  driver_b_eligible_laps: 42, driver_b_total_ms: '3781260'
}];
// Window median: 8 laps each; A median between 90.100 and 90.300.
const MEDIAN_ROWS = [{
  driver_a_eligible_laps: 8,
  driver_a_ms_values: ['90000', '90050', '90100', '90150', '90200', '90250', '90300', '90350'],
  driver_b_eligible_laps: 8,
  driver_b_ms_values: ['91000', '91050', '91100', '91150', '91200', '91250', '91300', '91350']
}];

describe('official timing result formatter v32', () => {
  it('formats the event-mean envelope with exact scale-4 decimals and recomputed winner', async () => {
    const context = await formattedChain(EVENT_MEAN_QUESTION, MEAN_ROWS);
    const envelope = formatOfficialTimingResult(context.execution, context);
    expect(envelope.mode).toBe('proven_semantic_result');
    expect(envelope.format_version).toBe(OFFICIAL_TIMING_RESULT_FORMAT_VERSION);
    expect(envelope.format_version).toBe('semantic-result-format-v32');
    expect(envelope.proof_hash).toBe(context.proof.proof_hash);
    expect(envelope.planned_f1ql_hash).toBe(context.plan.planned_f1ql_hash);
    expect(envelope.core_hash).toBe(context.pipeline.planned_core_hash);
    expect(envelope.rows).toHaveLength(1);
    const row = envelope.rows[0];
    expect(row.driver_a_id).toBe('max-verstappen');
    expect(row.driver_b_id).toBe('fernando-alonso');
    expect(row.driver_a_mean_lap_time_seconds).toBe('90.0000');
    expect(row.driver_b_mean_lap_time_seconds).toBe('90.0300');
    expect(row.mean_delta_seconds).toBe('0.0300');
    expect(row.winner_driver_id).toBe('max-verstappen');
    expect(row.f1ql_integrity_ok).toBeUndefined();
    expect(row.season).toBe(2022);
    expect(row.round).toBe(14);
    expect(row.event_name).toBe('2022 Belgian Grand Prix');
    expect(row.dataset_sha256).toBe(CERTIFIED().dataset_sha256);
    expect(envelope.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: 1, row_limit: 1 });
    expect(envelope.metadata.caveats).toEqual([
      ...WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.output_schemas[0].required_caveats
    ]);
    expect(envelope.metadata.catalog_hash).toBe(OFFICIAL_TIMING_CATALOG_V2_SHA256);
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it('formats the window-median envelope with exact even-count medians', async () => {
    const context = await formattedChain(WINDOW_MEDIAN_QUESTION, MEDIAN_ROWS);
    const envelope = formatOfficialTimingResult(context.execution, context);
    const row = envelope.rows[0];
    // A: median of 8 sorted values = (90150+90200)/2 ms = 90175 ms = 90.1750 s exactly
    expect(row.driver_a_median_lap_time_seconds).toBe('90.1750');
    expect(row.driver_b_median_lap_time_seconds).toBe('91.1750');
    expect(row.median_delta_seconds).toBe('1.0000');
    expect(row.winner_driver_id).toBe('max-verstappen');
    expect(row.lap_start).toBe(3);
    expect(row.lap_end).toBe(10);
    expect(row.requested_laps_per_driver).toBe(8);
  });

  it('produces a null winner on exact ties and pins the sub-scale-4 delta contract', async () => {
    const tieRows = [{
      driver_a_eligible_laps: 42, driver_a_total_ms: '3780000',
      driver_b_eligible_laps: 42, driver_b_total_ms: '3780000'
    }];
    const tie = await formattedChain(EVENT_MEAN_QUESTION, tieRows);
    const tieRow = formatOfficialTimingResult(tie.execution, tie).rows[0];
    expect(tieRow.winner_driver_id).toBeNull();
    expect(tieRow.mean_delta_seconds).toBe('0.0000');
    // Sealed contract: winner is exact-rational; the delta display rounds to scale 4.
    // A 1ms difference over 42 laps each rounds to 0.0000 while the winner stays non-null.
    const subScaleRows = [{
      driver_a_eligible_laps: 42, driver_a_total_ms: '3780000',
      driver_b_eligible_laps: 42, driver_b_total_ms: '3780001'
    }];
    const subScale = await formattedChain(EVENT_MEAN_QUESTION, subScaleRows);
    const subScaleRow = formatOfficialTimingResult(subScale.execution, subScale).rows[0];
    expect(subScaleRow.mean_delta_seconds).toBe('0.0000');
    expect(subScaleRow.winner_driver_id).toBe('max-verstappen');
    expect(formatOfficialTimingResult(subScale.execution, subScale).answer.headline)
      .toContain('by 0.0000s');
  });

  it('exercises roundDiv exact-half, round-up, and round-down branches', async () => {
    // Exact half: 3ms over 4 laps -> 30/4 = 7.5 -> 8 -> 0.0008; 1ms over 4 -> 2.5 -> 3 -> 0.0003.
    const witness4 = { completed_laps: 44, eligible_laps: 4, excluded_deleted_laps: 20, excluded_pit_marker_laps: 20 };
    const halfRows = [{
      driver_a_eligible_laps: 4, driver_a_total_ms: '3',
      driver_b_eligible_laps: 4, driver_b_total_ms: '1'
    }];
    const half = await formattedChain(EVENT_MEAN_QUESTION, halfRows, witness4);
    const halfRow = formatOfficialTimingResult(half.execution, half).rows[0];
    expect(halfRow.driver_a_mean_lap_time_seconds).toBe('0.0008');
    expect(halfRow.driver_b_mean_lap_time_seconds).toBe('0.0003');
    expect(halfRow.winner_driver_id).toBe('fernando-alonso');
    // Non-half remainders: 10ms over 3 laps -> 100/3 = 33.33 -> 33 (round down);
    // 11ms over 3 laps -> 110/3 = 36.67 -> 37 (round up).
    const witness3 = { completed_laps: 44, eligible_laps: 3, excluded_deleted_laps: 20, excluded_pit_marker_laps: 21 };
    const thirdRows = [{
      driver_a_eligible_laps: 3, driver_a_total_ms: '10',
      driver_b_eligible_laps: 3, driver_b_total_ms: '11'
    }];
    const thirds = await formattedChain(EVENT_MEAN_QUESTION, thirdRows, witness3);
    const thirdRow = formatOfficialTimingResult(thirds.execution, thirds).rows[0];
    expect(thirdRow.driver_a_mean_lap_time_seconds).toBe('0.0033');
    expect(thirdRow.driver_b_mean_lap_time_seconds).toBe('0.0037');
    expect(thirdRow.winner_driver_id).toBe('max-verstappen');
  });

  it('computes odd-count medians exactly', async () => {
    const question = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 3 to 5 at the 2022 Belgian Grand Prix';
    const witness3 = { completed_laps: 3, eligible_laps: 3, excluded_deleted_laps: 0, excluded_pit_marker_laps: 0 };
    const rows = [{
      driver_a_eligible_laps: 3, driver_a_ms_values: ['90000', '90100', '90200'],
      driver_b_eligible_laps: 3, driver_b_ms_values: ['91000', '91100', '91200']
    }];
    const context = await formattedChain(question, rows, witness3);
    const row = formatOfficialTimingResult(context.execution, context).rows[0];
    expect(row.driver_a_median_lap_time_seconds).toBe('90.1000');
    expect(row.driver_b_median_lap_time_seconds).toBe('91.1000');
    expect(row.median_delta_seconds).toBe('1.0000');
    expect(row.requested_laps_per_driver).toBe(3);
  });

  it('matches the sealed public wire envelope shape', async () => {
    const context = await formattedChain(EVENT_MEAN_QUESTION, MEAN_ROWS);
    const envelope = formatOfficialTimingResult(context.execution, context);
    expect(Object.keys(envelope)).toEqual(
      WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.official_timing_success_envelope.top_level_fields_in_order
    );
    const forbidden = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.official_timing_success_envelope.forbidden_legacy_fields;
    for (const field of forbidden) {
      expect(envelope).not.toHaveProperty(field);
      expect(envelope.metadata).not.toHaveProperty(field);
    }
    expect(Object.keys(envelope.metadata).sort()).toEqual(
      [...WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.official_timing_success_envelope.metadata_fields].sort()
    );
    const rowContract = WP12_OFFICIAL_TIMING_PUBLIC_WIRE_TARGET.contract.metric_row_contracts[0];
    const publicRow = envelope.rows[0] as Record<string, unknown>;
    expect(Object.keys(publicRow)).toEqual(
      rowContract.field_order.filter(field => field !== 'f1ql_integrity_ok')
    );
    for (const field of rowContract.decimal_fields_scale_4_strings) {
      expect(publicRow[field]).toMatch(/^\d+\.\d{4}$/);
    }
  });

  it('rejects foreign execution results and broken bindings', async () => {
    const context = await formattedChain(EVENT_MEAN_QUESTION, MEAN_ROWS);
    expect(() => formatOfficialTimingResult(structuredClone(context.execution), context))
      .toThrowError(expect.objectContaining({ reason: 'result_invalid' }));
    const other = await formattedChain(WINDOW_MEDIAN_QUESTION, MEDIAN_ROWS);
    expect(() => formatOfficialTimingResult(context.execution, other))
      .toThrowError(OfficialTimingFormatError);
  });

  it('rejects execution rows whose counts diverge from the coverage witness', async () => {
    const divergentRows = [{
      driver_a_eligible_laps: 41, driver_a_total_ms: '3780000',
      driver_b_eligible_laps: 42, driver_b_total_ms: '3781260'
    }];
    const context = await formattedChain(EVENT_MEAN_QUESTION, divergentRows);
    expect(() => formatOfficialTimingResult(context.execution, context))
      .toThrowError(expect.objectContaining({ reason: 'coverage_arithmetic_invalid' }));
  });

  it('fails closed with a typed error on null median value arrays', async () => {
    const question = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 3 to 10 at the 2022 Belgian Grand Prix';
    const emptyWitness = { completed_laps: 8, eligible_laps: 0, excluded_deleted_laps: 8, excluded_pit_marker_laps: 0 };
    const nullRows = [{
      driver_a_eligible_laps: 0, driver_a_ms_values: null,
      driver_b_eligible_laps: 0, driver_b_ms_values: null
    }];
    const context = await formattedChain(question, nullRows, emptyWitness);
    expect(() => formatOfficialTimingResult(context.execution, context))
      .toThrowError(OfficialTimingFormatError);
    expect(() => formatOfficialTimingResult(context.execution, context))
      .toThrowError(expect.objectContaining({ reason: 'coverage_arithmetic_invalid' }));
  });

  it('fails closed when coverage arithmetic breaks', async () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const badCoverage = async () => ({
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric: 'official_non_deleted_non_pit_event_mean_v1',
      coverage_query_id: 'official_event_coverage_v1',
      coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[0].statement_sha256,
      query_calls: 1,
      driver_coverage: [
        { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 42, excluded_deleted_laps: 1, excluded_pit_marker_laps: 0 },
        { driver_id: 'fernando-alonso', ...WITNESS }
      ]
    }) as never;
    const deps = dependenciesFor('official_non_deleted_non_pit_event_mean_v1');
    deps.coverage_reader = badCoverage;
    const resolution = await collectOfficialTimingResolution(question, evidence, deps);
    const plan = planOfficialTimingAnswer({ question, evidence, resolution });
    const pipeline = runOfficialTimingPlannedPipeline(plan);
    const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
    const authorization = authorizeOfficialTimingCapability({
      question, evidence, resolution, plan, pipeline, proof,
      request_id: 'request-1', principal_class: 'internal',
      canary: { stage: 100, subject_id: 'subject-1' }, release: releaseBinding(), now_ms: NOW
    });
    const execution = await executeOfficialTimingPlan(
      fakePool(MEAN_ROWS), authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash,
      {
        request_id: 'request-1', principal_class: 'internal', statement_timeout_ms: 2000,
        deadline_ms: NOW + 5000, is_kill_switch_active: () => false, now_ms: NOW + 100
      }
    );
    expect(() => formatOfficialTimingResult(execution, { question, evidence, resolution, plan, pipeline, proof }))
      .toThrowError(expect.objectContaining({ reason: 'coverage_arithmetic_invalid' }));
  });
});

function CERTIFIED() {
  return WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope;
}
