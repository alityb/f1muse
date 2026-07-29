import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { F1QLProgram } from '../../src/f1ql/ast';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QLReadOnly } from '../../src/f1ql/executor';
import { interpretQualifyingCount, QualifyingClassificationRow } from '../../src/f1ql/interpreter';
import { enforceF1QLCostLimits, estimateF1QLCost, F1QLCostLimitError } from '../../src/f1ql/limits';
import { lowerF1QL } from '../../src/f1ql/lower';
import {
  CAREER_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES,
  COMPLETED_QUALIFYING_SEASONS,
  DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID,
  DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID,
  DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID,
  SEASON_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES,
  SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID
} from '../../src/f1ql/qualifying-counts';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';

const driverSeasonP1 = (driverId = 'driver-a', season = 2025): F1QLProgram => ({
  version: 1,
  root: { op: 'driver_season_qualifying_p1_count', metric: DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID, season, driver_id: driverId }
});
const driverCareerP1 = (driverId = 'driver-a'): F1QLProgram => ({
  version: 1,
  root: { op: 'driver_career_qualifying_p1_count', metric: DRIVER_CAREER_QUALIFYING_P1_COUNT_METRIC_ID, seasons: [...COMPLETED_QUALIFYING_SEASONS], driver_id: driverId }
});
const driverSeasonTopTen = (driverId = 'driver-a', season = 2025): F1QLProgram => ({
  version: 1,
  root: { op: 'driver_season_qualifying_top_ten_count', metric: DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID, season, driver_id: driverId }
});
const seasonTopTenRanking = (season = 2025): F1QLProgram => ({
  version: 1,
  root: { op: 'season_qualifying_top_ten_ranking', metric: SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID, season }
});

function row(season: number, round: number, driverId: string, position: number | null): QualifyingClassificationRow {
  return {
    season, round, driver_id: driverId, team_id: 'test-team', qualifying_position: position,
    best_time_ms: null, best_session: null, eliminated_in_round: null,
    classification_status: position === null ? 'dnf' : 'classified'
  };
}

const referenceRows = [
  row(2024, 1, 'driver-a', 1),
  row(2025, 1, 'driver-a', 1), row(2025, 2, 'driver-a', 5), row(2025, 3, 'driver-a', 11), row(2025, 4, 'driver-a', null),
  row(2025, 1, 'driver-b', 2), row(2025, 2, 'driver-b', 10), row(2025, 3, 'driver-b', 12),
  row(2025, 1, 'driver-c', 20),
  row(2026, 1, 'driver-a', 1)
];

let pool: Pool;

