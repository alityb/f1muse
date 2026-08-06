import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { F1QLStatementTimeoutError } from '../../src/f1ql/executor';
import {
  compilePlannedF1QLResultCollection,
  PLANNED_INTEGRITY_FIELD
} from '../../src/f1ql/planned-compiler';
import {
  executeAuthorizedSemanticPlan,
  verifySemanticPlanExecutionResult
} from '../../src/f1ql/semantic-plan-execution';
import { getSemanticPlanProofParent } from '../../src/f1ql/semantic-plan-proof';
import {
  formatSemanticPlanResult,
  formatSemanticPlanResultAsAnswerEnvelope
} from '../../src/f1ql/semantic-result-format';
import {
  createSemanticPlanExecutionOfflineInput,
  SEMANTIC_EXECUTION_OFFLINE_NOW,
  SEMANTIC_EXECUTION_OFFLINE_RUNTIME
} from '../../scripts/support/semantic-plan-execution';
import { compositionalRegressionCorpusInput } from '../fixtures/compositional-regression-corpus';
import { prepareReviewedCompositionalAnswerCase } from '../support/compositional-regression';

type Prepared = Awaited<ReturnType<typeof prepareReviewedCompositionalAnswerCase>>;

const cases = [
  {
    id: 'promoted-single-source-rows',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: true,
    rows: [{ driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'promoted-safe-dimension-join',
    profile: 'semantic-safe-dimension-join-v1' as const,
    answer_compatible: false,
    rows: [{
      driver_id: 'lando-norris', finishing_position: 1,
      event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'promoted-aggregate-locality',
    profile: 'semantic-aggregate-locality-v1' as const,
    answer_compatible: false,
    rows: [{
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 1,
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'family-unfiltered-aggregate-locality',
    profile: 'semantic-aggregate-locality-v1' as const,
    answer_compatible: false,
    rows: [{
      event_classification__count_finishing_position: 2,
      qualifying_classification__count_qualifying_position: 3,
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'family-filtered-race-classification',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'charles-leclerc', finishing_position: 5, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'george-russell', finishing_position: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', finishing_position: null, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-standings-position-ranking',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'oscar-piastri', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', championship_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'max-verstappen', championship_position: 3, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-race-position-ranking',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'lando-norris', finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'max-verstappen', finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', finishing_position: null, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-filtered-qualifying-classification',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'charles-leclerc', qualifying_position: 5, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'george-russell', qualifying_position: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', qualifying_position: null, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-qualifying-position-ranking',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'oscar-piastri', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'max-verstappen', qualifying_position: 3, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-event-date',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ date: '2025-01-01', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-event-circuit',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ circuit_id: 'monaco', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-event-name',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ event_name: 'Australian Grand Prix', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'promoted-single-source-aggregate',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ count_qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-race-scalar-aggregate',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ count_finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-filtered-race-scalar-aggregate',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ count_finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-filtered-qualifying-scalar-aggregate',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-qualifying-count-ranking',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'alpha-driver', count_qualifying_position: 10, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'bravo-driver', count_qualifying_position: 9, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'charlie-driver', count_qualifying_position: 8, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'delta-driver', count_qualifying_position: 7, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'echo-driver', count_qualifying_position: 6, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'foxtrot-driver', count_qualifying_position: 5, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'golf-driver', count_qualifying_position: 4, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'hotel-driver', count_qualifying_position: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'india-driver', count_qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'juliet-driver', count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-singleton-standings-position',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{
      driver_id: 'lando-norris', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'family-singleton-standings-summary',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{
      driver_id: 'lando-norris', championship_position: 1, points: '357.000',
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'family-filtered-standings-summary',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'charles-leclerc', championship_position: 3, points: '250.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'george-russell', championship_position: 3, points: null, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', championship_position: null, points: '357.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', championship_position: null, points: null, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-filtered-standings-position',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [
      { driver_id: 'charles-leclerc', championship_position: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'george-russell', championship_position: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', championship_position: null, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', championship_position: null, [PLANNED_INTEGRITY_FIELD]: true }
    ]
  },
  {
    id: 'family-event-date-name',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{
      date: '2025-03-16', event_name: 'Australian Grand Prix',
      [PLANNED_INTEGRITY_FIELD]: true
    }]
  },
  {
    id: 'family-event-date-circuit',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ date: '2025-03-16', circuit_id: 'albert-park', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-event-name-circuit',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{ event_name: 'Monaco Grand Prix', circuit_id: 'monaco', [PLANNED_INTEGRITY_FIELD]: true }]
  },
  {
    id: 'family-event-date-name-circuit',
    profile: 'semantic-single-source-v1' as const,
    answer_compatible: false,
    rows: [{
      date: '2025-04-06', event_name: 'Japanese Grand Prix', circuit_id: 'suzuka',
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
    const collectionCompilation = compilePlannedF1QLResultCollection(
      parent.core_program,
      input.authorization.result_collection.completeness_probe_rows
    );
    const participationRows = parent.participation.type === 'required'
      ? parent.participation.requirements.flatMap(requirement =>
          requirement.driver_ids.map(driver_id => ({ driver_id })))
      : undefined;
    const database = recordingPool(parent.compiled.sql, item.rows, { participationRows });
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
      collection_compiled_hash: input.authorization.result_collection.compiled_hash,
      row_count: item.rows.length,
      observed_row_count: item.rows.length,
      has_more_rows: false
    });
    expect(database.calls[0]).toEqual({ sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', params: undefined });
    expect(database.calls.filter(call => call.sql === parent.compiled.sql)).toEqual([{
      sql: parent.compiled.sql,
      params: collectionCompilation.params
    }]);
    const expectedSql = [
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SELECT set_config('statement_timeout', $1, true)",
      ...(parent.participation.type === 'required' ? [
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
    if (parent.participation.type === 'required') {
      expect(database.calls.find(call => call.sql.startsWith('SELECT DISTINCT REPLACE(driver_id'))?.params)
        .toEqual([
          parent.participation.requirements[0].season,
          parent.participation.requirements[0].driver_ids
        ]);
    }
    expect(database.calls.at(-1)?.sql).toBe('COMMIT');
    expect(database.releases).toEqual([false]);
    expect(formatSemanticPlanResult(result).rows).toHaveLength(item.rows.length);
    if (item.answer_compatible) {
      expect(formatSemanticPlanResultAsAnswerEnvelope(result).mode).toBe('gated_execution');
    } else {
      expect(() => formatSemanticPlanResultAsAnswerEnvelope(result)).toThrow('no reviewed answer-envelope');
    }
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

  it('proves 100-row completeness, hides one probe row, and rejects excess observation before row access', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const rows = Array.from({ length: 100 }, (_, index) => ({
      driver_id: `driver-${String(index).padStart(3, '0')}`,
      points: '1.000',
      [PLANNED_INTEGRITY_FIELD]: true
    }));

    const exactInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const exact = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, rows).pool,
      exactInput.authorization,
      standings.proof,
      exactInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    expect(exact).toMatchObject({ row_count: 100, observed_row_count: 100, has_more_rows: false });

    let probeAccessed = false;
    const probeRow = Object.defineProperty({ driver_id: 'probe-row' }, 'points', {
      enumerable: true,
      get: () => {probeAccessed = true; throw new Error('probe row was accessed');}
    });
    const truncatedInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const truncated = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, [...rows, probeRow]).pool,
      truncatedInput.authorization,
      standings.proof,
      truncatedInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    expect(truncated).toMatchObject({ row_count: 100, observed_row_count: 101, has_more_rows: true });
    expect(truncated.rows_sha256).toBe(exact.rows_sha256);
    expect(formatSemanticPlanResult(truncated).rows).toHaveLength(100);
    expect(probeAccessed).toBe(false);

    let probeSlotAccessed = false;
    const accessorProbeRows = [...rows];
    Object.defineProperty(accessorProbeRows, 100, {
      enumerable: true,
      get: () => {probeSlotAccessed = true; return probeRow;}
    });
    const accessorProbeInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    await expect(executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, accessorProbeRows).pool,
      accessorProbeInput.authorization,
      standings.proof,
      accessorProbeInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('completeness probe row is invalid');
    expect(probeSlotAccessed).toBe(false);

    let returnedRowAccessed = false;
    const excessiveRows = new Array(102);
    Object.defineProperty(excessiveRows, 0, {
      get: () => {returnedRowAccessed = true; return rows[0];}
    });
    const excessiveInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    await expect(executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, excessiveRows).pool,
      excessiveInput.authorization,
      standings.proof,
      excessiveInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('more than 101 rows');
    expect(returnedRowAccessed).toBe(false);

    const composeCase = cases.find(item => item.id === 'promoted-aggregate-locality')!;
    const compose = prepared.get(composeCase.id)!;
    const composeParent = getSemanticPlanProofParent(compose.proof);
    const scalarInput = createSemanticPlanExecutionOfflineInput(compose.proof, composeCase.profile);
    await expect(executeAuthorizedSemanticPlan(
      recordingPool(composeParent.compiled.sql, [composeCase.rows[0], composeCase.rows[0]]).pool,
      scalarInput.authorization,
      compose.proof,
      scalarInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('more than 1 rows');
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
    const composeCase = cases.find(item => item.id === 'promoted-aggregate-locality')!;
    const compose = prepared.get(composeCase.id)!;
    const parent = getSemanticPlanProofParent(compose.proof);
    const input = createSemanticPlanExecutionOfflineInput(compose.proof, composeCase.profile);
    const database = recordingPool(parent.compiled.sql, composeCase.rows, { participationRows: [] });

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

  it('rejects an event-classification request before result SQL when any selected driver is absent', async () => {
    const raceCase = cases.find(item => item.id === 'family-filtered-race-classification')!;
    const race = prepared.get(raceCase.id)!;
    const parent = getSemanticPlanProofParent(race.proof);
    const input = createSemanticPlanExecutionOfflineInput(race.proof, raceCase.profile);
    const database = recordingPool(parent.compiled.sql, raceCase.rows, {
      participationRows: [
        { driver_id: 'charles-leclerc' },
        { driver_id: 'george-russell' },
        { driver_id: 'lando-norris' }
      ]
    });

    await expect(executeAuthorizedSemanticPlan(
      database.pool,
      input.authorization,
      race.proof,
      input.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    )).rejects.toThrow('Driver did not participate');
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

    const composeCase = cases.find(item => item.id === 'promoted-aggregate-locality')!;
    const compose = prepared.get(composeCase.id)!;
    const composeParent = getSemanticPlanProofParent(compose.proof);
    const rollback = createSemanticPlanExecutionOfflineInput(compose.proof, composeCase.profile);
    const rollbackFailure = recordingPool(composeParent.compiled.sql, composeCase.rows, {
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

  it('enforces the signed byte ceiling against the compatibility envelope itself', async () => {
    const standings = prepared.get(cases[0].id)!;
    const parent = getSemanticPlanProofParent(standings.proof);
    const baselineInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const baseline = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, cases[0].rows).pool,
      baselineInput.authorization,
      standings.proof,
      baselineInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    const expected = formatSemanticPlanResultAsAnswerEnvelope(baseline);
    const responseBytes = Buffer.byteLength(JSON.stringify(expected), 'utf8');

    const exactInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile, {
      ...SEMANTIC_EXECUTION_OFFLINE_RUNTIME,
      max_response_bytes: responseBytes
    });
    const exact = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, cases[0].rows).pool,
      exactInput.authorization,
      standings.proof,
      exactInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    expect(formatSemanticPlanResultAsAnswerEnvelope(exact)).toEqual(expected);

    const shortInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile, {
      ...SEMANTIC_EXECUTION_OFFLINE_RUNTIME,
      max_response_bytes: responseBytes - 1
    });
    const short = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, cases[0].rows).pool,
      shortInput.authorization,
      standings.proof,
      shortInput.context,
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(short)).toThrow('response_bytes');
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
    const compatibilityInput = createSemanticPlanExecutionOfflineInput(standings.proof, cases[0].profile);
    const compatibilityResult = await executeAuthorizedSemanticPlan(
      recordingPool(parent.compiled.sql, cases[0].rows).pool,
      compatibilityInput.authorization,
      standings.proof,
      { ...compatibilityInput.context, is_kill_switch_active: () => killSwitch },
      { now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1 }
    );
    killSwitch = true;
    expect(() => formatSemanticPlanResult(result)).toThrow('kill_switch_active');
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(compatibilityResult)).toThrow('kill_switch_active');
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

  it('rechecks authorization after compatibility-envelope byte accounting', async () => {
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
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(result)).toThrow('authorization_expired');
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
    for (const path of typescriptFiles('src/api')) {
      expect(readFileSync(path, 'utf8')).not.toContain('formatSemanticPlanResultAsAnswerEnvelope');
    }
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
