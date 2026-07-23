import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { compileF1QL } from '../../src/f1ql/compiler';
import { executeF1QL, executeF1QLReadOnly, F1QLResultLimitError, F1QLStatementTimeoutError } from '../../src/f1ql/executor';
import { F1QLValidationError } from '../../src/f1ql/validation';
import { EventClassificationRow, EventMetadataRow, interpretEventClassification, interpretEventMetadata, interpretLapPaceProgram, interpretQualifyingClassification, interpretStandingsProgram, PaceLapRow, QualifyingClassificationRow, StandingsRow } from '../../src/f1ql/interpreter';
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
      `INSERT INTO laps_normalized_v2
        (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, methodology_version)
       VALUES ($1, $2, 'test-track', $3, 'R', $4, $5, $6, $7, $8, $9, $10, $11, 'clean_air_gap_2_0s_v1')`,
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

  it('enforces collection limits with deterministic top-level ordering', async () => {
    const exact = await executeF1QL(pool, program, { maxRows: 2 });
    expect(exact.rows.map(row => row.driver_id)).toEqual(['lando-norris', 'max-verstappen']);
    await expect(executeF1QL(pool, program, { maxRows: 1 })).rejects.toBeInstanceOf(F1QLResultLimitError);
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

  it('lowers pace_delta through shared-round generic core nodes', () => {
    expect(lowerF1QL(paceProgram).root).toMatchObject({
      op: 'delta',
      input: {
        op: 'compare',
        input: {
          op: 'join',
          on: ['round'],
          left: { op: 'aggregate', input: { op: 'filter', where: { driver_id: 'max-verstappen' } } },
          right: { op: 'aggregate', input: { op: 'filter', where: { driver_id: 'lando-norris' } } }
        }
      }
    });
  });

  it('compiles pace delta with parameters and matches the reference interpreter', async () => {
    const coreProgram = lowerF1QL(paceProgram);
    if (coreProgram.root.op !== 'delta') {
      throw new Error('Expected pace delta');
    }
    const compiled = compileF1QL(coreProgram);
    const reference = interpretLapPaceProgram(coreProgram, paceReferenceRows);
    const executed = await executeF1QL(pool, paceProgram);
    const actual = executed.rows.map((row) => ({
      driver_a_id: row.driver_a_id,
      driver_b_id: row.driver_b_id,
      methodology_version: row.methodology_version,
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

  it('compiles a pace summary from staged generic aggregates', async () => {
    const coreProgram = lowerF1QL(paceSummaryProgram);
    if (coreProgram.root.op !== 'aggregate') {
      throw new Error('Expected pace aggregate');
    }
    const compiled = compileF1QL(coreProgram);
    const reference = interpretLapPaceProgram(coreProgram, paceReferenceRows);
    const executed = await executeF1QL(pool, paceSummaryProgram);
    const actual = executed.rows.map((row) => ({
      driver_id: row.driver_id,
      methodology_version: row.methodology_version,
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
    if (coreProgram.root.op !== 'delta') {
      throw new Error('Expected pace delta');
    }

    const rows: PaceLapRow[] = [
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: 100, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: 102, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: 10, is_valid_lap: true, is_pit_lap: true, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-a', lap_time_seconds: null, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'SOFT' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 101, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 103, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 10, is_valid_lap: true, is_pit_lap: false, is_in_lap: true, is_out_lap: false, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 1, driver_id: 'driver-b', lap_time_seconds: 10, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: true, clean_air_flag: true, compound: 'HARD' },
      { season: 2026, round: 2, driver_id: 'driver-a', lap_time_seconds: 110, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: false, compound: 'SOFT' },
      { season: 2026, round: 2, driver_id: 'driver-b', lap_time_seconds: 111, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: false, compound: 'HARD' }
    ];

    expect(interpretLapPaceProgram(coreProgram, rows)).toEqual([expect.objectContaining({
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
    if (coreProgram.root.op !== 'delta') {
      throw new Error('Expected pace delta');
    }
    await pool.query(
      `INSERT INTO laps_normalized_v2
        (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, methodology_version)
       VALUES
        (2027, 1, 'test-track', 'driver-a', 'R', 1, 100, true, false, false, false, false, 'clean_air_gap_2_0s_v1'),
        (2027, 2, 'test-track', 'driver-b', 'R', 1, 101, true, false, false, false, false, 'clean_air_gap_2_0s_v1')`
    );

    const executed = await executeF1QL(pool, noOverlapProgram);
    const expected = expect.objectContaining({
      shared_events: 0,
      driver_a_avg_lap_time_seconds: null,
      driver_b_avg_lap_time_seconds: null,
      delta_seconds: null,
      delta_percent: null
    });
    expect(interpretLapPaceProgram(coreProgram, noOverlapRows)).toEqual([expected]);
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
    expect(lowerF1QL(filtered).root).toMatchObject({
      op: 'limit',
      input: {
        op: 'sort',
        input: {
          op: 'filter', where: { driver_id: 'driver-dns' },
          input: {
            op: 'filter', where: { classification_status: ['dns', 'dnf'] },
            input: { op: 'filter', where: { season: 2025, round: 9 }, input: { op: 'source', source: 'event_classification' } }
          }
        }
      }
    });
    expect(filteredCompiled.params).toEqual([2025, 9, ['dns', 'dnf'], 'driver-dns']);
    expect(filteredExecuted.rows).toEqual([expect.objectContaining({
      driver_id: 'driver-dns', classification_status: 'dns'
    })]);

    const filteredCore = lowerF1QL(filtered);
    const referenceRows: EventClassificationRow[] = [
      { season: 2025, round: 9, driver_id: 'max-verstappen', team_id: null, finishing_position: 1, points: 25, classification_status: 'classified', status_reason: null },
      { season: 2025, round: 9, driver_id: 'lando-norris', team_id: null, finishing_position: 2, points: 18, classification_status: 'classified', status_reason: null },
      { season: 2025, round: 9, driver_id: 'driver-dnf', team_id: null, finishing_position: null, points: 0, classification_status: 'dnf', status_reason: 'DNF' },
      { season: 2025, round: 9, driver_id: 'driver-dns', team_id: null, finishing_position: null, points: 0, classification_status: 'dns', status_reason: 'DNS' }
    ];
    expect(filteredExecuted.rows.map((row) => ({ ...row, points: Number(row.points) })))
      .toEqual(interpretEventClassification(filteredCore, referenceRows));
  });

  it('compiles official qualifying classification from the canonical view', async () => {
    await pool.query(`INSERT INTO qualifying_results
      (season, round, driver_id, team_id, qualifying_position, best_time_ms, best_session, eliminated_in_round, is_dnf, is_dns) VALUES
      (2025, 9, 'max_verstappen', 'red-bull', 1, 80000, 'Q3', NULL, false, false),
      (2025, 9, 'lando_norris', 'mclaren', 2, 80100, 'Q3', NULL, false, false),
      (2025, 9, 'driver_dnf', 'test-team', NULL, NULL, NULL, 'Q1', true, false),
      (2025, 9, 'driver_dns', 'test-team', NULL, NULL, NULL, NULL, false, true)`);
    const program: F1QLProgram = { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 9, limit: 4 } };
    const compiled = compileF1QL(lowerF1QL(program));
    const executed = await executeF1QL(pool, program);

    expect(lowerF1QL(program).root).toMatchObject({
      op: 'limit',
      input: { op: 'sort', by: 'qualifying_position', input: { op: 'filter', input: { op: 'source', source: 'qualifying_classification' } } }
    });
    expect(compiled.sql).toContain('f1ql.qualifying_classification');
    expect(compiled.params).toEqual([2025, 9]);
    expect(executed.rows).toEqual([
      { driver_id: 'max-verstappen', qualifying_position: 1, best_time_ms: 80000, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
      { driver_id: 'lando-norris', qualifying_position: 2, best_time_ms: 80100, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
      { driver_id: 'driver-dnf', qualifying_position: null, best_time_ms: null, best_session: null, eliminated_in_round: 'Q1', classification_status: 'dnf' },
      { driver_id: 'driver-dns', qualifying_position: null, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'dns' }
    ]);
    expect(renderF1QL(program)).toBe('Official qualifying classification; season 2025; round 9; top 4.');

    const filtered: F1QLProgram = {
      version: 1,
      root: {
        op: 'qualifying_classification', season: 2025, round: 9, limit: 10,
        filters: { classification_status: ['dns', 'dnf'], driver_id: 'driver-dns', team_id: 'test-team' }
      }
    };
    const filteredCompiled = compileF1QL(lowerF1QL(filtered));
    const filteredExecuted = await executeF1QL(pool, filtered);
    expect(filteredCompiled.params).toEqual([2025, 9, ['dns', 'dnf'], 'driver-dns', 'test-team']);
    expect(filteredExecuted.rows).toEqual([expect.objectContaining({ driver_id: 'driver-dns', classification_status: 'dns' })]);

    const referenceRows: QualifyingClassificationRow[] = [
      { season: 2025, round: 9, driver_id: 'max-verstappen', team_id: 'red-bull', qualifying_position: 1, best_time_ms: 80000, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
      { season: 2025, round: 9, driver_id: 'lando-norris', team_id: 'mclaren', qualifying_position: 2, best_time_ms: 80100, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
      { season: 2025, round: 9, driver_id: 'driver-dnf', team_id: 'test-team', qualifying_position: null, best_time_ms: null, best_session: null, eliminated_in_round: 'Q1', classification_status: 'dnf' },
      { season: 2025, round: 9, driver_id: 'driver-dns', team_id: 'test-team', qualifying_position: null, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'dns' }
    ];
    expect(filteredExecuted.rows).toEqual(interpretQualifyingClassification(lowerF1QL(filtered), referenceRows));
  });

  it('returns event metadata with an explicit race-session default', async () => {
    await pool.query(`INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation)
      VALUES ('australian_grand_prix', 'Australian Grand Prix', 'Formula 1 Australian Grand Prix', 'Australian GP', 'AUS')`);
    await pool.query(`INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date)
      VALUES (2002, 2025, 10, 'albert_park', 'australian_grand_prix', 'Formula 1 Australian Grand Prix', '2025-03-16')`);
    const program: F1QLProgram = { version: 1, root: { op: 'event_metadata', season: 2025, round: 10 } };
    const compiled = compileF1QL(lowerF1QL(program));
    const executed = await executeF1QL(pool, program);
    const referenceRows: EventMetadataRow[] = [{
      season: 2025, round: 10, event_id: 'australian-grand-prix', event_name: 'Formula 1 Australian Grand Prix', circuit_id: 'albert_park', date: '2025-03-16'
    }];

    expect(lowerF1QL(program).root).toMatchObject({
      op: 'filter', input: { op: 'filter', input: { op: 'source', source: 'event_metadata' }, where: { season: 2025, round: 10 } }, where: { session_scope: 'race' }
    });
    expect(compiled.sql).toContain('f1ql.event_metadata');
    expect(compiled.sql).not.toContain('2025');
    expect(compiled.params).toEqual([2025, 10, 'race']);
    expect(executed.rows).toEqual(interpretEventMetadata(lowerF1QL(program), referenceRows));
    expect(renderF1QL(program)).toBe('Event metadata; season 2025; round 10; race session.');

    const qualifyingProgram: F1QLProgram = { version: 1, root: { op: 'event_metadata', season: 2025, round: 10, session_scope: 'qualifying' } };
    expect((await executeF1QL(pool, qualifyingProgram)).rows).toEqual([expect.objectContaining({ session_scope: 'qualifying' })]);
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
    const qualifyingProgram: F1QLProgram = {
      version: 1,
      root: { op: 'qualifying_classification', season: 2025, round: 9, limit: 1, filters: { driver_id: 'driver-dnf' } }
    };
    await expect(executeF1QL(pool, standingsProgram)).rejects.toMatchObject({ code: 'participation_missing' } satisfies Partial<F1QLValidationError>);
    await expect(executeF1QL(pool, eventProgram)).rejects.toMatchObject({ code: 'participation_missing' } satisfies Partial<F1QLValidationError>);
    await expect(executeF1QL(pool, qualifyingProgram)).rejects.toMatchObject({ code: 'participation_missing' } satisfies Partial<F1QLValidationError>);
  });
});
