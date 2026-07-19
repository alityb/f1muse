import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';

const outputPath = path.resolve(
  process.cwd(),
  process.argv[2] ?? 'tests/schema/snapshots/production-schema.json'
);

async function main(): Promise<void> {
  if (process.env.ALLOW_SCHEMA_SNAPSHOT !== 'true') {
    throw new Error('Set ALLOW_SCHEMA_SNAPSHOT=true to run a production schema snapshot.');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for a production schema snapshot.');
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");

    const [tables, columns, constraints] = await Promise.all([
      client.query(`
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `),
      client.query(`
        SELECT table_name, column_name, data_type, is_nullable, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `),
      client.query(`
        SELECT tc.table_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
        ORDER BY tc.table_name, tc.constraint_type, kcu.ordinal_position
      `)
    ]);

    const snapshot = {
      captured_at: new Date().toISOString(),
      source: 'DATABASE_URL read-only information_schema query',
      tables: tables.rows,
      columns: columns.rows,
      constraints: constraints.rows
    };

    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await client.query('ROLLBACK');
    console.log(`Schema snapshot written to ${outputPath}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
