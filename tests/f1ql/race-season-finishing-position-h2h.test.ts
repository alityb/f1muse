import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { F1QLProgram } from '../../src/f1ql/ast';
import { canonicalProgramEntities } from '../../src/f1ql/answer-observations';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QL, executeF1QLReadOnly } from '../../src/f1ql/executor';
import { EventClassificationRow, interpretComparisonSummary } from '../../src/f1ql/interpreter';
import { enforceF1QLCostLimits, estimateF1QLCost, F1QLCostLimitError, MAX_F1QL_SOURCE_ROUND_BRANCHES, RACE_SEASON_H2H_SOURCE_ROUND_BRANCHES } from '../../src/f1ql/limits';
import { lowerF1QL } from '../../src/f1ql/lower';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';

const metric = 'official_race_finishing_position_shared_events_v1' as const;

function program(driverA = 'driver-a', driverB = 'driver-b'): F1QLProgram {
  return {
    version: 1,
    root: { op: 'race_season_finishing_position_h2h', metric, season: 2025, driver_a_id: driverA, driver_b_id: driverB }
  };
}

function row(round: number, driverId: string, finishingPosition: number | null): EventClassificationRow {
  return {
    season: 2025,
    round,
    driver_id: driverId,
    team_id: null,
    finishing_position: finishingPosition,
    points: 0,
    classification_status: finishingPosition === null ? 'dnf' : 'classified',
    status_reason: finishingPosition === null ? 'DNF' : null
  };
}

