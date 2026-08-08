import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerOfficialTimingQuestion,
  OfficialTimingAnswerDependencies
} from '../../src/f1ql/official-timing-answer';
import { OFFICIAL_TIMING_CAPABILITY_PROFILE_ID, OFFICIAL_TIMING_CATALOG_V2_SHA256 } from '../../src/f1ql/official-timing-capability';
import { prepareOfficialTimingTestDatabase } from '../../scripts/prepare-official-timing-test-db';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../../src/identity/answer-identity-resolvers';
import { parseOfficialTimingQuestion } from '../../src/f1ql/official-timing-question';
import { getTestDatabaseUrl } from '../../src/test/setup';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';

function proposerFor(question: string) {
  const parsed = parseOfficialTimingQuestion(question);
  if (parsed.type !== 'matched') {throw new Error('question must match');}
  const span = ({ start, end }: { start: number; end: number }) => ({ start, end });
  return {
    propose: async () => ({
      operation: 'certified_official_timing_compare',
      driver_a_span: span(parsed.driver_a),
      driver_b_span: span(parsed.driver_b),
      event_span: span(parsed.event_span),
      operation_evidence: [span(parsed.operation_span)],
      season_evidence: [span(parsed.season_span)],
      lap_range_evidence: parsed.lap_range === null
        ? null
        : { start_span: span(parsed.lap_range.start_span), end_span: span(parsed.lap_range.end_span) }
    })
  };
}

function releaseBinding(nowMs = NOW) {
  return {
    release_version: 9 as const,
    release_id: 'test-release-9',
    commit_sha: 'a'.repeat(40),
    audience: 'f1muse-answer',
    deployment_id: 'test-deployment',
    expires_at: new Date(nowMs + 300_000).toISOString(),
    routing_mode: 'compositional_profiles' as const,
    allowed_capability_profile_ids: [OFFICIAL_TIMING_CAPABILITY_PROFILE_ID],
    allowed_principal_classes: ['internal' as const],
    catalog_hash: OFFICIAL_TIMING_CATALOG_V2_SHA256,
    release_attestation_sha256: 'b'.repeat(64)
  };
}

function fakePool(rows: Record<string, unknown>[]) {
  const client = {
    query: async (sql: string) => ({ rows: sql.startsWith('WITH') || sql.startsWith('SELECT') ? rows : [] }),
    release: () => undefined
  };
  return { connect: async () => client } as never;
}

function coverageServingPool() {
  const coverageRow = (driverId: string) => ({
    driver_id: driverId, completed_laps: 44, eligible_laps: 42, deleted_laps: 1,
    pit_marker_laps: 1, first_lap: 1, last_lap: 44, distinct_laps: 44, dataset_count: 1
  });
  const client = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT') && sql.includes('COUNT')) {
        return { rows: [coverageRow('fernando-alonso'), coverageRow('max-verstappen')] };
      }
      if (sql.startsWith('WITH')) {
        return { rows: MEAN_ROWS };
      }
      return { rows: [] };
    },
    release: () => undefined
  };
  return { connect: async () => client } as never;
}

const MEAN_ROWS = [{
  driver_a_eligible_laps: 42, driver_a_total_ms: '3780000',
  driver_b_eligible_laps: 42, driver_b_total_ms: '3781260'
}];

function unitDependencies(overrides: Partial<OfficialTimingAnswerDependencies> = {}): OfficialTimingAnswerDependencies {
  return {
    database: fakePool(MEAN_ROWS),
    catalog: CATALOG_V2,
    proposer: proposerFor(EVENT_MEAN_QUESTION),
    driver_resolver: {
      resolveUnambiguous: async (alias: string) => {
        const ids: Record<string, string> = { 'Max Verstappen': 'max-verstappen', 'Fernando Alonso': 'fernando-alonso' };
        const id = ids[alias];
        return id
          ? { success: true, f1db_driver_id: id, candidates: [id], match_mode: 'literal' }
          : { success: false, error: 'unknown_driver' };
      }
    },
    event_resolver: {
      resolveRound: async (season: number, round: number) =>
        season === 2022 && round === 14 ? { type: 'resolved', season, round } : { type: 'missing' }
    },
    release: releaseBinding(),
    principal_class: 'internal',
    canary: { stage: 100, subject_id: 'subject-1' },
    request_id: 'request-1',
    statement_timeout_ms: 2000,
    request_deadline_ms: NOW + 10_000,
    is_kill_switch_active: () => false,
    now_ms: NOW + 100,
    ...overrides
  };
}

