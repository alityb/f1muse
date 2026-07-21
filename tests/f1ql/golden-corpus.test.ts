import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeF1QL } from '../../src/f1ql/executor';
import { lowerF1QL } from '../../src/f1ql/lower';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

interface CorpusCase {
  question: string;
  program: unknown;
  expected: {
    rows?: Array<Record<string, unknown>>;
    rejection?: { stage: 'schema' | 'execution'; code?: string; message?: string };
  };
}

const corpus = JSON.parse(readFileSync('tests/fixtures/f1ql-golden-corpus.json', 'utf8')) as CorpusCase[];
const golden = JSON.parse(readFileSync('tests/fixtures/f1ql-golden-corpus-programs.json', 'utf8')) as Array<{ question: string; core_program: unknown }>;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'red-bull', 'red-bull', 'max-verstappen'),
    (2025, 'mclaren', 'mclaren', 'lando-norris')`);
  await pool.query(`INSERT INTO season_driver_standing (year, position_display_order, position_number, position_text, driver_id, points) VALUES
    (2025, 1, 1, '1', 'max_verstappen', 25),
    (2025, 2, 2, '2', 'lando_norris', 18)`);
  await pool.query(`INSERT INTO laps_normalized
    (season, round, track_id, driver_id, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound) VALUES
    (2025, 1, 'albert-park', 'max_verstappen', 1, 100, true, false, false, false, true, 'MEDIUM'),
    (2025, 1, 'albert-park', 'max_verstappen', 2, 102, true, false, false, false, true, 'MEDIUM'),
    (2025, 1, 'albert-park', 'max_verstappen', 3, 104, true, false, false, false, true, 'MEDIUM'),
    (2025, 1, 'albert-park', 'lando_norris', 1, 101, true, false, false, false, true, 'MEDIUM'),
    (2025, 1, 'albert-park', 'lando_norris', 2, 103, true, false, false, false, true, 'MEDIUM'),
    (2025, 1, 'albert-park', 'lando_norris', 3, 105, true, false, false, false, true, 'MEDIUM'),
    (2025, 2, 'albert-park', 'max_verstappen', 1, 110, true, false, false, false, true, 'MEDIUM'),
    (2025, 2, 'albert-park', 'max_verstappen', 2, 112, true, false, false, false, true, 'MEDIUM'),
    (2025, 2, 'albert-park', 'lando_norris', 1, 111, true, false, false, false, true, 'MEDIUM'),
    (2025, 2, 'albert-park', 'lando_norris', 2, 113, true, false, false, false, true, 'MEDIUM')`);
  await pool.query(`INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
    ('australian_grand_prix', 'Australian Grand Prix', 'Formula 1 Australian Grand Prix', 'Australian GP', 'AUS')`);
  await pool.query(`INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date) VALUES
    (1, 2025, 1, 'albert-park', 'australian_grand_prix', 'Formula 1 Australian Grand Prix', '2025-03-16')`);
  await pool.query(`INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number, race_points, race_reason_retired) VALUES
    (1, 'RACE_RESULT', 'max_verstappen', 'red-bull', 1, 25, NULL),
    (1, 'RACE_RESULT', 'lando_norris', 'mclaren', NULL, 0, 'Engine')`);
  await pool.query(`INSERT INTO qualifying_results
    (season, round, driver_id, team_id, qualifying_position, best_time_ms, best_session, is_dnf, is_dns) VALUES
    (2025, 1, 'max_verstappen', 'red-bull', 1, 80000, 'Q3', false, false),
    (2025, 1, 'lando_norris', 'mclaren', NULL, NULL, NULL, false, true)`);
});

afterAll(async () => {
  await pool.end();
});

describe('F1QL golden corpus', () => {
  it('matches real-emitter core program snapshots for every schema-valid case', () => {
    const emitted = corpus.flatMap(({ question, program }) => {
      try {
        return [{ question, core_program: lowerF1QL(parseF1QLProgram(program)) }];
      } catch {
        return [];
      }
    });
    expect(emitted).toEqual(golden);
  });

  for (const testCase of corpus) {
    it(testCase.question, async () => {
      const rejection = testCase.expected.rejection;
      if (rejection?.stage === 'schema') {
        expect(() => parseF1QLProgram(testCase.program)).toThrow(rejection.message);
        return;
      }
      if (rejection) {
        await expect(executeF1QL(pool, testCase.program)).rejects.toMatchObject({
          ...(rejection.code ? { code: rejection.code } : {}),
          ...(rejection.message ? { message: expect.stringContaining(rejection.message) } : {})
        });
        return;
      }
      await expect(executeF1QL(pool, testCase.program)).resolves.toMatchObject({ rows: testCase.expected.rows });
    });
  }
});
