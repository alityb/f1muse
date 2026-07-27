import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestHistoricalLapDataset } from '../../src/etl/historical-lap-ingestion';
import { compareHistoricalLapWindow, type HistoricalLapDataset, loadHistoricalLapPilot } from '../../src/etl/historical-lap-window-pilot';
import { executeF1QL } from '../../src/f1ql/executor';
import { interpretOfficialLapWindowProgram, type OfficialLapTimingRow } from '../../src/f1ql/interpreter';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from '../../src/f1ql/official-lap-window';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { emitOfficialLapWindowF1QL } from '../../scripts/snapshot-phase8-belgium-2022-f1ql';

const storageMigration = fs.readFileSync(path.resolve('migrations/20260801_official_timing_historical_laps.sql'), 'utf8');
const servingMigration = fs.readFileSync(path.resolve('migrations/20260802_f1ql_official_lap_timing.sql'), 'utf8');
const sourceContent = fs.readFileSync('data/phase8-belgium-2022-pilot.json');
const identityContent = fs.readFileSync('data/phase8-belgium-2022-identity-map.json');
const role = 'f1ql_official_lap_test';

let pool: Pool;
let dataset: HistoricalLapDataset;

type SyntheticLap = { driver: 'driver_one' | 'driver_two'; lap: number; time: number; deleted?: boolean; pit?: boolean };

