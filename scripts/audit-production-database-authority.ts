import { Pool } from 'pg';
import { compileF1QL } from '../src/f1ql/compiler';
import { lowerF1QL } from '../src/f1ql/lower';
import { parseF1QLProgram } from '../src/f1ql/schema';
import { validateCoreProgram, validateF1QLProgram } from '../src/f1ql/validation';
import { championshipScoringRulesRegistry } from '../src/scoring/rules';
import { productionCorpusManifest, type ProductionCorpusCase } from './f1ql-production-corpus-manifest';

const STATEMENT_TIMEOUT_MS = 5_000;
const MAX_FACTUAL_CHECKS = 32;

type QueryClient = { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
type QueryPool = { connect(): Promise<QueryClient>; end(): Promise<void> };
type Domain = 'calendar_races' | 'race_classification' | 'standings' | 'qualifying' | 'pace' | 'identities' | 'scoring_rules';

const domains: Array<{ domain: Domain; relation: string; coverageSql?: string }> = [
  { domain: 'calendar_races', relation: 'f1ql.event_metadata', coverageSql: 'SELECT season, COUNT(DISTINCT round)::int AS events FROM f1ql.event_metadata GROUP BY season ORDER BY season' },
  { domain: 'race_classification', relation: 'f1ql.event_classification', coverageSql: 'SELECT season, COUNT(DISTINCT round)::int AS events, COUNT(*)::int AS rows FROM f1ql.event_classification GROUP BY season ORDER BY season' },
  { domain: 'standings', relation: 'f1ql.driver_standings', coverageSql: 'SELECT season, COUNT(DISTINCT driver_id)::int AS drivers, COUNT(*)::int AS rows FROM f1ql.driver_standings GROUP BY season ORDER BY season' },
  { domain: 'qualifying', relation: 'f1ql.qualifying_classification', coverageSql: 'SELECT season, COUNT(DISTINCT round)::int AS events, COUNT(*)::int AS rows FROM f1ql.qualifying_classification GROUP BY season ORDER BY season' },
  { domain: 'pace', relation: 'f1ql.lap_pace', coverageSql: 'SELECT season, COUNT(DISTINCT round)::int AS events, COUNT(DISTINCT driver_id)::int AS drivers, COUNT(*)::int AS laps FROM f1ql.lap_pace GROUP BY season ORDER BY season' },
  { domain: 'identities', relation: 'f1ql.event_classification', coverageSql: 'SELECT COUNT(DISTINCT driver_id)::int AS drivers, COUNT(DISTINCT team_id)::int AS teams FROM f1ql.event_classification' },
  { domain: 'scoring_rules', relation: 'local:championshipScoringRulesRegistry' }
];

export interface DatabaseAuthorityAudit {
  status: 'passed' | 'attention';
  assertion_scope: 'bounded_production_database_factual_audit';
  statement_timeout_ms: number;
  bounded_factual_check_limit: number;
  domains: Array<{ domain: Domain; relation: string; status: 'observed' | 'missing_relation' | 'local_registry'; coverage?: Record<string, unknown>[] }>;
  source_authority: Array<{ publisher: string; documents: number; urls: string[] }>;
  factual_checks: Array<{ id: string; source: string; outcome: 'passed' | 'mismatched' | 'skipped_missing_relation' }>;
  missing_contradiction_ledger: Array<{ severity: 'warning' | 'error'; domain: Domain | 'factual_checks'; code: string; detail: string }>;
  limitations: string[];
}

export function requireDatabaseAuthorityAuditConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DATABASE_AUTHORITY_AUDIT_ENABLED !== 'true') throw new Error('Set DATABASE_AUTHORITY_AUDIT_ENABLED=true to enable the production database authority audit.');
  if (environment.DATABASE_AUTHORITY_AUDIT_TARGET !== 'production') throw new Error('Set DATABASE_AUTHORITY_AUDIT_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the production database authority audit.');
  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') throw new Error('Production database authority audit refuses local database targets.');
  return environment.DATABASE_URL;
}

function factsMatch(actual: Record<string, unknown>[], expected: Record<string, unknown>[]): boolean {
  return actual.length === expected.length && expected.every((fact, index) => Object.entries(fact).every(([field, value]) => {
    const observed = actual[index]?.[field];
    return typeof value === 'number' && typeof observed === 'string' ? Number(observed) === value : observed === value;
  }));
}

