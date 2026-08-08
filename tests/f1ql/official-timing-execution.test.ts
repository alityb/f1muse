import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import {
  executeOfficialTimingPlan,
  OFFICIAL_TIMING_EXECUTION_RESULT_VERSION,
  verifyOfficialTimingExecutionResult
} from '../../src/f1ql/official-timing-execution';
import { OFFICIAL_TIMING_CAPABILITY_PROFILE_ID, OFFICIAL_TIMING_CATALOG_V2_SHA256 } from '../../src/f1ql/official-timing-capability';
import { ingestHistoricalLapDataset } from '../../src/etl/historical-lap-ingestion';
import { loadHistoricalLapPilot } from '../../src/etl/historical-lap-window-pilot';
import { readOfficialTimingCoverage } from '../../src/f1ql/official-timing-coverage';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

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

function releaseBinding(nowMs = NOW): OfficialTimingReleaseBinding {
  return {
    release_version: 9,
    release_id: 'test-release-9',
    commit_sha: 'a'.repeat(40),
    audience: 'f1muse-answer',
    deployment_id: 'test-deployment',
    expires_at: new Date(nowMs + 300_000).toISOString(),
    routing_mode: 'compositional_profiles',
    allowed_capability_profile_ids: [OFFICIAL_TIMING_CAPABILITY_PROFILE_ID],
    allowed_principal_classes: ['internal', 'internal_canary', 'public'],
    catalog_hash: OFFICIAL_TIMING_CATALOG_V2_SHA256,
    release_attestation_sha256: 'b'.repeat(64)
  };
}

interface FakeCall { readonly sql: string; readonly params?: unknown[] }

function fakePool(rows: Record<string, unknown>[], options: {
  failQueryWith?: { code?: string };
  track?: { calls: FakeCall[]; releasedWith?: Error };
} = {}) {
  const calls: FakeCall[] = [];
  const track = options.track ?? { calls };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      track.calls.push({ sql, params });
      if (sql.startsWith('SELECT') || sql.startsWith('WITH')) {
        if (options.failQueryWith) {
          const error = new Error('query failed');
          Object.assign(error, options.failQueryWith);
          throw error;
        }
        return { rows };
      }
      return { rows: [] };
    },
    release: (error?: Error) => { track.releasedWith = error; }
  };
  return {
    track,
    pool: { connect: async () => client } as unknown as Pool
  };
}

function coverageFor(metric: string, eligibleA = 42, eligibleB = 42) {
  const isEvent = metric === 'official_non_deleted_non_pit_event_mean_v1';
  return async () => ({
    type: 'eligible',
    source_id: 'official_race_lap_timing',
    metric,
    coverage_query_id: isEvent ? 'official_event_coverage_v1' : 'official_window_coverage_v1',
    coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[isEvent ? 0 : 1].statement_sha256,
    query_calls: 1,
    driver_coverage: [
      { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: eligibleA, excluded_deleted_laps: 1, excluded_pit_marker_laps: 1 },
      { driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: eligibleB, excluded_deleted_laps: 1, excluded_pit_marker_laps: 1 }
    ]
  }) as never;
}

function dependenciesFor(metric: string, reader = coverageFor(metric)): OfficialTimingResolutionDependencies {
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
    coverage_reader: reader
  };
}

async function authorizedChain(questionText = EVENT_MEAN_QUESTION, reader?: never) {
  const question = matched(questionText);
  const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
  const metric = evidence.candidates[0].metric_id;
  const resolution = await collectOfficialTimingResolution(question, evidence, dependenciesFor(metric, reader));
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
  return { question, evidence, resolution, plan, pipeline, proof, authorization };
}

const executionContext = {
  request_id: 'request-1',
  principal_class: 'internal' as const,
  statement_timeout_ms: 2000,
  deadline_ms: NOW + 5000,
  is_kill_switch_active: () => false,
  now_ms: NOW + 100
};

