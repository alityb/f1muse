import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { F1QLStatementTimeoutError } from '../../src/f1ql/executor';
import { PLANNED_INTEGRITY_FIELD } from '../../src/f1ql/planned-compiler';
import {
  executeAuthorizedSemanticPlan,
  verifySemanticPlanExecutionResult
} from '../../src/f1ql/semantic-plan-execution';
import { getSemanticPlanProofParent } from '../../src/f1ql/semantic-plan-proof';
import { formatSemanticPlanResult } from '../../src/f1ql/semantic-result-format';
import {
  createSemanticPlanExecutionOfflineInput,
  SEMANTIC_EXECUTION_OFFLINE_NOW
} from '../../scripts/support/semantic-plan-execution';
import { compositionalRegressionCorpusInput } from '../fixtures/compositional-regression-corpus';
import { prepareReviewedCompositionalAnswerCase } from '../support/compositional-regression';

type Prepared = Awaited<ReturnType<typeof prepareReviewedCompositionalAnswerCase>>;

const cases = [
  {
    id: 'promoted-single-source-rows',
    profile: 'semantic-single-source-v1' as const,
    rows: [{ driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'promoted-safe-dimension-join',
    profile: 'semantic-safe-dimension-join-v1' as const,
    rows: [{
      driver_id: 'lando-norris', finishing_position: 1,
      event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'promoted-aggregate-locality',
    profile: 'semantic-aggregate-locality-v1' as const,
    rows: [{
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 1,
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  }
] as const;

describe('authorized semantic plan execution', () => {
  const prepared = new Map<string, Prepared>();

  beforeAll(async () => {
    for (const item of cases) {
      prepared.set(item.id, await prepareReviewedCompositionalAnswerCase(
        compositionalRegressionCorpusInput,
        item.id
      ));
    }
  });

  it.each(cases)('executes the exact proof-bound $profile interaction in one read-only transaction', async item => {
    const artifacts = prepared.get(item.id)!;
    const parent = getSemanticPlanProofParent(artifacts.proof);
    const input = createSemanticPlanExecutionOfflineInput(artifacts.proof, item.profile);
    const database = recordingPool(parent.compiled.sql, item.rows);
    const result = await executeAuthorizedSemanticPlan(
      database.pool,
      input.authorization,
      artifacts.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );

    expect(verifySemanticPlanExecutionResult(result)).toBe(result);
    expect(result).toMatchObject({
      authorization_hash: input.authorization.authorization_hash,
      semantic_plan_proof_hash: artifacts.proof.proof_hash,
      planned_f1ql_hash: artifacts.proof.planned_f1ql_hash,
      core_hash: artifacts.proof.core_hash,
      compiled_hash: artifacts.proof.compiled_hash,
      row_count: item.rows.length
    });
    expect(database.calls[0]).toEqual({ sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', params: undefined });
    expect(database.calls.filter(call => call.sql === parent.compiled.sql)).toEqual([{
      sql: parent.compiled.sql,
      params: parent.compiled.params
    }]);
    const expectedSql = [
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SELECT set_config('statement_timeout', $1, true)",
      ...(item.profile === 'semantic-aggregate-locality-v1' ? [
        `SELECT DISTINCT REPLACE(driver_id, '_', '-') AS driver_id FROM f1ql.answer_season_participation WHERE season = $1 AND REPLACE(driver_id, '_', '-') = ANY($2::text[])`
      ] : []),
      "SELECT set_config('statement_timeout', $1, true)",
      parent.compiled.sql,
      'COMMIT'
    ];
    expect(database.calls.map(call => call.sql)).toEqual(expectedSql);
    expect(database.calls.filter(call => call.sql.startsWith("SELECT set_config('statement_timeout'")))
      .toEqual([
        { sql: "SELECT set_config('statement_timeout', $1, true)", params: ['3000ms'] },
        { sql: "SELECT set_config('statement_timeout', $1, true)", params: ['3000ms'] }
      ]);
    if (item.profile === 'semantic-aggregate-locality-v1') {
      expect(database.calls.find(call => call.sql.startsWith('SELECT DISTINCT REPLACE(driver_id'))?.params)
        .toEqual([2025, ['lando-norris']]);
    }
    expect(database.calls.at(-1)?.sql).toBe('COMMIT');
    expect(database.releases).toEqual([false]);
    expect(formatSemanticPlanResult(result).rows).toHaveLength(item.rows.length);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => formatSemanticPlanResult({ ...result })).toThrow('provenance');
  });

  it('snapshots rows before provenance so later source substitution or omission cannot change output', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const input = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const sourceRows = [
      { driver_id: 'lando-norris', points: '1.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', points: '2.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const result = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, sourceRows, {
        onCommit: () => {
          sourceRows[0].points = '999.000';
          sourceRows.pop();
        }
      }).pool,
      input.authorization,
      standings.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    const rowsHash = result.rows_sha256;
    expect(formatSemanticPlanResult(result).rows).toEqual([
      { driver_id: 'lando-norris', points: '1.000' },
      { driver_id: 'oscar-piastri', points: '2.000' }
    ]);
    expect(verifySemanticPlanExecutionResult(result).rows_sha256).toBe(rowsHash);
  });

  it('rejects mismatched proofs, expired deadlines, and replay before another database acquisition', async () => {
    const standings = prepared.get(cases[0].id)!;
    const join = prepared.get(cases[1].id)!;
    const input = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const database = recordingPool(getSemanticPlanProofParent(standings.proof).compiled.sql, cases[0].rows);

    await expect(executeAuthorizedSemanticPlan(
      database.pool, input.authorization, join.proof, input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('authorization_binding_mismatch');
    expect(database.connects).toBe(0);

    await expect(executeAuthorizedSemanticPlan(
      database.pool, input.authorization, standings.proof, input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1, deadlineMs: SEMANTIC_EXECUTION_OFFLINE_NOW }
    )).rejects.toThrow('deadline exceeded');
    expect(database.connects).toBe(0);

    await executeAuthorizedSemanticPlan(
      database.pool, input.authorization, standings.proof, input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    await expect(executeAuthorizedSemanticPlan(
      database.pool, input.authorization, standings.proof, input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('authorization_replayed');
    expect(database.connects).toBe(1);
  });

  it('validates required participation and rolls back before the result query when an identity is absent', async () => {
    const compose = prepared.get(cases[2].id)!;
    const parent = getSemanticPlanProofParent(compose.proof);
    const input = createSemanticPlanExecutionOfflineInput(compose.proof, cases[2].profile);
    const database = recordingPool(parent.compiled.sql, cases[2].rows, { participationRows: [] });

    await expect(executeAuthorizedSemanticPlan(
      database.pool,
      input.authorization,
      compose.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('Driver did not participate');
    expect(database.calls.some(call => call.sql.startsWith('SELECT DISTINCT REPLACE(driver_id'))).toBe(true);
    expect(database.calls.some(call => call.sql === parent.compiled.sql)).toBe(false);
    expect(database.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('rechecks the kill switch after acquisition and after the result query', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);

    const beforeSql = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    let active = false;
    const delayed = recordingPool(parent.compiled.sql, cases[0].rows, { onConnect: () => {active = true;} });
    await expect(executeAuthorizedSemanticPlan(
      delayed.pool,
      beforeSql.authorization,
      standings.proof,
      { ...beforeSql.context, is_kill_switch_active: () => active },
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('kill_switch_active');
    expect(delayed.calls).toEqual([]);

    const afterQuery = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    let checks = 0;
    const database = recordingPool(parent.compiled.sql, cases[0].rows);
    await expect(executeAuthorizedSemanticPlan(
      database.pool,
      afterQuery.authorization,
      standings.proof,
      { ...afterQuery.context, is_kill_switch_active: () => {checks += 1; return checks >= 4;} },
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('kill_switch_active');
    expect(database.calls.some(call => call.sql === parent.compiled.sql)).toBe(true);
    expect(database.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('bounds stalled acquisition and discards uncertain or rollback-failed connections', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const stalled = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const neverPool = { connect: () => new Promise(() => undefined) } as unknown as Pool;
    await expect(executeAuthorizedSemanticPlan(
      neverPool,
      stalled.authorization,
      standings.proof,
      stalled.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1, deadlineMs: SEMANTIC_EXECUTION_OFFLINE_NOW + 5 }
    )).rejects.toThrow('deadline exceeded');

    const uncertain = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const beginFailure = recordingPool(parent.compiled.sql, cases[0].rows, { beginError: new Error('begin failed') });
    await expect(executeAuthorizedSemanticPlan(
      beginFailure.pool,
      uncertain.authorization,
      standings.proof,
      uncertain.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('begin failed');
    expect(beginFailure.releases).toEqual([true]);

    const compose = prepared.get(cases[2].id)!;
    const composeParent = getSemanticPlanProofParent(compose.proof);
    const rollback = createSemanticPlanExecutionOfflineInput(compose.proof, cases[2].profile);
    const rollbackFailure = recordingPool(composeParent.compiled.sql, cases[2].rows, {
      participationRows: [], rollbackError: new Error('rollback failed')
    });
    await expect(executeAuthorizedSemanticPlan(
      rollbackFailure.pool,
      rollback.authorization,
      compose.proof,
      rollback.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('Driver did not participate');
    expect(rollbackFailure.releases).toEqual([true]);
  });

  it('enforces the signed response-byte ceiling during formatting', async () => {
    const join = prepared.get(cases[1].id)!;
    const parent = getSemanticPlanProofParent(join.proof);
    const input = createSemanticPlanExecutionOfflineInput(join.proof, cases[1].profile);
    const result = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, [{
        ...cases[1].rows[0], event_name: 'x'.repeat(70_000)
      }]).pool,
      input.authorization,
      join.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    expect(() => formatSemanticPlanResult(result)).toThrow('authorized response size');
  });

  it('rechecks live authorization at the synchronous formatting handoff', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const input = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    let killSwitch = false;
    const result = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, cases[0].rows).pool,
      input.authorization,
      standings.proof,
      { ...input.context, is_kill_switch_active: () => killSwitch },
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    killSwitch = true;
    expect(() => formatSemanticPlanResult(result)).toThrow('kill_switch_active');
  });

  it('rechecks authorization after envelope construction and byte accounting', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const input = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    let formatting = false;
    let formattingChecks = 0;
    const now = () => {
      if (!formatting) {return SEMANTIC_EXECUTION_OFFLINE_NOW + 1;}
      formattingChecks += 1;
      return formattingChecks === 1 ? input.authorization.expires_at_ms - 1 : input.authorization.expires_at_ms;
    };
    const result = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, cases[0].rows).pool,
      input.authorization,
      standings.proof,
      input.context,
      { now }
    );
    formatting = true;
    expect(() => formatSemanticPlanResult(result)).toThrow('authorization_expired');
    expect(formattingChecks).toBe(2);
  });

  it('classifies statement timeout, rolls back, and burns the one-shot authorization', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const input = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const timeout = Object.assign(new Error('hidden provider-independent database detail'), { code: '57014' });
    const database = recordingPool(parent.compiled.sql, cases[0].rows, { resultError: timeout });

    await expect(executeAuthorizedSemanticPlan(
      database.pool,
      input.authorization,
      standings.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toBeInstanceOf(F1QLStatementTimeoutError);
    expect(database.calls.at(-1)?.sql).toBe('ROLLBACK');
    await expect(executeAuthorizedSemanticPlan(
      database.pool,
      input.authorization,
      standings.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('authorization_replayed');
    expect(database.connects).toBe(1);
  });

  it('keeps the execution boundary structurally absent from every semantic shadow module', () => {
    for (const path of [
      'src/api/routes/program-semantic-shadow.ts',
      'src/f1ql/semantic-shadow-planner.ts',
      'scripts/collect-semantic-shadow-evidence.ts'
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain('semantic-plan-execution');
      expect(readFileSync(path, 'utf8')).not.toContain('executeAuthorizedSemanticPlan');
    }
    const bindingConsumers = ['src', 'scripts'].flatMap(typescriptFiles).filter(path =>
      readFileSync(path, 'utf8').includes('getSemanticPlanExecutionResultBinding'));
    expect(bindingConsumers.sort()).toEqual([
      'src/f1ql/semantic-plan-execution.ts',
      'src/f1ql/semantic-result-format.ts'
    ]);
  });
});

function recordingPool(
  resultSql: string,
  rows: readonly Record<string, unknown>[],
  options: {
    readonly participationRows?: readonly Record<string, unknown>[];
    readonly resultError?: Error;
    readonly beginError?: Error;
    readonly rollbackError?: Error;
    readonly onConnect?: () => void;
    readonly onCommit?: () => void;
  } = {}
) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const releases: boolean[] = [];
  let connects = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' && options.beginError) {
        throw options.beginError;
      }
      if (sql === 'ROLLBACK' && options.rollbackError) {throw options.rollbackError;}
      if (sql === 'COMMIT') {options.onCommit?.();}
      if (sql === resultSql) {
        if (options.resultError) {throw options.resultError;}
        return { rows };
      }
      if (sql.startsWith('SELECT DISTINCT REPLACE(driver_id')) {
        return { rows: options.participationRows ?? [{ driver_id: 'lando-norris' }] };
      }
      return { rows: [] };
    },
    release: (discard = false) => releases.push(discard)
  };
  return {
    pool: { connect: async () => {connects += 1; options.onConnect?.(); return client;} } as unknown as Pool,
    calls,
    releases,
    get connects() {return connects;}
  };
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return typescriptFiles(path);}
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}
