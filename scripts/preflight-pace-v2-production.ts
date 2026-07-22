import { Pool } from 'pg';

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

export interface PaceV2PreflightResult {
  status: 'ready' | 'attention' | 'missing';
  statement_timeout_ms: number;
  active_methodology_version: string;
  v2_row_count: number;
  rows_by_session_type_and_methodology_version: Array<{ session_type: string; methodology_version: string; row_count: number }>;
  season_round_coverage: Array<{ season: number; round_count: number; rounds: number[] }>;
  eligible_lap_counts: Array<{ season: number; round: number; eligible_laps: number; total_rows: number }>;
  etl_audit: { available: boolean; freshness_by_season: AuditRow[] };
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
        conditions: [{ code: 'missing_v2_relation', severity: 'error', detail: 'laps_normalized_v2 is unavailable.' }]
      };
    }

    const [total, grouped, coverage, auditRelation] = await Promise.all([
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
      client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', ['etl_runs_laps_normalized'])
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
