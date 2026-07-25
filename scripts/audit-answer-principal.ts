import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { Pool } from 'pg';
import { buildAnswerDatabasePoolConfig } from '../src/db/answer-database';

export const ANSWER_PRINCIPAL_AUDIT_VERSION = 4 as const;
export const ANSWER_PRINCIPAL_AUDIT_TIMEOUT_MS = 5_000;
export const ANSWER_PRINCIPAL_ALLOWED_ROUTINES = [] as const;
export const ANSWER_PRINCIPAL_REQUIRED_RELATIONS = [
  'f1ql.driver_standings',
  'f1ql.event_classification',
  'f1ql.qualifying_classification',
  'f1ql.event_metadata',
  'f1ql.answer_driver_identity',
  'f1ql.answer_event_identity',
  'f1ql.answer_season_participation'
] as const;

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

type QueryClient = { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>; release(): void };
type QueryPool = { connect(): Promise<QueryClient>; end(): Promise<void> };

interface RoleRow {
  role_name: string;
  database_name: string;
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

interface MembershipRow {
  role_name: string;
  depth: number;
  admin_option: boolean;
  can_set_role: boolean;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
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

interface RoutineObservationRow {
  routine_observation_count: number;
  effective_routine_execute_count: number;
}

export interface AnswerPrincipalAuditContext {
  readonly target: 'production';
  readonly commit_sha: string;
  readonly deployment_id: string;
  readonly release_id: string;
  readonly key_id: string;
  readonly private_key: KeyObject;
  readonly audited_at?: string;
}

export interface AnswerPrincipalAuditReport {
  readonly version: typeof ANSWER_PRINCIPAL_AUDIT_VERSION;
  readonly kind: 'f1ql_answer_principal_audit';
  readonly target: 'production';
  readonly audited_at: string;
  readonly commit_sha: string;
  readonly deployment_id: string;
  readonly release_id: string;
  readonly current_user_sha256: string;
  readonly current_database_sha256: string;
  readonly assertion_scope: 'answer_principal_least_privilege';
  readonly statement_timeout_ms: number;
  readonly required_relations: readonly string[];
  readonly routine_observation_count: number;
  readonly effective_routine_execute_count: number;
  readonly status: 'passed' | 'attention';
  readonly findings: readonly string[];
  readonly production_evidence: {
    readonly key_id: string;
    readonly algorithm: 'Ed25519';
    readonly signature: string;
  };
}

export type UnsignedAnswerPrincipalAuditReport = Omit<AnswerPrincipalAuditReport, 'production_evidence'> & {
  readonly production_evidence: { readonly key_id: string; readonly algorithm: 'Ed25519' };
};

export interface TrustedProductionEvidenceKey {
  readonly key_id: string;
  readonly public_key: KeyObject | string | Buffer;
}

export function requireAnswerPrincipalAuditConfiguration(environment: NodeJS.ProcessEnv = process.env): { pool_config: ReturnType<typeof buildAnswerDatabasePoolConfig>; context: AnswerPrincipalAuditContext } {
  if (environment.F1QL_ANSWER_PRINCIPAL_AUDIT_ENABLED !== 'true') throw new Error('answer_principal_audit_not_enabled');
  if (environment.F1QL_ANSWER_PRINCIPAL_AUDIT_TARGET !== 'production') throw new Error('answer_principal_audit_target_invalid');
  const connectionString = required(environment, 'F1QL_ANSWER_DATABASE_URL');
  const hostname = new URL(connectionString).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') throw new Error('answer_principal_audit_refuses_local_target');
  const commitSha = required(environment, 'RAILWAY_GIT_COMMIT_SHA');
  const deploymentId = required(environment, 'F1QL_ANSWER_DEPLOYMENT_ID');
  const releaseId = required(environment, 'F1QL_ANSWER_RELEASE_ID');
  const keyId = required(environment, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID');
  if (!COMMIT_SHA.test(commitSha) || !IDENTIFIER.test(deploymentId) || !IDENTIFIER.test(releaseId) || !IDENTIFIER.test(keyId)) {
    throw new Error('answer_principal_audit_context_invalid');
  }
  return {
    pool_config: buildAnswerDatabasePoolConfig(connectionString, required(environment, 'F1QL_ANSWER_DATABASE_CA_CERT_BASE64', 100_000)),
    context: {
      target: 'production', commit_sha: commitSha, deployment_id: deploymentId, release_id: releaseId, key_id: keyId,
      private_key: loadPrivateKey(required(environment, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64'))
    }
  };
}

export async function runAnswerPrincipalAudit(pool: QueryPool, context: AnswerPrincipalAuditContext): Promise<AnswerPrincipalAuditReport> {
  validateContext(context);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${ANSWER_PRINCIPAL_AUDIT_TIMEOUT_MS}ms`]);
    const role = (await client.query<RoleRow>(`
      SELECT current_user AS role_name, current_database() AS database_name,
        current_setting('transaction_read_only') AS transaction_read_only,
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
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_references,
        has_schema_privilege(current_user, n.oid, 'USAGE') AND has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_trigger
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY relation
    `)).rows;
    const memberships = (await client.query<MembershipRow>(`
      WITH RECURSIVE memberships AS (
        SELECT m.roleid, 1 AS depth, m.admin_option, ARRAY[m.member, m.roleid] AS path
        FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member
        WHERE member.rolname = current_user
        UNION ALL
        SELECT m.roleid, memberships.depth + 1, m.admin_option, memberships.path || m.roleid
        FROM memberships JOIN pg_auth_members m ON m.member = memberships.roleid
        WHERE NOT m.roleid = ANY(memberships.path)
      )
      SELECT r.rolname AS role_name, memberships.depth, memberships.admin_option,
        TRUE AS can_set_role,
        r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
      FROM memberships JOIN pg_roles r ON r.oid = memberships.roleid
      ORDER BY memberships.depth, r.rolname
    `)).rows;
    const routines = (await client.query<RoutineObservationRow>(`
      SELECT COUNT(*)::integer AS routine_observation_count,
        (COUNT(*) FILTER (WHERE has_schema_privilege(current_user, n.oid, 'USAGE')
          AND has_function_privilege(current_user, p.oid, 'EXECUTE')))::integer AS effective_routine_execute_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    `)).rows[0];
    await client.query('ROLLBACK');
    if (!role || typeof role.role_name !== 'string' || typeof role.database_name !== 'string' || !validRoutineObservation(routines)) {
      throw new Error('answer_principal_identity_observation_missing');
    }
    const findings = evaluate(role, relations, memberships, routines);
    const unsigned: UnsignedAnswerPrincipalAuditReport = {
      version: ANSWER_PRINCIPAL_AUDIT_VERSION,
      kind: 'f1ql_answer_principal_audit',
      target: 'production',
      audited_at: context.audited_at ?? new Date().toISOString(),
      commit_sha: context.commit_sha,
      deployment_id: context.deployment_id,
      release_id: context.release_id,
      current_user_sha256: sha256(role.role_name),
      current_database_sha256: sha256(role.database_name),
      assertion_scope: 'answer_principal_least_privilege',
      statement_timeout_ms: ANSWER_PRINCIPAL_AUDIT_TIMEOUT_MS,
      required_relations: ANSWER_PRINCIPAL_REQUIRED_RELATIONS,
      routine_observation_count: routines.routine_observation_count,
      effective_routine_execute_count: routines.effective_routine_execute_count,
      status: findings.length === 0 ? 'passed' : 'attention',
      findings,
      production_evidence: { key_id: context.key_id, algorithm: 'Ed25519' }
    };
    const parsed = parseAnswerPrincipalAuditReport({
      ...unsigned,
      production_evidence: {
        ...unsigned.production_evidence,
        signature: sign(null, getAnswerPrincipalAuditSigningPayload(unsigned), context.private_key).toString('base64')
      }
    });
    return parsed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function parseAnswerPrincipalAuditReport(input: unknown): AnswerPrincipalAuditReport {
  const value = strictRecord(input, [
    'version', 'kind', 'target', 'audited_at', 'commit_sha', 'deployment_id', 'release_id',
    'current_user_sha256', 'current_database_sha256', 'assertion_scope', 'statement_timeout_ms',
    'required_relations', 'routine_observation_count', 'effective_routine_execute_count', 'status', 'findings', 'production_evidence'
  ]);
  const evidence = strictRecord(value.production_evidence, ['key_id', 'algorithm', 'signature']);
  if (value.version !== ANSWER_PRINCIPAL_AUDIT_VERSION || value.kind !== 'f1ql_answer_principal_audit' || value.target !== 'production' ||
      typeof value.audited_at !== 'string' || !isIsoDate(value.audited_at) || typeof value.commit_sha !== 'string' || !COMMIT_SHA.test(value.commit_sha) ||
      typeof value.deployment_id !== 'string' || !IDENTIFIER.test(value.deployment_id) || typeof value.release_id !== 'string' || !IDENTIFIER.test(value.release_id) ||
      typeof value.current_user_sha256 !== 'string' || !SHA256.test(value.current_user_sha256) || typeof value.current_database_sha256 !== 'string' || !SHA256.test(value.current_database_sha256) ||
       value.assertion_scope !== 'answer_principal_least_privilege' || value.statement_timeout_ms !== ANSWER_PRINCIPAL_AUDIT_TIMEOUT_MS ||
       !sameStrings(value.required_relations, ANSWER_PRINCIPAL_REQUIRED_RELATIONS) || (value.status !== 'passed' && value.status !== 'attention') ||
       !isNonnegativeSafeInteger(value.routine_observation_count) || !isNonnegativeSafeInteger(value.effective_routine_execute_count) ||
       (value.effective_routine_execute_count as number) > (value.routine_observation_count as number) ||
      !Array.isArray(value.findings) || value.findings.some(finding => typeof finding !== 'string' || finding.length < 1 || finding.length > 256) ||
      typeof evidence.key_id !== 'string' || !IDENTIFIER.test(evidence.key_id) || evidence.algorithm !== 'Ed25519' ||
      typeof evidence.signature !== 'string' || !SIGNATURE.test(evidence.signature) || !isCanonicalBase64Length(evidence.signature, 64)) {
    throw new Error('answer_principal_audit_invalid');
  }
  return value as unknown as AnswerPrincipalAuditReport;
}

export function getAnswerPrincipalAuditSigningPayload(input: unknown): Buffer {
  const report = typeof input === 'object' && input !== null && 'production_evidence' in input
    ? input as Record<string, unknown>
    : {};
  const evidence = strictRecord(report.production_evidence, report.production_evidence && typeof report.production_evidence === 'object' && 'signature' in report.production_evidence ? ['key_id', 'algorithm', 'signature'] : ['key_id', 'algorithm']);
  const unsigned = { ...report, production_evidence: { key_id: evidence.key_id, algorithm: evidence.algorithm } };
  const withPlaceholder = { ...unsigned, production_evidence: { ...unsigned.production_evidence, signature: 'A'.repeat(86) + '==' } };
  parseAnswerPrincipalAuditReport(withPlaceholder);
  return Buffer.from(stableSerialize(unsigned), 'utf8');
}

export function verifyAnswerPrincipalAuditReport(input: unknown, trustedKey: TrustedProductionEvidenceKey, expected: { commit_sha: string; deployment_id: string; release_id: string }): AnswerPrincipalAuditReport {
  const report = parseAnswerPrincipalAuditReport(input);
  if (!trustedKey || report.production_evidence.key_id !== trustedKey.key_id || report.commit_sha !== expected.commit_sha || report.deployment_id !== expected.deployment_id || report.release_id !== expected.release_id) {
    throw new Error('answer_principal_audit_context_mismatch');
  }
  let publicKey: KeyObject;
  try {
    publicKey = trustedKey.public_key instanceof KeyObject
      ? trustedKey.public_key
      : typeof trustedKey.public_key === 'string'
        ? createPublicKey({ key: decodeCanonicalBase64(trustedKey.public_key), format: 'der', type: 'spki' })
        : createPublicKey({ key: trustedKey.public_key, format: 'der', type: 'spki' });
  } catch {
    throw new Error('answer_principal_audit_trusted_key_invalid');
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' ||
      !verify(null, getAnswerPrincipalAuditSigningPayload(report), publicKey, decodeCanonicalBase64(report.production_evidence.signature))) {
    throw new Error('answer_principal_audit_signature_invalid');
  }
  return report;
}

function evaluate(role: RoleRow, relations: RelationRow[], memberships: MembershipRow[], routines: RoutineObservationRow): string[] {
  const findings: string[] = [];
  if (role.transaction_read_only !== 'on') findings.push('transaction_not_read_only');
  if (role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls) findings.push('dangerous_role_attribute');
  if (role.database_create || role.database_temp) findings.push('unsafe_database_privilege');
  if (!role.f1ql_usage || role.f1ql_create || role.public_create) findings.push('unsafe_schema_privilege');
  const observed = new Map(relations.map(relation => [relation.relation, relation]));
  for (const requiredRelation of ANSWER_PRINCIPAL_REQUIRED_RELATIONS) {
    const relation = observed.get(requiredRelation);
    if (!relation?.exists) findings.push(`missing_relation:${requiredRelation}`);
    else if (!relation.can_select) findings.push(`select_missing:${requiredRelation}`);
  }
  for (const relation of relations) {
    if (relation.can_select && !ANSWER_PRINCIPAL_REQUIRED_RELATIONS.includes(relation.relation as typeof ANSWER_PRINCIPAL_REQUIRED_RELATIONS[number])) findings.push(`unexpected_select:${relation.relation}`);
    if (relation.can_insert || relation.can_update || relation.can_delete || relation.can_truncate || relation.can_references || relation.can_trigger) findings.push(`write_privilege:${relation.relation}`);
  }
  if (routines.effective_routine_execute_count > ANSWER_PRINCIPAL_ALLOWED_ROUTINES.length) {
    findings.push(`unexpected_routine_execute:${routines.effective_routine_execute_count}`);
  }
  if (memberships.length !== 1 || memberships[0]?.role_name !== 'f1ql_answer' || memberships[0].depth !== 1) {
    findings.push('unsafe_role_membership');
  } else {
    const answerRole = memberships[0];
    if (!answerRole.can_set_role || answerRole.admin_option || answerRole.rolcanlogin || answerRole.rolinherit || answerRole.rolsuper || answerRole.rolcreaterole ||
        answerRole.rolcreatedb || answerRole.rolreplication || answerRole.rolbypassrls) {
      findings.push('unsafe_answer_group_role');
    }
  }
  return findings;
}

function validRoutineObservation(value: RoutineObservationRow | undefined): value is RoutineObservationRow {
  return !!value && isNonnegativeSafeInteger(value.routine_observation_count) &&
    isNonnegativeSafeInteger(value.effective_routine_execute_count) &&
    value.effective_routine_execute_count <= value.routine_observation_count;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateContext(context: AnswerPrincipalAuditContext): void {
  if (context.target !== 'production' || !COMMIT_SHA.test(context.commit_sha) || !IDENTIFIER.test(context.deployment_id) || !IDENTIFIER.test(context.release_id) || !IDENTIFIER.test(context.key_id) ||
      context.private_key.type !== 'private' || context.private_key.asymmetricKeyType !== 'ed25519' || (context.audited_at !== undefined && !isIsoDate(context.audited_at))) {
    throw new Error('answer_principal_audit_context_invalid');
  }
}

function loadPrivateKey(raw: string): KeyObject {
  try {
    const der = decodeCanonicalBase64(raw);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
    return key;
  } catch {
    throw new Error('answer_principal_audit_signing_key_invalid');
  }
}

function required(environment: NodeJS.ProcessEnv, name: string, maximumLength = 10_000): string {
  const value = environment[name];
  if (!value || value.length > maximumLength) throw new Error('answer_principal_audit_context_missing');
  return value;
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength < 32 || decoded.byteLength > 4_096 || decoded.toString('base64') !== value) throw new Error('invalid');
  return decoded;
}

function isCanonicalBase64Length(value: string, length: number): boolean {
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.byteLength === length && decoded.toString('base64') === value;
  } catch {
    return false;
  }
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || !sameStrings(Object.keys(input).sort(), [...keys].sort())) {
    throw new Error('answer_principal_audit_invalid');
  }
  return input as Record<string, unknown>;
}

function sameStrings(input: unknown, expected: readonly string[]): boolean {
  return Array.isArray(input) && input.length === expected.length && input.every((value, index) => value === expected[index]);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right)).map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function isIsoDate(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const configuration = requireAnswerPrincipalAuditConfiguration();
  const pool = new Pool({ ...configuration.pool_config, max: 1 });
  try {
    const report = await runAnswerPrincipalAudit(pool, configuration.context);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(() => { process.stdout.write('{"status":"refused"}\n'); process.exitCode = 1; });
