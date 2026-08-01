import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAnswerExecutionAuthorization } from '../../src/f1ql/answer-authorization';
import { executeAuthorizedAnswer } from '../../src/f1ql/answer-execution';
import {
  ActiveAnswerReleaseContext,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationSigningPayload,
  verifyAnswerReleaseAttestation
} from '../../src/f1ql/answer-release-attestation';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { proveAnswerIntent, VerifiedAnswerSemanticProof } from '../../src/f1ql/answer-semantic-proof';
import { executeF1QL } from '../../src/f1ql/executor';
import { F1QLResultLimitError, F1QLStatementTimeoutError } from '../../src/f1ql/executor';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { FINAL_STANDINGS_ROWS_CAVEAT } from '../../src/f1ql/final-standings-response-contract';

const nowMs = Date.parse('2026-07-24T00:01:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const trustedKey = { key_id: 'execution-release-key', public_key: keyPair.publicKey };
const runtime = {
  max_concurrency: 2, queue_timeout_ms: 2_000, request_timeout_ms: 12_000, rate_limit_max: 10,
  rate_limit_window_ms: 900_000, statement_timeout_ms: 3_000, max_work_units: 200, max_rows: 100, max_response_bytes: 65_536
};
const hash = (digit: string) => digit.repeat(64);
const canaryKeyHash = createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex');

function release(templateId: string, deploymentId = 'execution-test-deployment') {
  const context: ActiveAnswerReleaseContext = {
    release_id: 'execution-test-release', issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:10:00.000Z',
    commit_sha: 'e'.repeat(40),
    audience: 'f1muse-answer', deployment_id: deploymentId,
    canary_policy_version: 'answer-canary-hmac-v1', maximum_canary_stage: 100, canary_hmac_key_sha256: canaryKeyHash,
    evidence_hashes: {
      manifest_sha256: hash('8'), artifact_sha256: hash('9'), report_sha256: hash('a'),
      result_fixture_sha256: hash('b'), principal_audit_sha256: hash('c'), production_evidence_sha256: hash('d'),
      semantic_catalog_hash: hash('e'), semantic_catalog_database_binding_hash: hash('f'), semantic_catalog_binding_artifact_sha256: hash('0')
    },
    statuses: { semantic: 'pass', safety: 'pass', linker: 'pass' },
    runtime, deployment_template_ids: [templateId], answer_routing_mode: 'template_only',
    deployment_capability_profile_ids: [], migrated_template_ids: [], deployment_principal_classes: ['internal']
  };
  const unsigned = {
    version: 8 as const, kind: 'f1ql_answer_release_attestation' as const,
    key_id: trustedKey.key_id, ...buildActiveAnswerReleaseBindings(context)
  };
  const raw = { ...unsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), keyPair.privateKey).toString('base64') };
  return verifyAnswerReleaseAttestation(raw, trustedKey, context, { now_ms: nowMs, max_validity_ms: 600_000, max_age_ms: 300_000 });
}

function span(question: string, text: string) {
  const start = Array.from(question.slice(0, question.indexOf(text))).length;
  return { text, start, end: start + Array.from(text).length };
}

async function leaderProof(): Promise<VerifiedAnswerSemanticProof> {
  const question = 'Who led the 2025 standings?';
  return proveAnswerIntent(createAnswerQuestionContract(question), {
    type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025')
  }, {
    resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' })
  }, { inventoryMentions: async () => [] });
}

async function driverProof(): Promise<VerifiedAnswerSemanticProof> {
  const question = '2025 standings points for Lando Norris';
  const driverReference = span(question, 'Lando Norris');
  return proveAnswerIntent(createAnswerQuestionContract(question), {
    type: 'final_standings_points', season: 2025, season_reference: span(question, '2025'), driver_references: [driverReference]
  }, {
    resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' })
  }, {
    inventoryMentions: async () => [{ ...driverReference, candidates: ['lando_norris'], active_candidates: ['lando_norris'] }]
  });
}

async function unfilteredPointsProof(): Promise<VerifiedAnswerSemanticProof> {
  const question = 'Show the final 2025 standings points.';
  return proveAnswerIntent(createAnswerQuestionContract(question), {
    type: 'final_standings_points', season: 2025, season_reference: span(question, '2025'), driver_references: []
  }, {
    resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' })
  }, { inventoryMentions: async () => [] });
}

