import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QL, executeF1QLReadOnly, F1QLStatementTimeoutError } from '../../src/f1ql/executor';
import { F1QLValidationError } from '../../src/f1ql/validation';
import { EventClassificationRow, interpretEventClassification, interpretPaceAggregate, interpretPaceSubtract, interpretStandingsProgram, PaceLapRow, StandingsRow } from '../../src/f1ql/interpreter';
import { renderF1QL } from '../../src/f1ql/render';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { F1QLProgram } from '../../src/f1ql/ast';
import { lowerF1QL } from '../../src/f1ql/lower';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const program: F1QLProgram = {
  version: 1,
  root: {
    op: 'rank',
    input: {
      op: 'aggregate',
      input: {
        op: 'filter',
        input: { op: 'source', source: 'standings' },
        where: { season: 2025 }
      },
      group_by: ['driver_id'],
      measures: [
        { as: 'total_points', function: 'sum', field: 'points' },
        { as: 'seasons_counted', function: 'count' }
      ]
    },
    by: 'total_points',
    direction: 'desc',
    limit: 2
  }
};

const referenceRows: StandingsRow[] = [
  { season: 2025, driver_id: 'max-verstappen', championship_position: 2, points: 421, championship_won: false },
  { season: 2025, driver_id: 'lando-norris', championship_position: 1, points: 423, championship_won: true },
  { season: 2025, driver_id: 'george-russell', championship_position: 4, points: 319, championship_won: false },
  { season: 2024, driver_id: 'max-verstappen', championship_position: 1, points: 437, championship_won: true }
];

const paceProgram: F1QLProgram = {
  version: 1,
  root: {
    op: 'pace_delta',
    driver_a_id: 'max-verstappen',
    driver_b_id: 'lando-norris',
    scope: { season: 2025, rounds: [1, 2, 3] },
    filters: { clean_air_only: true, compound: 'MEDIUM' }
  }
};

const paceSummaryProgram: F1QLProgram = {
  version: 1,
  root: {
    op: 'pace_summary',
    driver_id: 'max-verstappen',
    scope: { season: 2025, rounds: [1, 2, 3] },
    filters: { clean_air_only: true, compound: 'MEDIUM' }
  }
};

const paceReferenceRows: PaceLapRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 100, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 102, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 104, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 80, is_valid_lap: false, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 101, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 103, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 105, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 2, driver_id: 'max-verstappen', lap_time_seconds: 110, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 2, driver_id: 'max-verstappen', lap_time_seconds: 112, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 2, driver_id: 'lando-norris', lap_time_seconds: 111, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 2, driver_id: 'lando-norris', lap_time_seconds: 113, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 3, driver_id: 'max-verstappen', lap_time_seconds: null, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 3, driver_id: 'lando-norris', lap_time_seconds: 120, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' }
];

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool, { seed: false });

  for (const [index, row] of referenceRows.entries()) {
    await pool.query(
      `INSERT INTO season_driver_standing
        (year, position_display_order, position_number, position_text, driver_id, points, championship_won)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.season, index + 1, row.championship_position, String(row.championship_position), row.driver_id, row.points, row.championship_won]
    );
  }

  for (const [index, row] of paceReferenceRows.entries()) {
    await pool.query(
      `INSERT INTO laps_normalized
        (season, round, track_id, driver_id, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound)
       VALUES ($1, $2, 'test-track', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [row.season, row.round, row.driver_id, index + 1, row.lap_time_seconds, row.is_valid_lap, row.is_pit_lap, row.is_in_lap, row.is_out_lap, row.clean_air_flag, row.compound]
    );
  }
  await pool.query(
    `INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
      (2025, 'red-bull', 'red-bull', 'max-verstappen', false),
      (2025, 'mclaren', 'mclaren', 'lando-norris', false),
      (2025, 'test-team', 'test-team', 'driver-dns', false),
      (2027, 'team-a', 'team-a', 'driver-a', false),
      (2027, 'team-b', 'team-b', 'driver-b', false)`
  );
});

afterAll(async () => {
  await pool.end();
});

