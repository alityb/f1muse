import { Pool } from 'pg';
import {
  requireConstructorAuthorityAuditConfiguration,
  runConstructorAuthorityAudit,
  serializeConstructorAuthorityAuditReport
} from '../src/audit/constructor-authority';

async function main(): Promise<void> {
  const configuration = requireConstructorAuthorityAuditConfiguration();
  const pool = new Pool({
    connectionString: configuration.connection_string,
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...(configuration.target === 'production' ? { ssl: { rejectUnauthorized: false } } : {})
  });
  try {
    const report = await runConstructorAuthorityAudit(pool, configuration);
    const serialized = `${serializeConstructorAuthorityAuditReport(report)}\n`;
    process.stdout.write(serialized);
    if (report.status !== 'passed') {
      process.exitCode = 1;
    }
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
