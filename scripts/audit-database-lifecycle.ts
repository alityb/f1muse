import { readdirSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';

const STATEMENT_TIMEOUT_MS = 5_000;
const MIGRATION_LEDGER_CANDIDATES = ['schema_migrations', 'migrations', 'knex_migrations'];
const RELATIONS = [
  'laps_normalized',
  'laps_normalized_v2',
  'pace_v2_lap_replacement',
  'pace_v2_replacement_audit',
  'pace_v2_lap_rebuild',
  'pace_v2_rebuild_audit',
  'pace_v2_identity_repair_audit',
  'f1ql.lap_pace'
] as const;

type QueryClient = { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
type QueryPool = { connect(): Promise<QueryClient>; end(): Promise<void> };
type RelationName = typeof RELATIONS[number];

export interface DatabaseLifecycleAudit {
  status: 'passed' | 'attention';
  assertion_scope: 'read_only_database_lifecycle_audit';
  statement_timeout_ms: number;
  migration_ledger: { committed_files: string[]; database_relation: string | null; status: 'observed' | 'unavailable'; detail: string };
  schema_reconciliation: Array<{ relation: RelationName; kind: 'r' | 'v' | null; columns: string[]; status: 'present' | 'missing' }>;
  relation_sizes: Array<{ relation: string; total_bytes: number; table_bytes: number; indexes_bytes: number }>;
  legacy_consumers: Array<{ dependent: string; dependent_kind: string; dependency_type: string }>;
  correction_layer_dependencies: Array<{ relation: string; exists: boolean; dependencies: string[] }>;
  active_serving_view: { exists: boolean; definition: string | null; selected_sources: Array<{ source: string; rows: number }>; precedence: string[] };
  ledger: Array<{ severity: 'warning' | 'error'; code: string; detail: string }>;
  limitations: string[];
}

export function requireDatabaseLifecycleAuditConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DATABASE_LIFECYCLE_AUDIT_ENABLED !== 'true') throw new Error('Set DATABASE_LIFECYCLE_AUDIT_ENABLED=true to enable the database lifecycle audit.');
  if (environment.DATABASE_LIFECYCLE_AUDIT_TARGET !== 'production') throw new Error('Set DATABASE_LIFECYCLE_AUDIT_TARGET=production to confirm the target.');
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for the database lifecycle audit.');
  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') throw new Error('Database lifecycle audit refuses local database targets.');
  return environment.DATABASE_URL;
}

function committedMigrationFiles(): string[] {
  return readdirSync(path.resolve(process.cwd(), 'migrations'))
    .filter(file => file.endsWith('.sql'))
    .sort();
}

