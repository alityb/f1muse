import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import express from 'express';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createProgramSemanticShadowRoutes,
  ProgramSemanticShadowDependencies
} from '../../src/api/routes/program-semantic-shadow';
import { computeAnswerDatabaseConnectionIdentity } from '../../src/db/answer-database';
import {
  SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256,
  SEMANTIC_SHADOW_RESOLVER_STATEMENTS
} from '../../src/f1ql/semantic-shadow-resolver-reader';
import { SemanticShadowProposalRequest } from '../../src/f1ql/semantic-shadow-planner';
import { enumerateSemanticQueries } from '../../src/f1ql/semantic-query';

const QUESTION = 'List driver and championship points from final 2025 driver standings.';
const IID_POINTS_ALL_QUESTION = 'What were the final standings points in 2025?';
const FILTERED_POINTS_QUESTION = 'What were Charles Leclerc final standings points in 2024?';
const PAIR_POINTS_QUESTION = 'Final 2025 standings points for Lando Norris and Oscar Piastri.';
const REVERSED_PAIR_POINTS_QUESTION = 'Final 2025 standings points for Oscar Piastri and Lando Norris.';
const FOUR_DRIVER_POINTS_QUESTION = 'List driver and championship points for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from final 2025 driver standings.';
const FOUR_DRIVER_STANDINGS_RANK_QUESTION = 'Rank Charles Leclerc, George Russell, Lando Norris, Oscar Piastri by championship position in final 2025 driver standings.';
const FOUR_DRIVER_RACE_QUESTION = 'List driver and finishing position for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from round 1 of final 2025 race classification.';
const FOUR_DRIVER_NAMED_RACE_QUESTION = 'List driver and finishing position for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from final 2025 race classification at Monaco.';
const FOUR_DRIVER_QUALIFYING_QUESTION = 'List driver and qualifying position for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from round 1 of final 2025 qualifying classification.';
const FOUR_DRIVER_NAMED_QUALIFYING_QUESTION = 'List driver and qualifying position for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from final 2025 qualifying classification at Monaco.';
const EVENT_DATE_QUESTION = 'List race date from round 1 of final 2025 event metadata.';
const NAMED_EVENT_DATE_QUESTION = 'List race date from final 2025 event metadata at Monaco.';
const EVENT_CIRCUIT_QUESTION = 'List circuit identifier from round 1 of final 2025 event metadata.';
const NAMED_EVENT_CIRCUIT_QUESTION = 'List circuit identifier from final 2025 event metadata at Monaco.';
const EVENT_DATE_CIRCUIT_QUESTION = 'List race date and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_NAME_QUESTION = 'List Grand Prix name from round 1 of final 2025 event metadata.';
const LATEST_EVENT_CIRCUIT_QUESTION = 'List circuit identifier from round 1 of latest recorded 2026 event metadata.';
const SEASON_WIDE_DRIVER_RACE_QUESTION = 'List driver and finishing position for Max Verstappen from final 2025 race classification.';
const SEASON_WIDE_DRIVER_QUALIFYING_QUESTION = 'List driver and qualifying position for Max Verstappen from final 2025 qualifying classification.';
const LIMITED_DRIVER_QUALIFYING_QUESTION = 'List top 1 driver and qualifying position for Max Verstappen from round 1 of final 2025 qualifying classification.';
const OUTPUT_ALTERNATIVE_POINTS_QUESTION = 'For Max Verstappen and Lando Norris, list driver or championship points from final 2025 driver standings.';
const ALL_NAMED_DRIVER_POINTS_QUESTION = 'List all driver and championship points for Max Verstappen from final 2025 driver standings.';
const DANGLING_ALTERNATIVE_POINTS_QUESTION = 'List driver and championship points for Max Verstappen or from final 2025 driver standings.';
const MIXED_ENTITY_ALTERNATIVE_QUESTION = 'List driver and finishing position for Max Verstappen or Monaco from final 2025 race classification.';
const FIVE_DRIVER_POINTS_QUESTION = 'List driver and championship points for Max Verstappen, Lando Norris, Oscar Piastri, George Russell, Charles Leclerc from final 2025 driver standings.';
const FIVE_DRIVER_RACE_QUESTION = 'List driver and finishing position for Max Verstappen, Lando Norris, Oscar Piastri, George Russell, Charles Leclerc from round 1 of final 2025 race classification.';
const INTERNAL_TOKEN = 'semantic-shadow-internal-token-000001';
const TIMESTAMP = '2026-07-30T12:00:00.000Z';
const HASH = (character: string) => character.repeat(64);
const PROVIDER_IDENTITY = Object.freeze({
  provider: 'openai-compatible' as const,
  endpoint_sha256: HASH('1'),
  model_sha256: HASH('2'),
  catalog_projection_sha256: HASH('3'),
  prompt_sha256: HASH('4'),
  schema_sha256: HASH('5'),
  request_config_sha256: HASH('6')
});
const ENABLED_ENVIRONMENT: NodeJS.ProcessEnv = {
  F1QL_SEMANTIC_SHADOW_ENABLED: 'true',
  F1QL_SEMANTIC_SHADOW_STAGE: '0',
  F1QL_SEMANTIC_SHADOW_INTERNAL_TOKEN: INTERNAL_TOKEN
};

