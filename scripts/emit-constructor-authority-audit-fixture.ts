import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import {
  requireConstructorAuthorityAuditConfiguration,
  runConstructorAuthorityAudit,
  serializeConstructorAuthorityAuditReport
} from '../src/audit/constructor-authority';
import { setupTestDatabase } from '../src/test/setup';

const FIXTURE_PATH = path.resolve(process.cwd(), 'tests/fixtures/constructor-authority-audit.json');

async function main(): Promise<void> {
  const configuration = requireConstructorAuthorityAuditConfiguration();
  if (configuration.target !== 'localhost') {
    throw new Error('constructor_authority_audit_fixture_target_invalid');
  }
  const admin = new Pool({ connectionString: configuration.connection_string, max: 1 });
  try {
    await setupTestDatabase(admin, { seed: false });
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
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: configuration.connection_string, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const report = await runConstructorAuthorityAudit(pool, configuration);
    const serialized = `${serializeConstructorAuthorityAuditReport(report)}\n`;
    if (report.status !== 'passed') {
      throw new Error('constructor_authority_audit_fixture_failed');
    }
    writeFileSync(FIXTURE_PATH, serialized, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(serialized);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  });
}
