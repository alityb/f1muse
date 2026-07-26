import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Pool } from 'pg';
import { createProgramAnswerRoutes } from '../../src/api/routes/program-answer';
import { AnswerIntent } from '../../src/f1ql/answer-intent';
import { deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';
import { AnswerRuntimeConfig } from '../../src/f1ql/answer-runtime';
import { executeAuthorizedAnswer } from '../../src/f1ql/answer-execution';
import { AnswerBoundError } from '../../src/f1ql/answer-bounds';
import { F1QLRequestDeadlineError, F1QLStatementTimeoutError } from '../../src/f1ql/executor';
import { ActiveAnswerReleaseContext, AnswerReleaseVerificationInput, buildActiveAnswerReleaseBindings, getAnswerReleaseAttestationSigningPayload, verifyAnswerReleaseAttestation } from '../../src/f1ql/answer-release-attestation';
import { ANSWER_TEMPLATE_IDS } from '../../src/f1ql/answer-templates';
import { metrics } from '../../src/observability/metrics';

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
const internalCanaryToken = 'test-internal-canary-token-00000087';
const releaseNowMs = Date.parse('2026-07-24T00:01:00.000Z');

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;
let derivationAttempts: number;
let resolutionAttempts: number;
let derivationOverride: AnswerIntent | undefined;
let derivationError: Error | undefined;
let releaseOverride: AnswerReleaseVerificationInput | undefined;
let useReleaseOverride: boolean;
let releaseFailure: boolean;
let releaseLoads: number;
let connectionAttempts: number;
let databaseStatements: string[];
let routeNowMs: number;
let executionAttempts: number;
let executionError: Error | undefined;
let executedPrincipalClasses: string[];

const hash = (digit: string) => digit.repeat(64);
const releaseEvidence = {
  manifest_sha256: hash('8'), artifact_sha256: hash('9'), report_sha256: hash('a'),
  result_fixture_sha256: hash('b'), principal_audit_sha256: hash('c'), production_evidence_sha256: hash('d')
};
const releaseKeyPair = generateKeyPairSync('ed25519');
const releaseKey = { key_id: 'route-release-key', public_key: releaseKeyPair.publicKey };
const canaryHmacKey = Buffer.alloc(32, 7);
const canaryHmacKeyBase64 = canaryHmacKey.toString('base64');
const canaryHmacKeySha256 = createHash('sha256').update(canaryHmacKey).digest('hex');

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
    commit_sha: 'e'.repeat(40), provider: 'openai-compatible', model_id: 'reviewed-model', endpoint_sha256: hash('1'), reasoning_effort: 'disabled',
    audience: 'f1muse-answer', deployment_id: 'route-test-deployment', evidence_hashes: releaseEvidence,
    canary_policy_version: 'answer-canary-hmac-v1', maximum_canary_stage: 100, canary_hmac_key_sha256: canaryHmacKeySha256,
    statuses: { semantic: 'pass', safety: 'pass', linker: 'pass', latency: 'pass', timeout: 'pass' },
    runtime, deployment_template_ids: [...allowedTemplateIds]
  };
  const unsigned = {
    version: 4 as const, kind: 'f1ql_answer_release_attestation' as const,
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
    if (sql.includes('f1ql.answer_season_participation')) {
      return { rows: [{ driver_id: 'lando-norris' }] };
    }
    if (sql.startsWith('SELECT * FROM')) {
      return { rows: [{ driver_id: 'lando-norris', championship_position: 1, points: '357' }] };
    }
    return { rows: [] };
  },
  release: () => undefined
};
const fakePool = { connect: async () => { connectionAttempts++; return fakeClient; } } as unknown as Pool;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', createProgramAnswerRoutes(fakePool, {
    derive: async (contract, resolver) => {
      derivationAttempts++;
      if (derivationError) throw derivationError;
      return derivationOverride ?? deriveAnswerIntent(contract, resolver);
    },
    releaseVerification: () => {
      releaseLoads++;
      if (releaseFailure) throw new Error('release loading failed');
      return useReleaseOverride ? releaseOverride as AnswerReleaseVerificationInput : createRelease(runtimeConfig);
    },
    runtimeConfig,
    now: () => routeNowMs,
    execute: (...args) => {
      executionAttempts++;
      executedPrincipalClasses.push(args[1].principal_class);
      if (executionError) {
        return Promise.reject(executionError);
      }
      return executeAuthorizedAnswer(...args);
    }
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  process.env.F1QL_ANSWER_ENABLED = 'true';
  process.env.F1QL_ANSWER_INTERNAL_TOKEN = internalToken;
  process.env.F1QL_ANSWER_INTERNAL_CANARY_TOKEN = internalCanaryToken;
  process.env.F1QL_ANSWER_CANARY_STAGE = '100';
  process.env.F1QL_ANSWER_CANARY_HMAC_KEY_BASE64 = canaryHmacKeyBase64;
  delete process.env.F1QL_ANSWER_KILL_SWITCH;
  delete process.env.F1QL_DEFINITIONS_VERSION;
  derivationAttempts = 0;
  resolutionAttempts = 0;
  derivationOverride = undefined;
  derivationError = undefined;
  releaseOverride = undefined;
  useReleaseOverride = false;
  releaseFailure = false;
  releaseLoads = 0;
  connectionAttempts = 0;
  databaseStatements = [];
  routeNowMs = releaseNowMs;
  executionAttempts = 0;
  executionError = undefined;
  executedPrincipalClasses = [];
  runtimeConfig.maxWorkUnits = 200;
  metrics.reset();
});

