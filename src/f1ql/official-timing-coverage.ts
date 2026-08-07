import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';
import {
  WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE,
  WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL,
  WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL
} from './wp12-official-timing-activation-bundle';

const DRIVER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COVERAGE_FIELDS = [
  'driver_id', 'completed_laps', 'eligible_laps', 'deleted_laps', 'pit_marker_laps',
  'first_lap', 'last_lap', 'distinct_laps', 'dataset_count'
] as const;
const COVERAGE_NUMERIC_FIELDS = [
  'completed_laps', 'eligible_laps', 'deleted_laps', 'pit_marker_laps',
  'first_lap', 'last_lap', 'distinct_laps', 'dataset_count'
] as const;
const CONTROL_TIMEOUT_MS = 2000;

const driverPairSchema = z.tuple([
  z.string().max(100).regex(DRIVER_ID),
  z.string().max(100).regex(DRIVER_ID)
]).superRefine((drivers, context) => {
  if (drivers[0] === drivers[1]) {
    context.addIssue({ code: 'custom', message: 'official timing comparison drivers must be distinct' });
  }
});

const requestScope = {
  season: z.literal(2022),
  round: z.literal(14),
  session_type: z.literal('R'),
  driver_ids: driverPairSchema
} as const;

const coverageRequestSchema = z.discriminatedUnion('metric', [
  z.object({
    metric: z.literal(OFFICIAL_EVENT_MEAN_METRIC_ID),
    ...requestScope
  }).strict(),
  z.object({
    metric: z.literal(OFFICIAL_LAP_WINDOW_METRIC_ID),
    ...requestScope,
    lap_start: z.number().int().safe().min(1).max(2147483647),
    lap_end: z.number().int().safe().min(1).max(2147483647)
  }).strict()
]).superRefine((request, context) => {
  if (request.metric === OFFICIAL_LAP_WINDOW_METRIC_ID) {
    const laps = request.lap_end - request.lap_start + 1;
    if (laps < 1 || laps > 50) {
      context.addIssue({ code: 'custom', message: 'official timing lap window must contain 1 through 50 laps' });
    }
  }
});

type OfficialTimingCoverageRequest = z.infer<typeof coverageRequestSchema>;

type CoverageRow = QueryResultRow & {
  driver_id: string;
  completed_laps: number;
  eligible_laps: number;
  deleted_laps: number;
  pit_marker_laps: number;
  first_lap: number;
  last_lap: number;
  distinct_laps: number;
  dataset_count: number;
};
type RowAssessment = 'coverage' | 'eligible' | 'integrity';

export type OfficialTimingDriverCoverage = Readonly<{
  driver_id: string;
  completed_laps: number;
  eligible_laps: number;
  excluded_deleted_laps: number;
  excluded_pit_marker_laps: number;
}>;

export type OfficialTimingCoverageDecision =
  | Readonly<{
    type: 'eligible';
    source_id: 'official_race_lap_timing';
    metric: typeof OFFICIAL_EVENT_MEAN_METRIC_ID | typeof OFFICIAL_LAP_WINDOW_METRIC_ID;
    coverage_query_id: 'official_event_coverage_v1' | 'official_window_coverage_v1';
    coverage_query_sha256: string;
    query_calls: 1;
    driver_coverage: readonly [OfficialTimingDriverCoverage, OfficialTimingDriverCoverage];
  }>
  | Readonly<{
    type: 'abstain';
    reason: 'source_coverage_missing' | 'source_integrity_failed';
    stage: 'official_timing_coverage' | 'official_timing_integrity';
    query_calls: 1;
  }>;

export type OfficialTimingCoverageErrorCode =
  | 'connection_failed'
  | 'coverage_query_failed'
  | 'transaction_cleanup_failed'
  | 'transaction_setup_failed';

export class OfficialTimingCoverageError extends Error {
  constructor(readonly code: OfficialTimingCoverageErrorCode) {
    super(`Official timing coverage read failed: ${code}`);
    this.name = 'OfficialTimingCoverageError';
  }
}

class UnsafeOfficialTimingCoverageError extends OfficialTimingCoverageError {}

