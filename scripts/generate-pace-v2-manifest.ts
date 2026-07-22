import 'dotenv/config';
import { Pool } from 'pg';
import { generatePaceV2Manifest } from '../src/etl/pace-v2-manifest';

export async function runPaceV2ManifestGenerator(pool: Pool, season: number, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", ['5000ms']);
    const manifest = await generatePaceV2Manifest(client, season, now);
    await client.query('ROLLBACK');
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const season = Number(process.argv[2]);
  if (!Number.isInteger(season)) throw new Error('Usage: npm run pace:v2:manifest -- <season>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    process.stdout.write(`${JSON.stringify(await runPaceV2ManifestGenerator(pool, season))}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused","error":"pace_v2_manifest_failed"}\n'); process.exitCode = 1; });
