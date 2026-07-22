import { Pool } from 'pg';
import { PACE_V2_IDENTITY_REPAIR_METHOD, PACE_V2_IDENTITY_REPAIR_SEASON, PaceV2FactRow, createPaceV2IdentityRepairManifest, fingerprintPaceV2FactRows } from '../src/etl/pace-v2-identity-repair';
import { PACE_V2_APPROVED_TRACK_ID_RECONCILIATION } from '../src/etl/pace-v2-manifest';

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

interface AuditRoundResult {
  season: number;
  round: number;
  status: 'manifest_audit' | 'identity_repair_bridge' | 'missing_manifest_audit' | 'invalid_manifest_audit' | 'invalid_identity_repair_audit';
}

export interface PaceV2PreflightResult {
  status: 'ready' | 'attention' | 'missing';
  statement_timeout_ms: number;
  active_methodology_version: string;
  v2_row_count: number;
  rows_by_session_type_and_methodology_version: Array<{ session_type: string; methodology_version: string; row_count: number }>;
  season_round_coverage: Array<{ season: number; round_count: number; rounds: number[] }>;
  eligible_lap_counts: Array<{ season: number; round: number; eligible_laps: number; total_rows: number }>;
  etl_audit: { available: boolean; freshness_by_season: AuditRow[] };
  pace_audit: { manifest_available: boolean; identity_repair_available: boolean; identity_repair_immutable: boolean; rounds: AuditRoundResult[] };
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
  repairAudits: IdentityRepairAuditRow[],
  identityRepairImmutable: boolean
): { rounds: AuditRoundResult[]; conditions: Condition[] } {
  const factsByRound = new Map<string, PaceV2FactRow[]>();
  for (const row of factRows) {
    const key = `${row.season}:${row.round}`;
    factsByRound.set(key, [...(factsByRound.get(key) ?? []), row]);
  }
  const manifests = new Map(manifestAudits.map((audit) => [`${audit.season}:${audit.round}`, audit]));
  const repairs = new Map(repairAudits.map((audit) => [`${audit.season}:${audit.round}`, audit]));
  const rounds: AuditRoundResult[] = [];
  const conditions: Condition[] = [];

  for (const [key, rows] of factsByRound) {
    const [season, round] = key.split(':').map(Number);
    const fingerprint = fingerprintPaceV2FactRows(rows);
    const methodologyMatches = rows.every((row) => row.methodology_version === ACTIVE_METHODOLOGY_VERSION);
    const manifest = manifests.get(key);
    if (manifest) {
      const valid = manifest.session_type === 'R' && manifest.fact_fingerprint === fingerprint &&
        number(manifest.fact_row_count) === rows.length && manifest.methodology_version === ACTIVE_METHODOLOGY_VERSION && methodologyMatches;
      if (valid) {
        rounds.push({ season, round, status: 'manifest_audit' });
      } else {
        rounds.push({ season, round, status: 'invalid_manifest_audit' });
        conditions.push({ code: 'invalid_manifest_audit', severity: 'error', season, round, detail: 'Persisted manifest audit does not match the complete current race fact contract.' });
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
    const validRepair = identityRepairImmutable && repair?.session_type === 'R' &&
      repair.season === PACE_V2_IDENTITY_REPAIR_SEASON && repair.round === 1 && repair.repair_method === PACE_V2_IDENTITY_REPAIR_METHOD && repair.target_fact_fingerprint === fingerprint &&
      number(repair.fact_row_count) === rows.length && repair.methodology_version === ACTIVE_METHODOLOGY_VERSION && methodologyMatches &&
      /^[a-f0-9]{64}$/.test(repair.source_fact_fingerprint) && repair.source_fact_fingerprint !== repair.target_fact_fingerprint &&
      repair.manifest_fingerprint === expectedRepairManifest?.manifest_fingerprint;
    if (validRepair) {
      rounds.push({ season, round, status: 'identity_repair_bridge' });
    } else if (repair) {
      rounds.push({ season, round, status: 'invalid_identity_repair_audit' });
      conditions.push({ code: 'invalid_identity_repair_audit', severity: 'error', season, round, detail: 'Identity-repair audit cannot bridge the required manifest audit.' });
    } else {
      rounds.push({ season, round, status: 'missing_manifest_audit' });
      conditions.push({ code: 'missing_manifest_audit', severity: 'error', season, round, detail: 'No immutable manifest audit covers this complete race fact set.' });
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
        v2_row_count: 0, rows_by_session_type_and_methodology_version: [], season_round_coverage: [], eligible_lap_counts: [],
        etl_audit: { available: false, freshness_by_season: [] },
        pace_audit: { manifest_available: false, identity_repair_available: false, identity_repair_immutable: false, rounds: [] },
        conditions: [{ code: 'missing_v2_relation', severity: 'error', detail: 'laps_normalized_v2 is unavailable.' }]
      };
    }

    const [total, grouped, coverage, auditRelation, manifestAuditRelation, identityRepairAuditRelation] = await Promise.all([
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
        FROM laps_normalized_v2
        GROUP BY season, round
        ORDER BY season, round
      `, [ACTIVE_METHODOLOGY_VERSION]),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['etl_runs_laps_normalized']),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_round_audit']),
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['pace_v2_identity_repair_audit'])
    ]);

    const auditAvailable = auditRelation.rows[0]?.relation === 'etl_runs_laps_normalized';
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
    const identityRepairAuditAvailable = identityRepairAuditRelation.rows[0]?.relation === 'pace_v2_identity_repair_audit';
    const [factResult, manifestAuditResult, identityRepairAuditResult, identityRepairTrigger] = await Promise.all([
      client.query(`SELECT season, round, track_id, driver_id, session_type, lap_number, stint_id, stint_lap_index, lap_time_seconds, is_valid_lap, is_pit_lap, is_out_lap, is_in_lap, clean_air_flag, compound, tyre_age_laps, methodology_version FROM laps_normalized_v2 WHERE session_type = 'R' ORDER BY season, round, driver_id, lap_number`),
      manifestAuditAvailable ? client.query<ManifestAuditRow>('SELECT season, round, session_type, fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_round_audit WHERE session_type = $1', ['R']) : Promise.resolve({ rows: [] as ManifestAuditRow[] }),
      identityRepairAuditAvailable ? client.query<IdentityRepairAuditRow>('SELECT season, round, session_type, repair_method, manifest_fingerprint, source_fact_fingerprint, target_fact_fingerprint, fact_row_count, methodology_version FROM pace_v2_identity_repair_audit WHERE session_type = $1', ['R']) : Promise.resolve({ rows: [] as IdentityRepairAuditRow[] }),
      identityRepairAuditAvailable ? client.query<{ immutable: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'pace_v2_identity_repair_audit'::regclass AND tgname = 'pace_v2_identity_repair_audit_immutable' AND tgenabled <> 'D') AS immutable") : Promise.resolve({ rows: [{ immutable: false }] })
    ]);
    const identityRepairImmutable = Boolean(identityRepairTrigger.rows[0]?.immutable);
    const paceAudit = assessPaceV2AuditReadiness(asFactRows(factResult.rows), manifestAuditResult.rows, identityRepairAuditResult.rows, identityRepairImmutable);

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
    if (!grouped.rows.some((row) => row.session_type === 'R')) {
      conditions.push({ code: 'no_race_session_rows', severity: 'error', detail: 'No race-session rows are available.' });
    }
    for (const row of grouped.rows) {
      if (row.methodology_version !== ACTIVE_METHODOLOGY_VERSION) {
        conditions.push({ code: 'inactive_methodology_version', severity: 'warning', detail: `${row.session_type} uses ${row.methodology_version}.` });
      }
    }
    for (const row of eligibleLapCounts) {
      if (row.eligible_laps === 0) {
        conditions.push({ code: 'round_without_eligible_laps', severity: 'warning', season: row.season, round: row.round });
      }
    }
    if (!auditAvailable) {
      conditions.push({ code: 'etl_audit_unavailable', severity: 'info', detail: 'etl_runs_laps_normalized is unavailable.' });
    }
    if (!manifestAuditAvailable) {
      conditions.push({ code: 'manifest_audit_unavailable', severity: 'error', detail: 'pace_v2_round_audit is unavailable.' });
    }
    if (identityRepairAuditAvailable && !identityRepairImmutable) {
      conditions.push({ code: 'identity_repair_audit_not_immutable', severity: 'error', detail: 'pace_v2_identity_repair_audit lacks its enabled immutable-audit trigger.' });
    }
    conditions.push(...paceAudit.conditions);
    for (const row of audit.rows) {
      if (row.statuses.some((status) => status !== 'success')) {
        conditions.push({ code: 'etl_audit_partial_or_failed', severity: 'warning', season: number(row.season), detail: row.statuses.join(', ') });
      }
    }

    await client.query('ROLLBACK');
    return {
      status: conditions.some((condition) => condition.severity === 'error') ? 'attention' : conditions.length ? 'attention' : 'ready',
      statement_timeout_ms: STATEMENT_TIMEOUT_MS,
      active_methodology_version: ACTIVE_METHODOLOGY_VERSION,
      v2_row_count: number(total.rows[0]?.row_count),
      rows_by_session_type_and_methodology_version: grouped.rows.map((row) => ({ ...row, row_count: number(row.row_count) })),
      season_round_coverage: [...seasons.entries()].map(([season, rounds]) => ({ season, round_count: rounds.length, rounds })),
      eligible_lap_counts: eligibleLapCounts,
      etl_audit: { available: auditAvailable, freshness_by_season: audit.rows.map((row) => ({ ...row, season: number(row.season) })) },
      pace_audit: { manifest_available: manifestAuditAvailable, identity_repair_available: identityRepairAuditAvailable, identity_repair_immutable: identityRepairImmutable, rounds: paceAudit.rounds },
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
