import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { compileF1QL } from '../../src/f1ql/compiler';
import { CoreAggregateNode, CorePipelineNode, CoreProgram } from '../../src/f1ql/core';
import { executeF1QLReadOnly } from '../../src/f1ql/executor';
import { EventClassificationRow, interpretEventClassification, interpretLapPaceProgram, interpretQualifyingClassification, interpretStandingsProgram, PaceLapRow, QualifyingClassificationRow, StandingsRow } from '../../src/f1ql/interpreter';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { validateCoreProgram } from '../../src/f1ql/validation';

const eventRows: EventClassificationRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', team_id: 'red-bull', finishing_position: 1, points: 25, classification_status: 'classified', status_reason: null },
  { season: 2025, round: 1, driver_id: 'lando-norris', team_id: 'mclaren', finishing_position: 2, points: 18, classification_status: 'classified', status_reason: null },
  { season: 2025, round: 1, driver_id: 'driver-dnf', team_id: 'test-team', finishing_position: null, points: 0, classification_status: 'dnf', status_reason: 'Engine' }
];

const qualifyingRows: QualifyingClassificationRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', team_id: 'red-bull', qualifying_position: 1, best_time_ms: 80000, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
  { season: 2025, round: 1, driver_id: 'lando-norris', team_id: 'mclaren', qualifying_position: 2, best_time_ms: 80100, best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified' },
  { season: 2025, round: 1, driver_id: 'driver-dns', team_id: 'test-team', qualifying_position: null, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'dns' }
];

const standingsRows: StandingsRow[] = [
  { season: 2025, driver_id: 'max-verstappen', championship_position: 1, points: 25, championship_won: false },
  { season: 2025, driver_id: 'lando-norris', championship_position: 2, points: 18, championship_won: false }
];

const paceRows: PaceLapRow[] = [
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 100, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'max-verstappen', lap_time_seconds: 102, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 101, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' },
  { season: 2025, round: 1, driver_id: 'lando-norris', lap_time_seconds: 103, is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_flag: true, compound: 'MEDIUM' }
];

let pool: Pool;

function classificationProgram(source: 'event_classification' | 'qualifying_classification', input: CorePipelineNode): CoreProgram {
  return { version: 1, root: { op: 'limit', input, limit: 10 } };
}

function classified(input: CorePipelineNode, source: 'event_classification' | 'qualifying_classification'): CorePipelineNode {
  return { op: 'filter', input, where: { season: 2025, round: 1, classification_status: ['classified'] } } as CorePipelineNode;
}