describe('official timing execution result v3 (unit)', () => {
  const meanRows = [{
    driver_a_eligible_laps: 42, driver_a_total_ms: '3700000',
    driver_b_eligible_laps: 42, driver_b_total_ms: '3780000'
  }];

  it('executes the compiled statement with the sealed transaction envelope', async () => {
    const { pipeline, proof, authorization } = await authorizedChain();
    const { pool, track } = fakePool(meanRows);
    const result = await executeOfficialTimingPlan(
      pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext
    );
    expect(result.version).toBe(OFFICIAL_TIMING_EXECUTION_RESULT_VERSION);
    expect(result.rows).toHaveLength(1);
    expect(result.rows_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.returned_row_limit).toBe(1);
    expect(result.has_more_rows).toBe(false);
    expect(result.transaction).toBe('repeatable_read_read_only');
    expect(result.authorization_hash).toBe(authorization.authorization_hash);
    expect(result.compiled_hash).toBe(pipeline.compiled.compiled_sha256);
    expect(result.planned_core_hash).toBe(pipeline.planned_core_hash);
    expect(result.planned_f1ql_hash).toBe(pipeline.compiled.planned_f1ql_hash);
    expect(result.semantic_plan_proof_hash).toBe(proof.proof_hash);
    expect(result.result_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyOfficialTimingExecutionResult(result)).toBe(result);
    expect(track.calls.map(call => call.sql.split(' ')[0])).toEqual(['BEGIN', 'SET', 'WITH', 'COMMIT']);
    const statement = track.calls[2];
    expect(statement.sql).toBe(pipeline.compiled.statement);
    expect(statement.params).toEqual([2022, 14, 'R', 'max-verstappen', 'fernando-alonso']);
    expect(track.calls[1].sql).toContain('statement_timeout');
    expect(track.releasedWith).toBeUndefined();
  });

  it('consumes the authorization exactly once before any database acquisition', async () => {
    const { pipeline, proof, authorization } = await authorizedChain();
    const { pool, track } = fakePool(meanRows);
    await executeOfficialTimingPlan(pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext);
    const second = fakePool(meanRows);
    await expect(executeOfficialTimingPlan(
      second.pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'authorization_replayed' }));
    expect(second.track.calls).toHaveLength(0);
  });

  it('rejects a forged planned-core hash and cloned result objects', async () => {
    const { pipeline, proof, authorization } = await authorizedChain();
    const { pool, track } = fakePool(meanRows);
    await expect(executeOfficialTimingPlan(
      pool, authorization, pipeline.compiled, proof.proof_hash, 'f'.repeat(64), executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'authorization_binding_mismatch' }));
    expect(track.calls).toHaveLength(0);
    const second = await authorizedChain();
    const result = await executeOfficialTimingPlan(
      fakePool(meanRows).pool, second.authorization, second.pipeline.compiled,
      second.proof.proof_hash, second.pipeline.planned_core_hash, executionContext
    );
    expect(() => verifyOfficialTimingExecutionResult(structuredClone(result)))
      .toThrowError(expect.objectContaining({ code: 'result_invalid' }));
    expect(() => verifyOfficialTimingExecutionResult({ ...result }))
      .toThrowError(expect.objectContaining({ code: 'result_invalid' }));
  });

  it('propagates typed replay and expired-deadline failures before connecting', async () => {
    const { pipeline, proof, authorization } = await authorizedChain();
    const { pool, track } = fakePool(meanRows);
    await executeOfficialTimingPlan(pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext);
    const replay = fakePool(meanRows);
    await expect(executeOfficialTimingPlan(
      replay.pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'authorization_replayed' }));
    expect(replay.track.calls).toHaveLength(0);
    const expired = await authorizedChain();
    await expect(executeOfficialTimingPlan(
      fakePool(meanRows).pool, expired.authorization, expired.pipeline.compiled,
      expired.proof.proof_hash, expired.pipeline.planned_core_hash,
      { ...executionContext, deadline_ms: NOW - 1 }
    )).rejects.toThrowError(expect.objectContaining({ code: 'transaction_setup_failed' }));
  });

  it('rejects compiled statements that do not match the authorization before connecting', async () => {
    const first = await authorizedChain();
    const second = await authorizedChain(WINDOW_MEDIAN_QUESTION);
    const { pool, track } = fakePool(meanRows);
    await expect(executeOfficialTimingPlan(
      pool, first.authorization, second.pipeline.compiled, first.proof.proof_hash, first.pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'authorization_binding_mismatch' }));
    expect(track.calls).toHaveLength(0);
  });

  it('rolls back and discards the connection on invalid rows', async () => {
    const { pipeline, proof, authorization } = await authorizedChain();
    const { pool, track } = fakePool([{ driver_a_eligible_laps: -1 }]);
    await expect(executeOfficialTimingPlan(
      pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'result_invalid' }));
    // Unsafe result failures discard the connection without an in-band rollback.
    expect(track.calls.map(call => call.sql.split(' ')[0])).toEqual(['BEGIN', 'SET', 'WITH']);
    expect(track.releasedWith).toBeInstanceOf(Error);
  });

  it('maps statement timeouts and query failures to closed codes', async () => {
    const timeoutChain = await authorizedChain();
    const timeoutPool = fakePool([], { failQueryWith: { code: '57014' } });
    await expect(executeOfficialTimingPlan(
      timeoutPool.pool, timeoutChain.authorization, timeoutChain.pipeline.compiled,
      timeoutChain.proof.proof_hash, timeoutChain.pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'statement_timeout' }));
    const failureChain = await authorizedChain();
    const failurePool = fakePool([], { failQueryWith: {} });
    await expect(executeOfficialTimingPlan(
      failurePool.pool, failureChain.authorization, failureChain.pipeline.compiled,
      failureChain.proof.proof_hash, failureChain.pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'result_query_failed' }));
  });

  it('validates median rows: sorted integer millisecond arrays matching eligible counts', async () => {
    const medianRows = [{
      driver_a_eligible_laps: 8, driver_a_ms_values: ['90000', '90100', '90200', '90300', '90400', '90500', '90600', '90700'],
      driver_b_eligible_laps: 8, driver_b_ms_values: ['91000', '91100', '91200', '91300', '91400', '91500', '91600', '91700']
    }];
    const { pipeline, proof, authorization } = await authorizedChain(WINDOW_MEDIAN_QUESTION);
    const { pool } = fakePool(medianRows);
    const result = await executeOfficialTimingPlan(
      pool, authorization, pipeline.compiled, proof.proof_hash, pipeline.planned_core_hash, executionContext
    );
    expect(result.metric_id).toBe('official_non_deleted_non_pit_window_median_v1');
    const unsorted = await authorizedChain(WINDOW_MEDIAN_QUESTION);
    const badRows = [{ ...medianRows[0], driver_a_ms_values: ['90100', '90000', '90200', '90300', '90400', '90500', '90600', '90700'] }];
    await expect(executeOfficialTimingPlan(
      fakePool(badRows).pool, unsorted.authorization, unsorted.pipeline.compiled,
      unsorted.proof.proof_hash, unsorted.pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'result_invalid' }));
    const mismatched = await authorizedChain(WINDOW_MEDIAN_QUESTION);
    const shortRows = [{ ...medianRows[0], driver_a_ms_values: ['90000'] }];
    await expect(executeOfficialTimingPlan(
      fakePool(shortRows).pool, mismatched.authorization, mismatched.pipeline.compiled,
      mismatched.proof.proof_hash, mismatched.pipeline.planned_core_hash, executionContext
    )).rejects.toThrowError(expect.objectContaining({ code: 'result_invalid' }));
  });
});

