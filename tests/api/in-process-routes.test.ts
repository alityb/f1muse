import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { createRoutes } from '../../src/api/routes';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

beforeAll(async () => {
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
});