interface QueryCall {
  readonly sql: string;
  readonly parameters?: unknown[];
}

describe('WP8 stage-zero semantic shadow route', () => {
  it.each([
    [{}, { question: QUESTION }, undefined, 503, 'semantic_shadow_disabled'],
    [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_KILL_SWITCH: 'true' }, { question: QUESTION }, undefined, 503, 'kill_switch_active'],
    [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_STAGE: undefined }, { question: QUESTION }, undefined, 503, 'rollout_stage_unavailable'],
    [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_STAGE: '1' }, { question: QUESTION }, undefined, 503, 'rollout_stage_unavailable'],
    [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_INTERNAL_TOKEN: 'short' }, { question: QUESTION }, undefined, 503, 'semantic_shadow_auth_not_configured'],
    [ENABLED_ENVIRONMENT, { question: QUESTION }, 'Bearer wrong-token', 401, 'semantic_shadow_authentication_required'],
    [ENABLED_ENVIRONMENT, { question: QUESTION, extra: true }, undefined, 400, 'question_invalid'],
    [ENABLED_ENVIRONMENT, { question: '' }, undefined, 400, 'question_invalid']
  ])('stops disabled, kill, stage, auth, and input gates before provider or database work', async (
    environment, body, authorization, expectedStatus, expectedReason
  ) => {
    const fake = fakePool();
    let providerCalls = 0;
    const response = await request(fake.pool, {
      environment: () => environment,
      proposer: { propose: async () => {providerCalls += 1; return {}; } },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => {throw new Error('gated requests must not log');}
    }, body, authorization);

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toMatchObject({ reason: expectedReason });
    expect(providerCalls).toBe(0);
    expect(fake.connectionAttempts()).toBe(0);
  });

  it('requires the dedicated answer database before provider construction or database work', async () => {
    let providerCalls = 0;
    const response = await request(undefined, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async () => {providerCalls += 1; return {}; } },
      providerIdentity: PROVIDER_IDENTITY
    }, { question: QUESTION });

    expect(response).toEqual({
      status: 503,
      body: { error: 'semantic_shadow_unavailable', reason: 'answer_database_not_configured' }
    });
    expect(providerCalls).toBe(0);
  });

  it('returns and logs one sanitized proven observation through the exact read-only lifecycle', async () => {
    const fake = fakePool(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [{
          driver_id: 'LEAK_ENTITY_ID',
          identity: 'LEAK_ENTITY_LABEL',
          participation_source: 'LEAK_ROW_VALUE'
        }] };
      }
      return { rows: [] };
    });
    const logs: string[] = [];
    const providerRequests: SemanticShadowProposalRequest[] = [];
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: {
        propose: async (proposal, signal) => {
          expect(signal?.aborted).toBe(false);
          providerRequests.push(proposal);
          return exactProposal(proposal);
        }
      },
      providerIdentity: PROVIDER_IDENTITY,
      logger: line => logs.push(line),
      timestamp: () => TIMESTAMP,
      metadataStatementTimeoutMs: 2_000,
      requestTimeoutMs: 5_000
    }, { question: QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('LEAK_EXECUTOR_ERROR');
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      mode: 'semantic_shadow',
      rollout_stage: 0,
      observation: expect.objectContaining({
        outcome: 'answer',
        reason: 'plan_proven',
        result_query_calls: 0
      })
    });
    expect(providerRequests).toEqual([{
      question: QUESTION,
      semantic_query_version: 2,
      max_candidates: 5
    }]);
    expect(JSON.stringify(providerRequests)).not.toMatch(/entity_inventory|LEAK_ENTITY/u);
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['2000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(fake.releases()).toBe(1);
    expect(executionAttempts).toBe(0);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({
      version: 'semantic-shadow-retained-v2',
      timestamp: TIMESTAMP,
      mode: 'semantic_shadow',
      rollout_stage: 0,
      question_sha256: createHash('sha256').update(QUESTION).digest('hex'),
      provider_identity: PROVIDER_IDENTITY,
      resolver_transaction_count: 1,
      resolver_transaction_counters: {
        statement_count: 1,
        returned_row_count: 1,
        statements: {
          driver_inventory_unscoped: 0,
          driver_inventory_scoped: 1,
          event_name: 0,
          event_round: 0
        }
      },
      terminal: 'semantic',
      observation: response.body.observation
    });
    assertNoLeakage(JSON.stringify(response.body));
    assertNoLeakage(logs[0]);
  });

  it('maps iid-points-all through the enabled shadow route without result execution', async () => {
    const fake = fakePool();
    let executionAttempts = 0;
    let providerCalls = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: {
        propose: async proposal => {
          providerCalls += 1;
          return exactProposal(proposal);
        }
      },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: IID_POINTS_ALL_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow',
        rollout_stage: 0,
        observation: {
          outcome: 'answer',
          reason: 'plan_proven',
          result_query_calls: 0
        }
      }
    });
    expect(providerCalls).toBe(1);
    expect(executionAttempts).toBe(0);
  });

  it('maps holdout-historical-points through one metadata read and no result execution', async () => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [{
          driver_id: 'charles-leclerc',
          identity: 'Charles Leclerc',
          participation_source: 'entrant'
        }] }
      : { rows: [] });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FILTERED_POINTS_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: {
          outcome: 'answer', reason: 'plan_proven', result_query_calls: 0,
          template_dual: { status: 'matched', template_id: 'final_standings_points' }
        }
      }
    });
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2024, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(executionAttempts).toBe(0);
  });

  it.each([PAIR_POINTS_QUESTION, REVERSED_PAIR_POINTS_QUESTION])(
    'maps the exact shared pair question through one metadata read and no result execution: %s', async question => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] }
      : { rows: [] });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: {
          outcome: 'answer', reason: 'plan_proven', result_query_calls: 0,
          template_dual: { status: 'matched', template_id: 'final_standings_points' }
        }
      }
    });
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(executionAttempts).toBe(0);
  });

  it.each([
    FOUR_DRIVER_POINTS_QUESTION,
    FOUR_DRIVER_STANDINGS_RANK_QUESTION
  ])('proves a four-driver standings family request through one metadata read and no result execution: %s', async question => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] }
      : { rows: [] });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'answer', reason: 'plan_proven', result_query_calls: 0 }
      }
    });
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(executionAttempts).toBe(0);
  });

  it('proves a four-driver race family through bounded identity and event reads without result execution', async () => {
    const fake = fakePool(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round) {
        return { rows: [{ season: 2025, round: 1 }] };
      }
      return { rows: [] };
    });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FOUR_DRIVER_RACE_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'answer', reason: 'plan_proven', result_query_calls: 0 }
      }
    });
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined },
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, parameters: [2025, 1, 2] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(executionAttempts).toBe(0);
  });

  it('proves the same four-driver family through named-event resolution without result execution', async () => {
    const fake = fakePool(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name) {
        return { rows: [{ season: 2025, round: 8, identity: 'Monaco' }] };
      }
      return { rows: [] };
    });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FOUR_DRIVER_NAMED_RACE_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'answer', reason: 'plan_proven', result_query_calls: 0 }
      }
    });
    expect(fake.calls.filter(call => call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name)).toEqual([{
      sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, parameters: [2025, 501]
    }]);
    expect(executionAttempts).toBe(0);
  });

  it('proves a four-driver qualifying family through bounded identity and event reads without result execution', async () => {
    const fake = fakePool(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round) {
        return { rows: [{ season: 2025, round: 1 }] };
      }
      return { rows: [] };
    });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FOUR_DRIVER_QUALIFYING_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'answer', reason: 'plan_proven', result_query_calls: 0 }
      }
    });
    expect(fake.calls).toEqual([
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined },
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, parameters: [2025, 1, 2] },
      { sql: 'ROLLBACK', parameters: undefined }
    ]);
    expect(executionAttempts).toBe(0);
  });

  it('proves the qualifying family through named-event resolution without result execution', async () => {
    const fake = fakePool(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name) {
        return { rows: [{ season: 2025, round: 8, identity: 'Monaco' }] };
      }
      return { rows: [] };
    });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FOUR_DRIVER_NAMED_QUALIFYING_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'answer', reason: 'plan_proven', result_query_calls: 0 }
      }
    });
    expect(fake.calls.filter(call => call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name)).toEqual([{
      sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, parameters: [2025, 501]
    }]);
    expect(executionAttempts).toBe(0);
  });

  it.each([
    [EVENT_DATE_QUESTION, SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, [2025, 1, 2]],
    [NAMED_EVENT_DATE_QUESTION, SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, [2025, 501]],
    [EVENT_CIRCUIT_QUESTION, SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round, [2025, 1, 2]],
    [NAMED_EVENT_CIRCUIT_QUESTION, SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, [2025, 501]]
  ] as const)('proves one-event scalar metadata without result execution: %s', async (
    question, resolverSql, resolverParameters
  ) => {
    const fake = fakePool(async sql => {
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round) {
        return { rows: [{ season: 2025, round: 1 }] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name) {
        return { rows: [{ season: 2025, round: 8, identity: 'Monaco' }] };
      }
      return { rows: [] };
    });
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'answer', reason: 'plan_proven', result_query_calls: 0 }
      }
    });
    expect(fake.calls.filter(call => call.sql === resolverSql)).toEqual([{
      sql: resolverSql, parameters: resolverParameters
    }]);
    expect(executionAttempts).toBe(0);
  });

  it.each([
    EVENT_DATE_CIRCUIT_QUESTION,
    EVENT_NAME_QUESTION,
    LATEST_EVENT_CIRCUIT_QUESTION
  ])('rejects broader event metadata before provider or result execution: %s', async question => {
    const fake = fakePool();
    let providerCalls = 0;
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async () => {providerCalls += 1; return {};} },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'abstain', reason: 'unsupported_scope', result_query_calls: 0 }
      }
    });
    expect(providerCalls).toBe(0);
    expect(executionAttempts).toBe(0);
  });

  it.each([
    [OUTPUT_ALTERNATIVE_POINTS_QUESTION, 'clarify', 'output_shape_ambiguous', 1, false],
    [ALL_NAMED_DRIVER_POINTS_QUESTION, 'abstain', 'unsupported_concept', 0, false],
    [DANGLING_ALTERNATIVE_POINTS_QUESTION, 'abstain', 'unsupported_concept', 0, false],
    [MIXED_ENTITY_ALTERNATIVE_QUESTION, 'abstain', 'unsupported_concept', 0, true]
  ] as const)('never plans conflicting language at stage zero: %s', async (question, outcome, reason, expectedProviderCalls, expectsEventRead) => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' }
        ] }
      : { rows: [] });
    let providerCalls = 0;
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => {providerCalls += 1; return exactProposal(proposal);} },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome, reason, result_query_calls: 0 }
      }
    });
    const expectedCalls: QueryCall[] = [
      { sql: 'BEGIN READ ONLY', parameters: undefined },
      { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
      { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped, parameters: [2025, 10_001] },
      { sql: 'ROLLBACK', parameters: undefined }
    ];
    if (expectsEventRead) {
      expectedCalls.push(
        { sql: 'BEGIN READ ONLY', parameters: undefined },
        { sql: "SELECT set_config('statement_timeout', $1, true)", parameters: ['5000ms'] },
        { sql: SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name, parameters: [2025, 501] },
        { sql: 'ROLLBACK', parameters: undefined }
      );
    }
    expect(fake.calls).toEqual(expectedCalls);
    expect(providerCalls).toBe(expectedProviderCalls);
    expect(executionAttempts).toBe(0);
  });

  it('rejects five-driver standings language before provider or result execution', async () => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] }
      : { rows: [] });
    let providerCalls = 0;
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async () => {providerCalls += 1; return {};} },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FIVE_DRIVER_POINTS_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'abstain', reason: 'unsupported_scope', result_query_calls: 0 }
      }
    });
    expect(providerCalls).toBe(0);
    expect(executionAttempts).toBe(0);
  });

  it('rejects five-driver race language before provider, event resolution, or result execution', async () => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [
          { driver_id: 'charles-leclerc', identity: 'Charles Leclerc', participation_source: 'entrant' },
          { driver_id: 'george-russell', identity: 'George Russell', participation_source: 'entrant' },
          { driver_id: 'lando-norris', identity: 'Lando Norris', participation_source: 'entrant' },
          { driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' },
          { driver_id: 'oscar-piastri', identity: 'Oscar Piastri', participation_source: 'entrant' }
        ] }
      : { rows: [] });
    let providerCalls = 0;
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async () => {providerCalls += 1; return {};} },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: FIVE_DRIVER_RACE_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'abstain', reason: 'unsupported_scope', result_query_calls: 0 }
      }
    });
    expect(fake.calls.some(call => call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round)).toBe(false);
    expect(providerCalls).toBe(0);
    expect(executionAttempts).toBe(0);
  });

  it('rejects a season-wide filtered race selection before provider, event resolution, or result execution', async () => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [{ driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' }] }
      : { rows: [] });
    let providerCalls = 0;
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async () => {providerCalls += 1; return {};} },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question: SEASON_WIDE_DRIVER_RACE_QUESTION }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'abstain', reason: 'unsupported_scope', result_query_calls: 0 }
      }
    });
    expect(fake.calls.some(call => call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round ||
      call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name)).toBe(false);
    expect(providerCalls).toBe(0);
    expect(executionAttempts).toBe(0);
  });

  it.each([
    SEASON_WIDE_DRIVER_QUALIFYING_QUESTION,
    LIMITED_DRIVER_QUALIFYING_QUESTION
  ])('rejects unsupported qualifying selection language before provider or event resolution: %s', async question => {
    const fake = fakePool(async sql => sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped
      ? { rows: [{ driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' }] }
      : { rows: [] });
    let providerCalls = 0;
    let executionAttempts = 0;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async () => {providerCalls += 1; return {};} },
      providerIdentity: PROVIDER_IDENTITY,
      logger: () => undefined
    }, { question }, undefined, () => {
      executionAttempts += 1;
      throw new Error('semantic shadow must not execute a result query');
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        mode: 'semantic_shadow', rollout_stage: 0,
        observation: { outcome: 'abstain', reason: 'unsupported_scope', result_query_calls: 0 }
      }
    });
    expect(fake.calls.some(call => call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round ||
      call.sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name)).toBe(false);
    expect(providerCalls).toBe(0);
    expect(executionAttempts).toBe(0);
  });

  it.each([
    ['malformed', async () => ({
      provider_body: 'LEAK_PROVIDER_BODY',
      provider_error: 'LEAK_PROVIDER_ERROR',
      provider_url: 'https://leak-provider.invalid/private'
    }), 'provider_malformed'],
    ['failed', async () => {
      throw new Error('LEAK_PROVIDER_ERROR https://leak-provider.invalid/private');
    }, 'provider_unavailable']
  ])('sanitizes a %s provider outcome into an unavailable observation', async (_name, propose, reason) => {
    const fake = fakePool();
    const logs: string[] = [];
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose },
      providerIdentity: _name === 'malformed'
        ? { ...PROVIDER_IDENTITY, provider: 'anthropic' as const }
        : PROVIDER_IDENTITY,
      logger: line => logs.push(line),
      timestamp: () => TIMESTAMP
    }, { question: QUESTION });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      mode: 'semantic_shadow', rollout_stage: 0,
      observation: { outcome: 'unavailable', reason, result_query_calls: 0 }
    });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]).provider_identity.provider).toBe(
      _name === 'malformed' ? 'anthropic' : 'openai-compatible'
    );
    expect(`${JSON.stringify(response.body)}${logs[0]}`).not.toMatch(/LEAK_PROVIDER|leak-provider\.invalid/u);
    expect(fake.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('aborts provider and metadata transaction at the bounded request timeout', async () => {
    const fake = fakePool();
    const logs: string[] = [];
    let providerAborted = false;
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: {
        propose: async (_proposal, signal) => new Promise((_resolve, reject) => {
          const abort = () => {
            providerAborted = true;
            reject(new Error('LEAK_TIMEOUT_PROVIDER_DETAIL'));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        })
      },
      providerIdentity: PROVIDER_IDENTITY,
      logger: line => logs.push(line),
      metadataStatementTimeoutMs: 100,
      requestTimeoutMs: 10
    }, { question: QUESTION });

    expect(response).toEqual({
      status: 504,
      body: { error: 'semantic_shadow_unavailable', reason: 'request_timeout' }
    });
    expect(providerAborted).toBe(true);
    await waitFor(() => fake.calls.at(-1)?.sql === 'ROLLBACK');
    expect(fake.releases()).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({
      version: 'semantic-shadow-retained-v2', terminal: 'operational_failure',
      failure: { reason: 'request_timeout', stage: 'proposal' }, result_query_calls: 0
    });
    expect(logs[0]).not.toContain('LEAK_TIMEOUT_PROVIDER_DETAIL');
  });

  it('preserves typed metadata failures instead of converting them to semantic outcomes', async () => {
    const fake = fakePool(async () => {
      throw Object.assign(new Error('LEAK_DATABASE_DETAIL'), { code: '57014' });
    });
    const logs: string[] = [];
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: line => logs.push(line)
    }, { question: QUESTION });

    expect(response).toEqual({
      status: 504,
      body: { error: 'semantic_shadow_unavailable', reason: 'metadata_statement_timeout' }
    });
    expect(JSON.stringify(response)).not.toContain('LEAK_DATABASE_DETAIL');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({
      terminal: 'operational_failure',
      failure: { reason: 'metadata_statement_timeout', stage: 'inventory' },
      resolver_transaction_count: 1,
      resolver_transaction_counters: { statement_count: 1 }
    });
    expect(logs[0]).not.toContain('LEAK_DATABASE_DETAIL');
  });

  it.each(['logger', 'response'] as const)('attempts exactly one terminal retention when %s serialization fails', async failure => {
    const fake = fakePool();
    const logs: string[] = [];
    const response = await request(fake.pool, {
      environment: () => ENABLED_ENVIRONMENT,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: line => {
        logs.push(line);
        if (failure === 'logger') {throw new Error('LEAK_LOGGER_FAILURE');}
      },
      timestamp: () => TIMESTAMP
    }, { question: QUESTION }, undefined, undefined, failure === 'response');

    expect(response).toEqual(failure === 'logger' ? {
      status: 200,
      body: expect.objectContaining({ mode: 'semantic_shadow', observation: expect.objectContaining({ outcome: 'answer' }) })
    } : {
      status: 503,
      body: { error: 'semantic_shadow_unavailable', reason: 'semantic_shadow_planning_unavailable' }
    });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({
      terminal: failure === 'logger' ? 'semantic' : 'operational_failure'
    });
    expect(logs[0]).not.toMatch(/LEAK_LOGGER_FAILURE|LEAK_RESPONSE_FAILURE/u);
  });

  it('fails closed on non-hashed or extra provider identity material before database work', async () => {
    const fake = fakePool();
    const invalidIdentities = [
      { ...PROVIDER_IDENTITY, model_sha256: 'raw-model-name' },
      { ...PROVIDER_IDENTITY, endpoint: 'https://private.invalid' },
      { ...PROVIDER_IDENTITY, provider: 'unknown-provider' }
    ];
    for (const providerIdentity of invalidIdentities) {
      const response = await request(fake.pool, {
        environment: () => ENABLED_ENVIRONMENT,
        proposer: { propose: async proposal => exactProposal(proposal) },
        providerIdentity
      }, { question: QUESTION });
      expect(response.body).toEqual({
        error: 'semantic_shadow_unavailable',
        reason: 'semantic_shadow_provider_not_configured'
      });
    }
    expect(fake.connectionAttempts()).toBe(0);
  });

  it('has no execution, authorization, formatting, or interpreter import path and preserves translate bytes', () => {
    const route = resolve('src/api/routes/program-semantic-shadow.ts');
    const graph = reachableLocalModules(route);
    const forbidden = /(?:^|\/)(?:executor|answer-execution|answer-authorization|semantic-capability-authorization|semantic-plan-execution|semantic-result-format|answer-format|interpreter)\.ts$/u;
    expect([...graph].filter(file => forbidden.test(file))).toEqual([]);
    const routeSource = readFileSync(route, 'utf8');
    expect(routeSource).not.toMatch(/from ['"].*(?:executor|authorization|format|interpreter)['"]/u);

    const translateSource = readFileSync(resolve('src/api/routes/program-translate.ts'), 'utf8');
    expect(createHash('sha256').update(translateSource).digest('hex'))
      .toBe('93e9da59bfce8800ce2ef34dddf3ff6647f6445645234c3b32a67132c0204596');
  });

  it('hash-binds an explicitly enabled production evidence request to its runtime context and nonce', async () => {
    const nonce = 'n'.repeat(43);
    const captureKeys = generateKeyPairSync('ed25519');
    const environment = {
      ...ENABLED_ENVIRONMENT,
      F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_ENABLED: 'true',
      F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_TARGET: 'production',
      RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
      F1QL_ANSWER_DEPLOYMENT_ID: 'semantic-shadow-production-deployment',
      F1QL_ANSWER_RELEASE_ID: 'semantic-shadow-production-release',
      F1QL_ANSWER_DATABASE_URL: 'postgresql://f1ql_answer:unused@db.example.test:5432/f1muse',
      F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_NONCE: nonce,
      F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_KEY_ID: 'semantic-shadow-capture-key',
      F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_PRIVATE_KEY_BASE64:
        captureKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    };
    const fake = fakePool();
    const logs: string[] = [];
    const response = await request(fake.pool, {
      environment: () => environment,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY,
      logger: line => logs.push(line),
      timestamp: () => TIMESTAMP
    }, { question: QUESTION }, undefined, undefined, false, nonce);
    expect(response.status).toBe(200);
    expect(logs).toHaveLength(1);
    const captured = JSON.parse(logs[0]);
    const databaseIdentity = computeAnswerDatabaseConnectionIdentity(environment.F1QL_ANSWER_DATABASE_URL);
    expect(captured.production_evidence_binding).toEqual({
      commit_sha256: createHash('sha256').update(environment.RAILWAY_GIT_COMMIT_SHA).digest('hex'),
      deployment_id_sha256: createHash('sha256').update(environment.F1QL_ANSWER_DEPLOYMENT_ID).digest('hex'),
      release_id_sha256: createHash('sha256').update(environment.F1QL_ANSWER_RELEASE_ID).digest('hex'),
      capture_nonce_sha256: createHash('sha256').update(nonce).digest('hex'),
      answer_database_target_sha256: databaseIdentity.target_sha256,
      answer_database_user_sha256: databaseIdentity.current_user_sha256,
      answer_database_name_sha256: databaseIdentity.current_database_sha256,
      resolver_sql_fingerprint_set_sha256: SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256
    });
    expect(captured.production_capture).toMatchObject({
      key_id: 'semantic-shadow-capture-key', algorithm: 'Ed25519',
      signature: expect.stringMatching(/^[A-Za-z0-9+/]{86}==$/u)
    });

    const refused = await request(fake.pool, {
      environment: () => environment,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY
    }, { question: QUESTION });
    expect(refused).toEqual({
      status: 503,
      body: { error: 'semantic_shadow_unavailable', reason: 'semantic_shadow_configuration_invalid' }
    });
    const wrongNonce = await request(fake.pool, {
      environment: () => environment,
      proposer: { propose: async proposal => exactProposal(proposal) },
      providerIdentity: PROVIDER_IDENTITY
    }, { question: QUESTION }, undefined, undefined, false, 'x'.repeat(43));
    expect(wrongNonce.status).toBe(503);
  });
});

