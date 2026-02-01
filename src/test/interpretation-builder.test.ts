import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../execution/query-executor';
import { buildInterpretationResponse } from '../presentation/interpretation-builder';
import { QueryIntent } from '../types/query-intent';
import { setupTestDatabase, cleanupTestDatabase, getTestDatabaseUrl } from './setup';

let pool: Pool;
let executor: QueryExecutor;
let dbAvailable = false;

beforeAll(async () => {
  try {
    pool = new Pool({
      connectionString: getTestDatabaseUrl()
    });

    await pool.query('SELECT 1');
    await setupTestDatabase(pool);

    executor = new QueryExecutor(pool);
    dbAvailable = true;
  } catch {
    console.log('Test database not available, skipping interpretation builder tests');
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) { return; }
  await cleanupTestDatabase(pool);
  await pool.end();
});

describe('Interpretation builder fallbacks', () => {
  it.skipIf(!dbAvailable)('falls back to season comparison when track is missing', async () => {
    const intent: QueryIntent = {
      kind: 'cross_team_track_scoped_driver_comparison',
      track_id: '',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'fernando_alonso',
      season: 2023,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Compare Verstappen and Alonso 2023'
    };

    const response = await buildInterpretationResponse({ pool, executor, intent });
    expect('error' in response.result).toBe(false);
    expect(response.intent.kind).toBe('season_driver_vs_driver');
    expect(response.answer.headline).toContain('2023 season');
    expect(response.answer.followups.length).toBeGreaterThan(0);
  });

  it.skipIf(!dbAvailable)('downgrades track comparison to season comparison with insufficient shared laps', async () => {
    const intent: QueryIntent = {
      kind: 'cross_team_track_scoped_driver_comparison',
      track_id: 'monza',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'charles_leclerc',
      season: 2023,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Compare Verstappen and Leclerc Monza 2023'
    };

    const response = await buildInterpretationResponse({ pool, executor, intent });
    expect('error' in response.result).toBe(false);
    expect(response.intent.kind).toBe('season_driver_vs_driver');
    expect(response.answer.headline).toContain('2023 season');
    expect(response.answer.fallbacks?.length).toBeGreaterThan(0);
  });

  it.skipIf(!dbAvailable)('fails closed on teammate gap queries without overlap', async () => {
    const intent: QueryIntent = {
      kind: 'teammate_gap_summary_season',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'fernando_alonso',
      team_id: 'RBR',
      season: 2023,
      metric: 'teammate_gap_raw',
      normalization: 'team_baseline',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query: 'Max vs Alonso teammate gap 2023'
    };

    const response = await buildInterpretationResponse({ pool, executor, intent });
    expect('error' in response.result).toBe(true);
    expect(response.intent.kind).toBe('teammate_gap_summary_season');
    expect(response.answer.headline).toBe('Coverage is limited for this scope');
  });

  it.skipIf(!dbAvailable)('returns a season summary for a single driver query', async () => {
    const intent: QueryIntent = {
      kind: 'driver_season_summary',
      driver_id: 'lando_norris',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query: 'Lando Norris 2025'
    };

    const response = await buildInterpretationResponse({ pool, executor, intent });
    expect('error' in response.result).toBe(false);
    expect(response.answer.headline).toContain('Lando Norris');
    expect(response.answer.bullets.some(bullet => bullet.includes('Wins'))).toBe(true);
    expect(response.answer.followups.length).toBeGreaterThan(0);
  });
});