const referenceRows = [
  row(1, 'driver-a', 1), row(1, 'driver-b', 2),
  row(2, 'driver-a', 2), row(2, 'driver-b', 3),
  row(3, 'driver-a', 5), row(3, 'driver-b', 1),
  row(4, 'driver-a', 4), row(4, 'driver-b', 4),
  row(5, 'driver-a', null), row(5, 'driver-b', 6),
  row(6, 'driver-a', 2),
  row(7, 'driver-b', 3)
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
  for (let round = 1; round <= 7; round += 1) {
    await pool.query(`INSERT INTO race (id, year, round) VALUES ($1, 2025, $1)`, [round]);
  }
  for (const sourceRow of referenceRows) {
    await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, race_points, race_reason_retired)
      VALUES ($1, 'RACE_RESULT', $2, $3, 0, $4)`, [
      sourceRow.round,
      sourceRow.driver_id.replaceAll('-', '_'),
      sourceRow.finishing_position,
      sourceRow.status_reason
    ]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('canonical race season finishing-position H2H foundation', () => {
  it('accepts only the closed final-season scalar surface and preserves driver order', () => {
    const parsed = parseF1QLProgram(program());
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    expect(lowerF1QL(parsed).root).toEqual({
      op: 'comparison_summary',
      input: {
        op: 'compare',
        input: {
          op: 'join',
          left: {
            op: 'filter', input: { op: 'source', source: 'event_classification' },
            where: { season: 2025, driver_id: 'driver-a' }
          },
          right: {
            op: 'filter', input: { op: 'source', source: 'event_classification' },
            where: { season: 2025, driver_id: 'driver-b' }
          },
          on: ['season', 'round'],
          type: 'inner'
        },
        left: { field: 'finishing_position', as: 'driver_a_position' },
        right: { field: 'finishing_position', as: 'driver_b_position' }
      },
      metric_id: metric,
      lower_is_better: true,
      require_unique_source_keys: true,
      require_source_presence: true
    });
    expect(compileF1QL(lowerF1QL(parsed)).params).toEqual([2025, 'driver-a', 'driver-b', metric, true]);
    expect(canonicalProgramEntities(parsed)).toEqual(['driver:driver-a', 'driver:driver-b']);
    expect(renderF1QL(parsed)).toContain('driver-a versus driver-b');

    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, season: 2026 } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, season: [2024, 2025] } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, driver_b_id: 'driver-a' } })).toThrow('requires two different drivers');
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, metric: 'other' } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, round: 1 } })).toThrow();
    expect(() => parseF1QLProgramCandidate(program())).toThrow();
  });

  it('rejects mutations of the fixed Core comparison and integrity semantics', () => {
    const mutate = (change: (root: any) => void) => {
      const core = lowerF1QL(program());
      change(core.root);
      expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
    };
    mutate(root => { root.input.op = 'unknown'; });
    mutate(root => { root.input.input.type = 'left'; });
    mutate(root => { root.input.input.on = ['round']; });
    mutate(root => { root.input.left.field = 'points'; });
    mutate(root => { root.input.left.as = 'unsafe-alias'; });
    mutate(root => { root.input.right.as = 'driver_a_position'; });
    mutate(root => { root.input.input.left.input.source = 'standings'; });
    mutate(root => { root.input.input.left.where.extra = true; });
    mutate(root => { root.input.input.right.where.season = 2024; });
    mutate(root => { root.input.input.left.where.driver_id = ''; });
    mutate(root => { root.input.input.left.where.driver_id = '   '; });
    mutate(root => { root.input.input.right.where.driver_id = 'driver-a'; });
    mutate(root => { root.require_unique_source_keys = false; });
    mutate(root => { root.require_source_presence = false; });
  });

  it('treats a bounded Core metric label as opaque without changing comparison semantics', () => {
    const canonical = lowerF1QL(program());
    const alternate = lowerF1QL(program());
    if (alternate.root.op !== 'comparison_summary') throw new Error('Expected comparison summary');
    alternate.root.metric_id = 'alternate_classification_position_v1';
    expect(() => validateCoreProgram(alternate)).not.toThrow();

    const canonicalCompiled = compileF1QL(canonical);
    const alternateCompiled = compileF1QL(alternate);
    expect(alternateCompiled.sql).toBe(canonicalCompiled.sql);
    expect(alternateCompiled.params).toEqual([2025, 'driver-a', 'driver-b', 'alternate_classification_position_v1', true]);
    expect(interpretComparisonSummary(alternate, referenceRows)).toEqual([
      expect.objectContaining({ metric_id: 'alternate_classification_position_v1', driver_a_ahead: 2, driver_b_ahead: 1, ties: 1, shared_events: 4 })
    ]);

    alternate.root.lower_is_better = false;
    expect(() => validateCoreProgram(alternate)).not.toThrow();
    expect(compileF1QL(alternate).params).toEqual([2025, 'driver-a', 'driver-b', 'alternate_classification_position_v1', false]);
    expect(interpretComparisonSummary(alternate, referenceRows)).toEqual([
      expect.objectContaining({ driver_a_ahead: 1, driver_b_ahead: 2, ties: 1, shared_events: 4 })
    ]);
  });

  it('charges both 30-round source branches through public cost admission', () => {
    const parsed = parseF1QLProgram(program());
    expect(RACE_SEASON_H2H_SOURCE_ROUND_BRANCHES).toBe(60);
    expect(MAX_F1QL_SOURCE_ROUND_BRANCHES).toBe(60);
    expect(estimateF1QLCost(parsed)).toEqual({ source_round_branches: 60 });
    expect(() => enforceF1QLCostLimits(parsed)).not.toThrow();
    expect(() => enforceF1QLCostLimits(parsed, { maxSourceRoundBranches: 59 })).toThrow(F1QLCostLimitError);
    expect(() => enforceF1QLCostLimits(parsed, { maxSourceRoundBranches: 61 })).toThrow(F1QLCostLimitError);
  });

  it('matches SQL and reference semantics for shared, null, unshared, tie, and reverse-order rounds', async () => {
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
    expect(await executeCore(reversed)).toEqual([expect.objectContaining({
      driver_a_id: 'driver-b', driver_b_id: 'driver-a', driver_a_ahead: 1, driver_b_ahead: 2, ties: 1, shared_events: 4
    })]);
    expect(await executeCore(program('driver-a', 'missing-driver'))).toEqual([expect.objectContaining({
      driver_a_source_rows: 6,
      driver_b_source_rows: 0,
      source_presence_ok: false,
      source_integrity_ok: false,
      driver_a_ahead: null,
      shared_events: null
    })]);
  });

  it('does not silently deduplicate duplicate source keys', async () => {
    await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, race_points)
      VALUES (1, 'RACE', 'driver_a', 1, 0)`);
    const duplicateRows = [...referenceRows, row(1, 'driver-a', 1)];
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