function fakePool(
  respond: (sql: string, parameters?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] })
) {
  const calls: QueryCall[] = [];
  let connectionAttempts = 0;
  let releases = 0;
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      calls.push({ sql, parameters });
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK' || sql.startsWith("SELECT set_config('statement_timeout'")) {
        return { rows: [] };
      }
      return respond(sql, parameters);
    },
    release() {releases += 1;}
  };
  return {
    calls,
    connectionAttempts: () => connectionAttempts,
    releases: () => releases,
    pool: {
      connect: async () => {
        connectionAttempts += 1;
        return client;
      }
    } as unknown as Pool
  };
}

async function request(
  pool: Pool | undefined,
  dependencies: ProgramSemanticShadowDependencies,
  body: unknown,
  authorization = `Bearer ${INTERNAL_TOKEN}`,
  executor?: () => never,
  failSemanticResponseSerialization = false,
  evidenceNonce?: string
): Promise<{ status: number; body: Record<string, any> }> {
  const app = express();
  app.use(express.json());
  if (failSemanticResponseSerialization) {
    app.use((_req, res, next) => {
      const json = res.json.bind(res);
      res.json = ((responseBody: unknown) => {
        if ((responseBody as { mode?: unknown })?.mode === 'semantic_shadow') {
          throw new Error('LEAK_RESPONSE_FAILURE');
        }
        return json(responseBody);
      }) as typeof res.json;
      next();
    });
  }
  app.use('/', createProgramSemanticShadowRoutes(pool, dependencies, executor));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolveServer => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/program/semantic-shadow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization === undefined ? {} : { Authorization: authorization }),
        ...(evidenceNonce === undefined ? {} : { 'X-F1QL-Semantic-Shadow-Evidence-Nonce': evidenceNonce })
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
}