describe('official timing answer orchestrator (unit)', () => {
  it('answers a matched question end to end through the sealed chain', async () => {
    // The unit path injects the coverage reader indirectly: use the real resolution path with
    // a fake coverage-capable pool that serves the coverage query and the result query.
    const rows = {
      coverage: [{
        driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 42, deleted_laps: 1,
        pit_marker_laps: 1, first_lap: 1, last_lap: 44, distinct_laps: 44, dataset_count: 1
      }, {
        driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 42, deleted_laps: 1,
        pit_marker_laps: 1, first_lap: 1, last_lap: 44, distinct_laps: 44, dataset_count: 1
      }],
      result: MEAN_ROWS
    };
    const client = {
      calls: 0,
      query: async (sql: string) => {
        if (sql.startsWith('SELECT') && sql.includes('COUNT')) {
          return { rows: rows.coverage };
        }
        if (sql.startsWith('WITH')) {
          return { rows: rows.result };
        }
        return { rows: [] };
      },
      release: () => undefined
    };
    const deps = unitDependencies({ database: { connect: async () => client } as never });
    const outcome = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, deps);
    expect(outcome.type).toBe('answered');
    if (outcome.type !== 'answered') {throw new Error('expected answered');}
    expect(outcome.envelope.mode).toBe('proven_semantic_result');
    expect(outcome.envelope.format_version).toBe('semantic-result-format-v32');
    expect(outcome.envelope.rows[0].winner_driver_id).toBe('max-verstappen');
  });

  it('refuses grammar rejections and honors the kill switch', async () => {
    const refused = await answerOfficialTimingQuestion(
      'Who was faster on soft tyres between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?',
      unitDependencies()
    );
    expect(refused).toEqual({ type: 'refused', reason: 'tyre' });
    const invalid = await answerOfficialTimingQuestion(42, unitDependencies());
    expect(invalid).toEqual({ type: 'refused', reason: 'question_invalid' });
    const killed = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      is_kill_switch_active: () => true
    }));
    expect(killed).toEqual({ type: 'unavailable', reason: 'kill_switch_active' });
    // Kill switch precedes grammar work entirely.
    const killedRefusal = await answerOfficialTimingQuestion(
      'Who was faster on soft tyres between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?',
      unitDependencies({ is_kill_switch_active: () => true })
    );
    expect(killedRefusal).toEqual({ type: 'unavailable', reason: 'kill_switch_active' });
    const timedOut = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      request_deadline_ms: NOW + 50
    }));
    expect(timedOut).toEqual({ type: 'unavailable', reason: 'request_timeout' });
  });

  it('maps provider failure, malformed proposals, and drift to closed outcomes', async () => {
    const unavailable = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      proposer: { propose: async () => { throw new Error('upstream down'); } }
    }));
    expect(unavailable).toEqual({ type: 'unavailable', reason: 'provider_unavailable' });
    const malformed = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      proposer: { propose: async () => ({ operation: 'wrong' }) }
    }));
    expect(malformed).toEqual({ type: 'unavailable', reason: 'provider_malformed' });
    const drifted = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      proposer: {
        propose: async () => {
          const response = await proposerFor(EVENT_MEAN_QUESTION).propose();
          return { ...response, driver_a_span: { start: response.driver_a_span.start + 1, end: response.driver_a_span.end } };
        }
      }
    }));
    expect(drifted).toEqual({ type: 'abstained', reason: 'provider_candidate_not_enumerated' });
  });

  it('maps release and coverage failures to closed unavailable reasons', async () => {
    const routing = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      database: coverageServingPool(),
      release: { ...releaseBinding(), routing_mode: 'template_only' as never }
    }));
    expect(routing).toEqual({ type: 'unavailable', reason: 'routing_mode_inactive' });
    const expired = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      database: coverageServingPool(),
      release: releaseBinding(NOW - 600_000)
    }));
    expect(expired).toEqual({ type: 'unavailable', reason: 'release_inactive' });
  });

  it('propagates coverage abstention as a typed abstained outcome', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT') && sql.includes('COUNT')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => undefined
    };
    const outcome = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, unitDependencies({
      database: { connect: async () => client } as never
    }));
    // An empty coverage result for drivers with positive classified laps is an integrity abstention.
    expect(outcome.type).toBe('abstained');
  });
});

describe('official timing answer orchestrator (wrapped database round trip)', () => {
  let pool: Pool | undefined;
  let answerPool: Pool | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await prepareOfficialTimingTestDatabase(pool);
    answerPool = new Pool({ connectionString: getTestDatabaseUrl(), options: '-c role=f1ql_answer', max: 2 });
  });

  afterAll(async () => {
    await answerPool?.end();
    if (pool) {
      await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
      await pool.query('DROP TABLE IF EXISTS driver_aliases');
      await pool.end();
    }
  });

  it('answers both reference questions through the real chain as f1ql_answer', async () => {
    const now = Date.now();
    const base = {
      database: answerPool as Pool,
      catalog: CATALOG_V2,
      release: releaseBinding(now),
      principal_class: 'internal' as const,
      canary: { stage: 100, subject_id: 'answer-test' },
      statement_timeout_ms: 2000,
      is_kill_switch_active: () => false,
      now_ms: now
    };
    const mean = await answerOfficialTimingQuestion(EVENT_MEAN_QUESTION, {
      ...base,
      proposer: proposerFor(EVENT_MEAN_QUESTION),
      driver_resolver: new AnswerDriverIdentityResolver(answerPool as Pool),
      event_resolver: new AnswerEventIdentityResolver(answerPool as Pool),
      request_id: 'answer-mean',
      request_deadline_ms: now + 10_000
    });
    expect(mean.type).toBe('answered');
    if (mean.type !== 'answered') {throw new Error('expected answered');}
    expect(mean.envelope.rows[0].driver_a_mean_lap_time_seconds).toBe('117.0939');
    expect(mean.envelope.rows[0].winner_driver_id).toBe('max-verstappen');
    const medianQuestion = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 3 to 10 at the 2022 Belgian Grand Prix';
    const median = await answerOfficialTimingQuestion(
      medianQuestion,
      {
        ...base,
        proposer: proposerFor(medianQuestion),
        driver_resolver: new AnswerDriverIdentityResolver(answerPool as Pool),
        event_resolver: new AnswerEventIdentityResolver(answerPool as Pool),
        request_id: 'answer-median',
        request_deadline_ms: now + 10_000
      }
    );
    expect(median.type).toBe('answered');
    if (median.type !== 'answered') {throw new Error('expected answered');}
    expect(median.envelope.rows[0].driver_a_median_lap_time_seconds).toBe('113.8495');
    expect(median.envelope.rows[0].median_delta_seconds).toBe('1.3335');
  });
});