afterAll(async () => {
  delete process.env.F1QL_ANSWER_ENABLED;
  delete process.env.F1QL_ANSWER_KILL_SWITCH;
  delete process.env.F1QL_ANSWER_INTERNAL_TOKEN;
  delete process.env.F1QL_ANSWER_INTERNAL_CANARY_TOKEN;
  delete process.env.F1QL_DEFINITIONS_VERSION;
  delete process.env.F1QL_ANSWER_CANARY_STAGE;
  delete process.env.F1QL_ANSWER_CANARY_HMAC_KEY_BASE64;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(question = 'Who led the 2025 standings?', body?: Record<string, unknown>, token = internalToken): Promise<Response> {
  return fetch(`${baseUrl}/program/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

function assertNoReachableProviderDependency(entrypoint: string): void {
  const pending = [resolve(entrypoint)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (visited.has(path) || path.endsWith(`${resolve('src/f1ql')}/answer-execution.ts`)) continue;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    expect(path).not.toMatch(/answer-translator\.ts$|model-provider|provider-config/);
    expect(source, path).not.toMatch(/createAnswerIntentModel|getConfiguredAnswerModelIdentity|\bfetch\s*\(/);
    for (const specifier of localModuleSpecifiers(source)) {
      const dependency = resolveLocalTypeScriptModule(path, specifier);
      if (dependency) pending.push(dependency);
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

describe('gated answer route', () => {
  it('keeps evaluation and observation entrypoints structurally non-executing', () => {
    assertNoReachableExecution([
      'scripts/collect-answer-evaluation-observations.ts',
      'scripts/report-answer-evaluation-observations.ts',
      'src/f1ql/answer-observations.ts'
    ]);
    const source = readFileSync('src/api/routes/program-answer.ts', 'utf8');
    expect(source).not.toContain('eventResolver?:');
    expect(source).not.toContain('driverResolver?:');
  });

  it('has no reachable translator, model-provider, or network dependency before execution', () => {
    assertNoReachableProviderDependency('src/api/routes/program-answer.ts');
    const source = readFileSync('src/api/routes/program-answer.ts', 'utf8');
    expect(source).not.toMatch(/answer-translator|modelFactory|translate\??:|provider_unavailable|invalid_response/);
  });

  it('defaults to stage zero before release, derivation, database identity, bounds, or authorization work', async () => {
    delete process.env.F1QL_ANSWER_CANARY_STAGE;
    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    useReleaseOverride = true;
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'canary_control', mode: 'gated_non_execution' });
    expect({ releaseLoads, connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ releaseLoads: 0, connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
    expect(executionAttempts).toBe(0);
  });

  it('applies an attested intermediate canary cohort before execution', async () => {
    process.env.F1QL_ANSWER_CANARY_STAGE = '25';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'canary_control', mode: 'gated_non_execution' });
    expect({ releaseLoads, connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ releaseLoads: 1, connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
    expect(executionAttempts).toBe(0);
  });

  it('admits only the separately authenticated canary principal at stage one', async () => {
    process.env.F1QL_ANSWER_CANARY_STAGE = '1';
    const primary = await ask();
    expect(primary.status).toBe(503);
    await expect(primary.json()).resolves.toMatchObject({ reason: 'canary_control' });
    expect({ connectionAttempts, derivationAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0 });
    expect(executionAttempts).toBe(0);

    const canary = await ask('Who led the 2025 standings?', undefined, internalCanaryToken);
    expect(canary.status).toBe(200);
    await expect(canary.json()).resolves.toMatchObject({ answer: { facts: [{ subject: 'lando-norris' }] } });
    expect(executionAttempts).toBe(1);
    expect(executedPrincipalClasses).toEqual(['internal_canary']);
  });

  it('checks the disabled gate before database acquisition or derivation', async () => {
    process.env.F1QL_ANSWER_ENABLED = 'false';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'answer_disabled' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it('checks the emergency kill switch before database acquisition or derivation', async () => {
    process.env.F1QL_ANSWER_KILL_SWITCH = 'true';
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'kill_switch_active' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it('rechecks an injected live kill switch immediately before authorization', async () => {
    const liveEnvironment: NodeJS.ProcessEnv = {
      F1QL_ANSWER_ENABLED: 'true', F1QL_ANSWER_INTERNAL_TOKEN: internalToken, F1QL_ANSWER_CANARY_STAGE: '100',
      F1QL_ANSWER_CANARY_HMAC_KEY_BASE64: canaryHmacKeyBase64
    };
    const app = express();
    app.use(express.json());
    app.use('/', createProgramAnswerRoutes(fakePool, {
      runtimeConfig,
      releaseVerification: createRelease(runtimeConfig),
      environment: () => liveEnvironment,
      now: () => releaseNowMs,
      derive: async (contract, resolver) => {
        liveEnvironment.F1QL_ANSWER_KILL_SWITCH = 'true';
        return deriveAnswerIntent(contract, resolver);
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
    derivationOverride = { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 12, end: 16 } } as AnswerIntent;
    const originalQuery = fakeClient.query;
    fakeClient.query = async (sql: string) => {
      const result = await originalQuery(sql);
      if (sql.includes('ROLLBACK')) routeNowMs = Date.parse(createRelease(runtimeConfig).active_context.expires_at);
      return result;
    };
    try {
      const response = await ask();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'release_not_approved' });
    } finally {
      fakeClient.query = originalQuery;
    }
  });

  it('rejects invalid input before database acquisition or derivation', async () => {
    const response = await fetch(`${baseUrl}/program/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` }, body: JSON.stringify({ question: '' }) });
    expect(response.status).toBe(400);
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it('requires configured internal authentication before database acquisition or derivation', async () => {
    delete process.env.F1QL_ANSWER_INTERNAL_TOKEN;
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'answer_auth_not_configured' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it('rejects invalid internal authentication before database acquisition or derivation', async () => {
    const response = await fetch(`${baseUrl}/program/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ question: 'Who led the 2025 standings?' })
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unauthorized', reason: 'answer_authentication_required' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it.each(['missing', 'forged', 'prebranded', 'failed', 'runtime_mismatch'] as const)('rejects a %s release attestation before derivation or resolver work', async failure => {
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
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it('returns a derived clarification without proving or executing', async () => {
    derivationOverride = { type: 'clarification', reason: 'metric_ambiguous' };
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'metric_ambiguous' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 1, derivationAttempts: 1, resolutionAttempts: 0 });
    expect(metrics.toJSON().f1ql.answer_outcomes).toEqual({ 'derivation:clarification:metric_ambiguous': 1 });
  });

  it('returns a derived unsupported outcome without proving or executing', async () => {
    derivationOverride = { type: 'unsupported', reason: 'grid_source_unsupported' };
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'capability_unsupported', reason: 'grid_source_unsupported' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 1, derivationAttempts: 1, resolutionAttempts: 0 });
    expect(metrics.toJSON().f1ql.answer_outcomes).toEqual({ 'derivation:unsupported:grid_source_unsupported': 1 });
  });

  it('fails closed when deterministic derivation fails', async () => {
    derivationError = new Error('derivation failed');
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'linking_unavailable' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 1, derivationAttempts: 1, resolutionAttempts: 0 });
  });

  it('maps a deadline reached during derivation', async () => {
    derivationError = new F1QLRequestDeadlineError();
    const response = await ask();
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ reason: 'request_timeout' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 1, derivationAttempts: 1, resolutionAttempts: 0 });
  });

  it('returns linking ambiguity without authorization or execution', async () => {
    const question = 'Max in the 2025 Monaco race results';
    derivationOverride = {
      type: 'race_classification_driver', season: 2025,
      season_reference: { text: '2025', start: 11, end: 15 }, event_reference: { text: 'Monaco', start: 16, end: 22 }, driver_reference: { text: 'Max', start: 0, end: 3 }
    } as AnswerIntent;
    const response = await ask(question);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'entity_ambiguous' });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 2 });
  });

  it.each([
    ['Show the 2025 starting grid', 'grid_source_unsupported'],
    ['Who was last in the final 2025 standings?', 'capability_unsupported'],
    ['Show the top 3 final 2025 standings points', 'capability_unsupported'],
    ['Show 2025 Monaco race results excluding DNFs', 'capability_unsupported'],
    ['Show all drivers except Max Verstappen in the final 2025 standings', 'capability_unsupported'],
    ['Show the 2025 race results except Monaco', 'capability_unsupported'],
    ['Show 2025 Monaco race results without commentary', 'capability_unsupported'],
    ['Show 2025 Monaco qualifying without DNS', 'capability_unsupported'],
    ['Show all 2025 Monaco race results other than DNFs', 'capability_unsupported'],
    ['Show 2025 Monaco qualifying apart from DNS', 'capability_unsupported'],
    ['Show 2025 Monaco race results save for DSQs', 'capability_unsupported'],
    ['Show 2025 Monaco race results with the exception of withdrawn drivers', 'capability_unsupported'],
    ['Show 2025 Monaco race results all but classified drivers', 'capability_unsupported'],
    ['Show 2025 Monaco race results for non-DNFs', 'capability_unsupported'],
    ['Show 2025 Monaco qualifying, not DNS', 'capability_unsupported'],
    ['Show the top-3 final 2025 standings points', 'capability_unsupported'],
    ['Show the three highest final 2025 standings drivers', 'capability_unsupported'],
    ['Show the highest three final 2025 standings drivers', 'capability_unsupported'],
    ['Show the five best final 2025 standings drivers', 'capability_unsupported'],
    ['Show the trailing 2 final 2025 standings drivers', 'capability_unsupported'],
    ['Who finished second-place in the 2025 Monaco race?', 'capability_unsupported'],
    ['Who was in position 2 in the final 2025 standings?', 'capability_unsupported'],
    ['Who ranked third in the final 2025 standings?', 'capability_unsupported'],
    ['Who was P2 in the final 2025 standings?', 'capability_unsupported'],
    ['Who was the runner-up in the 2025 championship?', 'capability_unsupported'],
    ['Who had the highest final 2025 standings points?', 'capability_unsupported'],
    ['Show the top three final 2025 standings drivers.', 'capability_unsupported'],
    ['Final 2025 standings points for Max Verstappen; also add Lando Norris.', 'capability_unsupported'],
    ['Show Max Verstappen final standings points in 2025 but substitute Lando Norris.', 'capability_unsupported'],
    ['Final 2025 standings points for Lando Norris and Oscar Piastri; omit Oscar.', 'capability_unsupported'],
    ['Give the 2025 Australian race result but use the valid Monaco event.', 'capability_unsupported'],
    ['Show 2025 Australian race DNFs but return classified drivers.', 'capability_unsupported'],
    ['Show 2025 Monaco race results not Max Verstappen', 'capability_unsupported'],
    ['not DNFs in the 2025 Monaco race results', 'capability_unsupported'],
    ['Show three drivers in the final 2025 standings', 'capability_unsupported'],
    ['Show results for 3 drivers in the 2025 Monaco race', 'capability_unsupported'],
    ['Show 3 race results from Monaco in 2025', 'capability_unsupported']
  ])('authoritatively rejects unsupported cues before derivation: %s', async (question, reason) => {
    useReleaseOverride = true;
    const response = await ask(question);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'capability_unsupported', reason });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it.each([
    'Who was the final 2025 champion?',
    'Who was the final 2025 standings leader?',
    'Show the 2025 Monaco race results not classified',
    'Show the 2025 race results for round 2',
    'Show the 2025 race results for the second round'
  ])('admits status, round, and exact leader/champion counterexamples to deterministic inspection: %s', async question => {
    await ask(question);
    expect(derivationAttempts).toBe(1);
  });

  it.each([
    'Who was the final 2025 champion?',
    'Who was the final 2025 standings champion?',
    'Who was the 2025 championship champion?',
    'Who was the final 2025 driver champion?'
  ])('hydrates and proves the champion route as the final standings leader: %s', async question => {
    const response = await ask(question);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ answer: { facts: [{ subject: 'lando-norris' }] } });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 2 });
  });

  it('fails an event champion closed instead of proving a standings answer', async () => {
    const response = await ask('Who was the final 2025 Monaco champion?');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'capability_unsupported', reason: 'capability_unsupported' });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 1 });
  });

  it('hydrates and proves all final standings points through the route', async () => {
    const question = 'Show all final 2025 standings points.';
    const response = await ask(question);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ answer: { facts: [{ subject: 'lando-norris' }] } });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 2 });
  });

  it('authoritatively clarifies an uncued comparison before derivation', async () => {
    useReleaseOverride = true;
    const response = await ask('Who was better in 2025?');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'metric_ambiguous' });
    expect({ connectionAttempts, derivationAttempts, resolutionAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0, resolutionAttempts: 0 });
  });

  it('authoritatively clarifies a missing season before derivation', async () => {
    useReleaseOverride = true;
    const response = await ask('Show the race results');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'clarification_required', reason: 'season_missing', question: 'Which season did you mean?' });
    expect({ connectionAttempts, derivationAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0 });
  });

  it('requires the exact request body shape before derivation', async () => {
    const response = await ask('', { question: 'Who led the 2025 standings?', program: {} });
    expect(response.status).toBe(400);
    expect({ connectionAttempts, derivationAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0 });
  });

  it('reparses an injected derivation intent before semantic proof', async () => {
    derivationOverride = {
      type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 0, end: 4 }
    } as AnswerIntent;
    const response = await ask();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'answer_unavailable', reason: 'linking_unavailable' });
    expect(derivationAttempts).toBe(1);
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
      expect({ connectionAttempts, derivationAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0 });
    } finally {
      await new Promise<void>(resolve => isolated.close(() => resolve()));
    }
  });

  it('clarifies status without an explicit session before derivation', async () => {
    const response = await ask('Show DNFs in 2025 at Monaco');
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'clarification_required', reason: 'session_ambiguous' });
    expect({ connectionAttempts, derivationAttempts }).toEqual({ connectionAttempts: 0, derivationAttempts: 0 });
  });

  it('rejects an approved candidate above the deterministic work budget', async () => {
    runtimeConfig.maxWorkUnits = 1;
    const response = await ask();
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'answer_bound_exceeded', reason: 'work_units' });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 2 });
    expect(metrics.toJSON().f1ql.answer_outcomes).toEqual({ 'bounds:rejected:work_units': 1 });
  });

  it('refuses an authorization envelope when active definitions do not match', async () => {
    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    const response = await ask();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'answer_failed', reason: 'authorization_envelope_failed' });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 2 });
    expect(databaseStatements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(databaseStatements[1]).toContain("set_config('statement_timeout'");
    expect(databaseStatements.at(-1)).toBe('ROLLBACK');
  });

  it('executes one approved candidate and returns the bounded deterministic envelope', async () => {
    const response = await ask();
    expect(response.status).toBe(200);
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(response.json()).resolves.toMatchObject({ answer: { facts: [{ subject: 'lando-norris' }] } });
    expect({ derivationAttempts, resolutionAttempts }).toEqual({ derivationAttempts: 1, resolutionAttempts: 2 });
    expect(executionAttempts).toBe(1);
  });

  it.each([
    [new AnswerBoundError('response_bytes', 65_537, 65_536), 422, 'answer_bound_exceeded', 'response_bytes'],
    [new F1QLStatementTimeoutError(50), 504, 'answer_unavailable', 'statement_timeout']
  ] as const)('maps bounded execution failure %# without exposing query details', async (error, status, responseError, reason) => {
    executionError = error;
    const response = await ask();
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: responseError, reason });
    expect(executionAttempts).toBe(1);
  });
});
