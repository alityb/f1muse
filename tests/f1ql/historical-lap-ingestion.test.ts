import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestHistoricalLapDataset } from '../../src/etl/historical-lap-ingestion';
import { type HistoricalLapDataset, loadHistoricalLapPilot } from '../../src/etl/historical-lap-window-pilot';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const migration = fs.readFileSync(path.resolve('migrations/20260801_official_timing_historical_laps.sql'), 'utf8');
const sourceContent = fs.readFileSync('data/phase8-belgium-2022-pilot.json');
const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');

let pool: Pool;
let dataset: HistoricalLapDataset;

describe('official historical lap ingestion', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool);
    await pool.query('DROP SCHEMA IF EXISTS official_timing CASCADE');
    const mappings = (JSON.parse(identityContent.toString('utf8')) as { mappings: Array<{ driver_id: string }> }).mappings;
    const canonical = await pool.query<{ driver_id: string; full_name: string }>(`
      SELECT id AS driver_id, full_name FROM driver WHERE id = ANY($1::text[]) ORDER BY id
    `, [mappings.map(mapping => mapping.driver_id)]);
    dataset = loadHistoricalLapPilot(sourceContent, identityContent, canonical.rows);
  });

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS official_timing CASCADE');
    await pool.end();
  });

  it('applies idempotently with private exact relations and all mutation triggers', async () => {
    await pool.query(migration);
    await pool.query(migration);
    const relations = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'official_timing' ORDER BY table_name
    `);
    expect(relations.rows.map(row => row.table_name)).toEqual(['artifact', 'coverage', 'dataset', 'driver_identity', 'lap_fact']);
    const triggers = await pool.query<{ relation_name: string; trigger_name: string; function_schema: string; function_name: string; trigger_type: number }>(`
      SELECT c.relname AS relation_name, t.tgname AS trigger_name, pn.nspname AS function_schema, p.proname AS function_name,
        t.tgtype::integer AS trigger_type
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE n.nspname = 'official_timing' AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
      ORDER BY c.relname, t.tgname
    `);
    expect(triggers.rows).toHaveLength(14);
    expect(triggers.rows.filter(row => row.trigger_name === 'official_timing_immutable'))
      .toEqual(expect.arrayContaining(['artifact', 'coverage', 'dataset', 'driver_identity', 'lap_fact'].map(relationName => ({
        relation_name: relationName, trigger_name: 'official_timing_immutable', function_schema: 'official_timing', function_name: 'reject_mutation', trigger_type: 27
      }))));
    expect(triggers.rows.filter(row => row.trigger_name === 'official_timing_no_truncate').every(row =>
      row.function_schema === 'official_timing' && row.function_name === 'reject_mutation' && Number(row.trigger_type) === 34)).toBe(true);
    expect(triggers.rows.filter(row => row.trigger_name === 'official_timing_no_insert_after_seal').every(row =>
      row.function_schema === 'official_timing' && row.function_name === 'reject_child_insert_after_seal' && Number(row.trigger_type) === 7)).toBe(true);
    const artifactForeignKey = await pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'official_timing.lap_fact'::regclass AND contype = 'f'
    `);
    expect(artifactForeignKey.rows.some(row => row.definition.includes('source_artifact_sha256') && row.definition.includes('artifact'))).toBe(true);
    const privileges = await pool.query<{ schema_usage: boolean; table_select: boolean }>(`
      SELECT has_schema_privilege('public', 'official_timing', 'USAGE') AS schema_usage,
        has_table_privilege('public', 'official_timing.dataset', 'SELECT') AS table_select
    `);
    expect(privileges.rows).toEqual([{ schema_usage: false, table_select: false }]);
  });

  it('rolls back every child row when publication fails before the seal', async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE official_timing.lap_fact IN ACCESS EXCLUSIVE MODE');
      await expect(ingestHistoricalLapDataset(pool, dataset)).rejects.toThrow('lock timeout');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const counts = await pool.query<{ relation: string; count: number }>(`
      SELECT 'artifact' AS relation, count(*)::integer AS count FROM official_timing.artifact
      UNION ALL SELECT 'identity', count(*)::integer FROM official_timing.driver_identity
      UNION ALL SELECT 'fact', count(*)::integer FROM official_timing.lap_fact
      UNION ALL SELECT 'coverage', count(*)::integer FROM official_timing.coverage
      UNION ALL SELECT 'dataset', count(*)::integer FROM official_timing.dataset
      ORDER BY relation
    `);
    expect(counts.rows.every(row => row.count === 0)).toBe(true);
  });

  it('commits all verified evidence once and accepts only an exact replay', async () => {
    const simultaneous = await Promise.all([
      ingestHistoricalLapDataset(pool, dataset),
      ingestHistoricalLapDataset(pool, dataset)
    ]);
    expect(simultaneous.map(result => result.status).sort()).toEqual(['already_committed', 'committed']);
    expect(simultaneous.every(result => result.dataset_sha256 === dataset.dataset_sha256 && result.identity_count === 20 && result.fact_count === 790)).toBe(true);
    await expect(ingestHistoricalLapDataset(pool, dataset)).resolves.toEqual({
      dataset_sha256: dataset.dataset_sha256,
      status: 'already_committed',
      identity_count: 20,
      fact_count: 790
    });
    const counts = await pool.query<{ identities: number; facts: number; coverage: number; artifacts: number }>(`
      SELECT
        (SELECT count(*)::integer FROM official_timing.driver_identity) AS identities,
        (SELECT count(*)::integer FROM official_timing.lap_fact) AS facts,
        (SELECT count(*)::integer FROM official_timing.coverage) AS coverage,
        (SELECT count(*)::integer FROM official_timing.artifact) AS artifacts
    `);
    expect(counts.rows).toEqual([{ identities: 20, facts: 790, coverage: 3, artifacts: 3 }]);
  });

  it('rejects extension, mutation, truncation, and silent scope replacement', async () => {
    await expect(pool.query(`
      INSERT INTO official_timing.coverage
        (dataset_sha256, coverage_kind, expected_count, actual_count, missing_keys, unexpected_keys)
      VALUES ($1, 'late_extension', 0, 0, '[]', '[]')
    `, [dataset.dataset_sha256])).rejects.toThrow('sealed official timing dataset cannot be extended');
    await expect(pool.query('UPDATE official_timing.dataset SET event_name = event_name')).rejects.toThrow('official timing evidence is immutable');
    await expect(pool.query('DELETE FROM official_timing.lap_fact')).rejects.toThrow('official timing evidence is immutable');
    await expect(pool.query('TRUNCATE official_timing.coverage')).rejects.toThrow('official timing evidence is immutable');
    await expect(pool.query(`
      INSERT INTO official_timing.dataset
        (dataset_sha256, contract_version, authority, season, round, session_type, event_name,
         source_manifest_sha256, identity_map_sha256, identity_fingerprint, fact_fingerprint, identity_count, fact_count)
      VALUES ($1, 'immutable_official_lap_event_v1', 'FIA', 2022, 14, 'R', 'conflict', $2, $3, $4, $5, 1, 1)
    `, ['0'.repeat(64), '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)])).rejects.toMatchObject({ code: '23505' });
  });

  it('does not expose the private relations through F1QL', async () => {
    const exposed = await pool.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM information_schema.views
      WHERE table_schema = 'f1ql' AND view_definition ILIKE '%official_timing%'
    `);
    expect(exposed.rows).toEqual([{ count: 0 }]);
  });

  it('retains exact nonempty evidence generated by the persistent emitter', () => {
    const content = fs.readFileSync('data/phase8-belgium-2022-persistent-result.json');
    expect(createHash('sha256').update(content).digest('hex')).toBe('e5f909436c0e69aadac42d5428c34d93cf2c111b1b5a1b7528d4c4b27faf8c04');
    const evidence = JSON.parse(content.toString('utf8')) as {
      dataset_sha256: string;
      committed: { status: string; identity_count: number; fact_count: number };
      replay: { status: string };
      stored: { persistence: string; f1ql_view_count: number };
      f1ql_operation: string;
    };
    expect(evidence).toEqual(expect.objectContaining({
      dataset_sha256: dataset.dataset_sha256,
      committed: expect.objectContaining({ status: 'committed', identity_count: 20, fact_count: 790 }),
      replay: expect.objectContaining({ status: 'already_committed' }),
      stored: expect.objectContaining({ persistence: 'p', f1ql_view_count: 0 }),
      f1ql_operation: 'unsupported'
    }));
  });
});
