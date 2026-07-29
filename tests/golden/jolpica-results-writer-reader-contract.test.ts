import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeF1QL } from '../../src/f1ql/executor';
import { syncResults } from '../../src/sync/jolpica-sync';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await pool.query('SELECT 1');
  await setupTestDatabase(pool);

  await pool.query(`
    INSERT INTO circuit (id, name, full_name)
    VALUES ('bahrain', 'Bahrain', 'Bahrain International Circuit') ON CONFLICT DO NOTHING;
    INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation)
    VALUES ('bahrain', 'Bahrain Grand Prix', 'Formula 1 Bahrain Grand Prix', 'Bahrain GP', 'BHR') ON CONFLICT DO NOTHING;
    INSERT INTO constructor (id, name) VALUES ('mercedes', 'Mercedes') ON CONFLICT DO NOTHING;
    INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation)
    VALUES ('lewis-hamilton', 'Hamilton', 'Lewis Hamilton', 'Lewis', 'Hamilton', 'HAM') ON CONFLICT DO NOTHING;
    INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date)
    VALUES (2601, 2026, 1, 'bahrain', 'bahrain', 'Bahrain Grand Prix', '2026-03-08') ON CONFLICT DO NOTHING;
  `);

  await syncResults(pool, 2026, async () => ({
    RaceTable: {
      Races: [{
        season: '2026',
        round: '1',
        Results: [{
          number: '44',
          positionText: '1',
          points: '25',
          status: 'Finished',
          Driver: { driverId: 'hamilton', permanentNumber: '44' },
          Constructor: { constructorId: 'mercedes' },
          Time: { time: '1:30:00.000' }
        }]
      }]
    }
  }));
});

afterAll(async () => {
  await pool.end();
});

describe('Jolpica race-results writer-to-reader contract', () => {
  it('writes a result the F1QL race-classification reader returns', async () => {
    const result = await executeF1QL(pool, { version: 1, root: { op: 'event_classification', season: 2026, round: 1, limit: 30 } });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].driver_id).toBe('lewis-hamilton');
    expect(Number(result.rows[0].points)).toBe(25);
    expect(result.rows[0].finishing_position).toBe(1);
  });
});
