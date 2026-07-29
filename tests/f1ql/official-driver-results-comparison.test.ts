import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { F1QLProgram } from '../../src/f1ql/ast';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QL, executeF1QLReadOnly } from '../../src/f1ql/executor';
import { EventClassificationRow, interpretOfficialDriverResultsComparison, QualifyingClassificationRow, StandingsRow } from '../../src/f1ql/interpreter';
import { enforceF1QLCostLimits, estimateF1QLCost, F1QLCostLimitError, OFFICIAL_DRIVER_RESULTS_COMPARISON_SOURCE_ROUND_BRANCHES } from '../../src/f1ql/limits';
import { lowerF1QL } from '../../src/f1ql/lower';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';

const metric = 'official_driver_results_comparison_v1' as const;

function program(driverA = 'driver-a', driverB = 'driver-b'): F1QLProgram {
  return { version: 1, root: { op: 'official_driver_results_comparison', metric, season: 2025, driver_a_id: driverA, driver_b_id: driverB } };
}

function race(round: number, driver_id: string, finishing_position: number | null): EventClassificationRow {
  return { season: 2025, round, driver_id, team_id: null, finishing_position, points: 0, classification_status: 'classified', status_reason: null };
}

function qualifying(round: number, driver_id: string, qualifying_position: number | null): QualifyingClassificationRow {
  return { season: 2025, round, driver_id, team_id: 'test-team', qualifying_position, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' };
}

const standingsRows: StandingsRow[] = [
  { season: 2025, driver_id: 'driver-a', championship_position: 2, points: 300, championship_won: false },
  { season: 2025, driver_id: 'driver-b', championship_position: 1, points: 300, championship_won: true }
];
const raceRows = [race(1, 'driver-a', 1), race(1, 'driver-b', 2), race(2, 'driver-a', 3), race(2, 'driver-b', 1), race(3, 'driver-a', 4), race(3, 'driver-b', 4), race(4, 'driver-a', null), race(4, 'driver-b', 5)];
const qualifyingRows = [qualifying(1, 'driver-a', 1), qualifying(1, 'driver-b', 2), qualifying(2, 'driver-a', 3), qualifying(2, 'driver-b', 1), qualifying(3, 'driver-a', 4), qualifying(3, 'driver-b', 4), qualifying(4, 'driver-a', null), qualifying(4, 'driver-b', 5)];

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query('INSERT INTO season (year) VALUES (2025)');
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'entrant-a', 'team-a', 'driver_a'), (2025, 'entrant-b', 'team-b', 'driver_b')`);
  await pool.query(`INSERT INTO season_driver_standing
    (year, position_display_order, position_number, position_text, driver_id, points, championship_won)
    VALUES (2025, 1, 1, '1', 'driver_b', 300, true), (2025, 2, 2, '2', 'driver_a', 300, false)`);
  for (let round = 1; round <= 4; round += 1) await pool.query('INSERT INTO race (id, year, round) VALUES ($1, 2025, $1)', [round]);
  for (const row of raceRows) {
    await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, race_points)
      VALUES ($1, 'RACE_RESULT', $2, $3, 0)`, [row.round, row.driver_id.replaceAll('-', '_'), row.finishing_position]);
  }
  for (const row of qualifyingRows) {
    await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position)
      VALUES (2025, $1, $2, $3, $4)`, [row.round, row.driver_id.replaceAll('-', '_'), row.team_id, row.qualifying_position]);
  }
});

afterAll(async () => pool.end());

describe('canonical official driver results comparison foundation', () => {
  it('accepts only the closed final-season surface and rejects shadow candidates', () => {
    const parsed = parseF1QLProgram(program());
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, season: 2026 } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, driver_b_id: 'driver-a' } })).toThrow('requires two different drivers');
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, metric: 'other' } })).toThrow();
    expect(() => parseF1QLProgramCandidate(program())).toThrow();
    expect(renderF1QL(parsed)).toContain('no pace, time-gap, weather, or synthetic score');
  });

  it('lowers to four scalar generic inputs and compiles parameterized SQL', () => {
    const core = lowerF1QL(program());
    expect(core.root).toMatchObject({
      op: 'compose', metric_id: metric, require_exactly_one_row_per_input: true,
      inputs: [
        { as: 'driver_a_standing', input: { op: 'aggregate' } },
        { as: 'driver_b_standing', input: { op: 'aggregate' } },
        { as: 'race', input: { op: 'comparison_summary' } },
        { as: 'qualifying', input: { op: 'comparison_summary' } }
      ]
    });
    validateCoreProgram(core);
    const compiled = compileF1QL(core);
    expect(compiled.params).toEqual([[2025], ['driver-a'], [2025], ['driver-b'], 2025, 'driver-a', 'driver-b', 'official_race_finishing_position_shared_events_v1', true, 2025, 'driver-a', 'driver-b', 'official_qualifying_position_shared_events_v1', true, metric]);
    expect(compiled.sql).not.toContain('driver-a');
    expect(compiled.sql).toContain('f1ql.driver_standings');
    expect(compiled.sql).toContain('f1ql.event_classification');
    expect(compiled.sql).toContain('f1ql.qualifying_classification');
  });

  it('independently rejects malformed composed aliases, fields, and cardinality contracts', () => {
    const mutate = (change: (root: any) => void) => {
      const core = lowerF1QL(program());
      change(core.root);
      expect(() => validateCoreProgram(core)).toThrow();
      expect(() => compileF1QL(core)).toThrow();
      expect(() => interpretOfficialDriverResultsComparison(core, standingsRows, raceRows, qualifyingRows)).toThrow();
    };
    mutate(root => { root.inputs[0].input.measures[0].as = 'unsafe alias'; });
    mutate(root => { root.inputs[0].require.equals = 2; });
    mutate(root => { root.inputs[0].require.non_null_fields = ['points']; });
    mutate(root => { root.inputs[0].input.input.where.extra = true; });
    mutate(root => { root.inputs[0].input.input.where.points = 300; });
    mutate(root => { root.inputs[0].input.group_by = []; });
    mutate(root => { root.inputs[0].input.input.where.driver_id = 'driver-b'; });
    mutate(root => { root.inputs[2].input.input.input.left.where.season = 2024; });
    mutate(root => {
      root.inputs[0].input.input.where.season = 2026;
      root.inputs[1].input.input.where.season = 2026;
      for (const input of root.inputs.slice(2)) {
        input.input.input.input.left.where.season = 2026;
        input.input.input.input.right.where.season = 2026;
      }
    });
    mutate(root => { root.inputs[2].input.metric_id = 'other'; });
    mutate(root => { root.inputs[3].input.lower_is_better = false; });
    mutate(root => { root.inputs[2].input.require_unique_source_keys = false; });
    mutate(root => { root.inputs[3].input.require_source_presence = false; });
    mutate(root => {
      root.inputs[2].input.input.input.left.input.source = 'qualifying_classification';
      root.inputs[2].input.input.input.right.input.source = 'qualifying_classification';
      root.inputs[2].input.input.left.field = 'qualifying_position';
      root.inputs[2].input.input.right.field = 'qualifying_position';
    });
    mutate(root => { root.inputs[1].as = 'driver_a_standing'; });
    mutate(root => { root.select[0].field = 'unknown_field'; });
    mutate(root => { root.select[1].as = 'season'; });
    mutate(root => { root.select[1].as = 'unsafe-alias'; });
    mutate(root => { root.require_exactly_one_row_per_input = false; });
    mutate(root => { root.metric_id = 'other'; });
  });

  it('charges both H2Hs and both standings branches without a caller bypass', () => {
    expect(OFFICIAL_DRIVER_RESULTS_COMPARISON_SOURCE_ROUND_BRANCHES).toBe(122);
    expect(estimateF1QLCost(program())).toEqual({ source_round_branches: 122 });
    expect(() => enforceF1QLCostLimits(program())).not.toThrow();
    expect(() => enforceF1QLCostLimits(program(), { maxSourceRoundBranches: 121 })).toThrow(F1QLCostLimitError);
    expect(() => enforceF1QLCostLimits(program(), { maxSourceRoundBranches: 123 })).toThrow(F1QLCostLimitError);
  });

  it('matches SQL and reference semantics with equal points and distinct official positions', async () => {
    const core = lowerF1QL(program());
    const reference = interpretOfficialDriverResultsComparison(core, standingsRows, raceRows, qualifyingRows);
    expect(reference).toEqual([expect.objectContaining({
      metric_id: metric, season: 2025, driver_a_id: 'driver-a', driver_b_id: 'driver-b',
      driver_a_championship_position: 2, driver_b_championship_position: 1,
      driver_a_points: 300, driver_b_points: 300,
      race_driver_a_ahead: 1, race_driver_b_ahead: 1, race_ties: 1, race_shared_events: 3,
      qualifying_driver_a_ahead: 1, qualifying_driver_b_ahead: 1, qualifying_ties: 1, qualifying_shared_events: 3
    })]);
    const compiled = compileF1QL(core);
    const sqlRows = (await executeF1QLReadOnly(pool, compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual([expect.objectContaining({
      metric_id: metric, season: 2025, driver_a_id: 'driver-a', driver_b_id: 'driver-b',
      driver_a_championship_position: 2, driver_b_championship_position: 1,
      driver_a_points: '300', driver_b_points: '300',
      race_driver_a_ahead: 1, race_driver_b_ahead: 1, race_ties: 1, race_shared_events: 3,
      qualifying_driver_a_ahead: 1, qualifying_driver_b_ahead: 1, qualifying_ties: 1, qualifying_shared_events: 3
    })]);
    await expect(executeF1QL(pool, program())).resolves.toMatchObject({ rows: sqlRows });
  });

  it('fails closed for missing or duplicate standings and independently exposes duplicate classification integrity', async () => {
    expect(interpretOfficialDriverResultsComparison(lowerF1QL(program()), standingsRows.slice(0, 1), raceRows, qualifyingRows)).toEqual([]);
    expect(interpretOfficialDriverResultsComparison(lowerF1QL(program()), [...standingsRows, { ...standingsRows[0], points: 999 }], raceRows, qualifyingRows)).toEqual([]);
    expect(interpretOfficialDriverResultsComparison(lowerF1QL(program()), [{ ...standingsRows[0], championship_position: null }, standingsRows[1]], raceRows, qualifyingRows)).toEqual([]);
    const duplicateRace = [...raceRows, race(1, 'driver-a', 1)];
    expect(interpretOfficialDriverResultsComparison(lowerF1QL(program()), standingsRows, duplicateRace, qualifyingRows)).toEqual([
      expect.objectContaining({ race_duplicate_source_rows: 1, race_source_integrity_ok: false, race_shared_events: null, qualifying_source_integrity_ok: true })
    ]);
    await pool.query(`INSERT INTO season_driver_standing
      (year, position_display_order, position_number, position_text, driver_id, points, championship_won)
      VALUES (2025, 3, 3, '3', 'driver_a', 999, false)`);
    const core = lowerF1QL(program());
    const compiled = compileF1QL(core);
    await expect(executeF1QLReadOnly(pool, compiled.sql, compiled.params)).resolves.toMatchObject({ rows: [] });
    await expect(executeF1QL(pool, program())).resolves.toMatchObject({ rows: [] });
  });
});
