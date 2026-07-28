import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { syncStandings } from '../../src/sync/jolpica-sync';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

interface SnapshotStanding {
  position: string;
  points: string;
}

interface StandingsSnapshot {
  payload: {
    MRData: {
      StandingsTable: {
        season: string;
        StandingsLists: Array<{ DriverStandings: SnapshotStanding[] }>;
      };
    };
  };
}

const snapshotsDirectory = resolve(process.cwd(), 'tests/golden/snapshots');
const snapshotFiles = readdirSync(snapshotsDirectory)
  .filter((name) => /^jolpica-\d{4}-driverstandings\.json$/.test(name))
  .sort()
  .map((name) => `tests/golden/snapshots/${name}`);
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool, { seed: false });
});

afterAll(async () => {
  await pool.end();
});

describe('Jolpica standings snapshot sync', () => {
  for (const snapshotFile of snapshotFiles) {
    it(`preserves every position and point total from ${snapshotFile}`, async () => {
      const snapshot = JSON.parse(
        readFileSync(resolve(process.cwd(), snapshotFile), 'utf8')
      ) as StandingsSnapshot;
      const mrdata = snapshot.payload.MRData;
      const season = Number(mrdata.StandingsTable.season);
      const expected = mrdata.StandingsTable.StandingsLists[0].DriverStandings;

      await syncStandings(pool, season, async (path) => {
        if (path.includes('driverstandings')) {
          return mrdata;
        }
        return { StandingsTable: { StandingsLists: [] } };
      });

      const actual = await pool.query<{ position_number: number; points: string }>(
        `SELECT position_number, points
         FROM season_driver_standing
         WHERE year = $1
         ORDER BY position_display_order`,
        [season]
      );

      expect(actual.rows).toHaveLength(expected.length);
      expect(actual.rows).toEqual(expected.map((standing) => ({
        position_number: Number(standing.position),
        points: standing.points
      })));
    });
  }

  it('rolls back an incomplete standings replacement', async () => {
    const season = 2099;
    await pool.query(`INSERT INTO season_driver_standing
      (year, position_display_order, position_number, position_text, driver_id, points)
      VALUES ($1, 1, 1, '1', 'existing-driver', 99)`, [season]);
    await pool.query(`INSERT INTO season_constructor_standing
      (year, position_display_order, position_number, position_text, constructor_id, engine_manufacturer_id, points)
      VALUES ($1, 1, 1, '1', 'existing-constructor', 'existing-engine', 88)`, [season]);

    await expect(syncStandings(pool, season, async path => path.includes('driverstandings')
      ? { StandingsTable: { StandingsLists: [{ DriverStandings: [{ position: '1', points: '10', Driver: { driverId: 'replacement-driver' } }] }] } }
      : { StandingsTable: { StandingsLists: [{ ConstructorStandings: [
        { position: '1', points: '9', Constructor: { constructorId: 'replacement-constructor' } },
        { position: 'invalid', points: '5', Constructor: { constructorId: 'broken-constructor' } }
      ] }] } })).rejects.toThrow();

    const actual = await pool.query('SELECT driver_id, points FROM season_driver_standing WHERE year = $1', [season]);
    expect(actual.rows).toEqual([{ driver_id: 'existing-driver', points: '99' }]);
    const constructors = await pool.query('SELECT constructor_id, points FROM season_constructor_standing WHERE year = $1', [season]);
    expect(constructors.rows).toEqual([{ constructor_id: 'existing-constructor', points: '88' }]);
  });
});