describe('official timing execution result v3 (wrapped database round trip)', () => {
  let pool: Pool;
  let answerPool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool);
    const storageMigration = fs.readFileSync(path.resolve('migrations/20260801_official_timing_historical_laps.sql'), 'utf8');
    const servingMigration = fs.readFileSync(path.resolve('migrations/20260802_f1ql_official_lap_timing.sql'), 'utf8');
    const activationMigration = fs.readFileSync(path.resolve('migrations/20260807_f1ql_official_race_lap_timing_activation.sql'), 'utf8');
    await pool.query(storageMigration);
    await pool.query(servingMigration);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'f1ql_answer') THEN
        CREATE ROLE f1ql_answer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      END IF;
    END $$`);
    await pool.query('GRANT USAGE ON SCHEMA f1ql TO f1ql_answer');
    await pool.query(activationMigration);
    const sourceContent = fs.readFileSync('data/phase8-belgium-2022-pilot.json');
    const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');
    const mappings = (JSON.parse(identityContent.toString('utf8')) as { mappings: Array<{ driver_id: string }> }).mappings;
    const canonical = await pool.query<{ driver_id: string; full_name: string }>(
      'SELECT id AS driver_id, full_name FROM driver WHERE id = ANY($1::text[]) ORDER BY id',
      [mappings.map(mapping => mapping.driver_id)]
    );
    const dataset = loadHistoricalLapPilot(sourceContent, identityContent, canonical.rows);
    await ingestHistoricalLapDataset(pool, dataset);
    answerPool = new Pool({ connectionString: getTestDatabaseUrl(), options: '-c role=f1ql_answer', max: 1 });
  });

  afterAll(async () => {
    await answerPool.end();
    await pool.end();
  });

  async function realChain(questionText: string) {
    const question = matched(questionText);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    const resolution = await collectOfficialTimingResolution(question, evidence, {
      database: answerPool,
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
      }
    });
    expect(resolution.type).toBe('resolved');
    const plan = planOfficialTimingAnswer({ question, evidence, resolution });
    const pipeline = runOfficialTimingPlannedPipeline(plan);
    const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
    const authorization = authorizeOfficialTimingCapability({
      question, evidence, resolution, plan, pipeline, proof,
      request_id: `request-${questionText.length}`,
      principal_class: 'internal',
      canary: { stage: 100, subject_id: 'subject-1' },
      release: releaseBinding(Date.now()),
      now_ms: Date.now()
    });
    return { question, evidence, resolution, plan, pipeline, proof, authorization };
  }

  it('executes the event-mean statement against the real sealed view as f1ql_answer', async () => {
    const chain = await realChain(EVENT_MEAN_QUESTION);
    const result = await executeOfficialTimingPlan(
      answerPool, chain.authorization, chain.pipeline.compiled, chain.proof.proof_hash,
      chain.pipeline.planned_core_hash,
      {
        request_id: `request-${EVENT_MEAN_QUESTION.length}`,
        principal_class: 'internal',
        statement_timeout_ms: 2000,
        deadline_ms: Date.now() + 10_000,
        is_kill_switch_active: () => false
      }
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as Record<string, unknown>;
    if (chain.resolution.type !== 'resolved') {throw new Error('expected resolved');}
    const [witnessA, witnessB] = chain.resolution.coverage.driver_coverage;
    expect(row.driver_a_eligible_laps).toBe(witnessA.eligible_laps);
    expect(row.driver_b_eligible_laps).toBe(witnessB.eligible_laps);
    expect(witnessA.eligible_laps).toBe(42);
    expect(witnessB.eligible_laps).toBe(42);
    const meanA = Number(row.driver_a_total_ms) / witnessA.eligible_laps;
    const meanB = Number(row.driver_b_total_ms) / witnessB.eligible_laps;
    expect(meanA).toBeGreaterThan(80_000);
    expect(meanA).toBeLessThan(meanB);
    expect(verifyOfficialTimingExecutionResult(result)).toBe(result);
  });

  it('executes the window-median statement with sorted exact millisecond values', async () => {
    const chain = await realChain(WINDOW_MEDIAN_QUESTION);
    const result = await executeOfficialTimingPlan(
      answerPool, chain.authorization, chain.pipeline.compiled, chain.proof.proof_hash,
      chain.pipeline.planned_core_hash,
      {
        request_id: `request-${WINDOW_MEDIAN_QUESTION.length}`,
        principal_class: 'internal',
        statement_timeout_ms: 2000,
        deadline_ms: Date.now() + 10_000,
        is_kill_switch_active: () => false
      }
    );
    const row = result.rows[0] as Record<string, unknown>;
    if (chain.resolution.type !== 'resolved') {throw new Error('expected resolved');}
    const [witnessA] = chain.resolution.coverage.driver_coverage;
    expect(row.driver_a_eligible_laps).toBe(witnessA.eligible_laps);
    const values = row.driver_a_ms_values as string[];
    expect(values).toHaveLength(witnessA.eligible_laps);
    expect(values.every((value, index) => index === 0 || BigInt(values[index - 1]) <= BigInt(value))).toBe(true);
  });

  it('confirms the coverage abstention path against the real view for an uncovered driver', async () => {
    await expect(readOfficialTimingCoverage(answerPool, {
      metric: 'official_non_deleted_non_pit_event_mean_v1',
      season: 2022, round: 14, session_type: 'R',
      driver_ids: ['fernando-alonso', 'lewis-hamilton']
    })).resolves.toEqual({
      type: 'abstain', reason: 'source_coverage_missing', stage: 'official_timing_coverage', query_calls: 1
    });
  });
});
