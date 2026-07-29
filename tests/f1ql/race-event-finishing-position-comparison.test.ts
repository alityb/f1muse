import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { F1QLProgram } from '../../src/f1ql/ast';
import { canonicalProgramEntities } from '../../src/f1ql/answer-observations';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QLReadOnly } from '../../src/f1ql/executor';
import { EventClassificationRow, interpretComparisonSummary } from '../../src/f1ql/interpreter';
import { enforceF1QLCostLimits, estimateF1QLCost, F1QLCostLimitError } from '../../src/f1ql/limits';
import { lowerF1QL } from '../../src/f1ql/lower';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const metric = 'official_race_finishing_position_single_event_v1' as const;

function program(driverA = 'max-verstappen', driverB = 'lando-norris'): F1QLProgram {
  return {
    version: 1,
    root: { op: 'race_event_finishing_position_comparison', metric, season: 2025, round: 12, driver_a_id: driverA, driver_b_id: driverB }
  };
}

function row(round: number, driverId: string, finishingPosition: number | null): EventClassificationRow {
  return {
    season: 2025, round, driver_id: driverId, team_id: null, finishing_position: finishingPosition, points: 0,
    classification_status: finishingPosition === null ? 'dnf' : 'classified', status_reason: finishingPosition === null ? 'DNF' : null
  };
}

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO season (year) VALUES (2025)`);
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'entrant-a', 'team-a', 'max_verstappen'),
    (2025, 'entrant-b', 'team-b', 'lando_norris')`);
  await pool.query(`INSERT INTO race (id, year, round) VALUES (12, 2025, 12), (11, 2025, 11)`);
  await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, race_points) VALUES
    (12, 'RACE_RESULT', 'max_verstappen', 5, 0),
    (12, 'RACE_RESULT', 'lando_norris', 1, 25),
    (11, 'RACE_RESULT', 'max_verstappen', 1, 25),
    (11, 'RACE_RESULT', 'lando_norris', 2, 18)`);
});

afterAll(async () => {
  await pool.end();
});

describe('canonical race event finishing-position comparison foundation', () => {
  it('lowers only the closed event-scoped official classification surface', () => {
    const parsed = parseF1QLProgram(program());
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    expect(lowerF1QL(parsed).root).toEqual({
      op: 'comparison_summary',
      input: {
        op: 'compare',
        input: {
          op: 'join', type: 'inner', on: ['season', 'round'],
          left: { op: 'filter', input: { op: 'source', source: 'event_classification' }, where: { season: 2025, round: 12, driver_id: 'max-verstappen' } },
          right: { op: 'filter', input: { op: 'source', source: 'event_classification' }, where: { season: 2025, round: 12, driver_id: 'lando-norris' } }
        },
        left: { field: 'finishing_position', as: 'driver_a_position' },
        right: { field: 'finishing_position', as: 'driver_b_position' }
      },
      metric_id: metric, lower_is_better: true, require_unique_source_keys: true, require_source_presence: true,
      require_exactly_one_shared_event: true
    });
    expect(compileF1QL(lowerF1QL(parsed)).params).toEqual([2025, 12, 'max-verstappen', 'lando-norris', metric, true]);
    expect(canonicalProgramEntities(parsed)).toEqual(['driver:lando-norris', 'driver:max-verstappen', 'event:2025:12']);
    expect(renderF1QL(parsed)).toContain('no pace or time gap');
    expect(() => parseF1QLProgramCandidate(parsed)).toThrow();

    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, season: 2026 } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, round: 31 } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, driver_b_id: 'max-verstappen' } })).toThrow('requires two different drivers');
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, metric: 'other' } })).toThrow();
    expect(() => parseF1QLProgram({ ...program(), root: { ...program().root, extra: true } })).toThrow();
  });

  it('rejects mutations of round, source, field, direction, and integrity', () => {
    const mutate = (change: (root: any) => void) => {
      const core = lowerF1QL(program());
      change(core.root);
      expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
      expect(() => compileF1QL(core)).toThrow();
      expect(() => interpretComparisonSummary(core, [])).toThrow();
    };
    mutate(root => { root.input.input.left.where.round = 11; });
    mutate(root => { root.input.input.right.where.extra = true; });
    mutate(root => { root.input.input.left.input.source = 'qualifying_classification'; });
    mutate(root => {
      root.input.input.left.input.source = 'qualifying_classification';
      root.input.input.right.input.source = 'qualifying_classification';
      root.input.left.field = 'qualifying_position';
      root.input.right.field = 'qualifying_position';
    });
    mutate(root => { root.input.left.field = 'points'; });
    mutate(root => { root.input.input.type = 'left'; });
    mutate(root => { root.lower_is_better = 'yes'; });
    mutate(root => { root.lower_is_better = false; });
    mutate(root => { root.require_unique_source_keys = false; });
    mutate(root => { root.require_source_presence = false; });
    mutate(root => { delete root.require_exactly_one_shared_event; });
  });

  it('scopes comparison and integrity sentinels to exactly one round', () => {
    const rows = [
      row(12, 'max-verstappen', 5), row(12, 'lando-norris', 1),
      row(11, 'max-verstappen', 1), row(11, 'lando-norris', 2)
    ];
    expect(interpretComparisonSummary(lowerF1QL(program()), rows)).toEqual([{
      metric_id: metric, season: 2025, driver_a_id: 'max-verstappen', driver_b_id: 'lando-norris',
      driver_a_ahead: 0, driver_b_ahead: 1, ties: 0, shared_events: 1,
      driver_a_source_rows: 1, driver_b_source_rows: 1, distinct_source_keys: 2, duplicate_source_rows: 0,
      source_presence_ok: true, source_unique_keys_ok: true, source_integrity_ok: true
    }]);

    expect(interpretComparisonSummary(lowerF1QL(program()), [rows[0]])[0]).toMatchObject({
      driver_b_source_rows: 0, source_presence_ok: false, source_integrity_ok: false, shared_events: null
    });
    expect(interpretComparisonSummary(lowerF1QL(program()), [...rows, row(12, 'max-verstappen', 5)])[0]).toMatchObject({
      duplicate_source_rows: 1, source_unique_keys_ok: false, source_integrity_ok: false, shared_events: null
    });
    expect(interpretComparisonSummary(lowerF1QL(program()), [row(12, 'max-verstappen', null), rows[1]])[0]).toMatchObject({
      source_integrity_ok: false, driver_a_ahead: null, driver_b_ahead: null, ties: null, shared_events: null
    });
    expect(interpretComparisonSummary(lowerF1QL(program()), [row(12, 'max-verstappen', 1), row(12, 'lando-norris', 1)])[0]).toMatchObject({
      driver_a_ahead: 0, driver_b_ahead: 0, ties: 1, shared_events: 1
    });
  });

  it('matches PostgreSQL and reference semantics for the round-scoped placeholder layout', async () => {
    const core = lowerF1QL(program());
    const compiled = compileF1QL(core);
    const expected = interpretComparisonSummary(core, [row(12, 'max-verstappen', 5), row(12, 'lando-norris', 1)]);
    expect(compiled.sql).toContain('WHERE season = $1 AND round = $2 AND driver_id IN ($3, $4)');
    expect((await executeF1QLReadOnly(pool, compiled.sql, compiled.params)).rows).toEqual(expected);
  });

  it('charges exactly two source-round branches', () => {
    expect(estimateF1QLCost(program())).toEqual({ source_round_branches: 2 });
    expect(() => enforceF1QLCostLimits(program())).not.toThrow();
    expect(() => enforceF1QLCostLimits(program(), { maxSourceRoundBranches: 1 })).toThrow(F1QLCostLimitError);
    expect(() => enforceF1QLCostLimits(program(), { maxSourceRoundBranches: 61 })).toThrow(F1QLCostLimitError);
  });
});
