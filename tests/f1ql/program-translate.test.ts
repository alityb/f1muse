import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { createProgramTranslateRoutes } from '../../src/api/routes/program-translate';
import { F1QLTextModel } from '../../src/f1ql/translator';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

class StubModel implements F1QLTextModel {
  constructor(private readonly output: string) {}
  async complete(): Promise<string> { return this.output; }
}

let pool: Pool;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

beforeAll(async () => {
  process.env.F1QL_TRANSLATION_SHADOW = 'true';
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES ('max_verstappen', 'Max Verstappen', 'Max Verstappen', 'Max', 'Verstappen', 'VER')`);
  const app = express();
  app.use(express.json());
  app.use('/', createProgramTranslateRoutes(pool, new StubModel(JSON.stringify({ version: 1, root: { op: 'pace_summary', driver_id: 'Max Verstappen', scope: { season: 2025 } } }))));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); await pool.end(); });

describe('shadow F1QL translation', () => {
  it('returns a resolved program without executing it', async () => {
    const response = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Max pace in 2025' }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: 'shadow', program: { root: { driver_id: 'max-verstappen' } } });
  });
  it('rejects invalid questions', async () => {
    const response = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '' }) });
    expect(response.status).toBe(400);
  });
});
