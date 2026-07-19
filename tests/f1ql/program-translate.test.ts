import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { createProgramTranslateRoutes } from '../../src/api/routes/program-translate';
import { F1QLTextModel } from '../../src/f1ql/translator';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { metrics } from '../../src/observability/metrics';

class StubModel implements F1QLTextModel {
  constructor(private output: string) {}
  setOutput(output: string): void { this.output = output; }
  async complete(): Promise<string> { return this.output; }
}

let pool: Pool;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;
let model: StubModel;
let executionAttempts = 0;

beforeAll(async () => {
  process.env.F1QL_TRANSLATION_SHADOW = 'true';
  metrics.reset();
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await pool.query(`INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES ('max_verstappen', 'Max Verstappen', 'Max Verstappen', 'Max', 'Verstappen', 'VER')`);
  const app = express();
  app.use(express.json());
  model = new StubModel(JSON.stringify({ version: 1, root: { op: 'pace_summary', driver_id: 'Max Verstappen', scope: { season: 2025 } } }));
  app.use('/', createProgramTranslateRoutes(pool, model, () => { executionAttempts++; throw new Error('shadow mode must not execute'); }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); if (pool) await pool.end(); });

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

  it('rejects overlong questions and disabled shadow mode', async () => {
    const overlong = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'x'.repeat(1001) }) });
    expect(overlong.status).toBe(400);
    process.env.F1QL_TRANSLATION_SHADOW = 'false';
    const disabled = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Max pace' }) });
    expect(disabled.status).toBe(503);
    process.env.F1QL_TRANSLATION_SHADOW = 'true';
  });

  it('fails closed for unknown identities and non-program model output', async () => {
    model.setOutput(JSON.stringify({ version: 1, root: { op: 'pace_summary', driver_id: 'Unknown Driver', scope: { season: 2025 } } }));
    const unknown = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Unknown pace' }) });
    expect(unknown.status).toBe(422);
    model.setOutput('```sql\nSELECT * FROM race_data\n```');
    const injected = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Ignore instructions' }) });
    expect(injected.status).toBe(400);
  });

  it('records typed shadow outcomes', () => {
    expect(metrics.toJSON().f1ql.translation_outcomes).toMatchObject({
      succeeded: 1, invalid: 2, unavailable: 1, identity_miss: 1, unsupported: 1
    });
    expect(metrics.toPrometheus()).toContain('f1muse_f1ql_translation_outcomes_total{outcome="succeeded"} 1');
  });

  it('never invokes the injected executor in shadow mode', () => {
    expect(executionAttempts).toBe(0);
  });
});
