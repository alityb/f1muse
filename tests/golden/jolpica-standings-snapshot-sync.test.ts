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
});
