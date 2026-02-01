import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DriverResolver } from '../identity/driver-resolver';
import { TrackResolver } from '../identity/track-resolver';
import { QueryExecutor } from '../execution/query-executor';
import { QueryIntent } from '../types/query-intent';
import { setupTestDatabase, cleanupTestDatabase, getTestDatabaseUrl } from './setup';

let pool: Pool;
let driverResolver: DriverResolver;
let trackResolver: TrackResolver;
let executor: QueryExecutor;
let dbAvailable = false;

beforeAll(async () => {
  try {
    pool = new Pool({
      connectionString: getTestDatabaseUrl()
    });

    await pool.query('SELECT 1');
    await setupTestDatabase(pool);

    driverResolver = new DriverResolver(pool);
    trackResolver = new TrackResolver(pool);
    executor = new QueryExecutor(pool);
    dbAvailable = true;
  } catch {
    console.log('Test database not available, skipping database tests');
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) { return; }
  await cleanupTestDatabase(pool);
  await pool.end();
});

describe('Deterministic identity resolution', () => {
  it.skipIf(!dbAvailable)('resolves seasonal ambiguity using season participation', async () => {
    const result = await driverResolver.resolve('Schumacher', { season: 2020 });
    expect(result.success).toBe(true);
    expect(result.f1db_driver_id).toBe('mick_schumacher');
  });

  it.skipIf(!dbAvailable)('falls back to coverage ranking without season', async () => {
    const result = await driverResolver.resolve('Schumacher');
    expect(result.success).toBe(true);
    expect(result.f1db_driver_id).toBe('michael_schumacher');
  });

  it.skipIf(!dbAvailable)('returns unknown for misspelled names', async () => {
    const result = await driverResolver.resolve('Piastriq');
    expect(result.success).toBe(false);
    expect(result.error).toBe('unknown_driver');
  });
});

describe('Strict literal track resolution', () => {
  it.skipIf(!dbAvailable)('resolves literal circuit names', async () => {
    const result = await trackResolver.resolve('Suzuka');
    expect(result.success).toBe(true);
    expect(result.f1db_track_id).toBe('suzuka');
  });

  it.skipIf(!dbAvailable)('rejects non-literal aliases', async () => {
    const result = await trackResolver.resolve('Japanese GP');
    expect(result.success).toBe(false);
  });
});

describe('Query execution core cases', () => {
  it.skipIf(!dbAvailable)('runs teammate season comparison', async () => {
    const intent: QueryIntent = {
      kind: 'teammate_gap_summary_season',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      season: 2025,
      metric: 'teammate_gap_raw',
      normalization: 'team_baseline',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query: 'Norris vs Piastri 2025'
    };

    const result = await executor.execute(intent);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.result.type).toBe('teammate_gap_summary_season');
      expect(result.result.payload.team_id).toBe('mclaren');
    }
  });

  it.skipIf(!dbAvailable)('runs track driver ranking', async () => {
    const intent: QueryIntent = {
      kind: 'track_fastest_drivers',
      track_id: 'suzuka',
      season: 2023,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Fastest at Suzuka 2023'
    };

    const result = await executor.execute(intent);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.result.type).toBe('driver_ranking');
      expect(result.result.payload.entries.length).toBe(2);
      expect(result.result.payload.entries[0].driver_id).toBe('max_verstappen');
    }
  });

  it.skipIf(!dbAvailable)('runs cross-team season comparison', async () => {
    const intent: QueryIntent = {
      kind: 'season_driver_vs_driver',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'fernando_alonso',
      season: 2023,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query: 'Verstappen vs Alonso 2023'
    };

    const result = await executor.execute(intent);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.result.type).toBe('season_driver_vs_driver');
      expect(result.result.payload.driver_a).toBe('max_verstappen');
      expect(result.result.payload.driver_b).toBe('fernando_alonso');
    }
  });

  it.skipIf(!dbAvailable)('returns teammate gap summary', async () => {
    const intent: QueryIntent = {
      kind: 'teammate_gap_summary_season',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      team_id: 'MCL',
      season: 2025,
      metric: 'teammate_gap_raw',
      normalization: 'team_baseline',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'all',
      raw_query: 'Norris vs Piastri 2025'
    };

    const result = await executor.execute(intent);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.result.type).toBe('teammate_gap_summary_season');
      expect(result.result.payload.team_id).toBe('mclaren');
      expect(result.result.payload.coverage_status).toBe('valid');
    }
  });

  it.skipIf(!dbAvailable)('fails closed on insufficient shared-lap coverage', async () => {
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
      raw_query: 'Max vs Leclerc at Monza 2023'
    };

    const result = await executor.execute(intent);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('execution_failed');
      expect(result.reason).toContain('INSUFFICIENT_DATA');
    }
  });
});
