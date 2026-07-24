import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Pool } from 'pg';
import { createProgramAnswerRoutes } from '../../src/api/routes/program-answer';
import { AnswerIntentModel, AnswerTranslationResult, translateAnswerQuestion } from '../../src/f1ql/answer-translator';
import { AnswerRuntimeConfig } from '../../src/f1ql/answer-runtime';
import { ActiveAnswerReleaseContext, AnswerReleaseVerificationInput, buildActiveAnswerReleaseBindings, getAnswerReleaseAttestationSigningPayload, verifyAnswerReleaseAttestation } from '../../src/f1ql/answer-release-attestation';
import { ANSWER_TEMPLATE_IDS } from '../../src/f1ql/answer-templates';
import { metrics } from '../../src/observability/metrics';

class StubModel implements AnswerIntentModel {
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
  statementTimeoutMs: 50,
  maxWorkUnits: 200,
  maxRows: 100,
  maxResponseBytes: 65_536
};
const internalToken = 'test-internal-answer-token-00000001';
const releaseNowMs = Date.parse('2026-07-24T00:01:00.000Z');

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;
let model: StubModel;
let modelCreations: number;
let resolutionAttempts: number;
let translationOverride: AnswerTranslationResult | undefined;
let releaseOverride: AnswerReleaseVerificationInput | undefined;
let useReleaseOverride: boolean;
let releaseFailure: boolean;
let releaseLoads: number;
let connectionAttempts: number;
let databaseStatements: string[];
let routeNowMs: number;

const hash = (digit: string) => digit.repeat(64);
const releaseEvidence = {
  manifest_sha256: hash('8'), artifact_sha256: hash('9'), report_sha256: hash('a'),
  result_fixture_sha256: hash('b'), principal_audit_sha256: hash('c'), production_evidence_sha256: hash('d')
};
const releaseKeyPair = generateKeyPairSync('ed25519');
const releaseKey = { key_id: 'route-release-key', public_key: releaseKeyPair.publicKey };

function releaseRuntime(config: AnswerRuntimeConfig) {
  return {
    max_concurrency: config.maxConcurrency, queue_timeout_ms: config.queueTimeoutMs,
    request_timeout_ms: config.requestTimeoutMs, rate_limit_max: config.rateLimitMax,
    rate_limit_window_ms: config.rateLimitWindowMs, statement_timeout_ms: config.statementTimeoutMs,
    max_work_units: config.maxWorkUnits, max_rows: config.maxRows, max_response_bytes: config.maxResponseBytes
  };
}

function createRelease(config: AnswerRuntimeConfig, allowedTemplateIds: readonly string[] = ANSWER_TEMPLATE_IDS): AnswerReleaseVerificationInput {
  const runtime = releaseRuntime(config);
  const activeContext: ActiveAnswerReleaseContext = {
    release_id: 'route-test-release', issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:10:00.000Z',
    commit_sha: 'e'.repeat(40), provider: 'openai-compatible', model_id: 'reviewed-model',
    audience: 'f1muse-answer', deployment_id: 'route-test-deployment', evidence_hashes: releaseEvidence,
    statuses: { semantic: 'pass', safety: 'pass', linker: 'pass', latency: 'pass', timeout: 'pass' },
    runtime, deployment_template_ids: [...allowedTemplateIds]
  };
  const unsigned = {
    version: 3 as const, kind: 'f1ql_answer_release_attestation' as const,
    key_id: releaseKey.key_id, ...buildActiveAnswerReleaseBindings(activeContext)
  };
  return {
    raw_attestation: { ...unsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), releaseKeyPair.privateKey).toString('base64') },
    trusted_key: releaseKey,
    active_context: activeContext,
    temporal_policy: { now_ms: releaseNowMs, max_validity_ms: 600_000, max_age_ms: 300_000 }
  };
}

const fakeClient = {
  query: async (sql: string) => {
    databaseStatements.push(sql.trim());
    if (sql.includes('f1ql.answer_event_identity')) {
      resolutionAttempts++;
      return { rows: [{ season: 2025, round: 8, identity: 'Monaco' }] };
    }
    if (sql.includes('f1ql.answer_driver_identity')) {
      resolutionAttempts++;
      return { rows: [
        { driver_id: 'driver-a', identity: 'Max', participation_source: 'entrant' },
        { driver_id: 'driver-b', identity: 'Max', participation_source: 'entrant' }
      ] };
    }
    return { rows: [] };
  },
  release: () => undefined
};
const fakePool = { connect: async () => { connectionAttempts++; return fakeClient; } } as unknown as Pool;

