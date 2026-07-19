import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../../src/execution/query-executor';
import { runMatchupSync } from '../../src/etl/matchup-matrix';
import { QueryIntent } from '../../src/types/query-intent';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool);

  for (let round = 1; round <= 4; round++) {
    const raceId = 2600 + round;
    await pool.query('INSERT INTO race (id, year, round) VALUES ($1, $2, $3)', [raceId, 2026, round]);
    await pool.query(
      `INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
       VALUES
        ($1, $2, $3, $4, $5, $6),
        ($1, $2, $7, $4, $8, $6)`,
      [2026, round, 'max_verstappen', 'red-bull', 1, 'RACE_QUALIFYING', 'sergio_perez', 2]
    );
    await pool.query(
      `INSERT INTO race_data (race_id, type, driver_id, position_number)
       VALUES ($1, 'RACE_RESULT', $2, 1), ($1, 'RACE_RESULT', $3, 2)`,
      [raceId, 'max_verstappen', 'sergio_perez']
    );
  }

  await runMatchupSync(pool, 2026);
});

afterAll(async () => {
  await pool.end();
});

describe('matchup ETL writer-to-reader contract', () => {
  it('writes qualifying matchups that the public lookup template returns', async () => {
    const executor = new QueryExecutor(pool);
    const intent: QueryIntent = {
      kind: 'driver_matchup_lookup',
      season: 2026,
      driver_a_id: 'max_verstappen',
      driver_b_id: 'sergio_perez',
      h2h_metric: 'qualifying_position'
    } as QueryIntent;

    const response = await executor.execute(intent);

    expect('error' in response).toBe(false);
    if (!('error' in response)) {
      expect(response.result.type).toBe('driver_matchup_lookup');
      expect(response.result.payload.shared_events).toBe(4);
      expect(response.result.payload.primary_wins).toBe(4);
      expect(response.result.payload.secondary_wins).toBe(0);
      expect(response.result.payload.coverage_status).toBe('low_coverage');
    }
  });

  it('honors the requested season instead of the module default', async () => {
    await pool.query(`
      INSERT INTO race (id, year, round) VALUES (2701, 2027, 1);
      INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
      VALUES
        (2027, 1, 'max_verstappen', 'red-bull', 1, 'RACE_QUALIFYING'),
        (2027, 1, 'sergio_perez', 'red-bull', 2, 'RACE_QUALIFYING');
    `);

    await runMatchupSync(pool, 2027);

    const result = await pool.query(
      `SELECT shared_events
       FROM driver_matchup_matrix_2025
       WHERE season = $1
         AND driver_a_id = $2
         AND driver_b_id = $3
         AND metric = $4`,
      [2027, 'max_verstappen', 'sergio_perez', 'qualifying_position']
    );

    expect(result.rows[0]?.shared_events).toBe(1);
  });
});
