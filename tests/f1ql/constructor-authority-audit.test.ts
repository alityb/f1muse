import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  computeConstructorAuthorityAuditSha256,
  parseConstructorAuthorityAuditReport,
  requireConstructorAuthorityAuditConfiguration,
  runConstructorAuthorityAudit,
  serializeConstructorAuthorityAuditReport,
  verifyConstructorAuthorityAuditReport,
  type ConstructorAuthorityAuditClient,
  type ConstructorAuthorityAuditPool
} from '../../src/audit/constructor-authority';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

const databaseUrl = getTestDatabaseUrl();
const context = { target: 'localhost' as const, database_target_sha256: 'a'.repeat(64) };
const fixturePath = 'tests/fixtures/constructor-authority-audit.json';
let admin: Pool;

async function seedValidFixture(): Promise<void> {
  await admin.query(`
    INSERT INTO constructor (id, name) VALUES
      ('fixture-alpha', 'Fixture Alpha'),
      ('fixture-beta', 'Fixture Beta'),
      ('fixture-gamma', 'Fixture Gamma');
    INSERT INTO race (id, year, round, official_name, date)
    SELECT 112500 + round, 2025, round, 'Fixture Grand Prix ' || round,
      DATE '2025-01-01' + round
    FROM generate_series(1, 24) AS round;
    INSERT INTO season_constructor_standing
      (year, position_display_order, position_number, position_text, constructor_id, points)
    VALUES
      (2025, 1, 1, '1', 'fixture_alpha', 800.50),
      (2025, 2, 2, '2', 'fixture-beta', 650),
      (2025, 3, 3, '3', 'fixture-gamma', 42.25);
    INSERT INTO race_data
      (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
    SELECT 112500 + round, 'RACE_RESULT', driver_id, constructor_id, position, position, points
    FROM generate_series(1, 24) AS round
    CROSS JOIN (VALUES
      ('fixture-driver-a', 'fixture-alpha', 1, 25),
      ('fixture-driver-b', 'fixture-beta', 2, 18),
      ('fixture-driver-c', 'fixture-gamma', 3, 15)
    ) AS entry(driver_id, constructor_id, position, points);
  `);
}

function auditPool(calls?: string[]): ConstructorAuthorityAuditPool {
  return {
    async connect() {
      const client = await admin.connect();
      return {
        async query<Row extends object>(sql: string, params?: readonly unknown[]) {
          calls?.push(sql);
          return await client.query<Row>(sql, params ? [...params] : undefined);
        },
        release(error?: Error) { client.release(error); }
      };
    },
    async end() {}
  };
}

function productionTargetHash(hostname = 'db.example'): string {
  return createHash('sha256').update([
    'f1ql-constructor-authority-database-target-v2', hostname, '5432', '/f1muse'
  ].join('\n'), 'utf8').digest('hex');
}