beforeAll(async () => {
  model = new StubModel();
  const app = express();
  app.use(express.json());
  app.use('/', createProgramAnswerRoutes(fakePool, {
    modelFactory: () => { modelCreations++; return model; },
    translate: async (contract, selectedModel, signal) => translationOverride ?? translateAnswerQuestion(contract, selectedModel, signal),
    releaseVerification: () => {
      releaseLoads++;
      if (releaseFailure) throw new Error('release loading failed');
      return useReleaseOverride ? releaseOverride as AnswerReleaseVerificationInput : createRelease(runtimeConfig);
    },
    runtimeConfig,
    now: () => routeNowMs
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  process.env.F1QL_ANSWER_ENABLED = 'true';
  process.env.F1QL_ANSWER_INTERNAL_TOKEN = internalToken;
  process.env.F1QL_ANSWER_CANARY_STAGE = '100';
  delete process.env.F1QL_ANSWER_KILL_SWITCH;
  delete process.env.F1QL_DEFINITIONS_VERSION;
  modelCreations = 0;
  resolutionAttempts = 0;
  translationOverride = undefined;
  releaseOverride = undefined;
  useReleaseOverride = false;
  releaseFailure = false;
  releaseLoads = 0;
  connectionAttempts = 0;
  databaseStatements = [];
  routeNowMs = releaseNowMs;
  model.waitForAbort = false;
  model.output = JSON.stringify({ intent: { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 12, end: 16 } } });
  runtimeConfig.maxWorkUnits = 200;
  metrics.reset();
});

afterAll(async () => {
  delete process.env.F1QL_ANSWER_ENABLED;
  delete process.env.F1QL_ANSWER_KILL_SWITCH;
  delete process.env.F1QL_ANSWER_INTERNAL_TOKEN;
  delete process.env.F1QL_DEFINITIONS_VERSION;
  delete process.env.F1QL_ANSWER_CANARY_STAGE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(question = 'Who led the 2025 standings?', body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/program/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
    body: JSON.stringify(body ?? { question })
  });
}

function assertNoReachableExecution(entrypoints: readonly string[]): void {
  const pending = entrypoints.map(path => resolve(path));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    expect(source, path).not.toContain('executeF1QL');
    for (const specifier of localModuleSpecifiers(source)) {
      const dependency = resolveLocalTypeScriptModule(path, specifier);
      if (dependency) {
        expect(dependency, `${path} -> ${specifier}`).not.toMatch(/[/\\]executor\.ts$/);
        pending.push(dependency);
      }
    }
  }
}

function localModuleSpecifiers(source: string): string[] {
  const staticImports = [...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)];
  const requires = [...source.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)];
  return [...staticImports, ...requires].map(match => match[1]).filter(specifier => specifier.startsWith('.'));
}

