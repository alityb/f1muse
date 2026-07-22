import { Pool } from 'pg';
import { PACE_V2_IDENTITY_REPAIR_METHOD, PACE_V2_IDENTITY_REPAIR_SEASON, PaceV2FactRow, createPaceV2IdentityRepairManifest, fingerprintPaceV2FactRows } from '../src/etl/pace-v2-identity-repair';
import { PACE_V2_APPROVED_TRACK_ID_RECONCILIATION } from '../src/etl/pace-v2-manifest';
import { PACE_V2_AUDIT_RECONCILIATION_METHOD, createPaceV2AuditReconciliationManifest } from '../src/etl/pace-v2-audit-reconciliation';

const ACTIVE_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';
const STATEMENT_TIMEOUT_MS = 5_000;

interface QueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}

interface QueryPool {
  connect(): Promise<QueryClient>;
  end(): Promise<void>;
}

interface Condition {
  code: string;
  severity: 'info' | 'warning' | 'error';
  season?: number;
  round?: number;
  detail?: string;
  predicates?: AuditPredicate[];
}

interface CoverageRow {
  season: number;
  round: number;
  total_rows: number;
  eligible_laps: number;
}

interface AuditRow {
  season: number;
  newest_finished_at: string | null;
  statuses: string[];
}

interface ManifestAuditRow {
  season: number;
  round: number;
  session_type: string;
  fact_fingerprint: string;
  fact_row_count: number;
  methodology_version: string;
}

interface IdentityRepairAuditRow {
  season: number;
  round: number;
  session_type: string;
  repair_method: string;
  manifest_fingerprint: string;
  source_fact_fingerprint: string;
  target_fact_fingerprint: string;
  fact_row_count: number;
  methodology_version: string;
}

interface AuditReconciliationRow {
  season: number;
  round: number;
  session_type: string;
  reconciliation_method: string;
  reconciliation_manifest_fingerprint: string;
  original_manifest_fact_fingerprint: string;
  reconciled_fact_fingerprint: string;
  fact_row_count: number;
  methodology_version: string;
}

interface AuditPredicate {
  name: string;
  passes: boolean;
  expected: boolean | number | string | null;
  actual: boolean | number | string | string[] | null;
}

interface AuditRoundResult {
  season: number;
  round: number;
  status: 'manifest_audit' | 'audit_reconciliation' | 'identity_repair_bridge' | 'missing_manifest_audit' | 'missing_audit_reconciliation' | 'invalid_manifest_audit' | 'invalid_audit_reconciliation' | 'invalid_identity_repair_audit';
  predicates: AuditPredicate[];
}

export interface PaceV2PreflightResult {
  status: 'ready' | 'attention' | 'missing';
  statement_timeout_ms: number;
  active_methodology_version: string;
  pace_selection_relation: 'f1ql.lap_pace';
  v2_row_count: number;
  rows_by_session_type_and_methodology_version: Array<{ session_type: string; methodology_version: string; row_count: number }>;
  season_round_coverage: Array<{ season: number; round_count: number; rounds: number[] }>;
  eligible_lap_counts: Array<{ season: number; round: number; eligible_laps: number; total_rows: number }>;
  etl_audit: { available: boolean; freshness_by_season: AuditRow[] };
  pace_audit: { manifest_available: boolean; audit_reconciliation_available: boolean; audit_reconciliation_immutable: boolean; identity_repair_available: boolean; identity_repair_immutable: boolean; rounds: AuditRoundResult[] };
  conditions: Condition[];
}

export function requirePaceV2PreflightConfiguration(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.PACE_V2_PREFLIGHT_ENABLED !== 'true') {
    throw new Error('Set PACE_V2_PREFLIGHT_ENABLED=true to enable the pace v2 production preflight.');
  }
  if (environment.PACE_V2_PREFLIGHT_TARGET !== 'production') {
    throw new Error('Set PACE_V2_PREFLIGHT_TARGET=production to confirm the target.');
  }
  if (!environment.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the pace v2 production preflight.');
  }

  const hostname = new URL(environment.DATABASE_URL).hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    throw new Error('Pace v2 production preflight refuses local database targets.');
  }
  return environment.DATABASE_URL;
}

function number(value: unknown): number {
  return Number(value);
}

