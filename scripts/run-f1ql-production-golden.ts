import { Pool } from 'pg';
import { compileF1QL } from '../src/f1ql/compiler';
import { lowerF1QL } from '../src/f1ql/lower';
import { parseF1QLProgram } from '../src/f1ql/schema';
import { validateCoreProgram, validateF1QLProgram } from '../src/f1ql/validation';
import { productionCorpusAudit, productionCorpusManifest, type ProductionCorpusCase } from './f1ql-production-corpus-manifest';

const STATEMENT_TIMEOUT_MS = 5_000;

interface QueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}

interface QueryPool {
  connect(): Promise<QueryClient>;
  end(): Promise<void>;
}

export interface ProductionGoldenResult {
  status: 'passed' | 'failed';
  statement_timeout_ms: number;
  cases: Array<{
    id: string;
    disposition: ProductionCorpusCase['disposition'];
    outcome: 'passed' | 'failed' | 'skipped';
    required_relation: string;
    authority?: ProductionCorpusCase['authority'];
    expected_facts?: Array<Record<string, unknown>>;
    actual_rows?: Array<Record<string, unknown>>;
    matched: boolean;
    skip_reason?: 'missing_production_view';
  }>;
  corpus_audit: typeof productionCorpusAudit;
}

export function requireProductionGoldenConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.F1QL_PRODUCTION_GOLDEN_ENABLED !== 'true') {
    throw new Error('Set F1QL_PRODUCTION_GOLDEN_ENABLED=true to enable the production golden run.');
  }
  if (environment.F1QL_PRODUCTION_GOLDEN_TARGET !== 'production') {
    throw new Error('Set F1QL_PRODUCTION_GOLDEN_TARGET=production to confirm the target.');
  }
  if (!environment.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the production golden run.');
  }

  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    throw new Error('Production golden run refuses local database targets.');
  }
  return environment.DATABASE_URL;
}

function hasExpectedFacts(actual: Record<string, unknown>[], expected: Array<Record<string, unknown>>): boolean {
  return actual.length === expected.length && expected.every((fact, index) =>
    Object.entries(fact).every(([field, value]) => valuesMatch(actual[index]?.[field], value))
  );
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number' && typeof actual === 'string') {
    return Number(actual) === expected;
  }
  return actual === expected;
}

function assertReadOnlySelect(sql: string): void {
  const normalized = sql.trim().toUpperCase();
  if ((!normalized.startsWith('SELECT') && !normalized.startsWith('WITH '))
    || normalized.includes(';')
    || /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO)\b/.test(normalized)) {
    throw new Error('Production golden manifest compiled an unsafe statement.');
  }
}

export async function runProductionGolden(pool: QueryPool): Promise<ProductionGoldenResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const cases: ProductionGoldenResult['cases'] = [];
    const relationExists = new Map<string, boolean>();
    for (const testCase of productionCorpusManifest) {
      let exists = relationExists.get(testCase.required_relation);
      if (exists === undefined) {
        const result = await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [testCase.required_relation]);
        exists = result.rows[0]?.relation === testCase.required_relation;
        relationExists.set(testCase.required_relation, exists);
      }
      if (!exists) {
        cases.push({ id: testCase.id, disposition: testCase.disposition, outcome: 'skipped', required_relation: testCase.required_relation, authority: testCase.authority, expected_facts: testCase.expected_facts, matched: false, skip_reason: 'missing_production_view' });
        continue;
      }
      const program = parseF1QLProgram(testCase.program);
      validateF1QLProgram(program);
      const coreProgram = lowerF1QL(program);
      validateCoreProgram(coreProgram);
      const compiled = compileF1QL(coreProgram);
      assertReadOnlySelect(compiled.sql);
      const result = await client.query(compiled.sql, compiled.params);
      cases.push({
        id: testCase.id,
        disposition: testCase.disposition,
        outcome: testCase.disposition === 'authoritative_factual' && !hasExpectedFacts(result.rows, testCase.expected_facts ?? []) ? 'failed' : 'passed',
        required_relation: testCase.required_relation,
        authority: testCase.authority,
        expected_facts: testCase.expected_facts,
        actual_rows: result.rows,
        matched: testCase.disposition === 'production_runnable_structural' || hasExpectedFacts(result.rows, testCase.expected_facts ?? [])
      });
    }
    await client.query('ROLLBACK');
    return {
      status: cases.every(testCase => testCase.outcome !== 'failed') ? 'passed' : 'failed',
      statement_timeout_ms: STATEMENT_TIMEOUT_MS,
      cases,
      corpus_audit: productionCorpusAudit
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const connectionString = requireProductionGoldenConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const result = await runProductionGolden(pool);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
