import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { compileF1QL } from '../src/f1ql/compiler';
import { lowerF1QL } from '../src/f1ql/lower';
import { parseF1QLProgram } from '../src/f1ql/schema';
import { validateCoreProgram, validateF1QLProgram } from '../src/f1ql/validation';

const STATEMENT_TIMEOUT_MS = 5_000;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;

type QueryClient = { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
type QueryPool = { connect(): Promise<QueryClient>; end(): Promise<void> };
type Source = 'standings' | 'event_classification' | 'qualifying_classification' | 'event_metadata' | 'lap_pace';

const programs: Array<{ source: Source; program: unknown }> = [
  { source: 'standings', program: { version: 1, root: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2026 } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum', field: 'points' }] } } },
  { source: 'event_classification', program: { version: 1, root: { op: 'event_classification', season: 2026, round: 1, limit: 30 } } },
  { source: 'qualifying_classification', program: { version: 1, root: { op: 'qualifying_classification', season: 2026, round: 1, limit: 30 } } },
  { source: 'event_metadata', program: { version: 1, root: { op: 'event_metadata', season: 2026, round: 1 } } },
  { source: 'lap_pace', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2026, rounds: [1] }, filters: { clean_air_only: true } } } }
];

const paceLayers = [
  ['serving_view', 'f1ql.lap_pace'],
  ['nat_pit_flags_v1', 'pace_v2_lap_replacement'],
  ['fastf1_complete_race_v1', 'pace_v2_lap_rebuild'],
  ['original_v2', 'laps_normalized_v2']
] as const;

export interface F1QLPerformanceEvidence {
  status: 'observed' | 'attention';
  assertion_scope: 'bounded_production_performance_observation';
  statement_timeout_ms: number;
  warmup_runs: number;
  measured_runs: number;
  sources: Array<{ source: Source; query_fingerprint: string; plan: PlanSummary; measurements: Measurement }>;
  lap_pace_correction_layers: Array<{ layer: string; relation: string; status: 'observed' | 'missing_relation'; plan?: PlanSummary; measurements?: Measurement }>;
  limitations: string[];
}

export interface PlanSummary {
  total_cost: number | null;
  plan_rows: number | null;
  node_types: string[];
  relation_names: string[];
}

export interface Measurement { executions: number; row_count: number; p50_ms: number; p95_ms: number }

export function requireF1QLPerformanceEvidenceConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.F1QL_PERFORMANCE_EVIDENCE_ENABLED !== 'true') throw new Error('Set F1QL_PERFORMANCE_EVIDENCE_ENABLED=true to enable F1QL performance evidence.');
  if (environment.F1QL_PERFORMANCE_EVIDENCE_TARGET !== 'production') throw new Error('Set F1QL_PERFORMANCE_EVIDENCE_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for F1QL performance evidence.');
  let hostname: string;
  try { hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase(); } catch { throw new Error('DATABASE_URL must be a valid connection URL.'); }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) throw new Error('F1QL performance evidence refuses local database targets.');
  return environment.DATABASE_URL;
}

function assertReadOnlySelect(sql: string): void {
  const normalized = sql.trim().toUpperCase();
  if ((!normalized.startsWith('SELECT') && !normalized.startsWith('WITH ')) || normalized.includes(';') || /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO)\b/.test(normalized)) throw new Error('Performance evidence compiled an unsafe statement.');
}

function compileProgram(program: unknown): { sql: string; params: unknown[] } {
  const parsed = parseF1QLProgram(program);
  validateF1QLProgram(parsed);
  const core = lowerF1QL(parsed);
  validateCoreProgram(core);
  const compiled = compileF1QL(core);
  assertReadOnlySelect(compiled.sql);
  return compiled;
}

function percentile(sorted: number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

function summarizePlan(value: unknown): PlanSummary {
  const root = Array.isArray(value) ? (value[0] as { Plan?: unknown })?.Plan : undefined;
  const nodeTypes = new Set<string>();
  const relations = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record['Node Type'] === 'string') nodeTypes.add(record['Node Type']);
    if (typeof record['Relation Name'] === 'string' && /^[a-z_][a-z0-9_]*$/i.test(record['Relation Name'])) relations.add(record['Relation Name']);
    for (const child of Object.values(record)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
  };
  visit(root);
  const record = root && typeof root === 'object' ? root as Record<string, unknown> : {};
  return { total_cost: typeof record['Total Cost'] === 'number' ? record['Total Cost'] : null, plan_rows: typeof record['Plan Rows'] === 'number' ? record['Plan Rows'] : null, node_types: [...nodeTypes].sort(), relation_names: [...relations].sort() };
}

async function observe(client: QueryClient, sql: string, params: unknown[]): Promise<{ plan: PlanSummary; measurements: Measurement }> {
  const explained = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON, COSTS true, VERBOSE false, SETTINGS false) ${sql}`, params);
  const plan = summarizePlan(explained.rows[0]?.['QUERY PLAN']);
  for (let index = 0; index < WARMUP_RUNS; index += 1) await client.query(sql, params);
  const durations: number[] = [];
  let rowCount = 0;
  for (let index = 0; index < MEASURED_RUNS; index += 1) {
    const started = process.hrtime.bigint();
    const result = await client.query(sql, params);
    durations.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    rowCount = result.rows.length;
  }
  durations.sort((left, right) => left - right);
  return { plan, measurements: { executions: MEASURED_RUNS, row_count: rowCount, p50_ms: percentile(durations, 0.5), p95_ms: percentile(durations, 0.95) } };
}

export async function collectF1QLPerformanceEvidence(pool: QueryPool): Promise<F1QLPerformanceEvidence> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const sources = [] as F1QLPerformanceEvidence['sources'];
    for (const entry of programs) {
      const compiled = compileProgram(entry.program);
      const observation = await observe(client, compiled.sql, compiled.params);
      sources.push({ source: entry.source, query_fingerprint: createHash('sha256').update(compiled.sql).digest('hex'), ...observation });
    }
    const layers = [] as F1QLPerformanceEvidence['lap_pace_correction_layers'];
    for (const [layer, relation] of paceLayers) {
      const exists = await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [relation]);
      if (exists.rows[0]?.relation !== relation) { layers.push({ layer, relation, status: 'missing_relation' }); continue; }
      const sql = `SELECT COUNT(*)::integer AS row_count FROM ${relation} WHERE season = $1`;
      const observation = await observe(client, sql, [2026]);
      layers.push({ layer, relation, status: 'observed', ...observation });
    }
    await client.query('ROLLBACK');
    return { status: layers.some(layer => layer.status === 'missing_relation') ? 'attention' : 'observed', assertion_scope: 'bounded_production_performance_observation', statement_timeout_ms: STATEMENT_TIMEOUT_MS, warmup_runs: WARMUP_RUNS, measured_runs: MEASURED_RUNS, sources, lap_pace_correction_layers: layers, limitations: ['Measurements are observational p50/p95 wall-clock samples, not release thresholds or a load test.', 'Plans and reports are sanitized: they omit SQL text, parameter values, result values, database URLs, and credentials.', 'Correction-layer observations describe serving and available underlying relations; they do not assert factual pace correctness or change selection.'] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function main(): Promise<void> {
  const connectionString = requireF1QLPerformanceEvidenceConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try { process.stdout.write(`${JSON.stringify(await collectF1QLPerformanceEvidence(pool))}\n`); } finally { await pool.end(); }
}

if (require.main === module) main().catch((error: unknown) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
