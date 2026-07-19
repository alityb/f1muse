import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../../src/execution/query-executor';
import { syncStandings } from '../../src/sync/jolpica-sync';
import { QueryIntent } from '../../src/types/query-intent';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { getGoldenAssertion, getGoldenCase } from './golden-registry';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool);

  const golden = getGoldenCase('russell-2025-sprint-inclusive-points');
  const points = getGoldenAssertion(golden, 'george-russell', 'championship_points');
  if (typeof points !== 'number') {
    throw new Error('Russell standings golden must contain numeric points');
  }

  await syncStandings(pool, 2025, async (path) => {
    if (path.includes('driverstandings')) {
      return {
        StandingsTable: {
          StandingsLists: [{
            DriverStandings: [{
              position: '4',
              points: String(points),
              Driver: { driverId: 'russell' }
            }]
          }]
        }
      };
    }
    return {
      StandingsTable: {
        StandingsLists: [{
          ConstructorStandings: [{
            position: '1',
            points: '500',
            Constructor: { constructorId: 'mercedes' }
          }]
        }]
      }
    };
  });
});

afterAll(async () => {
  await pool.end();
});

describe('Jolpica standings writer-to-reader contract', () => {
  it('writes official points that the public season-summary query returns', async () => {
    const golden = getGoldenCase('russell-2025-sprint-inclusive-points');
    const expectedPoints = getGoldenAssertion(golden, 'george-russell', 'championship_points');
    const executor = new QueryExecutor(pool);
    const intent: QueryIntent = {
      kind: 'driver_season_summary',
      driver_id: 'george_russell',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'George Russell 2025 season'
    };

    const response = await executor.execute(intent);

    expect('error' in response).toBe(false);
    if (!('error' in response)) {
      expect(response.result.type).toBe('driver_season_summary');
      expect(response.result.payload.points).toBe(expectedPoints);
    }
  });
});