async function currentProof(): Promise<VerifiedAnswerSemanticProof> {
  const question = 'Show the latest recorded 2026 driver standings.';
  return proveAnswerIntent(createAnswerQuestionContract(question), {
    type: 'current_standings', season: 2026, season_reference: span(question, '2026')
  }, {
    resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' })
  }, { inventoryMentions: async () => [] });
}

function authority(proof: VerifiedAnswerSemanticProof, deploymentId = 'execution-test-deployment') {
  const attestation = release(proof.template_id, deploymentId);
  const requestId = randomUUID();
  const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', proof, attestation, nowMs);
  return {
    authorization,
    context: {
      request_id: requestId,
      audience: attestation.audience,
      deployment_id: attestation.deployment_id,
      release_attestation: attestation,
      is_kill_switch_active: () => false
    }
  };
}

describe('answer execution service', () => {
  it('keeps normal F1QL execution on the public participation relation', async () => {
    const proof = await driverProof();
    const client = {
      query: vi.fn(async (sql: string) => sql === 'COMMIT' || sql === 'BEGIN READ ONLY' || sql.startsWith('SELECT set_config')
        ? { rows: [] }
        : { rows: [{ driver_id: 'lando-norris', points: '357' }] }),
      release: vi.fn()
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [{ driver_id: 'lando-norris' }] })),
      connect: vi.fn(async () => client)
    } as unknown as Pool;

    await executeF1QL(pool, proof.program);

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM season_entrant_driver'), [2025, ['lando-norris']]);
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('f1ql.answer_season_participation'), expect.anything());
  });

  it('consumes authorization immediately before read-only database work and returns exact serialized bytes', async () => {
    const proof = await driverProof();
    const { authorization, context } = authority(proof);
    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') order.push('begin');
        else if (sql.startsWith("SELECT set_config('statement_timeout'")) order.push('timeout');
        else if (sql === 'COMMIT') order.push('commit');
        else if (sql === 'ROLLBACK') order.push('rollback');
        else if (sql.includes('f1ql.answer_season_participation')) {
          order.push('participation');
          return { rows: [{ driver_id: 'lando-norris' }] };
        }
        else {
          order.push('execute');
          return { rows: [{ driver_id: 'lando-norris', points: '357.000' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => { order.push('connect'); return client; })
    } as unknown as Pool;
    context.is_kill_switch_active = () => { order.push('consume'); return false; };

    const result = await executeAuthorizedAnswer(pool, authorization, proof, context, { now: () => nowMs });

    expect(order).toEqual(['consume', 'connect', 'begin', 'timeout', 'participation', 'consume', 'timeout', 'execute', 'consume', 'commit', 'consume']);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('f1ql.answer_season_participation'), [2025, ['lando-norris']]);
    expect(client.query.mock.calls[1]).toEqual(["SELECT set_config('statement_timeout', $1, true)", ['3000ms']]);
    expect(Buffer.from(result.serialized_response, 'utf8')).toEqual(Buffer.from(JSON.stringify(result.response), 'utf8'));
    expect(JSON.parse(result.serialized_response)).toEqual(result.response);
    expect(result.response.answer.facts[0].values).toEqual({ points: '357' });
  });

  it('returns 100 final standings rows with a proven truncation witness and never reads the probe row', async () => {
    const proof = await unfilteredPointsProof();
    const { authorization, context } = authority(proof);
    const rows = Array.from({ length: 100 }, (_, index) => ({
      driver_id: `driver-${String(index).padStart(3, '0')}`,
      points: '1.000'
    }));
    let probeAccessed = false;
    const probe = Object.defineProperty({ driver_id: 'probe-row' }, 'points', {
      enumerable: true,
      get: () => {probeAccessed = true; throw new Error('probe row was accessed');}
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT * FROM')) {return { rows: [...rows, probe] };}
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool;

    const result = await executeAuthorizedAnswer(pool, authorization, proof, context, { now: () => nowMs });

    expect(result.response.rows).toHaveLength(100);
    expect(result.response.metadata.coverage).toEqual({ status: 'possibly_truncated', rows_returned: 100 });
    expect(result.response.metadata.caveats).toEqual([FINAL_STANDINGS_ROWS_CAVEAT]);
    const resultCall = calls.find(call => call.sql.startsWith('SELECT * FROM'));
    expect(resultCall?.sql).toContain('ORDER BY driver_id COLLATE "C" ASC LIMIT');
    expect(resultCall?.params?.at(-1)).toBe(101);
    expect(probeAccessed).toBe(false);
    expect(result.serialized_response).not.toContain('probe-row');

    const sparseRows = [...rows];
    sparseRows.length = 101;
    const sparseAuthority = authority(proof);
    const sparseClient = {
      query: vi.fn(async (sql: string) => sql.startsWith('SELECT * FROM')
        ? { rows: sparseRows }
        : { rows: [] }),
      release: vi.fn()
    };
    await expect(executeAuthorizedAnswer(
      { query: vi.fn(), connect: vi.fn(async () => sparseClient) } as unknown as Pool,
      sparseAuthority.authorization,
      proof,
      sparseAuthority.context,
      { now: () => nowMs }
    )).rejects.toThrow('invalid completeness probe row');
  });

  it('executes current standings through release-bound read-only authority', async () => {
    const proof = await currentProof();
    const { authorization, context } = authority(proof);
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT * FROM')) {
          return { rows: [
            { driver_id: 'lando-norris', championship_position: 1, points: '42' },
            { driver_id: 'oscar-piastri', championship_position: 2, points: '42' }
          ] };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool;

    const result = await executeAuthorizedAnswer(pool, authorization, proof, context, { now: () => nowMs });

    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements).toContain("SELECT set_config('statement_timeout', $1, true)");
    expect(statements.at(-1)).toBe('COMMIT');
    expect(result.response.metadata).toMatchObject({ source: 'current_driver_standings', caveats: ['season_in_progress'] });
    expect(result.response.answer).toMatchObject({ headline: 'Latest recorded 2026 driver standings.' });
  });

  it('executes zero database operations for copied, killed, and replayed authorization', async () => {
    const proof = await leaderProof();
    const makePool = () => ({
      query: vi.fn(),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => sql.startsWith('SELECT * FROM')
          ? { rows: [{ driver_id: 'lando-norris', championship_position: 1, points: '357' }] }
          : { rows: [] }),
        release: vi.fn()
      }))
    } as unknown as Pool);

    const copied = authority(proof);
    const copiedPool = makePool();
    await expect(executeAuthorizedAnswer(copiedPool, { ...copied.authorization } as never, proof, copied.context, { now: () => nowMs }))
      .rejects.toMatchObject({ code: 'invalid_authorization' });
    expect(copiedPool.query).not.toHaveBeenCalled();
    expect(copiedPool.connect).not.toHaveBeenCalled();

    const otherProof = await driverProof();
    const mismatchedPool = makePool();
    await expect(executeAuthorizedAnswer(mismatchedPool, copied.authorization, otherProof, copied.context, { now: () => nowMs }))
      .rejects.toMatchObject({ code: 'authorization_binding_mismatch' });
    expect(mismatchedPool.query).not.toHaveBeenCalled();
    expect(mismatchedPool.connect).not.toHaveBeenCalled();

    const killed = authority(proof);
    const killedPool = makePool();
    killed.context.is_kill_switch_active = () => true;
    await expect(executeAuthorizedAnswer(killedPool, killed.authorization, proof, killed.context, { now: () => nowMs }))
      .rejects.toMatchObject({ code: 'kill_switch_active' });
    expect(killedPool.query).not.toHaveBeenCalled();
    expect(killedPool.connect).not.toHaveBeenCalled();

    const replayed = authority(proof);
    const replayedPool = makePool();
    await executeAuthorizedAnswer(replayedPool, replayed.authorization, proof, replayed.context, { now: () => nowMs });
    vi.mocked(replayedPool.query).mockClear();
    vi.mocked(replayedPool.connect).mockClear();
    await expect(executeAuthorizedAnswer(replayedPool, replayed.authorization, proof, replayed.context, { now: () => nowMs }))
      .rejects.toMatchObject({ code: 'authorization_replayed' });
    expect(replayedPool.query).not.toHaveBeenCalled();
    expect(replayedPool.connect).not.toHaveBeenCalled();
  });

  it.each(['kill_switch', 'authorization_expiry'] as const)('rechecks %s after participation and before the result query', async failure => {
    const proof = await driverProof();
    const { authorization, context } = authority(proof);
    let killed = false;
    let clock = nowMs;
    context.is_kill_switch_active = () => killed;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('f1ql.answer_season_participation')) {
          killed = failure === 'kill_switch';
          clock = failure === 'authorization_expiry' ? nowMs + 5_000 : clock;
          return { rows: [{ driver_id: 'lando-norris' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(executeAuthorizedAnswer(pool, authorization, proof, context, { now: () => clock }))
      .rejects.toBeInstanceOf(Error);

    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('SELECT * FROM'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it.each(['timeout', 'row_overflow'] as const)('keeps %s typed and bounded', async failure => {
    const proof = await leaderProof();
    const { authorization, context } = authority(proof);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM')) {
          if (failure === 'timeout') {
            throw Object.assign(new Error('cancelled'), { code: '57014' });
          }
          return { rows: Array.from({ length: 101 }, (_, index) => ({ driver_id: `driver-${index}`, championship_position: index + 1, points: '1' })) };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool;

    const execution = executeAuthorizedAnswer(pool, authorization, proof, context, { now: () => nowMs });
    await expect(execution).rejects.toBeInstanceOf(failure === 'timeout' ? F1QLStatementTimeoutError : F1QLResultLimitError);
  });

  it.each(['kill_switch', 'request_abort'] as const)('suppresses a completed result when %s activates during the query', async failure => {
    const proof = await leaderProof();
    const { authorization, context } = authority(proof);
    const controller = new AbortController();
    let killed = false;
    context.is_kill_switch_active = () => killed;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM')) {
          killed = failure === 'kill_switch';
          if (failure === 'request_abort') controller.abort();
          return { rows: [{ driver_id: 'lando-norris', championship_position: 1, points: '357' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(executeAuthorizedAnswer(pool, authorization, proof, context, {
      now: () => nowMs, signal: controller.signal, deadlineMs: nowMs + 10_000
    })).rejects.toBeInstanceOf(Error);

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
});

const restrictedRole = 'f1ql_answer_execution_test';
let adminPool: Pool;

describe('answer execution restricted-role participation', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(adminPool, { seed: false });
    await adminPool.query('CREATE TABLE driver_aliases (driver_id text, alias text, is_primary boolean)');
    await adminPool.query(readFileSync(path.resolve(process.cwd(), 'migrations/20260729_f1ql_answer_identity_views.sql'), 'utf8'));
    await adminPool.query(readFileSync(path.resolve(process.cwd(), 'migrations/20260730_normalize_f1ql_answer_identity_driver_ids.sql'), 'utf8'));
    await adminPool.query(`CREATE ROLE ${restrictedRole} NOLOGIN`);
    await adminPool.query(`GRANT USAGE ON SCHEMA f1ql TO ${restrictedRole}`);
    await adminPool.query(`GRANT SELECT ON f1ql.driver_standings, f1ql.event_classification, f1ql.qualifying_classification, f1ql.event_metadata, f1ql.answer_driver_identity, f1ql.answer_event_identity, f1ql.answer_season_participation TO ${restrictedRole}`);
    await adminPool.query(`
      INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation)
        VALUES ('lando_norris', 'Lando Norris', 'Lando Norris', 'Lando', 'Norris', 'NOR');
      INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver)
        VALUES (2025, 'mclaren', 'MCLAREN', 'lando_norris', false);
      INSERT INTO season_driver_standing
        (year, position_display_order, position_number, position_text, driver_id, points, championship_won)
        VALUES (2025, 2, 2, '2', 'lando_norris', 357, false);
    `);
  });

  afterAll(async () => {
    if (adminPool) {
      await adminPool.query(`DROP OWNED BY ${restrictedRole}; DROP ROLE IF EXISTS ${restrictedRole}`);
      await adminPool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
      await adminPool.query('DROP TABLE IF EXISTS driver_aliases');
      await adminPool.end();
    }
  });

  it('validates driver participation through only the answer view without base-table access', async () => {
    const client = await adminPool.connect();
    try {
      await client.query(`SET ROLE ${restrictedRole}`);
      await expect(client.query('SELECT driver_id FROM season_entrant_driver LIMIT 1')).rejects.toMatchObject({ code: '42501' });
      const restrictedPool = {
        query: client.query.bind(client),
        connect: async () => ({ query: client.query.bind(client), release: () => undefined })
      } as unknown as Pool;
      const proof = await driverProof();
      const { authorization, context } = authority(proof, 'restricted-execution-test');

      const result = await executeAuthorizedAnswer(restrictedPool, authorization, proof, context, { now: () => nowMs });

      expect(result.response.rows).toEqual([{ driver_id: 'lando-norris', points: '357' }]);
      expect(result.response.answer.facts).toEqual([{ subject: 'lando-norris', values: { points: '357' } }]);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
});
