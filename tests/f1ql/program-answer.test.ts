import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createProgramAnswerRoutes } from '../../src/api/routes/program-answer';
import { AnswerRuntimeConfig } from '../../src/f1ql/answer-runtime';
import { F1QLProgram } from '../../src/f1ql/ast';
import { F1QLLinkingError } from '../../src/f1ql/translation-linking';
import { F1QLProgramCandidate } from '../../src/f1ql/translation-schema';
import { F1QLTextModel } from '../../src/f1ql/translator';
import { metrics } from '../../src/observability/metrics';

class StubModel implements F1QLTextModel {
  output = '';
  waitForAbort = false;
  async complete(_systemPrompt: string, _question: string, signal?: AbortSignal): Promise<string> {
    if (!this.waitForAbort) return this.output;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }
}

const runtimeConfig: AnswerRuntimeConfig = {
  maxConcurrency: 2,
  queueTimeoutMs: 50,
  requestTimeoutMs: 100,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  statementTimeoutMs: 3_000,
  maxWorkUnits: 200,
  maxRows: 100,
  maxResponseBytes: 65_536
};

const standingsProgram: F1QLProgram = {
  version: 1,
  root: {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } },
    group_by: ['driver_id'],
    measures: [{ as: 'points', function: 'max', field: 'points' }]
  }
};

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;
let model: StubModel;
let modelCreations: number;
let linkAttempts: number;
let linkFailure: Error | undefined;

beforeAll(async () => {
  model = new StubModel();
  const app = express();
  app.use(express.json());
  app.use('/', createProgramAnswerRoutes({} as Pool, {
    modelFactory: () => { modelCreations++; return model; },
    link: async (candidate: F1QLProgramCandidate) => {
      linkAttempts++;
      if (linkFailure) throw linkFailure;
      return candidate as F1QLProgram;
    },
    runtimeConfig
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  process.env.F1QL_ANSWER_ENABLED = 'true';
  delete process.env.F1QL_ANSWER_KILL_SWITCH;
  modelCreations = 0;
  linkAttempts = 0;
  linkFailure = undefined;
  model.waitForAbort = false;
  runtimeConfig.maxWorkUnits = 200;
  metrics.reset();
});

afterAll(async () => {
  delete process.env.F1QL_ANSWER_ENABLED;
  delete process.env.F1QL_ANSWER_KILL_SWITCH;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(): Promise<Response> {
  return fetch(`${baseUrl}/program/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Who led the 2025 standings?' })
  });
}

describe('gated answer route skeleton', () => {
  it('has no executor import or F1QL execution call', () => {
    const source = readFileSync('src/api/routes/program-answer.ts', 'utf8');
    expect(source).not.toContain('executeF1QL');
    expect(source).not.toMatch(/from ['"].*executor/);
  });

  it('checks the disabled gate before constructing a model', async () => {
    process.env.F1QL_ANSWER_ENABLED = 'false';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'answer_disabled' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 0, linkAttempts: 0 });
  });

  it('checks the emergency kill switch before constructing a model', async () => {
    process.env.F1QL_ANSWER_KILL_SWITCH = 'true';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'kill_switch_active' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 0, linkAttempts: 0 });
  });

  it('rejects invalid input before constructing a model', async () => {
    const response = await fetch(`${baseUrl}/program/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '' }) });
    expect(response.status).toBe(400);
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 0, linkAttempts: 0 });
  });

  it('returns model clarification without linking or executing', async () => {
    model.output = JSON.stringify({ type: 'clarification_required', reason: 'metric_ambiguous', question: 'Points or position?', options: ['Points', 'Position'] });
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'metric_ambiguous' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 0 });
  });

  it('returns model abstention without linking or executing', async () => {
    model.output = JSON.stringify({ type: 'unsupported', reason: 'grid_source_unsupported' });
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'capability_unsupported', reason: 'grid_source_unsupported' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 0 });
  });

  it('returns provider failure without linking', async () => {
    model.output = 'not json';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'invalid_response' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 0 });
  });

  it('cancels provider work at the answer request deadline', async () => {
    model.waitForAbort = true;
    const response = await ask();
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ reason: 'request_timeout' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 0 });
  });

  it('returns linking ambiguity without authorization or execution', async () => {
    model.output = JSON.stringify({ type: 'program_candidate', program: standingsProgram });
    linkFailure = new F1QLLinkingError('entity_ambiguous', ['driver-a', 'driver-b']);
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'entity_ambiguous' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 1 });
  });

  it('rejects a policy-denied candidate without executing', async () => {
    model.output = JSON.stringify({ type: 'program_candidate', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } } });
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'capability_unsupported', reason: 'pace_source_disabled' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 1 });
  });

  it('rejects an approved candidate above the deterministic work budget', async () => {
    runtimeConfig.maxWorkUnits = 1;
    model.output = JSON.stringify({ type: 'program_candidate', program: standingsProgram });
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'answer_bound_exceeded', reason: 'work_units' });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 1 });
    expect(metrics.toJSON().f1ql.answer_outcomes).toEqual({ 'bounds:rejected:work_units': 1 });
  });

  it('keeps an approved candidate non-executing until runtime budgets are enforced', async () => {
    model.output = JSON.stringify({ type: 'program_candidate', program: standingsProgram });
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'answer_unavailable',
      reason: 'execution_bounds_not_enforced',
      mode: 'gated_non_execution',
      capability: { source: 'final_driver_standings' }
    });
    expect({ modelCreations, linkAttempts }).toEqual({ modelCreations: 1, linkAttempts: 1 });
  });
});