async function executeCore(program: CoreProgram): Promise<Array<Record<string, unknown>>> {
  validateCoreProgram(program);
  const compiled = compileF1QL(program);
  return (await executeF1QLReadOnly(pool, compiled.sql, compiled.params)).rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO season_driver_standing (year, position_display_order, position_number, position_text, driver_id, points, championship_won) VALUES
    (2025, 1, 1, '1', 'max_verstappen', 25, false),
    (2025, 2, 2, '2', 'lando_norris', 18, false)`);
  await pool.query(`INSERT INTO race (id, year, round) VALUES (1, 2025, 1)`);
  await pool.query(`INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number, race_points, race_reason_retired) VALUES
    (1, 'RACE_RESULT', 'max_verstappen', 'red-bull', 1, 25, NULL),
    (1, 'RACE_RESULT', 'lando_norris', 'mclaren', 2, 18, NULL),
    (1, 'RACE_RESULT', 'driver_dnf', 'test-team', NULL, 0, 'Engine')`);
  await pool.query(`INSERT INTO qualifying_results (season, round, driver_id, team_id, qualifying_position, best_time_ms, best_session, is_dnf, is_dns) VALUES
    (2025, 1, 'max_verstappen', 'red-bull', 1, 80000, 'Q3', false, false),
    (2025, 1, 'lando_norris', 'mclaren', 2, 80100, 'Q3', false, false),
    (2025, 1, 'driver_dns', 'test-team', NULL, NULL, NULL, false, true)`);
  for (const [index, row] of paceRows.entries()) {
    await pool.query(`INSERT INTO laps_normalized_v2 (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, methodology_version)
      VALUES ($1, $2, 'test-track', $3, 'R', $4, $5, $6, $7, $8, $9, $10, $11, 'clean_air_gap_2_0s_v1')`,
    [row.season, row.round, row.driver_id, index + 1, row.lap_time_seconds, row.is_valid_lap, row.is_pit_lap, row.is_in_lap, row.is_out_lap, row.clean_air_flag, row.compound]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('generic core metamorphic laws', () => {
  for (const [source, position] of [['event_classification', 'finishing_position'], ['qualifying_classification', 'qualifying_position']] as const) {
    it(`${source} sort inversion reverses unique, non-null ordered rows`, async () => {
      const input = classified({ op: 'source', source }, source);
      const ascending = classificationProgram(source, { op: 'sort', input, by: position, direction: 'asc', nulls: 'last' });
      const descending = classificationProgram(source, { op: 'sort', input, by: position, direction: 'desc', nulls: 'last' });
      expect(await executeCore(descending)).toEqual((await executeCore(ascending)).reverse());
    });

    it(`${source} limit is an ordered prefix`, async () => {
      const input = { op: 'sort', input: { op: 'filter', input: { op: 'source', source }, where: { season: 2025, round: 1 } }, by: position, direction: 'asc', nulls: 'last' } as CorePipelineNode;
      const short = { version: 1, root: { op: 'limit', input, limit: 2 } } as CoreProgram;
      const long = { version: 1, root: { op: 'limit', input, limit: 3 } } as CoreProgram;
      expect(await executeCore(short)).toEqual((await executeCore(long)).slice(0, 2));
    });

    it(`${source} accepts an empty filter as a no-op`, async () => {
      const base = { op: 'sort', input: { op: 'filter', input: { op: 'source', source }, where: { season: 2025, round: 1 } }, by: position, direction: 'asc', nulls: 'last' } as CorePipelineNode;
      const withVacuousFilter = { op: 'sort', input: { op: 'filter', input: base.input, where: {} }, by: position, direction: 'asc', nulls: 'last' } as CorePipelineNode;
      expect(await executeCore(classificationProgram(source, withVacuousFilter))).toEqual(await executeCore(classificationProgram(source, base)));
    });

    it(`${source} filter reordering preserves results`, async () => {
      const first = { op: 'filter', input: { op: 'filter', input: { op: 'source', source }, where: { season: 2025, round: 1 } }, where: { classification_status: ['classified'] } } as CorePipelineNode;
      const second = { op: 'filter', input: { op: 'filter', input: { op: 'source', source }, where: { classification_status: ['classified'] } }, where: { season: 2025, round: 1 } } as CorePipelineNode;
      const firstProgram = classificationProgram(source, { op: 'sort', input: first, by: position, direction: 'asc', nulls: 'last' });
      const secondProgram = classificationProgram(source, { op: 'sort', input: second, by: position, direction: 'asc', nulls: 'last' });
      expect(await executeCore(firstProgram)).toEqual(await executeCore(secondProgram));
    });
  }
});

describe('SQL compiler and reference interpreter differential fixtures', () => {
  it('matches standings aggregate, sort, and limit', async () => {
    const aggregate: CoreAggregateNode = { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum', field: 'points' }] };
    const program: CoreProgram = { version: 1, root: { op: 'limit', input: { op: 'sort', input: aggregate, by: 'points', direction: 'desc' }, limit: 2 } };
    expect((await executeCore(program)).map((row) => ({ ...row, points: Number(row.points) }))).toEqual(interpretStandingsProgram(program, standingsRows));
  });

  it('matches event and qualifying classification, including null ordering', async () => {
    const eventProgram = classificationProgram('event_classification', { op: 'sort', input: { op: 'filter', input: { op: 'source', source: 'event_classification' }, where: { season: 2025, round: 1 } }, by: 'finishing_position', direction: 'desc', nulls: 'last' });
    const qualifyingProgram = classificationProgram('qualifying_classification', { op: 'sort', input: { op: 'filter', input: { op: 'source', source: 'qualifying_classification' }, where: { season: 2025, round: 1 } }, by: 'qualifying_position', direction: 'desc', nulls: 'last' });
    expect((await executeCore(eventProgram)).map((row) => ({ ...row, points: Number(row.points) }))).toEqual(interpretEventClassification(eventProgram, eventRows));
    expect(await executeCore(qualifyingProgram)).toEqual(interpretQualifyingClassification(qualifyingProgram, qualifyingRows));
  });

  it('matches lap pace median aggregation', async () => {
    const program: CoreProgram = { version: 1, root: { op: 'aggregate', input: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'lap_pace' }, where: { season: 2025, driver_id: 'max-verstappen', lap_time_seconds: 'not_null', is_valid_lap: true, is_pit_lap: false, is_in_lap: false, is_out_lap: false, clean_air_only: true, compound: 'MEDIUM' } }, group_by: ['round'], measures: [{ as: 'median_lap_time_seconds', function: 'median', field: 'lap_time_seconds' }] }, group_by: [], measures: [{ as: 'events', function: 'count' }, { as: 'avg_lap_time_seconds', function: 'avg', field: 'median_lap_time_seconds' }] } };
    expect((await executeCore(program)).map((row) => ({ ...row, events: Number(row.events), avg_lap_time_seconds: Number(row.avg_lap_time_seconds) }))).toEqual(interpretLapPaceProgram(program, paceRows));
  });
});
