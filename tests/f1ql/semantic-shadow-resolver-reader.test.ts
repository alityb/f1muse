import { describe, expect, it } from 'vitest';
import {
  identifySemanticShadowResolverRead,
  SEMANTIC_SHADOW_RESOLVER_MAX_RETURNED_ROWS,
  SEMANTIC_SHADOW_RESOLVER_MAX_STATEMENTS,
  SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINTS,
  SEMANTIC_SHADOW_RESOLVER_STATEMENTS,
  SemanticShadowResolverAccess,
  withSemanticShadowResolverReader
} from '../../src/f1ql/semantic-shadow-resolver-reader';

interface QueryCall {
  readonly sql: string;
  readonly parameters?: unknown[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakeDatabase(
  respond: (sql: string, parameters?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] }),
  rollback: () => Promise<void> = async () => {}
) {
  const calls: QueryCall[] = [];
  let releases = 0;
  const releaseErrors: unknown[] = [];
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      calls.push({ sql, parameters });
      if (sql === 'ROLLBACK') {
        await rollback();
        return { rows: [] };
      }
      if (sql === 'BEGIN READ ONLY' || sql.startsWith("SELECT set_config('statement_timeout'")) {
        return { rows: [] };
      }
      return respond(sql, parameters);
    },
    release(error?: unknown) { releases += 1; releaseErrors.push(error); }
  };
  return {
    calls,
    releases: () => releases,
    releaseErrors: () => releaseErrors,
    database: { connect: async () => client } as never
  };
}