function syntheticHash(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

async function insertSyntheticSealedDataset(season: number, classifiedLaps: number, laps: SyntheticLap[]): Promise<string> {
  const datasetHash = syntheticHash(`dataset-${season}`);
  const historyHash = syntheticHash(`history-${season}`);
  await pool.query('BEGIN');
  try {
    await pool.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [name, hash] of [
      ['deleted_race_lap_times', syntheticHash(`deleted-${season}`)],
      ['final_race_classification', syntheticHash(`classification-${season}`)],
      ['race_history_chart', historyHash]
    ]) {
      await pool.query(`INSERT INTO official_timing.artifact
        (dataset_sha256, artifact_name, source_url, artifact_sha256, bytes) VALUES ($1, $2, $3, $4, 1)`,
      [datasetHash, name, `https://example.invalid/${season}/${name}.pdf`, hash]);
    }
    await pool.query(`INSERT INTO official_timing.driver_identity
      (dataset_sha256, racing_number, official_name, driver_id, canonical_full_name, classified_laps) VALUES
      ($1, '1', 'Driver One', 'driver_one', 'Driver One', $2),
      ($1, '2', 'Driver Two', 'driver_two', 'Driver Two', $2)`, [datasetHash, classifiedLaps]);
    for (const lap of laps) {
      await pool.query(`INSERT INTO official_timing.lap_fact
        (dataset_sha256, racing_number, driver_id, lap_number, lap_time_seconds, leader_gap_seconds,
         official_deleted_lap, official_pit_marker, source_artifact_sha256)
        VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`, [
        datasetHash, lap.driver === 'driver_one' ? '1' : '2', lap.driver, lap.lap, lap.time,
        lap.deleted === true, lap.pit === true, historyHash
      ]);
    }
    await pool.query(`INSERT INTO official_timing.coverage
      (dataset_sha256, coverage_kind, expected_count, actual_count, missing_keys, unexpected_keys) VALUES
      ($1, 'final_classification_to_race_history', $2, $2, '[]', '[]'),
      ($1, 'race_history_to_final_classification', $2, $2, '[]', '[]'),
      ($1, 'official_identity_to_canonical_driver', 2, 2, '[]', '[]')`, [datasetHash, laps.length]);
    await pool.query(`INSERT INTO official_timing.dataset
      (dataset_sha256, contract_version, authority, season, round, session_type, event_name,
       source_manifest_sha256, identity_map_sha256, identity_fingerprint, fact_fingerprint, identity_count, fact_count)
      VALUES ($1, 'immutable_official_lap_event_v1', 'FIA', $2, 1, 'R', $3, $4, $5, $6, $7, 2, $8)`, [
      datasetHash, season, `${season} Synthetic Grand Prix`, syntheticHash(`manifest-${season}`), syntheticHash(`identity-map-${season}`),
      syntheticHash(`identities-${season}`), syntheticHash(`facts-${season}`), laps.length
    ]);
    await pool.query('COMMIT');
    return datasetHash;
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

const program = {
  version: 1 as const,
  root: {
    op: 'official_lap_window_median_compare' as const,
    metric: OFFICIAL_LAP_WINDOW_METRIC_ID,
    season: 2022,
    round: 14,
    driver_a_id: 'max-verstappen',
    driver_b_id: 'fernando-alonso',
    lap_start: 3,
    lap_end: 10
  }
};

describe('sealed official lap timing serving contract', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool);
    const mappings = (JSON.parse(identityContent.toString('utf8')) as { mappings: Array<{ driver_id: string }> }).mappings;
    const canonical = await pool.query<{ driver_id: string; full_name: string }>(
      'SELECT id AS driver_id, full_name FROM driver WHERE id = ANY($1::text[]) ORDER BY id',
      [mappings.map(mapping => mapping.driver_id)]
    );
    dataset = loadHistoricalLapPilot(sourceContent, identityContent, canonical.rows);
    await pool.query(storageMigration);
    await pool.query(servingMigration);
    await pool.query(servingMigration);
    await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
      (2022, 'phase8-red-bull', 'RBR', 'max_verstappen', false),
      (2022, 'phase8-alpine', 'ALP', 'fernando_alonso', false),
      (2022, 'phase8-mercedes', 'MER', 'lewis_hamilton', false)
      ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    await pool.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        EXECUTE 'DROP OWNED BY ${role}';
        EXECUTE 'DROP ROLE ${role}';
      END IF;
    END $$`);
    await pool.end();
  });

  it('is a private security-barrier view and exposes nothing before the seal', async () => {
    const metadata = await pool.query<{ reloptions: string[] | null; public_select: boolean }>(`
      SELECT c.reloptions, has_table_privilege('public', 'f1ql.official_lap_timing', 'SELECT') AS public_select
      FROM pg_class c WHERE c.oid = 'f1ql.official_lap_timing'::regclass
    `);
    expect(metadata.rows).toEqual([{ reloptions: ['security_barrier=true'], public_select: false }]);
    await expect(pool.query('SELECT count(*)::integer AS count FROM f1ql.official_lap_timing')).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('exposes exactly the complete sealed event and no private-table privileges', async () => {
    await expect(ingestHistoricalLapDataset(pool, dataset)).resolves.toMatchObject({ status: 'committed', identity_count: 20, fact_count: 790 });
    const served = await pool.query<{ rows: number; drivers: number; minimum_lap: number; maximum_lap: number }>(`
      SELECT count(*)::integer AS rows, count(DISTINCT driver_id)::integer AS drivers,
        min(lap_number)::integer AS minimum_lap, max(lap_number)::integer AS maximum_lap
      FROM f1ql.official_lap_timing
    `);
    expect(served.rows).toEqual([{ rows: 790, drivers: 19, minimum_lap: 1, maximum_lap: 44 }]);

    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA f1ql TO ${role}`);
    await pool.query(`GRANT SELECT ON f1ql.official_lap_timing TO ${role}`);
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await expect(client.query('SELECT count(*)::integer AS count FROM f1ql.official_lap_timing')).resolves.toMatchObject({ rows: [{ count: 790 }] });
      await expect(client.query('SELECT count(*) FROM official_timing.dataset')).rejects.toMatchObject({ code: '42501' });
      const privileges = await client.query<{ view_select: boolean; view_insert: boolean; schema_create: boolean }>(`
        SELECT has_table_privilege(current_user, 'f1ql.official_lap_timing', 'SELECT') AS view_select,
          has_table_privilege(current_user, 'f1ql.official_lap_timing', 'INSERT') AS view_insert,
          has_schema_privilege(current_user, 'f1ql', 'CREATE') AS schema_create
      `);
      expect(privileges.rows).toEqual([{ view_select: true, view_insert: false, schema_create: false }]);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('rejects a sealed dataset missing one required coverage assertion', async () => {
    const datasetHash = 'a'.repeat(64);
    const historyHash = 'b'.repeat(64);
    await pool.query('BEGIN');
    try {
      await pool.query('SET CONSTRAINTS ALL DEFERRED');
      await pool.query(`INSERT INTO official_timing.artifact
        (dataset_sha256, artifact_name, source_url, artifact_sha256, bytes) VALUES
        ($1, 'deleted_race_lap_times', 'https://example.invalid/deleted.pdf', $2, 1),
        ($1, 'final_race_classification', 'https://example.invalid/classification.pdf', $3, 1),
        ($1, 'race_history_chart', 'https://example.invalid/history.pdf', $4, 1)`,
      [datasetHash, 'c'.repeat(64), 'd'.repeat(64), historyHash]);
      await pool.query(`INSERT INTO official_timing.driver_identity
        (dataset_sha256, racing_number, official_name, driver_id, canonical_full_name, classified_laps) VALUES
        ($1, '1', 'Driver One', 'driver_one', 'Driver One', 2),
        ($1, '2', 'Driver Two', 'driver_two', 'Driver Two', 2)`, [datasetHash]);
      await pool.query(`INSERT INTO official_timing.lap_fact
        (dataset_sha256, racing_number, driver_id, lap_number, lap_time_seconds, leader_gap_seconds, official_deleted_lap, official_pit_marker, source_artifact_sha256) VALUES
        ($1, '1', 'driver_one', 1, 100, NULL, false, false, $2),
        ($1, '1', 'driver_one', 2, 101, NULL, false, false, $2),
        ($1, '2', 'driver_two', 1, 102, NULL, false, false, $2),
        ($1, '2', 'driver_two', 2, 103, NULL, false, false, $2)`, [datasetHash, historyHash]);
      await pool.query(`INSERT INTO official_timing.coverage
        (dataset_sha256, coverage_kind, expected_count, actual_count, missing_keys, unexpected_keys) VALUES
        ($1, 'final_classification_to_race_history', 4, 4, '[]', '[]'),
        ($1, 'race_history_to_final_classification', 4, 4, '[]', '[]')`, [datasetHash]);
      await pool.query(`INSERT INTO official_timing.dataset
        (dataset_sha256, contract_version, authority, season, round, session_type, event_name,
         source_manifest_sha256, identity_map_sha256, identity_fingerprint, fact_fingerprint, identity_count, fact_count)
        VALUES ($1, 'immutable_official_lap_event_v1', 'FIA', 2021, 1, 'R', 'Incomplete Coverage Grand Prix',
          $2, $3, $4, $5, 2, 4)`, [datasetHash, 'e'.repeat(64), 'f'.repeat(64), '1'.repeat(64), '2'.repeat(64)]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    await expect(pool.query('SELECT count(*)::integer AS count FROM f1ql.official_lap_timing WHERE season = 2021')).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('rejects a sealed dataset with an internal lap hole', async () => {
    await insertSyntheticSealedDataset(2019, 3, [
      { driver: 'driver_one', lap: 1, time: 100 },
      { driver: 'driver_one', lap: 3, time: 101 },
      { driver: 'driver_one', lap: 4, time: 102 },
      { driver: 'driver_two', lap: 1, time: 103 },
      { driver: 'driver_two', lap: 2, time: 104 },
      { driver: 'driver_two', lap: 3, time: 105 }
    ]);
    await expect(pool.query('SELECT count(*)::integer AS count FROM f1ql.official_lap_timing WHERE season = 2019')).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('distinguishes deleted/PIT exclusions, integer-millisecond even medians, and a tie in SQL', async () => {
    await insertSyntheticSealedDataset(2020, 4, [
      { driver: 'driver_one', lap: 1, time: 100.001 },
      { driver: 'driver_one', lap: 2, time: 90, deleted: true },
      { driver: 'driver_one', lap: 3, time: 200, pit: true },
      { driver: 'driver_one', lap: 4, time: 100.002 },
      { driver: 'driver_two', lap: 1, time: 100 },
      { driver: 'driver_two', lap: 2, time: 100.001 },
      { driver: 'driver_two', lap: 3, time: 100.002 },
      { driver: 'driver_two', lap: 4, time: 101 }
    ]);
    await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
      (2020, 'synthetic-one', 'ONE', 'driver_one', false),
      (2020, 'synthetic-two', 'TWO', 'driver_two', false) ON CONFLICT DO NOTHING`);
    const syntheticProgram = {
      ...program,
      root: {
        ...program.root,
        season: 2020,
        round: 1,
        driver_a_id: 'driver-one',
        driver_b_id: 'driver-two',
        lap_start: 1,
        lap_end: 4
      }
    };
    await expect(executeF1QL(pool, syntheticProgram, { maxRows: 1 })).resolves.toMatchObject({ rows: [{
      driver_a_excluded_deleted_laps: 1,
      driver_a_excluded_pit_marker_laps: 1,
      driver_a_eligible_laps: 2,
      driver_b_eligible_laps: 4,
      driver_a_median_lap_time_seconds: 100.0015,
      driver_b_median_lap_time_seconds: 100.0015,
      median_delta_seconds: 0,
      winner_driver_id: null
    }] });
  });

  it('executes the closed metric with exact equivalence to the verified reference', async () => {
    const reference = compareHistoricalLapWindow(dataset, {
      driver_ids: ['max_verstappen', 'fernando_alonso'],
      lap_start: 3,
      lap_end: 10
    });
    const result = await executeF1QL(pool, program, { statementTimeoutMs: 1000, maxRows: 1 });
    expect(result.rendering).toContain('safety-car, weather, traffic, tyre, fuel, and race-state effects included');
    expect(result.rows).toEqual([expect.objectContaining({
      metric_id: reference.metric.id,
      driver_a_id: 'max-verstappen',
      driver_b_id: 'fernando-alonso',
      driver_a_eligible_laps: reference.drivers[0].eligible_laps,
      driver_b_eligible_laps: reference.drivers[1].eligible_laps,
      driver_a_median_lap_time_seconds: reference.drivers[0].median_lap_time_seconds,
      driver_b_median_lap_time_seconds: reference.drivers[1].median_lap_time_seconds,
      median_delta_seconds: reference.median_delta_seconds,
      winner_driver_id: 'max-verstappen',
      dataset_sha256: dataset.dataset_sha256
    })]);
    const sourceRows = await pool.query<OfficialLapTimingRow>('SELECT * FROM f1ql.official_lap_timing WHERE season = 2022 AND round = 14');
    const interpreted = interpretOfficialLapWindowProgram(result.core_program, sourceRows.rows.map(row => ({
      ...row,
      lap_number: Number(row.lap_number),
      lap_time_seconds: Number(row.lap_time_seconds)
    })));
    expect(interpreted).toEqual(result.rows);

    const reversed = { ...program, root: { ...program.root, driver_a_id: 'fernando-alonso', driver_b_id: 'max-verstappen' } };
    await expect(executeF1QL(pool, reversed, { maxRows: 1 })).resolves.toMatchObject({ rows: [expect.objectContaining({
      driver_a_median_lap_time_seconds: reference.drivers[1].median_lap_time_seconds,
      driver_b_median_lap_time_seconds: reference.drivers[0].median_lap_time_seconds,
      median_delta_seconds: reference.median_delta_seconds,
      winner_driver_id: 'max-verstappen'
    })] });
  });

  it('excludes explicit PIT laps and returns no partial comparison for insufficient coverage', async () => {
    const pitWindow = {
      ...program,
      root: { ...program.root, lap_start: 14, lap_end: 16 }
    };
    const reference = compareHistoricalLapWindow(dataset, {
      driver_ids: ['max_verstappen', 'fernando_alonso'],
      lap_start: 14,
      lap_end: 16
    });
    await expect(executeF1QL(pool, pitWindow, { maxRows: 1 })).resolves.toMatchObject({ rows: [expect.objectContaining({
      driver_a_eligible_laps: reference.drivers[0].eligible_laps,
      driver_a_excluded_pit_marker_laps: 1,
      driver_a_median_lap_time_seconds: reference.drivers[0].median_lap_time_seconds
    })] });

    const fewerThanTwo = { ...program, root: { ...program.root, lap_start: 14, lap_end: 15 } };
    await expect(executeF1QL(pool, fewerThanTwo, { maxRows: 1 })).resolves.toMatchObject({ rows: [] });

    const missingDriverCoverage = {
      ...program,
      root: { ...program.root, driver_b_id: 'lewis-hamilton' }
    };
    await expect(executeF1QL(pool, missingDriverCoverage, { maxRows: 1 })).resolves.toMatchObject({ rows: [] });
  });

  it('regenerates the complete nonempty bounded F1QL result with answer access denied', async () => {
    const content = fs.readFileSync('data/phase8-belgium-2022-f1ql-result.json');
    expect(createHash('sha256').update(content).digest('hex')).toBe('a7b82d2986743750393c1850d85a455e2c218cea57d6572d0195a0ca4390f29b');
    const expected = JSON.parse(content.toString('utf8'));
    expect(expected).toMatchObject({
      emitter: 'localhost_sealed_official_lap_f1ql_v1',
      definitions_version: 'v3',
      compiler_version: 'core-v2',
      fact_space_version: 'source-views-v2',
      answer_policy: { type: 'rejected', reason: 'capability_unsupported' },
      rows: [{ metric_id: OFFICIAL_LAP_WINDOW_METRIC_ID, median_delta_seconds: 1.3335, winner_driver_id: 'max-verstappen' }]
    });
    await expect(emitOfficialLapWindowF1QL(getTestDatabaseUrl())).resolves.toEqual(expected);
  });
});