export async function readOfficialTimingCoverage(
  database: Pick<Pool, 'connect'>,
  input: unknown
): Promise<OfficialTimingCoverageDecision> {
  const request = coverageRequestSchema.parse(input);
  const expectedClassifiedLaps = new Map(
    WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.source.certified_scope.classified_laps_by_driver
      .map(driver => [driver.driver_id, driver.classified_laps] as const)
  );
  if (request.driver_ids.some(driverId => !expectedClassifiedLaps.has(driverId))) {
    throw new Error('FAIL_CLOSED: driver is outside the certified official timing identity map');
  }
  const client = await acquireClient(database);
  let transactionOpen = false;
  let releaseError: Error | undefined;

  try {
    await boundedControlQuery(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'transaction_setup_failed');
    transactionOpen = true;
    await boundedControlQuery(client, `SET LOCAL statement_timeout = '${CONTROL_TIMEOUT_MS}ms'`, 'transaction_setup_failed');
    const result = await runCoverageQuery(client, request);
    const decision = assessCoverageRows(request, result.rows, expectedClassifiedLaps);
    await boundedControlQuery(client, 'COMMIT', 'transaction_cleanup_failed');
    transactionOpen = false;
    return decision;
  } catch (error) {
    let failure = error instanceof Error ? error : new Error('official timing coverage failure');
    if (error instanceof UnsafeOfficialTimingCoverageError) {transactionOpen = false;}
    if (transactionOpen) {
      try {
        await boundedControlQuery(client, 'ROLLBACK', 'transaction_cleanup_failed');
      } catch (cleanupError) {
        failure = cleanupError instanceof Error ? cleanupError : failure;
      }
    }
    releaseError = failure;
    throw failure;
  } finally {
    client.release(releaseError);
  }
}

async function runCoverageQuery(
  client: PoolClient,
  request: OfficialTimingCoverageRequest
): Promise<QueryResult<CoverageRow>> {
  const isEvent = request.metric === OFFICIAL_EVENT_MEAN_METRIC_ID;
  const sql = isEvent ? WP12_OFFICIAL_TIMING_EVENT_COVERAGE_SQL : WP12_OFFICIAL_TIMING_WINDOW_COVERAGE_SQL;
  const parameters = isEvent
    ? [request.season, request.round, [...request.driver_ids]]
    : [request.season, request.round, [...request.driver_ids], request.lap_start, request.lap_end];
  try {
    return await wallClockQuery(client, sql, parameters);
  } catch (error) {
    if (error instanceof UnsafeOfficialTimingCoverageError) {throw error;}
    throw new OfficialTimingCoverageError('coverage_query_failed');
  }
}

function assessCoverageRows(
  request: OfficialTimingCoverageRequest,
  rows: readonly CoverageRow[],
  expectedClassifiedLaps: ReadonlyMap<string, number>
): OfficialTimingCoverageDecision {
  const byDriver = indexCoverageRows(request, rows);
  if (!byDriver) {return integrityAbstention();}
  if (request.driver_ids.some(driverId => !byDriver.has(driverId))) {
    return assessMissingRows(request, byDriver, expectedClassifiedLaps);
  }

  const orderedRows = request.driver_ids.map(driverId => byDriver.get(driverId)!) as [CoverageRow, CoverageRow];
  const assessments = orderedRows.map(row => assessDriverRow(request, row, expectedClassifiedLaps));
  if (assessments.includes('integrity')) {return integrityAbstention();}
  if (assessments.includes('coverage')) {return coverageAbstention();}

  const isEvent = request.metric === OFFICIAL_EVENT_MEAN_METRIC_ID;
  const contract = WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[isEvent ? 0 : 1];
  const coverageQueryId = isEvent ? 'official_event_coverage_v1' : 'official_window_coverage_v1';
  if (contract.metric_id !== request.metric || contract.id !== coverageQueryId) {
    throw new Error('FAIL_CLOSED: official timing coverage query contract is missing');
  }
  return deepFreeze({
    type: 'eligible',
    source_id: 'official_race_lap_timing',
    metric: request.metric,
    coverage_query_id: coverageQueryId,
    coverage_query_sha256: contract.statement_sha256,
    query_calls: 1,
    driver_coverage: orderedRows.map(publicCoverage) as [OfficialTimingDriverCoverage, OfficialTimingDriverCoverage]
  });
}

function indexCoverageRows(
  request: OfficialTimingCoverageRequest,
  rows: readonly CoverageRow[]
): Map<string, CoverageRow> | null {
  if (rows.length > 2 || rows.some(row => !isStrictCoverageRow(row))) {return null;}
  const byDriver = new Map<string, CoverageRow>();
  for (const row of rows) {
    if (!request.driver_ids.includes(row.driver_id) || byDriver.has(row.driver_id)) {return null;}
    byDriver.set(row.driver_id, row);
  }
  return byDriver;
}

function assessMissingRows(
  request: OfficialTimingCoverageRequest,
  byDriver: ReadonlyMap<string, CoverageRow>,
  expectedClassifiedLaps: ReadonlyMap<string, number>
): OfficialTimingCoverageDecision {
  const missingPositiveEvent = request.metric === OFFICIAL_EVENT_MEAN_METRIC_ID && request.driver_ids.some(
    driverId => !byDriver.has(driverId) && expectedClassifiedLaps.get(driverId)! > 0
  );
  return missingPositiveEvent ? integrityAbstention() : coverageAbstention();
}