describe('semantic shadow resolver metadata reader', () => {
  it('runs only fixed resolver reads, exposes no generic client, and reports exact counters', async () => {
    const fake = fakeDatabase(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [{ driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' }] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name) {
        return { rows: [{ season: 2025, round: 12, identity: 'British Grand Prix' }] };
      }
      return { rows: [] };
    });

    const result = await withSemanticShadowResolverReader(fake.database, { statementTimeoutMs: 2_000 }, async access => {
      expect(Object.keys(access).sort()).toEqual(['counters', 'driver_resolver', 'event_resolver']);
      expect('query' in access).toBe(false);
      expect('connect' in access).toBe(false);
      expect('release' in access).toBe(false);
      expect(Reflect.ownKeys(access.driver_resolver)).toEqual(['inventoryMentions']);
      expect(Reflect.ownKeys(access.event_resolver).sort()).toEqual(['resolve', 'resolveRound']);
      expect('query' in access.driver_resolver).toBe(false);
      expect('query' in access.event_resolver).toBe(false);
      expect('client' in access.driver_resolver).toBe(false);
      expect('client' in access.event_resolver).toBe(false);
      expect('database' in access.driver_resolver).toBe(false);
      expect('database' in access.event_resolver).toBe(false);
      const mentions = await access.driver_resolver.inventoryMentions('Max Verstappen at Silverstone', 2025);
      const event = await access.event_resolver.resolve(2025, 'Silverstone');
      return { mentions, event };
    });

    expect(result.value).toEqual({
      mentions: [{ text: 'Max Verstappen', start: 0, end: 14, candidates: ['max-verstappen'], active_candidates: ['max-verstappen'] }],
      event: { type: 'resolved', season: 2025, round: 12 }
    });
    expect(result.counters).toEqual({
      statement_count: 2,
      returned_row_count: 2,
      statements: { driver_inventory_unscoped: 0, driver_inventory_scoped: 1, event_name: 1, event_round: 0 }
    });
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['2000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, parameters: [2025, 501] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(fake.releases()).toBe(1);
  });

  it('pins the exact request statement and aggregate returned-row ceilings', () => {
    expect(SEMANTIC_SHADOW_RESOLVER_MAX_STATEMENTS).toBe(2);
    expect(SEMANTIC_SHADOW_RESOLVER_MAX_RETURNED_ROWS).toBe(10_502);
  });

  it('pins all four SQL fingerprints and exact parameter contracts', () => {
    expect(Object.values(SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINTS).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(identifySemanticShadowResolverRead(SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_unscoped, [10_001]))
      .toBe('driver_inventory_unscoped');
    expect(identifySemanticShadowResolverRead(SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, [1950, 10_001]))
      .toBe('driver_inventory_scoped');
    expect(identifySemanticShadowResolverRead(SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, [2100, 501]))
      .toBe('event_name');
    expect(identifySemanticShadowResolverRead(SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, [2025, 30, 2]))
      .toBe('event_round');

    for (const invalid of [
      [SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_unscoped, []],
      [SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, [1949, 10_001]],
      [SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, ['2025', 501]],
      [SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, [2025, 31, 2]],
      [SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, [2025, 1, 3]]
    ] as const) {
      expect(() => identifySemanticShadowResolverRead(invalid[0], invalid[1])).toThrowError(expect.objectContaining({ code: 'parameter_contract_invalid' }));
    }
  });

  it('rejects changed fingerprints, comments, multiple statements, planner SQL, fact views, and standalone participation reads', () => {
    const forbidden = [
      `${SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name} `,
      `${SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name} -- changed`,
      `${SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name}; SELECT 1`,
      'WITH planned AS (SELECT * FROM f1ql.race_classification) SELECT * FROM planned',
      'SELECT * FROM f1ql.race_classification WHERE season = $1',
      'SELECT driver_id FROM f1ql.answer_season_participation WHERE season = $1',
      'DELETE FROM f1ql.answer_driver_identity'
    ];
    for (const sql of forbidden) {
      expect(() => identifySemanticShadowResolverRead(sql, [2025, 501])).toThrowError(expect.objectContaining({ code: 'statement_not_allowed' }));
    }
  });

  it('enforces returned-row and the two-read statement ceiling with exact counters', async () => {
    const overflow = fakeDatabase(async sql => ({
      rows: sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name
        ? Array.from({ length: 502 }, () => ({ season: 2025, round: 1, identity: 'Example' }))
        : []
    }));
    let overflowCounters: ReturnType<SemanticShadowResolverAccess['counters']> | undefined;
    await expect(withSemanticShadowResolverReader(overflow.database, { statementTimeoutMs: 100 }, async access => {
      try {
        await access.event_resolver.resolve(2025, 'Example');
      } finally {
        overflowCounters = access.counters();
      }
    })).rejects.toMatchObject({ code: 'returned_row_limit_exceeded' });
    expect(overflowCounters).toMatchObject({ statement_count: 1, returned_row_count: 502 });
    expect(overflow.calls.at(-1)?.sql).toBe('ROLLBACK');

    const extra = fakeDatabase();
    let limitCounters: ReturnType<SemanticShadowResolverAccess['counters']> | undefined;
    await expect(withSemanticShadowResolverReader(extra.database, { statementTimeoutMs: 100 }, async access => {
      await access.driver_resolver.inventoryMentions('Max', 2025);
      await access.event_resolver.resolveRound(2025, 1);
      try {
        await access.event_resolver.resolve(2025, 'Example');
      } finally {
        limitCounters = access.counters();
      }
    })).rejects.toMatchObject({ code: 'statement_limit_exceeded' });
    expect(limitCounters).toEqual({
      statement_count: 2,
      returned_row_count: 0,
      statements: { driver_inventory_unscoped: 0, driver_inventory_scoped: 1, event_name: 0, event_round: 1 }
    });
    expect(extra.calls.filter(call => Object.values(SEMANTIC_SHADOW_RESOLVER_STATEMENTS).includes(call.sql))).toHaveLength(2);
    expect(extra.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(extra.releases()).toBe(1);
  });

  it('closes retained access after success before rollback and release', async () => {
    const rollbackStarted = deferred();
    const allowRollback = deferred();
    const fake = fakeDatabase(async () => ({ rows: [] }), async () => {
      rollbackStarted.resolve();
      await allowRollback.promise;
    });
    let retained: SemanticShadowResolverAccess | undefined;
    const request = withSemanticShadowResolverReader(fake.database, { statementTimeoutMs: 100 }, async access => {
      retained = access;
      await access.driver_resolver.inventoryMentions('Max', 2025);
      return 'complete';
    });

    await rollbackStarted.promise;
    expect(fake.releases()).toBe(0);
    const callsBeforeRetainedUse = fake.calls.length;
    const retainedCalls = await Promise.allSettled([
      retained!.driver_resolver.inventoryMentions('Max', 2025),
      retained!.event_resolver.resolve(2025, ''),
      retained!.event_resolver.resolveRound(2025, 1)
    ]);
    expect(retainedCalls).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'reader_closed', message: 'reader_closed' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'reader_closed', message: 'reader_closed' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'reader_closed', message: 'reader_closed' }) })
    ]);
    expect(() => retained!.counters()).toThrowError(expect.objectContaining({ code: 'reader_closed', message: 'reader_closed' }));
    expect(fake.calls).toHaveLength(callsBeforeRetainedUse);

    allowRollback.resolve();
    await expect(request).resolves.toEqual({
      value: 'complete',
      counters: {
        statement_count: 1,
        returned_row_count: 0,
        statements: { driver_inventory_unscoped: 0, driver_inventory_scoped: 1, event_name: 0, event_round: 0 }
      }
    });
    expect(fake.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(fake.releases()).toBe(1);
  });

  it('closes retained access after failure before rollback and release', async () => {
    const rollbackStarted = deferred();
    const allowRollback = deferred();
    const fake = fakeDatabase(async () => ({ rows: [] }), async () => {
      rollbackStarted.resolve();
      await allowRollback.promise;
    });
    const callbackError = new Error('private callback failure');
    let retained: SemanticShadowResolverAccess | undefined;
    const request = withSemanticShadowResolverReader(fake.database, { statementTimeoutMs: 100 }, async access => {
      retained = access;
      throw callbackError;
    });

    await rollbackStarted.promise;
    expect(fake.releases()).toBe(0);
    const callsBeforeRetainedUse = fake.calls.length;
    await expect(retained!.event_resolver.resolve(2025, '')).rejects.toMatchObject({
      code: 'reader_closed',
      message: 'reader_closed'
    });
    const closedError = await retained!.event_resolver.resolve(2025, '').catch(error => error as Error);
    expect(JSON.stringify(closedError)).not.toContain(callbackError.message);
    expect(() => retained!.counters()).toThrowError(expect.objectContaining({ code: 'reader_closed', message: 'reader_closed' }));
    expect(fake.calls).toHaveLength(callsBeforeRetainedUse);

    allowRollback.resolve();
    await expect(request).rejects.toBe(callbackError);
    expect(fake.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(fake.releases()).toBe(1);
  });

  it('always rolls back and releases on callback failure and abort', async () => {
    const failure = fakeDatabase();
    const callbackError = new Error('callback failed');
    await expect(withSemanticShadowResolverReader(failure.database, { statementTimeoutMs: 100 }, async () => {
      throw callbackError;
    })).rejects.toBe(callbackError);
    expect(failure.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(failure.releases()).toBe(1);

    const abort = fakeDatabase();
    const controller = new AbortController();
    await expect(withSemanticShadowResolverReader(abort.database, { statementTimeoutMs: 100, signal: controller.signal }, async access => {
      controller.abort(new Error('private abort reason'));
      await access.driver_resolver.inventoryMentions('Max', 2025);
    })).rejects.toMatchObject({ code: 'request_cancelled', message: 'request_cancelled' });
    expect(abort.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(abort.releases()).toBe(1);
  });

  it('discards a connection and prioritizes cleanup failure when rollback fails', async () => {
    const fake = fakeDatabase(async () => ({ rows: [] }), async () => {
      throw new Error('private rollback failure');
    });

    await expect(withSemanticShadowResolverReader(fake.database, { statementTimeoutMs: 100 }, async access => {
      await access.driver_resolver.inventoryMentions('Max', 2025);
      throw new Error('private primary failure');
    })).rejects.toMatchObject({ code: 'transaction_cleanup_failed', message: 'transaction_cleanup_failed' });
    expect(fake.releases()).toBe(1);
    expect(fake.releaseErrors()[0]).toMatchObject({ code: 'transaction_cleanup_failed' });
  });

  it('owns the transaction-local timeout and sanitizes database and rejected-statement errors', async () => {
    const secret = 'postgresql://user:password@private.example/f1';
    const timedOut = fakeDatabase(async () => { throw Object.assign(new Error(secret), { code: '57014' }); });
    const timeoutError = await withSemanticShadowResolverReader(timedOut.database, { statementTimeoutMs: 37 }, async access => {
      await access.driver_resolver.inventoryMentions('Max', 2025);
    }).catch(error => error as Error & { code: string });
    expect(timeoutError).toMatchObject({ code: 'statement_timeout', message: 'statement_timeout' });
    expect(JSON.stringify(timeoutError)).not.toContain(secret);
    expect(timedOut.calls[1]).toEqual({ sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['37ms'] });
    expect(timedOut.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(timedOut.releases()).toBe(1);

    let rejected: Error | undefined;
    try {
      identifySemanticShadowResolverRead(`SELECT '${secret}' FROM f1ql.race_classification`, []);
    } catch (error) {
      rejected = error as Error;
    }
    expect(rejected?.message).toBe('statement_not_allowed');
    expect(rejected?.message).not.toContain(secret);
  });
});