export async function runDatabaseLifecycleAudit(pool: QueryPool, migrationFiles = committedMigrationFiles()): Promise<DatabaseLifecycleAudit> {
  const client = await pool.connect();
  const ledger: DatabaseLifecycleAudit['ledger'] = [];
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);

    const relationRows = await client.query<{ name: string; kind: 'r' | 'v' }>(`
      SELECT n.nspname || '.' || c.relname AS name, c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname || '.' || c.relname) = ANY($1::text[])
         OR (n.nspname = 'public' AND c.relname = ANY($2::text[]))
    `, [RELATIONS, RELATIONS.filter(name => !name.includes('.'))]);
    const present = new Map(relationRows.rows.map(row => [row.name, row.kind]));

    const columns = await client.query<{ relation: string; column_name: string }>(`
      SELECT table_schema || '.' || table_name AS relation, column_name
      FROM information_schema.columns
      WHERE (table_schema || '.' || table_name) = ANY($1::text[])
         OR (table_schema = 'public' AND table_name = ANY($2::text[]))
      ORDER BY relation, ordinal_position
    `, [RELATIONS, RELATIONS.filter(name => !name.includes('.'))]);
    const schemaReconciliation = RELATIONS.map(relation => {
      const qualified = relation.includes('.') ? relation : `public.${relation}`;
      const relationColumns = columns.rows.filter(row => row.relation === qualified).map(row => row.column_name);
      const kind = present.get(qualified) ?? null;
      if (!kind) ledger.push({ severity: relation === 'laps_normalized' ? 'warning' : 'error', code: 'expected_relation_missing', detail: relation });
      return { relation, kind, columns: relationColumns, status: kind ? 'present' as const : 'missing' as const };
    });

    const migrationRelations = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.' || name)::text AS relation FROM unnest($1::text[]) AS name", [MIGRATION_LEDGER_CANDIDATES]
    );
    const migrationRelation = migrationRelations.rows.find(row => row.relation)?.relation ?? null;
    if (!migrationRelation) ledger.push({ severity: 'warning', code: 'migration_ledger_unavailable', detail: 'No recognized public migration ledger relation was found.' });

    const relationSizes = await client.query<{ relation: string; total_bytes: string; table_bytes: string; indexes_bytes: string }>(`
      SELECT n.nspname || '.' || c.relname AS relation,
        pg_total_relation_size(c.oid)::text AS total_bytes,
        pg_relation_size(c.oid)::text AS table_bytes,
        (pg_total_relation_size(c.oid) - pg_relation_size(c.oid))::text AS indexes_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname || '.' || c.relname) = ANY($1::text[])
         OR (n.nspname = 'public' AND c.relname = ANY($2::text[]))
      ORDER BY pg_total_relation_size(c.oid) DESC, relation
    `, [RELATIONS, RELATIONS.filter(name => !name.includes('.'))]);

    const legacyConsumers = await client.query<{ dependent: string; dependent_kind: string; dependency_type: string }>(`
      SELECT DISTINCT dependent_ns.nspname || '.' || dependent.relname AS dependent,
        dependent.relkind AS dependent_kind, dependency.deptype AS dependency_type
      FROM pg_depend dependency
      JOIN pg_class referenced ON referenced.oid = dependency.refobjid
      JOIN pg_namespace referenced_ns ON referenced_ns.oid = referenced.relnamespace
      JOIN pg_class dependent ON dependent.oid = dependency.objid
      JOIN pg_namespace dependent_ns ON dependent_ns.oid = dependent.relnamespace
      WHERE referenced_ns.nspname = 'public' AND referenced.relname = 'laps_normalized'
      ORDER BY dependent
    `);

    const correctionDependencies = await client.query<{ relation: string; dependency: string }>(`
      SELECT source_n.nspname || '.' || source.relname AS relation,
        target_n.nspname || '.' || target.relname AS dependency
      FROM pg_depend dependency
      JOIN pg_rewrite rewrite ON rewrite.oid = dependency.objid
      JOIN pg_class source ON source.oid = rewrite.ev_class
      JOIN pg_namespace source_n ON source_n.oid = source.relnamespace
      JOIN pg_class target ON target.oid = dependency.refobjid
      JOIN pg_namespace target_n ON target_n.oid = target.relnamespace
      WHERE source_n.nspname = 'f1ql' AND source.relname = 'lap_pace'
      ORDER BY dependency
    `);
    const correctionRelations = ['public.pace_v2_lap_replacement', 'public.pace_v2_replacement_audit', 'public.pace_v2_lap_rebuild', 'public.pace_v2_rebuild_audit'];
    const corrections = correctionRelations.map(relation => ({
      relation,
      exists: present.has(relation),
      dependencies: correctionDependencies.rows.filter(row => row.dependency === relation).map(row => row.dependency)
    }));

    const viewDefinitionResult = await client.query<{ definition: string | null }>("SELECT pg_get_viewdef('f1ql.lap_pace'::regclass, true) AS definition WHERE to_regclass('f1ql.lap_pace') IS NOT NULL");
    const viewDefinition = viewDefinitionResult.rows[0]?.definition ?? null;
    if (!viewDefinition) ledger.push({ severity: 'error', code: 'serving_view_missing', detail: 'f1ql.lap_pace' });
    const selectedSources = viewDefinition ? await client.query<{ source: string; rows: string }>(`
      SELECT source, COUNT(*)::text AS rows FROM (
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM pace_v2_rebuild_audit a WHERE a.rebuild_version = 'fastf1_complete_race_v1' AND a.season = l.season AND a.round = l.round AND a.session_type = l.session_type) THEN 'fastf1_complete_race_v1'
          WHEN EXISTS (SELECT 1 FROM pace_v2_replacement_audit a WHERE a.replacement_version = 'nat_pit_flags_v1' AND a.season = l.season AND a.round = l.round AND a.session_type = l.session_type) THEN 'nat_pit_flags_v1'
          ELSE 'laps_normalized_v2'
        END AS source
        FROM f1ql.lap_pace l
      ) selected GROUP BY source ORDER BY source
    `) : { rows: [] };

    await client.query('ROLLBACK');
    return {
      status: ledger.some(item => item.severity === 'error') ? 'attention' : 'passed',
      assertion_scope: 'read_only_database_lifecycle_audit',
      statement_timeout_ms: STATEMENT_TIMEOUT_MS,
      migration_ledger: { committed_files: migrationFiles, database_relation: migrationRelation, status: migrationRelation ? 'observed' : 'unavailable', detail: migrationRelation ? 'Ledger relation presence is observed; migration application history is not inferred without a known ledger schema.' : 'No recognized ledger schema is available for reconciliation.' },
      schema_reconciliation: schemaReconciliation,
      relation_sizes: relationSizes.rows.map(row => ({ relation: row.relation, total_bytes: Number(row.total_bytes), table_bytes: Number(row.table_bytes), indexes_bytes: Number(row.indexes_bytes) })),
      legacy_consumers: legacyConsumers.rows,
      correction_layer_dependencies: corrections,
      active_serving_view: { exists: Boolean(viewDefinition), definition: viewDefinition, selected_sources: selectedSources.rows.map(row => ({ source: row.source, rows: Number(row.rows) })), precedence: ['fastf1_complete_race_v1', 'nat_pit_flags_v1', 'laps_normalized_v2'] },
      ledger,
      limitations: [
        'The committed migration filename inventory is reconciled only to a recognized ledger relation presence; no migration history is guessed from arbitrary table shapes.',
        'Catalog dependencies omit dynamic SQL and external application consumers; legacy consumers are database catalog dependents only.',
        'Source counts classify rows emitted by the active serving view using approved audit presence. They do not validate correction facts or mutate any relation.'
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
  const connectionString = requireDatabaseLifecycleAuditConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const report = await runDatabaseLifecycleAudit(pool);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error: unknown) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
