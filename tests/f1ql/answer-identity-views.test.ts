import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { linkAnswerF1QLCandidate } from '../../src/f1ql/translation-linking';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;
let migration: string;
const role = 'f1ql_answer_view_test';

describe('answer-only identity views', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool, { seed: false });
    await pool.query('CREATE TABLE driver_aliases (driver_id text, alias text, is_primary boolean)');
    migration = readFileSync(path.resolve(process.cwd(), 'migrations/20260729_f1ql_answer_identity_views.sql'), 'utf8');
    await pool.query(migration);
    await pool.query(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA f1ql TO ${role}; GRANT SELECT ON f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation TO ${role}`);
    await pool.query(`
      INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES
        ('alex_one', 'Alex One', 'Alex Smith', 'Alex', 'Smith', 'AO1'),
        ('alex_two', 'Alex Two', 'Alex Smith', 'Alex', 'Smith', 'AT2');
      INSERT INTO driver_aliases (driver_id, alias, is_primary) VALUES ('alex_one', 'A. Smith', true);
      INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation)
        VALUES ('belgian_gp_answer', 'Belgian Grand Prix', 'Formula 1 Belgian Grand Prix', 'Belgian GP', 'BEL');
      INSERT INTO race (id, year, round, grand_prix_id, official_name)
        VALUES (7001, 2025, 13, 'belgian_gp_answer', 'FORMULA 1 BELGIAN GRAND PRIX 2025');
      INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver)
        VALUES (2025, 'answer-team', 'ANSWER', 'alex_one', false);
      INSERT INTO driver_season_entries (driver_id, year) VALUES ('alex_two', 2025) ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
    await pool.query('DROP TABLE IF EXISTS driver_aliases');
    await pool.end();
  });

  it('exposes only the reviewed columns and is idempotent', async () => {
    await pool.query(migration);
    const columns = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'f1ql' AND table_name LIKE 'answer_%'
      ORDER BY table_name, ordinal_position
    `);
    expect(columns.rows).toEqual([
      { table_name: 'answer_driver_identity', column_name: 'driver_id' },
      { table_name: 'answer_driver_identity', column_name: 'identity' },
      { table_name: 'answer_event_identity', column_name: 'season' },
      { table_name: 'answer_event_identity', column_name: 'round' },
      { table_name: 'answer_event_identity', column_name: 'identity' },
      { table_name: 'answer_season_participation', column_name: 'season' },
      { table_name: 'answer_season_participation', column_name: 'driver_id' },
      { table_name: 'answer_season_participation', column_name: 'participation_source' }
    ]);
    const privileges = await pool.query(`SELECT has_table_privilege('public', view_name, 'SELECT') AS public_select FROM unnest($1::text[]) view_name`, [[
      'f1ql.answer_driver_identity', 'f1ql.answer_event_identity', 'f1ql.answer_season_participation'
    ]]);
    expect(privileges.rows).toEqual([{ public_select: false }, { public_select: false }, { public_select: false }]);
  });

  it('links named events and ambiguous drivers using primary participation before fallback', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      const linked = await linkAnswerF1QLCandidate(client, {
        version: 1,
        root: { op: 'event_classification', season: 2025, event_name: 'Belgium', limit: 30, filters: { driver_id: 'Alex Smith' } }
      });
      expect(linked).toEqual({
        version: 1,
        root: { op: 'event_classification', season: 2025, round: 13, limit: 30, filters: { driver_id: 'alex-one' } }
      });
      await expect(client.query('SELECT id FROM driver LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('contains no direct base-table SQL in the answer resolvers', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/identity/answer-identity-resolvers.ts'), 'utf8');
    expect(source).not.toMatch(/\bFROM\s+(?:public\.)?(?:race|grand_prix|driver|driver_aliases|season_entrant_driver|driver_season_entries)\b/i);
  });
});
