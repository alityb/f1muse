import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeF1QL } from '../../src/f1ql/executor';
import { syncStandings } from '../../src/sync/jolpica-sync';
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
  await pool.query(
    `INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver)
     VALUES (2025, 'mercedes', 'mercedes', 'george-russell', false)
     ON CONFLICT DO NOTHING`
  );
});

afterAll(async () => {
  await pool.end();
});

describe('Jolpica standings writer-to-reader contract', () => {
  it('writes official points that the public season-summary query returns', async () => {
    const golden = getGoldenCase('russell-2025-sprint-inclusive-points');
    const expectedPoints = getGoldenAssertion(golden, 'george-russell', 'championship_points');
    const response = await executeF1QL(pool, {
      version: 1,
      root: {
        op: 'aggregate',
        input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025, driver_id: 'george-russell' } },
        group_by: ['driver_id'],
        measures: [{ as: 'points', function: 'max', field: 'points' }]
      }
    });

    expect(response.rows).toEqual([{ driver_id: 'george-russell', points: String(expectedPoints) }]);
  });
});
