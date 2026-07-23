import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { createRoutes } from '../../src/api/routes';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { metrics } from '../../src/observability/metrics';

let pool: Pool;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

beforeAll(async () => {
  process.env.F1QL_ENABLED = 'true';
  metrics.reset();
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool);

  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(pool, pool));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await pool.end();
});

describe('in-process API routes', () => {
  it('serves the health endpoint from the initialized application', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'healthy' });
  });

  it('executes a valid deterministic query through HTTP', async () => {
    const response = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'driver_season_summary',
        driver_id: 'lando_norris',
        season: 2025,
        metric: 'avg_true_pace',
        normalization: 'none',
        clean_air_only: false,
        compound_context: 'mixed',
        session_scope: 'race',
        raw_query: 'Lando Norris 2025 season'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.payload.type).toBe('driver_season_summary');
    expect(body.result.payload.driver_id).toBe('lando_norris');
  });

  it('returns a structured error for an unknown driver', async () => {
    const response = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'driver_season_summary',
        driver_id: 'not-a-driver',
        season: 2025,
        metric: 'avg_true_pace',
        normalization: 'none',
        clean_air_only: false,
        compound_context: 'mixed',
        session_scope: 'race',
        raw_query: 'Not a driver 2025 season'
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'intent_resolution_failed'
    });
  });

  it('executes a validated F1QL standings program through HTTP', async () => {
    await pool.query(
      `INSERT INTO season_driver_standing
        (year, position_display_order, position_number, position_text, driver_id, points, championship_won)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [2025, 1, 1, '1', 'lando-norris', 423, true]
    );

    const response = await fetch(`${baseUrl}/program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        root: {
          op: 'aggregate',
          input: {
            op: 'filter',
            input: { op: 'source', source: 'standings' },
            where: { season: 2025 }
          },
          group_by: ['driver_id'],
          measures: [{ as: 'total_points', function: 'sum', field: 'points' }]
        }
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toEqual([{ driver_id: 'lando-norris', total_points: '423' }]);
    expect(body.rendering).toContain('official driver standings');
  });

  it('lists and executes curated verified F1QL programs through the same validation pipeline', async () => {
    const listed = await fetch(`${baseUrl}/program/verified`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ programs: [{ id: '2025-driver-standings' }] });

    const executed = await fetch(`${baseUrl}/program/verified/2025-driver-standings`, { method: 'POST' });
    expect(executed.status).toBe(200);
    await expect(executed.json()).resolves.toMatchObject({
      program: { version: 1, root: { op: 'aggregate' } },
      rows: expect.any(Array)
    });
  });

  it('executes a validated F1QL pace comparison through HTTP', async () => {
    await pool.query(
      `INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
        (2030, 'red-bull', 'red-bull', 'max-verstappen', false),
        (2030, 'mclaren', 'mclaren', 'lando-norris', false)`
    );
    await pool.query(
      `INSERT INTO laps_normalized_v2
        (season, round, track_id, driver_id, session_type, lap_number, lap_time_seconds, is_valid_lap, is_pit_lap, is_in_lap, is_out_lap, clean_air_flag, compound, methodology_version)
       VALUES
        (2030, 1, 'test-track', 'max-verstappen', 'R', 1, 100, true, false, false, false, true, 'MEDIUM', 'clean_air_gap_2_0s_v1'),
        (2030, 1, 'test-track', 'max-verstappen', 'R', 2, 102, true, false, false, false, true, 'MEDIUM', 'clean_air_gap_2_0s_v1'),
        (2030, 1, 'test-track', 'max-verstappen', 'R', 3, 104, true, false, false, false, true, 'MEDIUM', 'clean_air_gap_2_0s_v1'),
        (2030, 1, 'test-track', 'lando-norris', 'R', 1, 101, true, false, false, false, true, 'MEDIUM', 'clean_air_gap_2_0s_v1'),
        (2030, 1, 'test-track', 'lando-norris', 'R', 2, 103, true, false, false, false, true, 'MEDIUM', 'clean_air_gap_2_0s_v1'),
        (2030, 1, 'test-track', 'lando-norris', 'R', 3, 105, true, false, false, false, true, 'MEDIUM', 'clean_air_gap_2_0s_v1')`
    );

    const response = await fetch(`${baseUrl}/program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        root: {
          op: 'pace_delta',
          driver_a_id: 'max-verstappen',
          driver_b_id: 'lando-norris',
          scope: { season: 2030 },
          filters: { clean_air_only: true, compound: 'MEDIUM' }
        }
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toEqual([expect.objectContaining({
      driver_a_id: 'max-verstappen',
      driver_b_id: 'lando-norris',
      shared_events: 1,
      delta_seconds: -1,
      delta_percent: -0.9708737864077669,
      methodology_version: 'clean_air_gap_2_0s_v1'
    })]);
    expect(body.core_program.root.op).toBe('delta');
  });

  it('rejects malformed programs and requests over the F1QL cost budget', async () => {
    const malformed = await fetch(`${baseUrl}/program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, root: { op: 'unsupported', sql: 'SELECT 1' } })
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: 'validation_failed' });

    const overBudget = await fetch(`${baseUrl}/program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        root: {
          op: 'pace_summary',
          driver_id: 'max-verstappen',
          scope: { season: 2025, rounds: Array.from({ length: 25 }, (_, index) => index + 1) }
        }
      })
    });
    expect(overBudget.status).toBe(400);
    await expect(overBudget.json()).resolves.toMatchObject({ error: 'cost_limit_exceeded' });

    const nonParticipant = await fetch(`${baseUrl}/program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2099 } } })
    });
    expect(nonParticipant.status).toBe(400);
    await expect(nonParticipant.json()).resolves.toMatchObject({ error: 'participation_missing' });
  });

  it('records F1QL operation metrics without query values', () => {
    const snapshot = metrics.toJSON();
    expect(snapshot.f1ql).toMatchObject({
      requests: expect.objectContaining({ aggregate: 2, pace_delta: 1, invalid: 1, pace_summary: 2 }),
      failures: expect.objectContaining({ 'invalid:rejected': 1, 'pace_summary:rejected': 2 })
    });
    expect(metrics.toPrometheus()).toContain('f1muse_f1ql_requests_total{operation="pace_delta"} 1');
  });
});
