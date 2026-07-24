import { Pool } from 'pg';

const STATEMENT_TIMEOUT_MS = 5_000;
const REQUIRED_RELATIONS = [
  'f1ql.driver_standings',
  'f1ql.event_classification',
  'f1ql.qualifying_classification',
  'f1ql.event_metadata',
  'f1ql.answer_driver_identity',
  'f1ql.answer_event_identity',
  'f1ql.answer_season_participation'
] as const;

type QueryClient = { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
type QueryPool = { connect(): Promise<QueryClient>; end(): Promise<void> };

interface RoleRow {
  role_name: string;
  transaction_read_only: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  database_create: boolean;
  database_temp: boolean;
  f1ql_usage: boolean;
  f1ql_create: boolean;
  public_create: boolean;
}

interface RelationRow {
  relation: string;
  exists: boolean;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
  can_references: boolean;
  can_trigger: boolean;
}

export interface AnswerPrincipalAudit {
  status: 'passed' | 'attention';
  assertion_scope: 'answer_principal_least_privilege';
  statement_timeout_ms: number;
  required_relations: readonly string[];
  findings: string[];
}

export function requireAnswerPrincipalAuditConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED !== 'true') throw new Error('Set F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED=true to enable the answer principal audit.');
  if (environment.F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET !== 'production') throw new Error('Set F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET=production to confirm the target.');
  if (!environment.F1QL_ANSWER_DATABASE_URL) throw new Error('F1QL_ANSWER_DATABASE_URL is required for the answer principal audit.');
  const hostname = new URL(environment.F1QL_ANSWER_DATABASE_URL).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') throw new Error('Production answer principal audit refuses local database targets.');
  return environment.F1QL_ANSWER_DATABASE_URL;
}

export async function runAnswerPrincipalAudit(pool: QueryPool): Promise<AnswerPrincipalAudit> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);
    const role = (await client.query<RoleRow>(`
      SELECT current_user AS role_name, current_setting('transaction_read_only') AS transaction_read_only,
        r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
        has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
        has_database_privilege(current_user, current_database(), 'TEMP') AS database_temp,
        has_schema_privilege(current_user, 'f1ql', 'USAGE') AS f1ql_usage,
        has_schema_privilege(current_user, 'f1ql', 'CREATE') AS f1ql_create,
        has_schema_privilege(current_user, 'public', 'CREATE') AS public_create
      FROM pg_roles r WHERE r.rolname = current_user
    `)).rows[0];
    const relations = (await client.query<RelationRow>(`
      SELECT n.nspname || '.' || c.relname AS relation, true AS exists,
        has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
        has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
        has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
        has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
        has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
        has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_references,
        has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_trigger
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY relation
    `)).rows;
    await client.query('ROLLBACK');
    const findings = evaluate(role, relations);
    return { status: findings.length === 0 ? 'passed' : 'attention', assertion_scope: 'answer_principal_least_privilege', statement_timeout_ms: STATEMENT_TIMEOUT_MS, required_relations: REQUIRED_RELATIONS, findings };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function evaluate(role: RoleRow | undefined, relations: RelationRow[]): string[] {
  if (!role) return ['role_observation_missing'];
  const findings: string[] = [];
  if (role.transaction_read_only !== 'on') findings.push('transaction_not_read_only');
  if (role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls) findings.push('dangerous_role_attribute');
  if (role.database_create || role.database_temp) findings.push('unsafe_database_privilege');
  if (!role.f1ql_usage || role.f1ql_create || role.public_create) findings.push('unsafe_schema_privilege');
  const observed = new Map(relations.map(relation => [relation.relation, relation]));
  for (const required of REQUIRED_RELATIONS) {
    const relation = observed.get(required);
    if (!relation?.exists) findings.push(`missing_relation:${required}`);
    else if (!relation.can_select) findings.push(`select_missing:${required}`);
    if (relation && (relation.can_insert || relation.can_update || relation.can_delete || relation.can_truncate || relation.can_references || relation.can_trigger)) findings.push(`write_privilege:${required}`);
  }
  for (const relation of relations) {
    if (relation.can_select && !REQUIRED_RELATIONS.includes(relation.relation as typeof REQUIRED_RELATIONS[number])) findings.push(`unexpected_select:${relation.relation}`);
  }
  return findings;
}

async function main(): Promise<void> {
  const connectionString = requireAnswerPrincipalAuditConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const report = await runAnswerPrincipalAudit(pool);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error: unknown) => { process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
