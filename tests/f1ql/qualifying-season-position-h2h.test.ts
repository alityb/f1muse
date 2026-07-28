import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { F1QLProgram } from '../../src/f1ql/ast';
import { canonicalProgramEntities } from '../../src/f1ql/answer-observations';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QL, executeF1QLReadOnly } from '../../src/f1ql/executor';
import { ComparisonSummaryRow, QualifyingClassificationRow, interpretComparisonSummary } from '../../src/f1ql/interpreter';
import { enforceF1QLCostLimits, estimateF1QLCost, F1QLCostLimitError, MAX_F1QL_SOURCE_ROUND_BRANCHES, QUALIFYING_SEASON_H2H_SOURCE_ROUND_BRANCHES } from '../../src/f1ql/limits';
import { lowerF1QL } from '../../src/f1ql/lower';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';

const metric = 'official_qualifying_position_shared_events_v1' as const;

function program(driverA = 'driver-a', driverB = 'driver-b', season = 2025): F1QLProgram {
  return {
    version: 1,
    root: { op: 'qualifying_season_position_h2h', metric, season, driver_a_id: driverA, driver_b_id: driverB }
  };
}

function row(round: number, driverId: string, qualifyingPosition: number | null): QualifyingClassificationRow {
  return {
    season: 2025,
    round,
    driver_id: driverId,
    team_id: 'test-team',
    qualifying_position: qualifyingPosition,
    best_time_ms: null,
    best_session: null,
    eliminated_in_round: null,
    classification_status: qualifyingPosition === null ? 'dnf' : 'classified'
  };
}

const referenceRows = [
  row(1, 'driver-a', 1), row(1, 'driver-b', 2),
  row(2, 'driver-a', 4), row(2, 'driver-b', 2),
  row(3, 'driver-a', 3), row(3, 'driver-b', 3),
  row(4, 'driver-a', null), row(4, 'driver-b', 5),
  row(5, 'driver-a', 2),
  row(6, 'driver-b', 1),
  row(7, 'driver-a', 2), row(7, 'driver-b', 4)
];

let pool: Pool;

