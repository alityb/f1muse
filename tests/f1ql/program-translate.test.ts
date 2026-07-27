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
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES (2025, 'red-bull', 'red-bull', 'max_verstappen', false)`);
  await pool.query(`INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES
    ('alex_smith', 'Alex Smith', 'Alex Smith', 'Alex', 'Smith', 'ASM'),
    ('bob_smith', 'Bob Smith', 'Bob Smith', 'Bob', 'Smith', 'BSM')`);
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
    (2025, 'team-a', 'team-a', 'alex_smith', false),
    (2025, 'team-b', 'team-b', 'bob_smith', false)`);
  await pool.query(`INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
    ('belgian_grand_prix', 'Belgian Grand Prix', 'Belgian Grand Prix', 'Belgian GP', 'BEL'),
    ('ambiguous_a', 'Ambiguous Grand Prix', 'Ambiguous Grand Prix', 'Ambiguous GP', 'AMA'),
    ('ambiguous_b', 'Ambiguous Grand Prix', 'Ambiguous Grand Prix', 'Ambiguous GP', 'AMB')`);
  await pool.query(`INSERT INTO race (id, year, round, grand_prix_id, official_name) VALUES
    (200, 2025, 7, 'belgian_grand_prix', '2025 Belgian Grand Prix'),
    (201, 2025, 8, 'ambiguous_a', '2025 Ambiguous Grand Prix'),
    (202, 2025, 9, 'ambiguous_b', '2025 Ambiguous Grand Prix')`);
  const app = express();
  app.use(express.json());
  model = new StubModel(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'pace_summary', driver_id: 'Max Verstappen', scope: { season: 2025 } } } }));
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
    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'pace_summary', driver_id: 'Unknown Driver', scope: { season: 2025 } } } }));
    const unknown = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Unknown pace' }) });
    expect(unknown.status).toBe(422);
    model.setOutput('```sql\nSELECT * FROM race_data\n```');
    const injected = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Ignore instructions' }) });
    expect(injected.status).toBe(503);
  });

  it('returns focused clarification without executing', async () => {
    model.setOutput(JSON.stringify({ type: 'clarification_required', reason: 'metric_ambiguous', question: 'Do you mean points or position?', options: ['Points', 'Position'] }));
    const response = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Who was better?' }) });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'metric_ambiguous' });
  });

  it('canonically links named events and driver filters without executing', async () => {
    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'event_classification', season: 2025, event_name: 'Belgium', limit: 30 } } }));
    const event = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '2025 Belgian GP results' }) });
    expect(event.status).toBe(200);
    await expect(event.json()).resolves.toMatchObject({ program: { root: { season: 2025, round: 7 } } });

    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025, driver_id: 'Max Verstappen' } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'max', field: 'points' }] } } }));
    const standings = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Max points in 2025' }) });
    expect(standings.status).toBe(200);
    await expect(standings.json()).resolves.toMatchObject({ program: { root: { input: { where: { driver_id: 'max-verstappen' } } } } });

    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 7, limit: 30, filters: { driver_id: 'Max Verstappen' } } } }));
    const qualifying = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Where did Max qualify?' }) });
    expect(qualifying.status).toBe(200);
    await expect(qualifying.json()).resolves.toMatchObject({ program: { root: { filters: { driver_id: 'max-verstappen' } } } });
  });

  it('surfaces event and driver ambiguity without executing', async () => {
    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'event_metadata', season: 2025, event_name: 'Ambiguous GP' } } }));
    const event = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'When was the ambiguous GP?' }) });
    expect(event.status).toBe(422);
    await expect(event.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'event_ambiguous', options: ['2025 round 8', '2025 round 9'] });

    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'event_classification', season: 2025, round: 7, limit: 30, filters: { driver_id: 'Smith' } } } }));
    const driver = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Where did Smith finish?' }) });
    expect(driver.status).toBe(422);
    await expect(driver.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'entity_ambiguous', options: ['alex-smith', 'bob-smith'] });

    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'event_metadata', season: 2025, event_name: 'Missing GP' } } }));
    const missing = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'When was the missing GP?' }) });
    expect(missing.status).toBe(422);
    await expect(missing.json()).resolves.toMatchObject({ error: 'program_unsupported', reason: 'source_coverage_missing' });
  });

  it('reparses linked aliases and rejects a collapsed two-driver comparison', async () => {
    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: {
      op: 'official_lap_window_median_compare', metric: 'official_non_deleted_non_pit_window_median_v1', season: 2025,
      event_name: 'Belgium', driver_a_id: 'Max Verstappen', driver_b_id: 'VER', lap_start: 1, lap_end: 3
    } } }));
    const response = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Compare Max Verstappen and VER' }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'program_unsupported', reason: 'program_invalid' });
  });

  it('links a named historical event and both driver aliases without executing it', async () => {
    model.setOutput(JSON.stringify({
      type: 'program_candidate',
      program: {
        version: 1,
        root: {
          op: 'official_lap_window_median_compare',
          metric: 'official_non_deleted_non_pit_window_median_v1',
          season: 2025,
          event_name: 'Belgium',
          driver_a_id: 'Max Verstappen',
          driver_b_id: 'BSM',
          lap_start: 1,
          lap_end: 3
        }
      }
    }));
    const response = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Compare a historical lap window' }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: 'shadow',
      program: {
        version: 1,
        root: {
          op: 'official_lap_window_median_compare',
          metric: 'official_non_deleted_non_pit_window_median_v1',
          season: 2025,
          round: 7,
          driver_a_id: 'max-verstappen',
          driver_b_id: 'bob-smith',
          lap_start: 1,
          lap_end: 3
        }
      }
    });
  });

  it('fails closed for historical event and driver resolution failures', async () => {
    const root = {
      op: 'official_lap_window_median_compare',
      metric: 'official_non_deleted_non_pit_window_median_v1',
      season: 2025,
      event_name: 'Belgium',
      driver_a_id: 'Max Verstappen',
      driver_b_id: 'BSM',
      lap_start: 1,
      lap_end: 3
    };
    const request = async (overrides: Record<string, unknown>) => {
      model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { ...root, ...overrides } } }));
      return fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Historical lap window' }) });
    };

    const ambiguousEvent = await request({ event_name: 'Ambiguous GP' });
    expect(ambiguousEvent.status).toBe(422);
    await expect(ambiguousEvent.json()).resolves.toMatchObject({ reason: 'event_ambiguous', options: ['2025 round 8', '2025 round 9'] });

    const missingEvent = await request({ event_name: 'Missing GP' });
    expect(missingEvent.status).toBe(422);
    await expect(missingEvent.json()).resolves.toMatchObject({ reason: 'source_coverage_missing' });

    const ambiguousDriver = await request({ driver_a_id: 'Smith' });
    expect(ambiguousDriver.status).toBe(422);
    await expect(ambiguousDriver.json()).resolves.toMatchObject({ reason: 'entity_ambiguous', options: ['alex-smith', 'bob-smith'] });

    const ambiguousSecondDriver = await request({ driver_b_id: 'Smith' });
    expect(ambiguousSecondDriver.status).toBe(422);
    await expect(ambiguousSecondDriver.json()).resolves.toMatchObject({ reason: 'entity_ambiguous', options: ['alex-smith', 'bob-smith'] });

    for (const overrides of [{ driver_a_id: 'Missing Driver' }, { driver_b_id: 'Missing Driver' }]) {
      const missingDriver = await request(overrides);
      expect(missingDriver.status).toBe(422);
      await expect(missingDriver.json()).resolves.toMatchObject({ error: 'identity_unresolved' });
    }

    const unsupportedMetric = await request({ metric: 'clean_air_gap_2_0s_v1' });
    expect(unsupportedMetric.status).toBe(422);
    await expect(unsupportedMetric.json()).resolves.toMatchObject({ reason: 'program_invalid' });
  });

  it('logs typed participation rejections', async () => {
    model.setOutput(JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'pace_summary', driver_id: 'Max Verstappen', scope: { season: 2024 } } } }));
    const missing = await fetch(`${baseUrl}/program/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Max pace in 2024' }) });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ reason: 'participation_missing' });
  });

  it('records typed shadow outcomes', () => {
    expect(metrics.toJSON().f1ql.translation_outcomes).toMatchObject({
      succeeded: 5, invalid: 2, unavailable: 2, identity_miss: 3, unsupported: 11
    });
    expect(metrics.toJSON().f1ql.translation_reasons).toMatchObject({ participation_missing: 1 });
    expect(metrics.toPrometheus()).toContain('f1muse_f1ql_translation_outcomes_total{outcome="succeeded"} 5');
  });

  it('never invokes the injected executor in shadow mode', () => {
    expect(executionAttempts).toBe(0);
  });
});