function exactProposal(request: SemanticShadowProposalRequest): unknown {
  const entityInventory = request.question === FILTERED_POINTS_QUESTION
    ? [{
        type: 'driver' as const,
        span: { text: 'Charles Leclerc', start: 10, end: 25 }
      }]
    : request.question === PAIR_POINTS_QUESTION
      ? [
          { type: 'driver' as const, span: { text: 'Lando Norris', start: 32, end: 44 } },
          { type: 'driver' as const, span: { text: 'Oscar Piastri', start: 49, end: 62 } }
        ]
    : request.question === REVERSED_PAIR_POINTS_QUESTION
      ? [
          { type: 'driver' as const, span: { text: 'Oscar Piastri', start: 32, end: 45 } },
          { type: 'driver' as const, span: { text: 'Lando Norris', start: 50, end: 62 } }
        ]
    : request.question === FOUR_DRIVER_POINTS_QUESTION || request.question === FOUR_DRIVER_STANDINGS_RANK_QUESTION ||
        request.question === FOUR_DRIVER_RACE_QUESTION ||
        request.question === FOUR_DRIVER_QUALIFYING_QUESTION
      ? ['Charles Leclerc', 'George Russell', 'Lando Norris', 'Oscar Piastri'].map(text => ({
          type: 'driver' as const,
          span: questionSpan(request.question, text)
        }))
    : request.question === FOUR_DRIVER_NAMED_RACE_QUESTION
      ? [
          ...['Charles Leclerc', 'George Russell', 'Lando Norris', 'Oscar Piastri'].map(text => ({
            type: 'driver' as const,
            span: questionSpan(request.question, text)
          })),
          { type: 'event' as const, span: questionSpan(request.question, 'Monaco') }
        ]
    : request.question === FOUR_DRIVER_NAMED_QUALIFYING_QUESTION
      ? [
          ...['Charles Leclerc', 'George Russell', 'Lando Norris', 'Oscar Piastri'].map(text => ({
            type: 'driver' as const,
            span: questionSpan(request.question, text)
          })),
          { type: 'event' as const, span: questionSpan(request.question, 'Monaco') }
        ]
    : request.question === NAMED_EVENT_DATE_QUESTION || request.question === NAMED_EVENT_CIRCUIT_QUESTION
      ? [{ type: 'event' as const, span: questionSpan(request.question, 'Monaco') }]
    : request.question === OUTPUT_ALTERNATIVE_POINTS_QUESTION
      ? ['Max Verstappen', 'Lando Norris'].map(text => ({
          type: 'driver' as const,
          span: questionSpan(request.question, text)
        }))
    : request.question === ALL_NAMED_DRIVER_POINTS_QUESTION
      ? [{
          type: 'driver' as const,
          span: questionSpan(request.question, 'Max Verstappen')
        }]
    : [];
  const evidence = enumerateSemanticQueries(request.question, entityInventory);
  if (evidence.type !== 'candidate_set') {
    throw new Error('fixture question did not enumerate candidates');
  }
  return { version: request.semantic_query_version, candidates: evidence.candidates };
}

function questionSpan(question: string, text: string) {
  const questionPoints = Array.from(question);
  const textPoints = Array.from(text);
  const start = questionPoints.findIndex((_point, index) =>
    textPoints.every((point, offset) => questionPoints[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + textPoints.length };
}

function assertNoLeakage(serialized: string): void {
  for (const sentinel of [
    QUESTION,
    'LEAK_ENTITY_ID',
    'LEAK_ENTITY_LABEL',
    'LEAK_ROW_VALUE',
    'LEAK_EXECUTOR_ERROR',
    'SELECT driver_id',
    'statement_timeout',
    '10_001'
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
  expect(serialized).not.toMatch(/"(?:question|entities|sql|params|rows)"\s*:/iu);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for asynchronous cleanup');
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
}

function reachableLocalModules(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  const imports = [
    ...source.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].map(match => match[1]).filter(specifier => specifier.startsWith('.'));
  for (const specifier of imports) {
    const base = resolve(dirname(entry), specifier);
    const child = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(resolve(base, 'index.ts')) ? resolve(base, 'index.ts') : undefined;
    if (child) reachableLocalModules(child, seen);
  }
  return seen;
}