function asFactRows(rows: Record<string, unknown>[]): PaceV2FactRow[] {
  return rows.map((row) => ({
    season: number(row.season), round: number(row.round), track_id: String(row.track_id), driver_id: String(row.driver_id),
    session_type: String(row.session_type), lap_number: number(row.lap_number), stint_id: number(row.stint_id),
    stint_lap_index: number(row.stint_lap_index), lap_time_seconds: row.lap_time_seconds === null ? null : number(row.lap_time_seconds),
    is_valid_lap: Boolean(row.is_valid_lap), is_pit_lap: Boolean(row.is_pit_lap), is_out_lap: Boolean(row.is_out_lap),
    is_in_lap: Boolean(row.is_in_lap), clean_air_flag: Boolean(row.clean_air_flag), compound: row.compound === null ? null : String(row.compound),
    tyre_age_laps: row.tyre_age_laps === null ? null : number(row.tyre_age_laps), methodology_version: String(row.methodology_version)
  }));
}

export function assessPaceV2AuditReadiness(
  factRows: PaceV2FactRow[],
  manifestAudits: ManifestAuditRow[],
  reconciliations: AuditReconciliationRow[],
  repairAudits: IdentityRepairAuditRow[],
  auditReconciliationImmutable: boolean,
  identityRepairImmutable: boolean
): { rounds: AuditRoundResult[]; conditions: Condition[] } {
  const factsByRound = new Map<string, PaceV2FactRow[]>();
  for (const row of factRows) {
    const key = `${row.season}:${row.round}`;
    factsByRound.set(key, [...(factsByRound.get(key) ?? []), row]);
  }
  const manifests = new Map(manifestAudits.map((audit) => [`${audit.season}:${audit.round}`, audit]));
  const reconciliationByRound = new Map(reconciliations.map((audit) => [`${audit.season}:${audit.round}`, audit]));
  const repairs = new Map(repairAudits.map((audit) => [`${audit.season}:${audit.round}`, audit]));
  const rounds: AuditRoundResult[] = [];
  const conditions: Condition[] = [];

  for (const [key, rows] of factsByRound) {
    const [season, round] = key.split(':').map(Number);
    const fingerprint = fingerprintPaceV2FactRows(rows);
    const methodologyVersions = [...new Set(rows.map((row) => row.methodology_version))].sort();
    const methodologyMatches = methodologyVersions.length === 1 && methodologyVersions[0] === ACTIVE_METHODOLOGY_VERSION;
    const manifest = manifests.get(key);
    if (manifest) {
      const predicates: AuditPredicate[] = [
        { name: 'manifest_session_type', passes: manifest.session_type === 'R', expected: 'R', actual: manifest.session_type },
        { name: 'manifest_fact_fingerprint', passes: manifest.fact_fingerprint === fingerprint, expected: fingerprint, actual: manifest.fact_fingerprint },
        { name: 'manifest_fact_row_count', passes: number(manifest.fact_row_count) === rows.length, expected: rows.length, actual: number(manifest.fact_row_count) },
        { name: 'manifest_methodology_version', passes: manifest.methodology_version === ACTIVE_METHODOLOGY_VERSION, expected: ACTIVE_METHODOLOGY_VERSION, actual: manifest.methodology_version },
        { name: 'current_fact_methodology_version', passes: methodologyMatches, expected: ACTIVE_METHODOLOGY_VERSION, actual: methodologyVersions }
      ];
      const valid = predicates.every((predicate) => predicate.passes);
      if (valid) {
        rounds.push({ season, round, status: 'manifest_audit', predicates });
        continue;
      }
      const mismatchIsFingerprintOnly = predicates.filter((predicate) => predicate.name !== 'manifest_fact_fingerprint').every((predicate) => predicate.passes) && !predicates[1].passes;
      if (!mismatchIsFingerprintOnly) {
        rounds.push({ season, round, status: 'invalid_manifest_audit', predicates });
        conditions.push({ code: 'invalid_manifest_audit', severity: 'error', season, round, detail: 'Persisted manifest audit does not match the complete current race fact contract.', predicates });
        continue;
      }
      const reconciliation = reconciliationByRound.get(key);
      const expectedReconciliationManifest = reconciliation && createPaceV2AuditReconciliationManifest({
        season, round, session_type: 'R', methodology_version: ACTIVE_METHODOLOGY_VERSION,
        fact_row_count: rows.length, original_manifest_fact_fingerprint: manifest.fact_fingerprint,
        current_fact_fingerprint: fingerprint
      });
      const reconciliationPredicates: AuditPredicate[] = reconciliation ? [
        ...predicates,
        { name: 'audit_reconciliation_immutable', passes: auditReconciliationImmutable, expected: true, actual: auditReconciliationImmutable },
        { name: 'reconciliation_session_type', passes: reconciliation.session_type === 'R', expected: 'R', actual: reconciliation.session_type },
        { name: 'reconciliation_method', passes: reconciliation.reconciliation_method === PACE_V2_AUDIT_RECONCILIATION_METHOD, expected: PACE_V2_AUDIT_RECONCILIATION_METHOD, actual: reconciliation.reconciliation_method },
        { name: 'reconciliation_original_manifest_fact_fingerprint', passes: reconciliation.original_manifest_fact_fingerprint === manifest.fact_fingerprint, expected: manifest.fact_fingerprint, actual: reconciliation.original_manifest_fact_fingerprint },
        { name: 'reconciliation_current_fact_fingerprint', passes: reconciliation.reconciled_fact_fingerprint === fingerprint, expected: fingerprint, actual: reconciliation.reconciled_fact_fingerprint },
        { name: 'reconciliation_fact_row_count', passes: number(reconciliation.fact_row_count) === rows.length, expected: rows.length, actual: number(reconciliation.fact_row_count) },
        { name: 'reconciliation_methodology_version', passes: reconciliation.methodology_version === ACTIVE_METHODOLOGY_VERSION, expected: ACTIVE_METHODOLOGY_VERSION, actual: reconciliation.methodology_version },
        { name: 'reconciliation_manifest_fingerprint', passes: reconciliation.reconciliation_manifest_fingerprint === expectedReconciliationManifest?.manifest_fingerprint, expected: expectedReconciliationManifest?.manifest_fingerprint ?? null, actual: reconciliation.reconciliation_manifest_fingerprint }
      ] : [...predicates, { name: 'audit_reconciliation_present', passes: false, expected: true, actual: false }];
      const validReconciliation = reconciliation !== undefined && reconciliationPredicates.filter((predicate) => predicate.name !== 'manifest_fact_fingerprint').every((predicate) => predicate.passes) && !reconciliationPredicates.find((predicate) => predicate.name === 'manifest_fact_fingerprint')?.passes;
      if (validReconciliation) {
        rounds.push({ season, round, status: 'audit_reconciliation', predicates: reconciliationPredicates });
      } else if (reconciliation) {
        rounds.push({ season, round, status: 'invalid_audit_reconciliation', predicates: reconciliationPredicates });
        conditions.push({ code: 'invalid_audit_reconciliation', severity: 'error', season, round, detail: 'Reconciliation evidence does not exactly cover the original fingerprint-only mismatch.', predicates: reconciliationPredicates });
      } else {
        rounds.push({ season, round, status: 'missing_audit_reconciliation', predicates: reconciliationPredicates });
        conditions.push({ code: 'missing_audit_reconciliation', severity: 'error', season, round, detail: 'Original manifest audit has an approved fingerprint-only mismatch but no immutable reconciliation evidence.', predicates: reconciliationPredicates });
      }
      continue;
    }

    const repair = repairs.get(key);
    const expectedRepairManifest = repair && createPaceV2IdentityRepairManifest({
      season: PACE_V2_IDENTITY_REPAIR_SEASON, round: 1, session_type: 'R', methodology_version: ACTIVE_METHODOLOGY_VERSION,
      from_track_id: 'australian_grand_prix', to_track_id: PACE_V2_APPROVED_TRACK_ID_RECONCILIATION.australian_grand_prix,
      fact_row_count: number(repair.fact_row_count), source_fact_fingerprint: repair.source_fact_fingerprint,
      target_fact_fingerprint: repair.target_fact_fingerprint
    });
    const predicates: AuditPredicate[] = repair ? [
      { name: 'identity_repair_audit_immutable', passes: identityRepairImmutable, expected: true, actual: identityRepairImmutable },
      { name: 'repair_session_type', passes: repair.session_type === 'R', expected: 'R', actual: repair.session_type },
      { name: 'repair_season', passes: repair.season === PACE_V2_IDENTITY_REPAIR_SEASON, expected: PACE_V2_IDENTITY_REPAIR_SEASON, actual: repair.season },
      { name: 'repair_round', passes: repair.round === 1, expected: 1, actual: repair.round },
      { name: 'repair_method', passes: repair.repair_method === PACE_V2_IDENTITY_REPAIR_METHOD, expected: PACE_V2_IDENTITY_REPAIR_METHOD, actual: repair.repair_method },
      { name: 'repair_target_fact_fingerprint', passes: repair.target_fact_fingerprint === fingerprint, expected: fingerprint, actual: repair.target_fact_fingerprint },
      { name: 'repair_fact_row_count', passes: number(repair.fact_row_count) === rows.length, expected: rows.length, actual: number(repair.fact_row_count) },
      { name: 'repair_methodology_version', passes: repair.methodology_version === ACTIVE_METHODOLOGY_VERSION, expected: ACTIVE_METHODOLOGY_VERSION, actual: repair.methodology_version },
      { name: 'current_fact_methodology_version', passes: methodologyMatches, expected: ACTIVE_METHODOLOGY_VERSION, actual: methodologyVersions },
      { name: 'repair_source_fact_fingerprint_format', passes: /^[a-f0-9]{64}$/.test(repair.source_fact_fingerprint), expected: 'sha256_hex', actual: repair.source_fact_fingerprint },
      { name: 'repair_source_and_target_fingerprints_differ', passes: repair.source_fact_fingerprint !== repair.target_fact_fingerprint, expected: true, actual: repair.source_fact_fingerprint !== repair.target_fact_fingerprint },
      { name: 'repair_manifest_fingerprint', passes: repair.manifest_fingerprint === expectedRepairManifest?.manifest_fingerprint, expected: expectedRepairManifest?.manifest_fingerprint ?? null, actual: repair.manifest_fingerprint }
    ] : [{ name: 'manifest_audit_present', passes: false, expected: true, actual: false }];
    const validRepair = repair !== undefined && predicates.every((predicate) => predicate.passes);
    if (validRepair) {
      rounds.push({ season, round, status: 'identity_repair_bridge', predicates });
    } else if (repair) {
      rounds.push({ season, round, status: 'invalid_identity_repair_audit', predicates });
      conditions.push({ code: 'invalid_identity_repair_audit', severity: 'error', season, round, detail: 'Identity-repair audit cannot bridge the required manifest audit.', predicates });
    } else {
      rounds.push({ season, round, status: 'missing_manifest_audit', predicates });
      conditions.push({ code: 'missing_manifest_audit', severity: 'error', season, round, detail: 'No immutable manifest audit covers this complete race fact set.', predicates });
    }
  }
  return { rounds, conditions };
}