function assessDriverRow(
  request: OfficialTimingCoverageRequest,
  row: CoverageRow,
  expectedClassifiedLaps: ReadonlyMap<string, number>
): RowAssessment {
  if (!hasValidCountArithmetic(row) || row.dataset_count !== 1 || row.distinct_laps !== row.completed_laps) {
    return 'integrity';
  }
  const scope = request.metric === OFFICIAL_EVENT_MEAN_METRIC_ID
    ? assessEventRow(row, expectedClassifiedLaps.get(row.driver_id))
    : assessWindowRow(request, row);
  if (scope !== 'eligible') {return scope;}
  return row.eligible_laps < 2 ? 'coverage' : 'eligible';
}

function assessEventRow(row: CoverageRow, expectedClassifiedLaps: number | undefined): RowAssessment {
  return row.completed_laps === expectedClassifiedLaps && row.first_lap === 1 && row.last_lap === row.completed_laps
    ? 'eligible'
    : 'integrity';
}

function assessWindowRow(
  request: Extract<OfficialTimingCoverageRequest, { metric: typeof OFFICIAL_LAP_WINDOW_METRIC_ID }>,
  row: CoverageRow
): RowAssessment {
  const requestedLaps = request.lap_end - request.lap_start + 1;
  if (row.completed_laps < requestedLaps) {return 'coverage';}
  return row.completed_laps === requestedLaps && row.first_lap === request.lap_start && row.last_lap === request.lap_end
    ? 'eligible'
    : 'integrity';
}

function isStrictCoverageRow(row: CoverageRow): boolean {
  if (!row || typeof row !== 'object' || Object.keys(row).join(',') !== COVERAGE_FIELDS.join(',')) {return false;}
  if (typeof row.driver_id !== 'string' || !DRIVER_ID.test(row.driver_id)) {return false;}
  return COVERAGE_NUMERIC_FIELDS.every(field => Number.isSafeInteger(row[field]) && row[field] >= 0) &&
    row.completed_laps > 0 && row.first_lap > 0 && row.last_lap > 0;
}

function hasValidCountArithmetic(row: CoverageRow): boolean {
  return row.completed_laps === row.eligible_laps + row.deleted_laps + row.pit_marker_laps &&
    row.first_lap <= row.last_lap && row.eligible_laps <= row.completed_laps;
}

function publicCoverage(row: CoverageRow): OfficialTimingDriverCoverage {
  return {
    driver_id: row.driver_id,
    completed_laps: row.completed_laps,
    eligible_laps: row.eligible_laps,
    excluded_deleted_laps: row.deleted_laps,
    excluded_pit_marker_laps: row.pit_marker_laps
  };
}

function coverageAbstention(): OfficialTimingCoverageDecision {
  return deepFreeze({ type: 'abstain', reason: 'source_coverage_missing', stage: 'official_timing_coverage', query_calls: 1 });
}

function integrityAbstention(): OfficialTimingCoverageDecision {
  return deepFreeze({ type: 'abstain', reason: 'source_integrity_failed', stage: 'official_timing_integrity', query_calls: 1 });
}

async function acquireClient(database: Pick<Pool, 'connect'>): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new OfficialTimingCoverageError('connection_failed'));
      }
    }, CONTROL_TIMEOUT_MS);
    database.connect().then(client => {
      if (settled) {
        client.release(new OfficialTimingCoverageError('connection_failed'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    }, () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new OfficialTimingCoverageError('connection_failed'));
      }
    });
  });
}

async function boundedControlQuery(
  client: PoolClient,
  sql: string,
  code: Extract<OfficialTimingCoverageErrorCode, 'transaction_cleanup_failed' | 'transaction_setup_failed'>
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.query(sql),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new UnsafeOfficialTimingCoverageError(code)), CONTROL_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    if (error instanceof OfficialTimingCoverageError) {throw error;}
    throw new OfficialTimingCoverageError(code);
  } finally {
    if (timeout) {clearTimeout(timeout);}
  }
}

function wallClockQuery(
  client: PoolClient,
  sql: string,
  parameters: unknown[]
): Promise<QueryResult<CoverageRow>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new UnsafeOfficialTimingCoverageError('coverage_query_failed'));
      }
    }, CONTROL_TIMEOUT_MS);
    client.query<CoverageRow>(sql, parameters).then(result => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      }
    }, error => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