describe('retained final-2025 constructor authority candidate audit', () => {
  beforeEach(async () => {
    admin ??= new Pool({ connectionString: databaseUrl, max: 4 });
    await setupTestDatabase(admin, { seed: false });
    await seedValidFixture();
  });

  afterAll(async () => { await admin?.end(); });

  it('fails closed unless guard, target, and independent production hash agree', () => {
    expect(() => requireConstructorAuthorityAuditConfiguration({ DATABASE_URL: databaseUrl })).toThrow('not_enabled');
    expect(() => requireConstructorAuthorityAuditConfiguration({
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'production',
      DATABASE_URL: databaseUrl
    })).toThrow('target_mismatch');
    expect(() => requireConstructorAuthorityAuditConfiguration({
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'production',
      DATABASE_URL: 'postgresql://audit:secret@db.example:5432/f1muse'
    })).toThrow('expected_target_hash_invalid');
    expect(() => requireConstructorAuthorityAuditConfiguration({
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'production',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_EXPECTED_TARGET_SHA256: 'f'.repeat(64),
      DATABASE_URL: 'postgresql://audit:secret@db.example:5432/f1muse'
    })).toThrow('expected_target_mismatch');
    const configuration = requireConstructorAuthorityAuditConfiguration({
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'production',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_EXPECTED_TARGET_SHA256: productionTargetHash(),
      DATABASE_URL: 'postgresql://audit:secret@db.example:5432/f1muse'
    });
    expect(configuration.database_target_sha256).toBe(productionTargetHash());
  });

  it.each([
    '0', '0.0', '0.0.0', '0.0.0.0', '[::]', '[0:0:0:0:0:0:0:0]',
    '[::0.0.0.0]', '[::ffff:0:0]', '[::ffff:0.0.0.0]',
    '[0:0:0:0:0:ffff:0:0]', '[::ffff:0000:0000]', '*'
  ])(
    'rejects unspecified or wildcard production hostname %s', hostname => {
      expect(() => requireConstructorAuthorityAuditConfiguration({
        F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
        F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'production',
        F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_EXPECTED_TARGET_SHA256: 'a'.repeat(64),
        DATABASE_URL: `postgresql://audit:secret@${hostname}:5432/f1muse`
      })).toThrow(/target_mismatch|database_target_invalid/);
    }
  );

  it('keeps localhost target identity independent of credentials', () => {
    const configuration = requireConstructorAuthorityAuditConfiguration({
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'localhost',
      DATABASE_URL: databaseUrl
    });
    const alternate = requireConstructorAuthorityAuditConfiguration({
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_ENABLED: 'true',
      F1QL_CONSTRUCTOR_AUTHORITY_AUDIT_TARGET: 'localhost',
      DATABASE_URL: databaseUrl.replace('postgres:postgres@', 'other:credential@')
    });
    expect(alternate.database_target_sha256).toBe(configuration.database_target_sha256);
  });

  it('passes only the complete retained final-2025 candidate contract', async () => {
    const calls: string[] = [];
    const report = await runConstructorAuthorityAudit(auditPool(calls), context);
    expect(report).toMatchObject({
      version: 2,
      scope: { season: 2025, standing: 'retained_final_candidate', required_round_count: 24 },
      transaction: { read_only: true, statement_timeout_ms: 5_000, max_identity_count: 100, completion: 'rolled_back' },
      schema: { required_column_count: 10, required_key_count: 4, matched_key_count: 4, key_contract_matches: true },
      source: {
        bound_exceeded: false, row_count: 3, raw_identity_count: 3, normalized_identity_count: 3,
        fact_count: 3, duplicate_grain_count: 0, null_identity_count: 0,
        malformed_identity_count: 0, normalization_collision_count: 0,
        null_points_count: 0, invalid_points_count: 0
      },
      identity: { bound_exceeded: false, matched_normalized_identity_count: 3, missing_normalized_identity_count: 0 },
      participation: {
        bound_exceeded: false, classification_row_count: 72, raw_identity_count: 3,
        normalized_identity_count: 3, season_round_count: 24, duplicate_season_round_count: 0,
        invalid_season_round_count: 0, incomplete_constructor_round_count: 0
      },
      membership: { final_standings_only_count: 0, participation_only_count: 0 },
      status: 'passed', reason: 'passed'
    });
    expect(calls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1]).toBe("SELECT set_config('statement_timeout', $1, true)");
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.filter(sql => /^BEGIN\b/.test(sql))).toHaveLength(1);
    expect(calls.every(sql => !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b/i.test(sql))).toBe(true);
  });

  it.each([
    ['public.season_constructor_standing', 'source_relation_missing'],
    ['public.constructor', 'identity_relation_missing'],
    ['public.race', 'participation_relation_missing'],
    ['public.race_data', 'participation_relation_missing']
  ])('distinguishes absent relation %s before any data observation', async (relation, reason) => {
    await admin.query(`DROP TABLE ${relation} CASCADE`);
    const calls: string[] = [];
    const report = await runConstructorAuthorityAudit(auditPool(calls), context);
    expect(report).toMatchObject({ status: 'failed', reason });
    expect(report.source.row_count).toBe(0);
    expect(calls.some(sql => sql.includes('FROM public.season_constructor_standing'))).toBe(false);
  });

  it('enforces all four exact primary or unique key shapes', async () => {
    await admin.query(`ALTER TABLE season_constructor_standing
      DROP CONSTRAINT season_constructor_standing_year_constructor_id_key`);
    let report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'schema_mismatch', schema: { matched_key_count: 3, key_contract_matches: false }
    });

    await setupTestDatabase(admin, { seed: false });
    await seedValidFixture();
    await admin.query('ALTER TABLE race_data DROP CONSTRAINT race_data_pkey');
    await admin.query('ALTER TABLE race_data ADD PRIMARY KEY (race_id, type, position_display_order)');
    report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({ status: 'failed', reason: 'schema_mismatch', schema: { key_contract_matches: false } });
  });

  it('preserves the 101st source row and fails the source bound', async () => {
    await admin.query(`INSERT INTO season_constructor_standing
      (year, position_display_order, position_number, constructor_id, points)
      SELECT 2025, value, value, 'bound-' || value, value
      FROM generate_series(4, 101) AS value`);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'source_bound_exceeded', source: { bound_exceeded: true, row_count: 101 }
    });
  });

  it('preserves the 101st identity row and fails the identity bound', async () => {
    const parts = Array.from({ length: 8 }, () => 'bound');
    const variants = Array.from({ length: 101 }, (_, value) => parts
      .map((part, index) => index === parts.length - 1 ? part : `${part}${value & (1 << index) ? '_' : '-'}`)
      .join(''));
    await admin.query('INSERT INTO constructor (id, name) SELECT id, id FROM unnest($1::text[]) AS id', [variants]);
    await admin.query(`INSERT INTO season_constructor_standing
      (year, position_display_order, position_number, constructor_id, points)
      VALUES (2025, 4, 4, $1, 1)`, [variants[0]]);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'identity_bound_exceeded',
      identity: { bound_exceeded: true, observed_row_count: 101 }
    });
  });

  it('preserves the 101st participation identity and fails the participation bound', async () => {
    await admin.query(`INSERT INTO race_data
      (race_id, type, driver_id, constructor_id, position_display_order, position_number)
      SELECT 112501, 'RACE_RESULT', 'bound-driver-' || value, 'bound-' || value, value + 3, value + 3
      FROM generate_series(1, 98) AS value`);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'participation_bound_exceeded',
      participation: { bound_exceeded: true, observed_identity_group_count: 101 }
    });
  });

  it('rejects an empty final-2025 source', async () => {
    await admin.query('DELETE FROM season_constructor_standing WHERE year = 2025');
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'source_absent'
    });
  });

  it('hashes normalized identities with canonical exact-decimal points', async () => {
    const first = await runConstructorAuthorityAudit(auditPool(), context);
    await admin.query("UPDATE season_constructor_standing SET points = '800.5000'::numeric WHERE constructor_id = 'fixture_alpha'");
    const second = await runConstructorAuthorityAudit(auditPool(), context);
    expect(second.source.fact_set_sha256).toBe(first.source.fact_set_sha256);
    expect(JSON.stringify(second)).not.toContain('800.5');
  });

  it('rejects source normalization collisions', async () => {
    await admin.query(`INSERT INTO season_constructor_standing
      (year, position_display_order, position_number, constructor_id, points)
      VALUES (2025, 4, 4, 'fixture-alpha', 1)`);
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'normalization_collision',
      source: { normalization_collision_count: 1 }
    });
  });

  it('requires every normalized source identity in the constructor relation', async () => {
    await admin.query("DELETE FROM constructor WHERE id = 'fixture-beta'");
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'identity_membership_mismatch',
      identity: { matched_normalized_identity_count: 2, missing_normalized_identity_count: 1 }
    });
  });

  it('rejects identity-side normalization collisions below the identity bound', async () => {
    await admin.query("INSERT INTO constructor (id, name) VALUES ('fixture_alpha', 'Fixture Alpha Alias')");
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'identity_membership_mismatch',
      identity: {
        bound_exceeded: false, observed_row_count: 4,
        matched_normalized_identity_count: 3, normalization_collision_count: 1
      }
    });
  });

  it('rejects missing, duplicate, or out-of-range 2025 schedule rounds', async () => {
    await admin.query('DELETE FROM race_data WHERE race_id = 112524');
    await admin.query('DELETE FROM race WHERE id = 112524');
    let report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({ status: 'failed', reason: 'season_round_coverage_mismatch' });

    await setupTestDatabase(admin, { seed: false });
    await seedValidFixture();
    await admin.query("UPDATE race SET round = 25 WHERE id = 112524");
    report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'season_round_coverage_mismatch', participation: { invalid_season_round_count: 1 }
    });

    await setupTestDatabase(admin, { seed: false });
    await seedValidFixture();
    await admin.query('UPDATE race SET round = 23 WHERE id = 112524');
    report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'season_round_coverage_mismatch',
      participation: { duplicate_season_round_count: 1, season_round_count: 23 }
    });
  });

  it('requires every retained standings constructor in every one of 24 rounds', async () => {
    await admin.query("DELETE FROM race_data WHERE race_id = 112524 AND constructor_id = 'fixture-gamma'");
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'participation_round_coverage_mismatch',
      participation: { incomplete_constructor_round_count: 1 }
    });
  });

  it('rejects absent retained race-classification participation', async () => {
    await admin.query('DELETE FROM race_data');
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'participation_absent',
      participation: {
        classification_row_count: 0, observed_identity_group_count: 0,
        raw_identity_count: 0, normalized_identity_count: 0
      }
    });
  });

  it.each([
    [null, 'null_identity_count'],
    ['Fixture Bad', 'malformed_identity_count']
  ])('rejects invalid participation identity %s', async (value, countField) => {
    await admin.query(`UPDATE race_data SET constructor_id = $1
      WHERE race_id = 112501 AND constructor_id = 'fixture-alpha'`, [value]);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({ status: 'failed', reason: 'participation_identity_invalid' });
    expect(report.participation[countField as 'null_identity_count']).toBe(1);
  });

  it('rejects participation normalization collisions below the participation bound', async () => {
    await admin.query(`UPDATE race_data SET constructor_id = 'fixture_alpha'
      WHERE race_id = 112501 AND constructor_id = 'fixture-alpha'`);
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'participation_identity_invalid',
      participation: {
        bound_exceeded: false, observed_identity_group_count: 4,
        normalized_identity_count: 3, normalization_collision_count: 1
      }
    });
  });

  it('records only hashes and counts for participation membership differences', async () => {
    await admin.query("DELETE FROM race_data WHERE constructor_id = 'fixture-gamma'");
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report.membership.final_standings_only_count).toBe(1);
    expect(JSON.stringify(report)).not.toContain('fixture-gamma');
  });

  it('records a participation-only membership difference', async () => {
    await admin.query(`INSERT INTO race_data
      (race_id, type, driver_id, constructor_id, position_display_order, position_number)
      SELECT 112500 + round, 'RACE_RESULT', 'fixture-driver-extra', 'fixture-extra', 4, 4
      FROM generate_series(1, 24) AS round`);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({
      status: 'failed', reason: 'participation_membership_mismatch',
      membership: { final_standings_only_count: 0, participation_only_count: 1 }
    });
    expect(JSON.stringify(report)).not.toContain('fixture-extra');
  });

  it('rejects duplicate raw season-constructor grain even when the key contract drifted', async () => {
    await admin.query(`ALTER TABLE season_constructor_standing
      DROP CONSTRAINT season_constructor_standing_year_constructor_id_key`);
    await admin.query(`INSERT INTO season_constructor_standing
      (year, position_display_order, position_number, constructor_id, points)
      VALUES (2025, 4, 4, 'fixture-beta', 1)`);
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'duplicate_grain', source: { duplicate_grain_count: 1 }
    });
  });

  it.each([
    [null, 'null_identity', 'null_identity_count'],
    ['Fixture Bad', 'malformed_identity', 'malformed_identity_count']
  ])('rejects null or malformed standing identity %s', async (value, reason, countField) => {
    await admin.query('ALTER TABLE season_constructor_standing ALTER COLUMN constructor_id DROP NOT NULL');
    await admin.query('UPDATE season_constructor_standing SET constructor_id = $1 WHERE position_display_order = 1', [value]);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report.reason).toBe(reason);
    expect(report.source[countField as 'null_identity_count']).toBe(1);
  });

  it('rejects null and non-decimal numeric points without reconstructing totals', async () => {
    await admin.query('ALTER TABLE season_constructor_standing ALTER COLUMN points DROP NOT NULL');
    await admin.query('UPDATE season_constructor_standing SET points = NULL WHERE position_display_order = 1');
    let report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({ status: 'failed', reason: 'null_points', source: { null_points_count: 1 } });
    await admin.query("UPDATE season_constructor_standing SET points = 'NaN'::numeric WHERE position_display_order = 1");
    report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({ status: 'failed', reason: 'invalid_points', source: { invalid_points_count: 1 } });
  });

  it('fails closed on required-column schema drift', async () => {
    await admin.query('ALTER TABLE season_constructor_standing ALTER COLUMN points TYPE text USING points::text');
    expect(await runConstructorAuthorityAudit(auditPool(), context)).toMatchObject({
      status: 'failed', reason: 'schema_mismatch', source: { row_count: 0 }
    });
  });

  it('strictly recomputes failed report reason, arithmetic, and empty hashes', async () => {
    await admin.query("DELETE FROM race_data WHERE constructor_id = 'fixture-gamma'");
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report.status).toBe('failed');
    expect(() => parseConstructorAuthorityAuditReport({ ...report, reason: 'passed', status: 'passed' })).toThrow('report_invalid');
    expect(() => parseConstructorAuthorityAuditReport({
      ...report,
      source: { ...report.source, row_count: report.source.row_count + 1 }
    })).toThrow('report_invalid');
    expect(() => parseConstructorAuthorityAuditReport({
      ...report,
      identity: { ...report.identity, missing_normalized_identity_set_sha256: 'f'.repeat(64) }
    })).toThrow('report_invalid');
  });

  it('strictly recomputes passed report arithmetic and hash equalities', async () => {
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(() => parseConstructorAuthorityAuditReport({
      ...report,
      source: { ...report.source, fact_count: report.source.fact_count - 1 }
    })).toThrow('report_invalid');
    expect(() => parseConstructorAuthorityAuditReport({
      ...report,
      membership: { ...report.membership, participation_only_sha256: 'f'.repeat(64) }
    })).toThrow('report_invalid');
  });

  it('rejects impossible passing schema count and boolean combinations', async () => {
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    const invalidSchemas = [
      { ...report.schema, observed_column_count: 9 },
      { ...report.schema, observed_column_count: 11 },
      { ...report.schema, column_contract_matches: false, observed_column_count: 3 },
      { ...report.schema, observed_key_count: 3 },
      { ...report.schema, matched_key_count: 3 },
      { ...report.schema, key_contract_matches: false },
      { ...report.schema, relation_presence: { ...report.schema.relation_presence, race: false } }
    ];
    for (const schema of invalidSchemas) {
      expect(() => parseConstructorAuthorityAuditReport({ ...report, schema })).toThrow('report_invalid');
    }
  });

  it('rejects impossible failed schema count and boolean combinations', async () => {
    await admin.query(`ALTER TABLE season_constructor_standing
      DROP CONSTRAINT season_constructor_standing_year_constructor_id_key`);
    const report = await runConstructorAuthorityAudit(auditPool(), context);
    expect(report).toMatchObject({ status: 'failed', reason: 'schema_mismatch' });
    const invalidSchemas = [
      { ...report.schema, observed_column_count: 9 },
      { ...report.schema, observed_column_count: 11 },
      { ...report.schema, column_contract_matches: false, observed_column_count: 2 },
      { ...report.schema, observed_key_count: 2 },
      { ...report.schema, matched_key_count: 4 }
    ];
    for (const schema of invalidSchemas) {
      expect(() => parseConstructorAuthorityAuditReport({ ...report, schema })).toThrow('report_invalid');
    }
  });

  it('rolls back after a statement-timeout failure', async () => {
    const calls: string[] = [];
    const pool: ConstructorAuthorityAuditPool = {
      async connect() {
        const client = await admin.connect();
        return {
          async query<Row extends object>(sql: string, params?: readonly unknown[]) {
            calls.push(sql);
            if (sql.includes('FROM pg_class c') && sql.includes('pg_attribute')) {
              const error = new Error('canceling statement due to statement timeout') as Error & { code: string };
              error.code = '57014';
              throw error;
            }
            return await client.query<Row>(sql, params ? [...params] : undefined);
          },
          release(error?: Error) { client.release(error); }
        };
      },
      async end() {}
    };
    await expect(runConstructorAuthorityAudit(pool, context)).rejects.toMatchObject({ code: '57014' });
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it.each([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    "SELECT set_config('statement_timeout', $1, true)",
    'ROLLBACK'
  ])('bounds transaction control and discards the connection when %s stalls', async stalledSql => {
    const releases: Array<Error | undefined> = [];
    const pool: ConstructorAuthorityAuditPool = {
      async connect() {
        const client = await admin.connect();
        return {
          async query<Row extends object>(sql: string, params?: readonly unknown[]) {
            if (sql === stalledSql) return await new Promise<never>(() => undefined);
            return await client.query<Row>(sql, params ? [...params] : undefined);
          },
          release(error?: Error) { releases.push(error); client.release(error); }
        };
      },
      async end() {}
    };
    await expect(runConstructorAuthorityAudit(pool, context, 5)).rejects.toThrow('control_timeout');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
  });

  it('parses the emitter-generated canonical fixture and detects hash drift', () => {
    const bytes = readFileSync(fixturePath, 'utf8');
    const input: unknown = JSON.parse(bytes);
    const report = parseConstructorAuthorityAuditReport(input);
    expect(bytes).toBe(`${serializeConstructorAuthorityAuditReport(report)}\n`);
    expect(report.status).toBe('passed');
    const hash = computeConstructorAuthorityAuditSha256(report);
    expect(verifyConstructorAuthorityAuditReport(report, hash)).toEqual(report);
    const drifted = {
      ...report,
      database_provenance: { ...report.database_provenance, current_user_sha256: 'f'.repeat(64) }
    };
    expect(() => verifyConstructorAuthorityAuditReport(drifted, hash)).toThrow('hash_mismatch');
    expect(() => parseConstructorAuthorityAuditReport({ ...report, rows: ['forbidden'] })).toThrow('report_invalid');
  });

  it('emits no credentials, SQL, raw IDs, points values, or source rows', async () => {
    const serialized = serializeConstructorAuthorityAuditReport(await runConstructorAuthorityAudit(auditPool(), context));
    expect(serialized).not.toMatch(/fixture-(?:alpha|beta|gamma)|fixture_alpha|password|secret|postgresql?:\/\//);
    expect(serialized).not.toMatch(/SELECT |FROM public|points_text|constructor_id|800\.5|650|42\.25/);
    expect(serialized).not.toContain('rows');
  });
});