async function executeCore(input: F1QLProgram): Promise<Array<Record<string, unknown>>> {
  const core = lowerF1QL(input);
  validateCoreProgram(core);
  const compiled = compileF1QL(core);
  return (await executeF1QLReadOnly(pool, compiled.sql, compiled.params)).rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO season (year) VALUES (2025)`);
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'entrant-a', 'team-a', 'driver_a'),
    (2025, 'entrant-b', 'team-b', 'driver_b')`);
  for (const sourceRow of referenceRows) {
    await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position)
      VALUES ($1, $2, $3, $4, $5)`, [
      sourceRow.season,
      sourceRow.round,
      sourceRow.driver_id.replaceAll('-', '_'),
      sourceRow.team_id,
      sourceRow.qualifying_position
    ]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('canonical qualifying season position H2H foundation', () => {
  it('closes the surface to one final scalar season, literal metric, and distinct ordered drivers', () => {
    const parsed = parseF1QLProgram(program());
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    expect(() => parseF1QLProgram(program('driver-a', 'driver-b', 1950))).not.toThrow();
    expect(() => parseF1QLProgram(program('driver-a', 'driver-b', 1949))).toThrow();
    expect(() => parseF1QLProgram(program('driver-a', 'driver-b', 2026))).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, season: [2024, 2025] } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, metric: 'other' } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, driver_b_id: 'driver-a' } })).toThrow('requires two different drivers');
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, round: 1 } })).toThrow();
    expect(() => parseF1QLProgramCandidate(program())).toThrow();
  });

  it('lowers through generic Filter, Join, Compare, and comparison_summary with parameterized SQL', () => {
    const parsed = parseF1QLProgram(program('driver-z', 'driver-a'));
    const core = lowerF1QL(parsed);
    expect(core.root).toEqual({
      op: 'comparison_summary',
      input: {
        op: 'compare',
        input: {
          op: 'join',
          left: { op: 'filter', input: { op: 'source', source: 'qualifying_classification' }, where: { season: 2025, driver_id: 'driver-z' } },
          right: { op: 'filter', input: { op: 'source', source: 'qualifying_classification' }, where: { season: 2025, driver_id: 'driver-a' } },
          on: ['season', 'round'],
          type: 'inner'
        },
        left: { field: 'qualifying_position', as: 'driver_a_position' },
        right: { field: 'qualifying_position', as: 'driver_b_position' }
      },
      metric_id: metric,
      lower_is_better: true,
      require_unique_source_keys: true,
      require_source_presence: true
    });
    validateCoreProgram(core);
    const compiled = compileF1QL(core);
    expect(compiled.params).toEqual([2025, 'driver-z', 'driver-a', metric, true]);
    expect(compiled.sql).toContain('FROM f1ql.qualifying_classification');
    expect(compiled.sql).not.toContain('driver-z');
    expect(canonicalProgramEntities(parsed)).toEqual(['driver:driver-a', 'driver:driver-z']);
    expect(renderF1QL(parsed)).toContain('driver-z versus driver-a');
  });

  it('independently rejects source, field, scope, ID, and integrity mutations', () => {
    const mutate = (change: (root: any) => void) => {
      const core = lowerF1QL(program());
      change(core.root);
      expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
      expect(() => compileF1QL(core)).toThrow();
      expect(() => interpretComparisonSummary(core, referenceRows)).toThrow();
    };
    mutate(root => { root.input.input.left.input.source = 'event_classification'; });
    mutate(root => { root.input.left.field = 'finishing_position'; });
    mutate(root => { root.input.right.field = 'points'; });
    mutate(root => { root.input.left.as = 'other_position'; });
    mutate(root => { root.input.input.left.where.extra = true; });
    mutate(root => { root.input.input.right.where.season = 2024; });
    mutate(root => { root.input.input.left.where.season = 1949; });
    mutate(root => { root.input.input.left.where.driver_id = ''; });
    mutate(root => { root.input.input.right.where.driver_id = 'driver-a'; });
    mutate(root => { root.input.input.on = ['round']; });
    mutate(root => { root.require_unique_source_keys = false; });
    mutate(root => { root.require_source_presence = false; });
  });

  it('charges two complete 30-round branches without a caller bypass', () => {
    const parsed = parseF1QLProgram(program());
    expect(QUALIFYING_SEASON_H2H_SOURCE_ROUND_BRANCHES).toBe(60);
    expect(MAX_F1QL_SOURCE_ROUND_BRANCHES).toBe(60);
    expect(estimateF1QLCost(parsed)).toEqual({ source_round_branches: 60 });
    expect(() => enforceF1QLCostLimits(parsed)).not.toThrow();
    expect(() => enforceF1QLCostLimits(parsed, { maxSourceRoundBranches: 59 })).toThrow(F1QLCostLimitError);
    expect(() => enforceF1QLCostLimits(parsed, { maxSourceRoundBranches: 61 })).toThrow(F1QLCostLimitError);
  });

  it('matches SQL/reference A wins, B wins, ties, null and one-sided exclusion, reverse order, and missing source', async () => {
    const expected = [{
      metric_id: metric,
      season: 2025,
      driver_a_id: 'driver-a',
      driver_b_id: 'driver-b',
      driver_a_ahead: 2,
      driver_b_ahead: 1,
      ties: 1,
      shared_events: 4,
      driver_a_source_rows: 6,
      driver_b_source_rows: 6,
      distinct_source_keys: 12,
      duplicate_source_rows: 0,
      source_presence_ok: true,
      source_unique_keys_ok: true,
      source_integrity_ok: true
    }];
    expect(interpretComparisonSummary(lowerF1QL(program()), referenceRows)).toEqual(expected);
    expect(await executeCore(program())).toEqual(expected);
    await expect(executeF1QL(pool, program())).resolves.toMatchObject({ rows: expected });

    const reversed = program('driver-b', 'driver-a');
    expect(interpretComparisonSummary(lowerF1QL(reversed), referenceRows)).toEqual([expect.objectContaining({
      driver_a_id: 'driver-b', driver_b_id: 'driver-a', driver_a_ahead: 1, driver_b_ahead: 2, ties: 1, shared_events: 4
    })]);
    expect(await executeCore(reversed)).toEqual([expect.objectContaining({
      driver_a_id: 'driver-b', driver_b_id: 'driver-a', driver_a_ahead: 1, driver_b_ahead: 2, ties: 1, shared_events: 4
    })]);
    expect(await executeCore(program('driver-a', 'missing-driver'))).toEqual([expect.objectContaining({
      driver_a_source_rows: 6,
      driver_b_source_rows: 0,
      source_presence_ok: false,
      source_integrity_ok: false,
      driver_a_ahead: null,
      driver_b_ahead: null,
      ties: null,
      shared_events: null
    })]);
  });

  it('invalidates duplicate source keys instead of silently deduplicating', async () => {
    await pool.query(`ALTER TABLE qualifying_results DROP CONSTRAINT qualifying_results_pkey`);
    await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position)
      VALUES (2025, 1, 'driver_a', 'test-team', 1)`);
    const duplicateRows: ComparisonSummaryRow[] = [...referenceRows, row(1, 'driver-a', 1)];
    const expected = expect.objectContaining({
      driver_a_source_rows: 7,
      driver_b_source_rows: 6,
      distinct_source_keys: 12,
      duplicate_source_rows: 1,
      source_presence_ok: true,
      source_unique_keys_ok: false,
      source_integrity_ok: false,
      driver_a_ahead: null,
      driver_b_ahead: null,
      ties: null,
      shared_events: null
    });
    expect(interpretComparisonSummary(lowerF1QL(program()), duplicateRows)).toEqual([expected]);
    expect(await executeCore(program())).toEqual([expected]);
  });
});