describe('F1QL standings vertical slice', () => {
  it('rejects aggregates and ranks outside the closed v1 grammar', () => {
    expect(() => parseF1QLProgram({
      version: 1,
      root: {
        op: 'aggregate',
        input: { op: 'source', source: 'standings' },
        group_by: ['driver_id'],
        measures: [{ as: 'bad', function: 'sum' }]
      }
    })).toThrow('sum requires a field');

    expect(() => parseF1QLProgram({
      version: 1,
      root: {
        op: 'rank',
        input: program.root.input,
        by: 'not_a_measure',
        direction: 'desc',
        limit: 2
      }
    })).toThrow('rank field must be an aggregate alias');
  });

  it('interprets the standings program deterministically in memory', () => {
    expect(interpretStandingsProgram(lowerF1QL(program), referenceRows)).toEqual([
      { driver_id: 'lando-norris', total_points: 423, seasons_counted: 1 },
      { driver_id: 'max-verstappen', total_points: 421, seasons_counted: 1 }
    ]);
  });

  it('compiles parameters without interpolating filter values into SQL', () => {
    const compiled = compileF1QL(lowerF1QL(program));

    expect(compiled.sql).toContain('season = ANY($1::integer[])');
    expect(compiled.sql).toContain('LIMIT 2');
    expect(compiled.sql).not.toContain('2025');
    expect(compiled.params).toEqual([[2025]]);
  });

  it('matches the reference interpreter when executed against PostgreSQL', async () => {
    const reference = interpretStandingsProgram(lowerF1QL(program), referenceRows);
    const executed = await executeF1QL(pool, program);
    const actual = executed.rows.map((row) => ({
      driver_id: row.driver_id,
      total_points: Number(row.total_points),
      seasons_counted: Number(row.seasons_counted)
    }));

    expect(actual).toEqual(reference);
    expect(executed.core_program.root).toMatchObject({ op: 'limit', input: { op: 'sort' } });
  });

  it('renders the calculation from the AST', () => {
    expect(renderF1QL(program)).toBe(
      'From official driver standings: sum points, count standings rows, grouped by driver; season 2025; rank by total_points desc, top 2.'
    );
  });

  it('rejects an invalid pace comparison', () => {
    expect(() => parseF1QLProgram({
      version: 1,
      root: { op: 'pace_delta', driver_a_id: 'max-verstappen', driver_b_id: 'max-verstappen', scope: { season: 2025 } }
    })).toThrow('pace_delta requires two different drivers');
  });

  it('rejects malformed pace syntax instead of silently changing its meaning', () => {
    expect(() => parseF1QLProgram({
      version: 1,
      root: {
        op: 'pace_delta',
        driver_a_id: 'max-verstappen',
        driver_b_id: 'lando-norris',
        scope: { season: 2025, rounds: [0] }
      }
    })).toThrow();

    expect(() => parseF1QLProgram({
      version: 1,
      root: {
        op: 'pace_delta',
        driver_a_id: 'max-verstappen',
        driver_b_id: 'lando-norris',
        scope: { season: 2025 },
        sql: 'SELECT * FROM laps_normalized'
      }
    })).toThrow();
  });

  it('rejects pace programs whose requested scope exceeds the execution budget', async () => {
    const rounds = Array.from({ length: 25 }, (_, index) => index + 1);
    await expect(executeF1QL(pool, {
      version: 1,
      root: {
        op: 'pace_summary',
        driver_id: 'max-verstappen',
        scope: { season: 2025, rounds }
      }
    })).rejects.toThrow('At most 24 rounds may be requested');
  });

  it('lowers pace_delta to aligned pace aggregates and a scalar subtraction', () => {
    expect(lowerF1QL(paceProgram).root).toMatchObject({
      op: 'subtract',
      alignment: 'shared_events',
      left: { op: 'pace_aggregate', driver_id: 'max-verstappen' },
      right: { op: 'pace_aggregate', driver_id: 'lando-norris' }
    });
  });

  it('compiles pace delta with parameters and matches the reference interpreter', async () => {
    const coreProgram = lowerF1QL(paceProgram);
    if (coreProgram.root.op !== 'subtract') {
      throw new Error('Expected pace subtraction');
    }
    const compiled = compileF1QL(coreProgram);
    const reference = interpretPaceSubtract(coreProgram.root, paceReferenceRows);
    const executed = await executeF1QL(pool, paceProgram);
    const actual = executed.rows.map((row) => ({
      driver_a_id: row.driver_a_id,
      driver_b_id: row.driver_b_id,
      shared_events: Number(row.shared_events),
      driver_a_avg_lap_time_seconds: Number(row.driver_a_avg_lap_time_seconds),
      driver_b_avg_lap_time_seconds: Number(row.driver_b_avg_lap_time_seconds),
      delta_seconds: Number(row.delta_seconds),
      delta_percent: Number(row.delta_percent)
    }));

    expect(compiled.sql).toContain('PERCENTILE_CONT(0.5)');
    expect(compiled.sql).not.toContain('2025');
    expect(compiled.params).toEqual([2025, 'max-verstappen', 'lando-norris', [1, 2, 3], true, 'MEDIUM']);
    expect(actual).toEqual(reference);
    expect(renderF1QL(paceProgram)).toBe(
      'Median valid race-lap pace per shared event, then mean across events; max-verstappen minus lando-norris; season 2025; rounds 1, 2, 3; clean-air laps only; compound MEDIUM.'
    );
  });

  it('compiles a pace summary from the reusable pace aggregate core primitive', async () => {
    const coreProgram = lowerF1QL(paceSummaryProgram);
    if (coreProgram.root.op !== 'pace_aggregate') {
      throw new Error('Expected pace aggregate');
    }
    const compiled = compileF1QL(coreProgram);
    const reference = interpretPaceAggregate(coreProgram.root, paceReferenceRows);
    const executed = await executeF1QL(pool, paceSummaryProgram);
    const actual = executed.rows.map((row) => ({
      driver_id: row.driver_id,
      events: Number(row.events),
      avg_lap_time_seconds: Number(row.avg_lap_time_seconds)
    }));

    expect(compiled.sql).toContain('PERCENTILE_CONT(0.5)');
    expect(compiled.params).toEqual([2025, 'max-verstappen', [1, 2, 3], true, 'MEDIUM']);
    expect(actual).toEqual(reference);
    expect(renderF1QL(paceSummaryProgram)).toBe(
      'Median valid race-lap pace per event, then mean; max-verstappen; season 2025; rounds 1, 2, 3; clean-air laps only; compound MEDIUM.'
    );
  });

  it('excludes null, invalid, pit, and in/out laps before shared-event alignment', () => {
    const coreProgram = lowerF1QL({
      version: 1,
      root: {
        op: 'pace_delta',
        driver_a_id: 'driver-a',
        driver_b_id: 'driver-b',
        scope: { season: 2026 },
        filters: { clean_air_only: true }
      }
    });
    if (coreProgram.root.op !== 'subtract') {
      throw new Error('Expected pace subtraction');
    }

    const rows: PaceLapRow[] = [
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: 100, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: 10, is_valid_lap: true, is_pit_lap: true, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: null, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 101, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 10, is_valid_lap: true, is_pit_lap: false, is_in_lap: true, is_out_lap: false, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 10, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: true, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 2, driver_id: 'driver-a', lap_time_seconds: 110, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: false, compound: 'SOFT' },
      { season: 2026, round: 2, driver_id: 'driver-b', lap_time_seconds: 111, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: false, compound: 'HARD' }
    ];

    expect(interpretPaceSubtract(coreProgram.root, rows)).toEqual([expect.objectContaining({
      shared_events: 1,
      delta_seconds: -1
    })]);
  });

  it('returns a null comparison when drivers have no shared eligible events', async () => {
    const noOverlapProgram: F1QLProgram = {
      version: 1,
      root: {
        op: 'pace_delta',
        driver_a_id: 'driver-a',
        driver_b_id: 'driver-b',
        scope: { season: 2027 }
      }
    };
    const noOverlapRows: PaceLapRow[] = [
      { season: 2027, round: 1, driver_id: 'driver-a', lap_time_seconds: 100, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: false, compound: null },
      { season: 2027, round: 2, driver_id: 'driver-b', lap_time_seconds: 101, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: false, compound: null }
    ];
    const coreProgram = lowerF1QL(noOverlapProgram);
    if (coreProgram.root.op !== 'subtract') {
      throw new Error('Expected pace subtraction');
    }
    await pool.query(
      `INSERT INTO laps_normalized
        (season, round, track_id, driver_id, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag)
       VALUES
        (2027, 1, 'test-track', 'driver-a', 1, 100, true, false, false, false, false),
        (2027, 2, 'test-track', 'driver-b', 1, 101, true, false, false, false, false)`
    );

    const executed = await executeF1QL(pool, noOverlapProgram);
    const expected = expect.objectContaining({
      shared_events: 0,
      driver_a_avg_lap_time_seconds: null,
      driver_b_avg_lap_time_seconds: null,
      delta_seconds: null,
      delta_percent: null
    });
    expect(interpretPaceSubtract(coreProgram.root, noOverlapRows)).toEqual([expected]);
    expect(executed.rows).toEqual([expected]);
  });

  it('compiles official event classification from the canonical view', async () => {
    await pool.query(`INSERT INTO race (id, year, round) VALUES (2001, 2025, 9)`);
    await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, race_points, race_reason_retired) VALUES
      (2001, 'RACE_RESULT', 'max_verstappen', 1, 25, NULL),
      (2001, 'RACE_RESULT', 'lando_norris', 2, 18, NULL),
      (2001, 'RACE_RESULT', 'driver_dnf', NULL, 0, 'DNF')`);
    await pool.query(`INSERT INTO race_data (race_id, type, driver_id, position_number, race_points, race_reason_retired) VALUES
      (2001, 'RACE_RESULT', 'driver_dns', NULL, 0, 'DNS')`);
    const program: F1QLProgram = { version: 1, root: { op: 'event_classification', season: 2025, round: 9, limit: 4 } };
    const compiled = compileF1QL(lowerF1QL(program));
    const executed = await executeF1QL(pool, program);

    expect(compiled.sql).toContain('f1ql.event_classification');
    expect(compiled.params).toEqual([2025, 9]);
    expect(executed.rows).toEqual([
      { driver_id: 'max-verstappen', finishing_position: 1, points: '25', classification_status: 'classified', status_reason: null },
      { driver_id: 'lando-norris', finishing_position: 2, points: '18', classification_status: 'classified', status_reason: null },
      { driver_id: 'driver-dnf', finishing_position: null, points: '0', classification_status: 'dnf', status_reason: 'DNF' },
      { driver_id: 'driver-dns', finishing_position: null, points: '0', classification_status: 'dns', status_reason: 'DNS' }
    ]);
    expect(renderF1QL(program)).toBe('Official race classification; season 2025; round 9; top 4.');

    const filtered: F1QLProgram = {
      version: 1,
      root: {
        op: 'event_classification', season: 2025, round: 9, limit: 10,
        filters: { classification_status: ['dns', 'dnf'], driver_id: 'driver-dns' }
      }
    };
    const filteredCompiled = compileF1QL(lowerF1QL(filtered));
    const filteredExecuted = await executeF1QL(pool, filtered);
    expect(filteredCompiled.params).toEqual([2025, 9, ['dns', 'dnf'], 'driver-dns']);
    expect(filteredExecuted.rows).toEqual([expect.objectContaining({
      driver_id: 'driver-dns', classification_status: 'dns'
    })]);

    const filteredCore = lowerF1QL(filtered);
    if (filteredCore.root.op !== 'event_classification') {
      throw new Error('Expected event classification');
    }
    const referenceRows: EventClassificationRow[] = [
      { season: 2025, round: 9, driver_id: 'max-verstappen', team_id: null, finishing_position: 1, points: 25, classification_status: 'classified', status_reason: null },
      { season: 2025, round: 9, driver_id: 'lando-norris', team_id: null, finishing_position: 2, points: 18, classification_status: 'classified', status_reason: null },
      { season: 2025, round: 9, driver_id: 'driver-dnf', team_id: null, finishing_position: null, points: 0, classification_status: 'dnf', status_reason: 'DNF' },
      { season: 2025, round: 9, driver_id: 'driver-dns', team_id: null, finishing_position: null, points: 0, classification_status: 'dns', status_reason: 'DNS' }
    ];
    expect(filteredExecuted.rows.map((row) => ({ ...row, points: Number(row.points) })))
      .toEqual(interpretEventClassification(filteredCore.root, referenceRows));
  });

  it('cancels slow statements under the configured read-only timeout', async () => {
    await expect(executeF1QLReadOnly(pool, 'SELECT pg_sleep(0.1)', [], { statementTimeoutMs: 10 }))
      .rejects.toBeInstanceOf(F1QLStatementTimeoutError);
  });

  it('enforces participation for driver-filtered standings and event classifications', async () => {
    const standingsProgram: F1QLProgram = {
      version: 1,
      root: {
        op: 'aggregate',
        input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025, driver_id: 'missing-driver' } },
        group_by: ['driver_id'],
        measures: [{ as: 'total_points', function: 'sum', field: 'points' }]
      }
    };
    const eventProgram: F1QLProgram = {
      version: 1,
      root: { op: 'event_classification', season: 2025, round: 9, limit: 1, filters: { driver_id: 'driver-dnf' } }
    };
    await expect(executeF1QL(pool, standingsProgram)).rejects.toMatchObject({ code: 'participation_missing' } satisfies Partial<F1QLValidationError>);
    await expect(executeF1QL(pool, eventProgram)).rejects.toMatchObject({ code: 'participation_missing' } satisfies Partial<F1QLValidationError>);
  });
});
