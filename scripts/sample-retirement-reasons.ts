import 'dotenv/config';
import { Pool } from 'pg';
import {
  normalizeRetirementReason,
  type RetirementReasonCategory
} from '../src/f1ql/retirement-reasons';

const MAX_SAMPLE_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 5_000;

interface SampleRow {
  raw_reason: string;
  occurrences: string;
}

interface SampleOutput {
  source: 'race_data.race_reason_retired';
  max_sample_rows: number;
  rows: Array<{
    raw_reason: string;
    occurrences: number;
    canonical_reason: RetirementReasonCategory;
  }>;
}

function requireProductionSamplingConfiguration(): string {
  if (process.env.RETIREMENT_REASON_SAMPLING_ENABLED !== 'true') {
    throw new Error('Set RETIREMENT_REASON_SAMPLING_ENABLED=true to enable production sampling.');
  }
  if (process.env.RETIREMENT_REASON_SAMPLING_TARGET !== 'production') {
    throw new Error('Set RETIREMENT_REASON_SAMPLING_TARGET=production to confirm the target.');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for production sampling.');
  }

  const hostname = new URL(connectionString).hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    throw new Error('Retirement-reason sampling refuses local database targets.');
  }

  return connectionString;
}

export function formatRetirementReasonSample(rows: SampleRow[]): SampleOutput {
  return {
    source: 'race_data.race_reason_retired',
    max_sample_rows: MAX_SAMPLE_ROWS,
    rows: rows.map((row) => ({
      raw_reason: row.raw_reason,
      occurrences: Number(row.occurrences),
      canonical_reason: normalizeRetirementReason(row.raw_reason)
    }))
  };
}

async function main(): Promise<void> {
  const connectionString = requireProductionSamplingConfiguration();
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1
  });
  const client = await pool.connect();

  try {
    // One bounded aggregate statement per invocation; no writes or persistent state.
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const result = await client.query<SampleRow>(`
      SELECT race_reason_retired AS raw_reason, COUNT(*)::text AS occurrences
      FROM race_data
      WHERE race_reason_retired IS NOT NULL
        AND BTRIM(race_reason_retired) <> ''
        AND LOWER(type) IN ('race', 'race_result')
      GROUP BY race_reason_retired
      ORDER BY COUNT(*) DESC, race_reason_retired ASC
      LIMIT $1
    `, [MAX_SAMPLE_ROWS]);
    await client.query('ROLLBACK');
    console.log(JSON.stringify(formatRetirementReasonSample(result.rows), null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