async function executeCore(program: F1QLProgram): Promise<Array<Record<string, unknown>>> {
  const core = lowerF1QL(program);
  validateCoreProgram(core);
  const compiled = compileF1QL(core);
  return (await executeF1QLReadOnly(pool, compiled.sql, compiled.params)).rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO season (year) VALUES (2024), (2025), (2026)`);
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'entrant-a', 'team-a', 'driver_a'),
    (2025, 'entrant-b', 'team-b', 'driver_b'),
    (2025, 'entrant-c', 'team-c', 'driver_c')`);
  for (const sourceRow of referenceRows) {
    await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position)
      VALUES ($1, $2, $3, $4, $5)`, [
      sourceRow.season, sourceRow.round, sourceRow.driver_id.replaceAll('-', '_'), sourceRow.team_id, sourceRow.qualifying_position
    ]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('canonical qualifying count foundations', () => {
  it('closes all four surfaces to official completed-season scopes and rejects shadow roots', () => {
    for (const program of [driverSeasonP1(), driverCareerP1(), driverSeasonTopTen(), seasonTopTenRanking()]) {
      const parsed = parseF1QLProgram(program);
      expect(() => validateF1QLProgram(parsed)).not.toThrow();
      expect(() => parseF1QLProgramCandidate(program)).toThrow();
    }
    expect(() => parseF1QLProgram(driverSeasonP1('driver-a', 1949))).toThrow();
    expect(() => parseF1QLProgram(driverSeasonP1('driver-a', 2026))).toThrow();
    expect(() => parseF1QLProgram(driverSeasonTopTen('Driver A'))).toThrow();
    expect(() => parseF1QLProgram(seasonTopTenRanking(2026))).toThrow();
    expect(() => parseF1QLProgram({ ...driverCareerP1(), root: { ...driverCareerP1().root, seasons: COMPLETED_QUALIFYING_SEASONS.slice(1) } })).toThrow();
    expect(() => parseF1QLProgram({ ...driverCareerP1(), root: { ...driverCareerP1().root, seasons: [...COMPLETED_QUALIFYING_SEASONS.slice(0, -1), 2026] } })).toThrow();
    expect(() => parseF1QLProgram({ ...driverSeasonP1(), root: { ...driverSeasonP1().root, metric: 'other' } })).toThrow();
  });

  it('lowers to generic filtered conditional aggregates and deterministic ranking sort', () => {
    expect(lowerF1QL(driverSeasonP1()).root).toEqual({
      op: 'aggregate',
      input: { op: 'filter', input: { op: 'source', source: 'qualifying_classification' }, where: { season: 2025, driver_id: 'driver-a' } },
      group_by: [],
      measures: [{ as: 'qualifying_p1_count', function: 'count', where: { field: 'qualifying_position', min: 1, max: 1 } }],
      source_record_integrity: {
        key: ['season', 'round', 'driver_id'], position_field: 'qualifying_position', position_min: 1, position_max: 30,
        require_source_presence: true, require_non_null_keys: true, require_unique_keys: true, require_unique_positions: true
      },
      metric_id: DRIVER_SEASON_QUALIFYING_P1_COUNT_METRIC_ID
    });
    const ranking = lowerF1QL(seasonTopTenRanking());
    expect(ranking.root).toMatchObject({
      op: 'sort', by: 'qualifying_top_ten_count', direction: 'desc',
      input: { op: 'aggregate', group_by: ['driver_id'], measures: [{ as: 'qualifying_top_ten_count', function: 'count' }] }
    });
    validateCoreProgram(ranking);
    const compiled = compileF1QL(ranking);
    expect(compiled.params).toEqual([2025, 1, 10, SEASON_QUALIFYING_TOP_TEN_RANKING_METRIC_ID]);
    expect(compiled.sql).toContain('FROM f1ql.qualifying_classification');
    expect(compiled.sql).toContain('driver_id COLLATE "C" ASC');
    expect(compiled.sql).not.toContain('driver-a');
    expect(renderF1QL(seasonTopTenRanking())).toContain('UTF-8 byte driver_id order');
  });

  it('independently rejects source, scope, measure, key, position, metric, and ordering mutations', () => {
    const mutate = (program: F1QLProgram, change: (root: any) => void) => {
      const core = lowerF1QL(program);
      change(core.root);
      expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
      expect(() => compileF1QL(core)).toThrow();
      expect(() => interpretQualifyingCount(core, referenceRows)).toThrow();
    };
    mutate(driverSeasonP1(), root => { root.input.input.source = 'event_classification'; });
    mutate(driverSeasonP1(), root => { root.input.where.season = 2026; });
    mutate(driverCareerP1(), root => { root.input.where.season = COMPLETED_QUALIFYING_SEASONS.slice(1); });
    mutate(driverSeasonTopTen(), root => { root.measures[0].where.max = 11; });
    mutate(driverSeasonP1(), root => { root.source_record_integrity.key = ['season', 'round']; });
    mutate(driverSeasonP1(), root => { root.source_record_integrity.position_max = 20; });
    mutate(driverSeasonP1(), root => { root.metric_id = DRIVER_SEASON_QUALIFYING_TOP_TEN_COUNT_METRIC_ID; });
    mutate(seasonTopTenRanking(), root => { root.direction = 'asc'; });
    expect(() => validateCoreProgram({
      version: 1,
      root: {
        op: 'aggregate', input: { op: 'source', source: 'standings' }, group_by: ['driver_id'],
        measures: [{ as: 'points', function: 'sum', field: 'points', where: { field: 'championship_position', min: 1, max: 1 } }]
      }
    })).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
  });

  it('admits one complete season branch and exactly 76 career season branches', () => {
    for (const program of [driverSeasonP1(), driverSeasonTopTen(), seasonTopTenRanking()]) {
      expect(estimateF1QLCost(program)).toEqual({ source_round_branches: SEASON_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES });
      expect(() => enforceF1QLCostLimits(program)).not.toThrow();
      expect(() => enforceF1QLCostLimits(program, { maxSourceRoundBranches: 29 })).toThrow(F1QLCostLimitError);
    }
    expect(SEASON_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES).toBe(30);
    expect(CAREER_QUALIFYING_COUNT_SOURCE_ROUND_BRANCHES).toBe(2280);
    expect(estimateF1QLCost(driverCareerP1())).toEqual({ source_round_branches: 2280 });
    expect(() => enforceF1QLCostLimits(driverCareerP1())).not.toThrow();
    expect(() => enforceF1QLCostLimits(driverCareerP1(), { maxSourceRoundBranches: 2279 })).toThrow(F1QLCostLimitError);
    expect(() => enforceF1QLCostLimits(driverCareerP1(), { maxSourceRoundBranches: 2281 })).toThrow(F1QLCostLimitError);
  });

  it('matches SQL/reference counts, preserves valid zero, rejects missing source as zero, and excludes 2026 from career', async () => {
    const cases: Array<[F1QLProgram, string, number]> = [
      [driverSeasonP1(), 'qualifying_p1_count', 1],
      [driverCareerP1(), 'qualifying_p1_count', 2],
      [driverSeasonTopTen(), 'qualifying_top_ten_count', 2],
      [driverSeasonTopTen('driver-c'), 'qualifying_top_ten_count', 0]
    ];
    for (const [program, field, count] of cases) {
      const expected = [expect.objectContaining({ driver_id: (program.root as { driver_id: string }).driver_id, [field]: count, source_integrity_ok: true })];
      expect(interpretQualifyingCount(lowerF1QL(program), referenceRows)).toEqual(expected);
      expect(await executeCore(program)).toEqual(expected);
    }
    const missing = interpretQualifyingCount(lowerF1QL(driverSeasonP1('missing-driver')), referenceRows);
    expect(missing).toEqual([expect.objectContaining({ qualifying_p1_count: null, qualifying_source_rows: 0, source_presence_ok: false, source_integrity_ok: false })]);
    expect(await executeCore(driverSeasonP1('missing-driver'))).toEqual(missing);
  });

  it('allows ranking ties and orders count DESC then UTF-8 byte driver_id in SQL and reference results', async () => {
    const expected = [
      expect.objectContaining({ driver_id: 'driver-a', qualifying_top_ten_count: 2 }),
      expect.objectContaining({ driver_id: 'driver-b', qualifying_top_ten_count: 2 }),
      expect.objectContaining({ driver_id: 'driver-c', qualifying_top_ten_count: 0 })
    ];
    expect(interpretQualifyingCount(lowerF1QL(seasonTopTenRanking()), referenceRows)).toEqual(expected);
    expect(await executeCore(seasonTopTenRanking())).toEqual(expected);
  });

  it('invalidates duplicate or missing keys, out-of-bound positions, and competing qualifying positions', async () => {
    const core = lowerF1QL(seasonTopTenRanking());
    expect(interpretQualifyingCount(core, [...referenceRows, row(2025, 1, 'driver-a', 1)]))
      .toEqual([expect.objectContaining({ duplicate_qualifying_rows: 1, qualifying_top_ten_count: null, source_key_integrity_ok: false, source_integrity_ok: false })]);
    expect(interpretQualifyingCount(core, [...referenceRows, { ...row(2025, 9, 'driver-z', 1), driver_id: null as unknown as string }]))
      .toEqual([expect.objectContaining({ missing_qualifying_key_rows: 1, qualifying_top_ten_count: null, source_key_integrity_ok: false })]);
    expect(interpretQualifyingCount(core, [...referenceRows, row(2025, 9, 'driver-z', 31)]))
      .toEqual([expect.objectContaining({ invalid_qualifying_position_rows: 1, qualifying_top_ten_count: null, position_integrity_ok: false, source_integrity_ok: false })]);
    expect(interpretQualifyingCount(lowerF1QL(driverSeasonP1()), [...referenceRows, row(2025, 1, 'driver-z', 1)]))
      .toEqual([expect.objectContaining({ duplicate_qualifying_position_rows: 1, qualifying_p1_count: null, position_integrity_ok: false, source_integrity_ok: false })]);

    await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position)
      VALUES (2025, 1, 'driver_z', 'test-team', 1)`);
    expect(await executeCore(driverSeasonP1())).toEqual([
      expect.objectContaining({ duplicate_qualifying_position_rows: 1, qualifying_p1_count: null, source_integrity_ok: false })
    ]);
    await pool.query(`DELETE FROM qualifying_results WHERE season = 2025 AND round = 1 AND driver_id = 'driver_z'`);

    await pool.query(`ALTER TABLE qualifying_results DROP CONSTRAINT qualifying_results_pkey`);
    await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position)
      VALUES (2025, 1, 'driver_a', 'test-team', 1)`);
    expect(await executeCore(seasonTopTenRanking())).toEqual([
      expect.objectContaining({ duplicate_qualifying_rows: 1, qualifying_top_ten_count: null, source_integrity_ok: false })
    ]);
  });
});