function resolveLocalTypeScriptModule(importer: string, specifier: string): string | undefined {
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [`${base}.ts`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe('gated answer route skeleton', () => {
  it('has no reachable executor import or F1QL execution call', () => {
    assertNoReachableExecution([
      'src/api/routes/program-answer.ts',
      'scripts/collect-answer-evaluation-observations.ts',
      'scripts/report-answer-evaluation-observations.ts',
      'src/f1ql/answer-observations.ts'
    ]);
    const source = readFileSync('src/api/routes/program-answer.ts', 'utf8');
    expect(source).not.toContain('eventResolver?:');
    expect(source).not.toContain('driverResolver?:');
  });

  it('defaults to stage zero before release, model, database identity, bounds, or authorization work', async () => {
    delete process.env.F1QL_ANSWER_CANARY_STAGE;
    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    useReleaseOverride = true;
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'canary_control', mode: 'gated_non_execution' });
    expect({ releaseLoads, connectionAttempts, modelCreations, resolutionAttempts }).toEqual({ releaseLoads: 0, connectionAttempts: 0, modelCreations: 0, resolutionAttempts: 0 });
  });

  it('rejects intermediate canary percentages before release or model work', async () => {
    process.env.F1QL_ANSWER_CANARY_STAGE = '25';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'release_not_approved' });
    expect({ releaseLoads, connectionAttempts, modelCreations, resolutionAttempts }).toEqual({ releaseLoads: 0, connectionAttempts: 0, modelCreations: 0, resolutionAttempts: 0 });
  });

  it('checks the disabled gate before constructing a model', async () => {
    process.env.F1QL_ANSWER_ENABLED = 'false';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'answer_disabled' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it('checks the emergency kill switch before constructing a model', async () => {
    process.env.F1QL_ANSWER_KILL_SWITCH = 'true';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'kill_switch_active' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it('rechecks an injected live kill switch immediately before authorization', async () => {
    const liveEnvironment: NodeJS.ProcessEnv = {
      F1QL_ANSWER_ENABLED: 'true', F1QL_ANSWER_INTERNAL_TOKEN: internalToken, F1QL_ANSWER_CANARY_STAGE: '100'
    };
    const app = express();
    app.use(express.json());
    app.use('/', createProgramAnswerRoutes(fakePool, {
      runtimeConfig,
      releaseVerification: createRelease(runtimeConfig),
      environment: () => liveEnvironment,
      now: () => releaseNowMs,
      modelFactory: () => model,
      translate: async () => {
        liveEnvironment.F1QL_ANSWER_KILL_SWITCH = 'true';
        return { type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 12, end: 16 } } };
      }
    }));
    const isolated = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${(isolated.address() as AddressInfo).port}/program/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
        body: JSON.stringify({ question: 'Who led the 2025 standings?' })
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ reason: 'kill_switch_active' });
    } finally {
      await new Promise<void>(resolve => isolated.close(() => resolve()));
    }
  });

  it('fails closed when the release expires after admission and proof but before authorization', async () => {
    translationOverride = {
      type: 'intent_candidate',
      intent: { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 12, end: 16 } }
    };
    const originalQuery = fakeClient.query;
    fakeClient.query = async (sql: string) => {
      const result = await originalQuery(sql);
      if (sql.includes('ROLLBACK')) routeNowMs = Date.parse(createRelease(runtimeConfig).active_context.expires_at);
      return result;
    };
    try {
      const response = await ask();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'answer_failed', reason: 'authorization_envelope_failed' });
    } finally {
      fakeClient.query = originalQuery;
    }
  });

  it('rejects invalid input before constructing a model', async () => {
    const response = await fetch(`${baseUrl}/program/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` }, body: JSON.stringify({ question: '' }) });
    expect(response.status).toBe(400);
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it('requires configured internal authentication before constructing a model', async () => {
    delete process.env.F1QL_ANSWER_INTERNAL_TOKEN;
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'answer_auth_not_configured' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it('rejects invalid internal authentication before constructing a model', async () => {
    const response = await fetch(`${baseUrl}/program/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ question: 'Who led the 2025 standings?' })
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unauthorized', reason: 'answer_authentication_required' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it.each(['missing', 'forged', 'prebranded', 'failed', 'runtime_mismatch'] as const)('rejects a %s release attestation before model or resolver work', async failure => {
    if (failure === 'failed') {
      releaseFailure = true;
    } else {
      useReleaseOverride = true;
      if (failure === 'forged') {
        const valid = createRelease(runtimeConfig);
        releaseOverride = { ...valid, raw_attestation: { ...(valid.raw_attestation as object), model_id: 'forged-model' } };
      } else if (failure === 'prebranded') {
        const valid = createRelease(runtimeConfig);
        releaseOverride = verifyAnswerReleaseAttestation(valid.raw_attestation, valid.trusted_key, valid.active_context, valid.temporal_policy) as unknown as AnswerReleaseVerificationInput;
      } else if (failure === 'runtime_mismatch') {
        releaseOverride = createRelease({ ...runtimeConfig, maxRows: runtimeConfig.maxRows - 1 });
      }
    }
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'release_not_approved' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it('returns model clarification without linking or executing', async () => {
    model.output = JSON.stringify({ intent: { type: 'clarification', reason: 'metric_ambiguous' } });
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'metric_ambiguous' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 0 });
  });

  it('returns model abstention without linking or executing', async () => {
    model.output = JSON.stringify({ intent: { type: 'unsupported', reason: 'grid_source_unsupported' } });
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'capability_unsupported', reason: 'grid_source_unsupported' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 0 });
  });

  it('returns provider failure without linking', async () => {
    model.output = 'not json';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'invalid_response' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 0 });
  });

  it('cancels provider work at the answer request deadline', async () => {
    model.waitForAbort = true;
    const response = await ask();
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ reason: 'request_timeout' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 0 });
  });

  it('returns linking ambiguity without authorization or execution', async () => {
    const question = 'Max in the 2025 Monaco race results';
    model.output = JSON.stringify({ intent: {
      type: 'race_classification_driver', season: 2025,
      season_reference: { text: '2025', start: 11, end: 15 }, event_reference: { text: 'Monaco', start: 16, end: 22 }, driver_reference: { text: 'Max', start: 0, end: 3 }
    } });
    const response = await ask(question);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'entity_ambiguous' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 2 });
  });

  it('authoritatively rejects unsupported cues before model construction', async () => {
    useReleaseOverride = true;
    const response = await ask('Show the 2025 starting grid');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'capability_unsupported', reason: 'grid_source_unsupported' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 0, resolutionAttempts: 0 });
  });

  it('authoritatively clarifies a missing season before model construction', async () => {
    useReleaseOverride = true;
    const response = await ask('Show the race results');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'clarification_required', reason: 'season_missing', question: 'Which season did you mean?' });
    expect(modelCreations).toBe(0);
  });

  it('requires the exact request body shape before model construction', async () => {
    const response = await ask('', { question: 'Who led the 2025 standings?', program: {} });
    expect(response.status).toBe(400);
    expect(modelCreations).toBe(0);
  });

  it('reparses injected translation intent spans before semantic proof', async () => {
    translationOverride = {
      type: 'intent_candidate',
      intent: { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 0, end: 4 } }
    };
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'invalid_response' });
    expect(resolutionAttempts).toBe(0);
  });

  it('checks authentication before revealing missing answer database configuration', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', createProgramAnswerRoutes(undefined, {
      runtimeConfig,
      releaseVerification: createRelease(runtimeConfig),
      now: () => releaseNowMs
    }));
    const isolated = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const url = `http://127.0.0.1:${(isolated.address() as AddressInfo).port}/program/answer`;
    try {
      const unauthorized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' }, body: JSON.stringify({ question: 'Who led the 2025 standings?' }) });
      expect(unauthorized.status).toBe(401);
      const authorized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` }, body: JSON.stringify({ question: 'Who led the 2025 standings?' }) });
      expect(authorized.status).toBe(503);
      await expect(authorized.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'answer_database_not_configured' });
    } finally {
      await new Promise<void>(resolve => isolated.close(() => resolve()));
    }
  });

  it('clarifies status without an explicit session before model construction', async () => {
    const response = await ask('Show DNFs in 2025 at Monaco');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'session_ambiguous' });
    expect(modelCreations).toBe(0);
  });

  it('rejects an approved candidate above the deterministic work budget', async () => {
    runtimeConfig.maxWorkUnits = 1;
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'answer_bound_exceeded', reason: 'work_units' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 1 });
    expect(metrics.toJSON().f1ql.answer_outcomes).toEqual({ 'bounds:rejected:work_units': 1 });
  });

  it('refuses an authorization envelope when active definitions do not match', async () => {
    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    const response = await ask();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'answer_failed', reason: 'authorization_envelope_failed' });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 1 });
    expect(databaseStatements[0]).toBe('BEGIN READ ONLY');
    expect(databaseStatements[1]).toContain("set_config('statement_timeout'");
    expect(databaseStatements.at(-1)).toBe('ROLLBACK');
  });

  it('keeps an approved candidate non-executing until runtime budgets are enforced', async () => {
    const response = await ask();
    expect(response.status).toBe(503);
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(response.json()).resolves.toEqual({
      error: 'answer_unavailable',
      reason: 'execution_bounds_not_enforced',
      mode: 'gated_non_execution'
    });
    expect({ modelCreations, resolutionAttempts }).toEqual({ modelCreations: 1, resolutionAttempts: 1 });
  });
});