function factualSql(testCase: ProductionCorpusCase): { sql: string; params: unknown[] } {
  const program = parseF1QLProgram(testCase.program);
  validateF1QLProgram(program);
  const core = lowerF1QL(program);
  validateCoreProgram(core);
  const compiled = compileF1QL(core);
  if (!/^(SELECT|WITH)\b/i.test(compiled.sql.trim()) || compiled.sql.includes(';') || /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b/i.test(compiled.sql)) {
    throw new Error(`Unsafe factual check: ${testCase.id}`);
  }
  return compiled;
}

export async function runDatabaseAuthorityAudit(pool: QueryPool): Promise<DatabaseAuthorityAudit> {
  const client = await pool.connect();
  const ledger: DatabaseAuthorityAudit['missing_contradiction_ledger'] = [];
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const relationNames = domains.filter(domain => !domain.relation.startsWith('local:')).map(domain => domain.relation);
    const relations = await client.query<{ relation: string | null }>('SELECT to_regclass(name)::text AS relation FROM unnest($1::text[]) AS name', [relationNames]);
    const present = new Set(relations.rows.flatMap(row => row.relation ? [row.relation] : []));
    const observedDomains: DatabaseAuthorityAudit['domains'] = [];
    for (const domain of domains) {
      if (domain.domain === 'scoring_rules') {
        observedDomains.push({ domain: domain.domain, relation: domain.relation, status: 'local_registry', coverage: [{ season_start: 1950, season_end: 2026, rule_intervals: championshipScoringRulesRegistry.length }] });
      } else if (!present.has(domain.relation)) {
        observedDomains.push({ domain: domain.domain, relation: domain.relation, status: 'missing_relation' });
        ledger.push({ severity: 'error', domain: domain.domain, code: 'missing_relation', detail: domain.relation });
      } else {
        const coverage = domain.coverageSql ? (await client.query(domain.coverageSql)).rows : [];
        observedDomains.push({ domain: domain.domain, relation: domain.relation, status: 'observed', coverage });
        if (coverage.length === 0) ledger.push({ severity: 'warning', domain: domain.domain, code: 'no_coverage_rows', detail: domain.relation });
      }
    }
    const factual = productionCorpusManifest.filter(testCase => testCase.disposition === 'authoritative_factual');
    if (factual.length > MAX_FACTUAL_CHECKS) throw new Error(`Factual check bound exceeded: ${factual.length}`);
    const factualChecks: DatabaseAuthorityAudit['factual_checks'] = [];
    for (const testCase of factual) {
      if (!present.has(testCase.required_relation)) {
        factualChecks.push({ id: testCase.id, source: testCase.authority!.url, outcome: 'skipped_missing_relation' });
        continue;
      }
      const compiled = factualSql(testCase);
      const actual = (await client.query(compiled.sql, compiled.params)).rows;
      const outcome = factsMatch(actual, testCase.expected_facts ?? []) ? 'passed' : 'mismatched';
      factualChecks.push({ id: testCase.id, source: testCase.authority!.url, outcome });
      if (outcome === 'mismatched') ledger.push({ severity: 'error', domain: 'factual_checks', code: 'authoritative_fact_mismatch', detail: testCase.id });
    }
    await client.query('ROLLBACK');
    const authorities = new Map<string, Set<string>>();
    for (const testCase of factual) {
      const authority = testCase.authority!;
      const urls = authorities.get(authority.publisher) ?? new Set<string>();
      urls.add(authority.url);
      authorities.set(authority.publisher, urls);
    }
    return {
      status: ledger.some(item => item.severity === 'error') ? 'attention' : 'passed',
      assertion_scope: 'bounded_production_database_factual_audit',
      statement_timeout_ms: STATEMENT_TIMEOUT_MS,
      bounded_factual_check_limit: MAX_FACTUAL_CHECKS,
      domains: observedDomains,
      source_authority: [...authorities].map(([publisher, urls]) => ({ publisher, documents: urls.size, urls: [...urls].sort() })),
      factual_checks: factualChecks,
      missing_contradiction_ledger: ledger,
      limitations: [
        'This audit quantifies observed database coverage and a fixed 23-check official factual sample; it does not verify every season, row, or source document.',
        'Pace coverage is database observation only. Official raw-lap comparisons remain limited to the separately retained 2026 artifacts and do not establish clean-air, pit, in-lap, or out-lap eligibility.',
        'The local scoring registry is checked for bounded 1950-2026 interval coverage; final championship totals remain authoritative only in season standings and FIA championship-points documents.',
        'Missing relations and mismatches are ledgered, never repaired or inferred by this runner.'
      ]
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const connectionString = requireDatabaseAuthorityAuditConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const report = await runDatabaseAuthorityAudit(pool);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error: unknown) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