export async function runPaceV2Preflight(pool: QueryPool): Promise<PaceV2PreflightResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${STATEMENT_TIMEOUT_MS}ms`]);

    const v2Relation = await client.query<{ relation: string | null }>(
      'SELECT to_regclass($1)::text AS relation',
      ['laps_normalized_v2']
    );
    if (v2Relation.rows[0]?.relation !== 'laps_normalized_v2') {
      await client.query('ROLLBACK');
      return {
        status: 'missing', statement_timeout_ms: STATEMENT_TIMEOUT_MS, active_methodology_version: ACTIVE_METHODOLOGY_VERSION,
        pace_selection_relation: 'f1ql.lap_pace',
        v2_row_count: 0, rows_by_session_type_and_methodology_version: [], season_round_coverage: [], eligible_lap_counts: [],
        etl_audit: { available: false, freshness_by_season: [] },
        pace_audit: { manifest_available: false, audit_reconciliation_available: false, audit_reconciliation_immutable: false, identity_repair_available: false, identity_repair_immutable: false, rounds: [] },
        conditions: [{ code: 'missing_v2_relation', severity: 'error', detail: 'laps_normalized_v2 is unavailable.' }]
      };
    }

    const [total, grouped, coverage, lapPaceRelation, auditRelation, manifestAuditRelation, reconciliationRelation, identityRepairAuditRelation] = await Promise.all([
      client.query<{ row_count: string }>('SELECT COUNT(*)::text AS row_count FROM laps_normalized_v2'),
      client.query<{ session_type: string; methodology_version: string; row_count: string }>(`
        SELECT session_type, methodology_version, COUNT(*)::text AS row_count
        FROM laps_normalized_v2
        GROUP BY session_type, methodology_version
        ORDER BY session_type, methodology_version
      `),
      client.query<CoverageRow>(`
        SELECT season, round, COUNT(*)::int AS total_rows,
          COUNT(*) FILTER (WHERE session_type = 'R' AND methodology_version = $1
            AND lap_time_seconds IS NOT NULL AND is_valid_lap = true AND is_pit_lap = false
            AND is_in_lap = false AND is_out_lap = false)::int AS eligible_laps
        FROM f1ql.lap_pace
        GROUP BY season, round
        ORDER BY season, round
      `, [ACTIVE_METHODOLOGY_VERSION]),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['f1ql.lap_pace']),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['etl_runs_laps_normalized']),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_round_audit']),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_round_audit_reconciliation']),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_identity_repair_audit'])
    ]);

    const auditAvailable = auditRelation.rows[0]?.relation === 'etl_runs_laps_normalized';
    const lapPaceAvailable = lapPaceRelation.rows[0]?.relation === 'f1ql.lap_pace';
    const audit = auditAvailable
      ? await client.query<AuditRow>(`
        SELECT season, MAX(finished_at)::text AS newest_finished_at,
          ARRAY_AGG(DISTINCT status ORDER BY status) AS statuses
        FROM etl_runs_laps_normalized
        GROUP BY season
        ORDER BY season
      `)
      : { rows: [] as AuditRow[] };
    const manifestAuditAvailable = manifestAuditRelation.rows[0]?.relation === 'pace_v2_round_audit';
    const reconciliationAvailable = reconciliationRelation.rows[0]?.relation === 'pace_v2_round_audit_reconciliation';
    const identityRepairAuditAvailable = identityRepairAuditRelation.rows[0]?.relation === 'pace_v2_identity_repair_audit';
    const [factResult, manifestAuditResult, reconciliationResult, reconciliationTrigger, identityRepairAuditResult, identityRepairTrigger] = await Promise.all([
      client.query(`SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE session_type = 'R' ORDER BY season, round, driver_id, lap_number`),
      manifestAuditAvailable ? client.query<ManifestAuditRow>('SELECT season, round, session_type, fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_round_audit WHERE session_type = $1', ['R']) : Promise.resolve({ rows: [] as ManifestAuditRow[] }),
      reconciliationAvailable ? client.query<AuditReconciliationRow>('SELECT season, round, session_type, reconciliation_method, reconciliation_manifest_fingerprint, original_manifest_fact_fingerprint, reconciled_fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_round_audit_reconciliation WHERE session_type = $1', ['R']) : Promise.resolve({ rows: [] as AuditReconciliationRow[] }),
      reconciliationAvailable ? client.query<{ immutable: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'pace_v2_round_audit_reconciliation'::regclass AND tgname = 'pace_v2_round_audit_reconciliation_immutable' AND tgenabled <> 'D') AS immutable") : Promise.resolve({ rows: [{ immutable: false }] }),
      identityRepairAuditAvailable ? client.query<IdentityRepairAuditRow>('SELECT season, round, session_type, repair_method, manifest_fingerprint, source_fact_fingerprint, target_fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_identity_repair_audit WHERE session_type = $1', ['R']) : Promise.resolve({ rows: [] as IdentityRepairAuditRow[] }),
      identityRepairAuditAvailable ? client.query<{ immutable: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'pace_v2_identity_repair_audit'::regclass AND tgname = 'pace_v2_identity_repair_audit_immutable' AND tgenabled <> 'D') AS immutable") : Promise.resolve({ rows: [{ immutable: false }] })
    ]);
    const auditReconciliationImmutable = Boolean(reconciliationTrigger.rows[0]?.immutable);
    const identityRepairImmutable = Boolean(identityRepairTrigger.rows[0]?.immutable);
    const paceAudit = assessPaceV2AuditReadiness(asFactRows(factResult.rows), manifestAuditResult.rows, reconciliationResult.rows, identityRepairAuditResult.rows, auditReconciliationImmutable, identityRepairImmutable);

    const eligibleLapCounts = coverage.rows.map((row) => ({
      season: number(row.season), round: number(row.round), total_rows: number(row.total_rows), eligible_laps: number(row.eligible_laps)
    }));
    const seasons = new Map<number, number[]>();
    for (const row of eligibleLapCounts) {
      const rounds = seasons.get(row.season) ?? [];
      rounds.push(row.round);
      seasons.set(row.season, rounds);
    }
    const conditions: Condition[] = [];
    if (number(total.rows[0]?.row_count) === 0) {
      conditions.push({ code: 'no_v2_rows', severity: 'error', detail: 'laps_normalized_v2 has no rows.' });
    }
    if (!lapPaceAvailable) {
      conditions.push({ code: 'missing_lap_pace_relation', severity: 'error', detail: 'f1ql.lap_pace is unavailable; selected pace eligibility cannot be evaluated.' });
    }
    if (!grouped.rows.some((row) => row.session_type === 'R')) {
      conditions.push({ code: 'no_race_session_rows', severity: 'error', detail: 'No race-session rows are available.' });
    }
    for (const row of grouped.rows) {
      if (row.methodology_version !== ACTIVE_METHODOLOGY_VERSION) {
        conditions.push({ code: 'inactive_methodology_version', severity: 'warning', detail: `${row.session_type} uses ${row.methodology_version}.`, predicates: [{ name: 'methodology_version', passes: false, expected: ACTIVE_METHODOLOGY_VERSION, actual: row.methodology_version }] });
      }
    }
    for (const row of eligibleLapCounts) {
      if (row.eligible_laps === 0) {
        conditions.push({ code: 'round_without_eligible_laps', severity: 'warning', season: row.season, round: row.round, predicates: [{ name: 'eligible_lap_count', passes: false, expected: '> 0', actual: row.eligible_laps }] });
      }
    }
    if (!auditAvailable) {
      conditions.push({ code: 'etl_audit_unavailable', severity: 'info', detail: 'etl_runs_laps_normalized is unavailable.' });
    }
    if (!manifestAuditAvailable) {
      conditions.push({ code: 'manifest_audit_unavailable', severity: 'error', detail: 'pace_v2_round_audit is unavailable.' });
    }
    if (!reconciliationAvailable) {
      conditions.push({ code: 'audit_reconciliation_unavailable', severity: 'error', detail: 'pace_v2_round_audit_reconciliation is unavailable.' });
    } else if (!auditReconciliationImmutable) {
      conditions.push({ code: 'audit_reconciliation_not_immutable', severity: 'error', detail: 'pace_v2_round_audit_reconciliation lacks its enabled immutable-audit trigger.' });
    }
    if (identityRepairAuditAvailable && !identityRepairImmutable) {
      conditions.push({ code: 'identity_repair_audit_not_immutable', severity: 'error', detail: 'pace_v2_identity_repair_audit lacks its enabled immutable-audit trigger.' });
    }
    conditions.push(...paceAudit.conditions);
    for (const row of audit.rows) {
      if (row.statuses.some((status) => status !== 'success')) {
        conditions.push({ code: 'etl_audit_partial_or_failed', severity: 'warning', season: number(row.season), detail: row.statuses.join(', '), predicates: [{ name: 'etl_statuses', passes: false, expected: 'success_only', actual: row.statuses }] });
      }
    }

    await client.query('ROLLBACK');
    return {
      status: conditions.some((condition) => condition.severity === 'error') ? 'attention' : 'ready',
      statement_timeout_ms: STATEMENT_TIMEOUT_MS,
      active_methodology_version: ACTIVE_METHODOLOGY_VERSION,
      pace_selection_relation: 'f1ql.lap_pace',
      v2_row_count: number(total.rows[0]?.row_count),
      rows_by_session_type_and_methodology_version: grouped.rows.map((row) => ({ ...row, row_count: number(row.row_count) })),
      season_round_coverage: [...seasons.entries()].map(([season, rounds]) => ({ season, round_count: rounds.length, rounds })),
      eligible_lap_counts: eligibleLapCounts,
      etl_audit: { available: auditAvailable, freshness_by_season: audit.rows.map((row) => ({ ...row, season: number(row.season) })) },
      pace_audit: { manifest_available: manifestAuditAvailable, audit_reconciliation_available: reconciliationAvailable, audit_reconciliation_immutable: auditReconciliationImmutable, identity_repair_available: identityRepairAuditAvailable, identity_repair_immutable: identityRepairImmutable, rounds: paceAudit.rounds },
      conditions
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const connectionString = requirePaceV2PreflightConfiguration();
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    process.stdout.write(`${JSON.stringify(await runPaceV2Preflight(pool))}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write('{"status":"refused","error":"pace_v2_preflight_failed"}\n');
    process.exitCode = 1;
  });
}
