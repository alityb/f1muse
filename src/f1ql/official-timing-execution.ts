import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  ConsumedOfficialTimingCapabilityAuthorization,
  consumeOfficialTimingCapabilityAuthorization,
  OfficialTimingAuthorizationError,
  OfficialTimingPrincipalClass
} from './official-timing-authorization';
import {
  OfficialTimingCompiledStatement,
  verifyOfficialTimingCompiledStatement
} from './official-timing-compiler';
import { OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID } from './official-timing-question';

export const OFFICIAL_TIMING_EXECUTION_RESULT_VERSION = 'semantic-plan-execution-result-v3' as const;
const MAX_STATEMENT_TIMEOUT_MS = 10_000;

export interface OfficialTimingExecutionContext {
  readonly request_id: string;
  readonly principal_class: OfficialTimingPrincipalClass;
  readonly statement_timeout_ms: number;
  readonly deadline_ms: number;
  readonly is_kill_switch_active: () => boolean;
  readonly now_ms?: number;
}

export interface OfficialTimingExecutionResult {
  readonly version: typeof OFFICIAL_TIMING_EXECUTION_RESULT_VERSION;
  readonly metric_id: OfficialTimingCompiledStatement['metric_id'];
  readonly rows: readonly [Readonly<Record<string, unknown>>];
  readonly rows_hash: string;
  readonly returned_row_limit: 1;
  readonly observed_row_limit: 1;
  readonly has_more_rows: false;
  readonly transaction: 'repeatable_read_read_only';
  readonly authorization_hash: string;
  readonly result_collection_compiled_hash: string;
  readonly compiled_hash: string;
  readonly planned_core_hash: string;
  readonly planned_f1ql_hash: string;
  readonly semantic_plan_proof_hash: string;
  readonly result_hash: string;
}

declare const activeOfficialTimingExecutionResultBrand: unique symbol;
export type VerifiedOfficialTimingExecutionResult = OfficialTimingExecutionResult & {
  readonly [activeOfficialTimingExecutionResultBrand]: true;
};

export class OfficialTimingExecutionError extends Error {
  constructor(readonly code:
    | 'authorization_binding_mismatch' | 'authorization_expired' | 'authorization_replayed'
    | 'connection_failed' | 'kill_switch_active' | 'result_invalid'
    | 'result_query_failed' | 'statement_timeout' | 'transaction_cleanup_failed'
    | 'transaction_setup_failed') {
    super(`Official timing execution failed: ${code}`);
    this.name = 'OfficialTimingExecutionError';
  }
}

class UnsafeOfficialTimingExecutionError extends OfficialTimingExecutionError {}

const activeResults = new WeakSet<object>();

export async function executeOfficialTimingPlan(
  database: Pick<Pool, 'connect'>,
  authorizationInput: unknown,
  compiledInput: unknown,
  proofHash: string,
  plannedCoreHash: string,
  context: OfficialTimingExecutionContext
): Promise<VerifiedOfficialTimingExecutionResult> {
  if (!Number.isSafeInteger(context.statement_timeout_ms) ||
      context.statement_timeout_ms < 1 || context.statement_timeout_ms > MAX_STATEMENT_TIMEOUT_MS ||
      !Number.isFinite(context.deadline_ms)) {
    throw new OfficialTimingExecutionError('transaction_setup_failed');
  }
  // Brand verification before consumption; one-time consumption strictly before database acquisition.
  const compiled = brandVerifiedCompiled(compiledInput);
  const authorization = consumeAuthorization(authorizationInput, context);
  assertExecutionBindings(authorization, compiled, proofHash, plannedCoreHash);
  const rows = await runStatement(database, compiled, context);
  const unsigned = {
    version: OFFICIAL_TIMING_EXECUTION_RESULT_VERSION,
    metric_id: compiled.metric_id,
    rows,
    rows_hash: hash(rows),
    returned_row_limit: 1 as const,
    observed_row_limit: 1 as const,
    has_more_rows: false as const,
    transaction: 'repeatable_read_read_only' as const,
    authorization_hash: authorization.authorization_hash,
    result_collection_compiled_hash: hash(authorization.result_collection),
    compiled_hash: compiled.compiled_sha256,
    planned_core_hash: plannedCoreHash,
    planned_f1ql_hash: authorization.planned_f1ql_hash,
    semantic_plan_proof_hash: proofHash
  };
  const result = deepFreeze({ ...unsigned, result_hash: hash(unsigned) });
  activeResults.add(result);
  return result as VerifiedOfficialTimingExecutionResult;
}

function brandVerifiedCompiled(compiledInput: unknown): OfficialTimingCompiledStatement {
  try {
    return verifyOfficialTimingCompiledStatement(compiledInput);
  } catch {
    throw new OfficialTimingExecutionError('result_invalid');
  }
}

function consumeAuthorization(
  authorizationInput: unknown,
  context: OfficialTimingExecutionContext
): ConsumedOfficialTimingCapabilityAuthorization {
  try {
    return consumeOfficialTimingCapabilityAuthorization(authorizationInput, {
      request_id: context.request_id,
      principal_class: context.principal_class,
      is_kill_switch_active: context.is_kill_switch_active,
      now_ms: context.now_ms
    });
  } catch (error) {
    if (error instanceof OfficialTimingAuthorizationError) {
      const mapped = {
        authorization_replayed: 'authorization_replayed',
        authorization_expired: 'authorization_expired',
        kill_switch_active: 'kill_switch_active'
      } as const;
      throw new OfficialTimingExecutionError(
        error.reason in mapped ? mapped[error.reason as keyof typeof mapped] : 'authorization_binding_mismatch'
      );
    }
    throw new OfficialTimingExecutionError('result_invalid');
  }
}

function assertExecutionBindings(
  authorization: ConsumedOfficialTimingCapabilityAuthorization,
  compiled: OfficialTimingCompiledStatement,
  proofHash: string,
  plannedCoreHash: string
): void {
  if (authorization.compiled_hash !== compiled.compiled_sha256 ||
      authorization.planned_core_hash !== plannedCoreHash ||
      authorization.proof_hash !== proofHash || authorization.result_collection.returned_row_limit !== 1 ||
      authorization.result_collection.observed_row_limit !== 1) {
    throw new OfficialTimingExecutionError('authorization_binding_mismatch');
  }
}

export function verifyOfficialTimingExecutionResult(input: unknown): VerifiedOfficialTimingExecutionResult {
  if (!input || typeof input !== 'object' || !activeResults.has(input)) {
    throw new OfficialTimingExecutionError('result_invalid');
  }
  return input as VerifiedOfficialTimingExecutionResult;
}

async function runStatement(
  database: Pick<Pool, 'connect'>,
  compiled: OfficialTimingCompiledStatement,
  context: OfficialTimingExecutionContext
): Promise<readonly [Readonly<Record<string, unknown>>]> {
  const client = await acquireClient(database, context);
  let transactionOpen = false;
  let releaseError: Error | undefined;
  try {
    await boundedControl(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'transaction_setup_failed', context);
    transactionOpen = true;
    await boundedControl(client, `SET LOCAL statement_timeout = '${context.statement_timeout_ms}ms'`, 'transaction_setup_failed', context);
    const result = await runBoundedQuery(client, compiled, context);
    const rows = validateRows(compiled, result);
    await boundedControl(client, 'COMMIT', 'transaction_cleanup_failed', context);
    transactionOpen = false;
    return rows;
  } catch (error) {
    let failure = error instanceof Error ? error : new OfficialTimingExecutionError('result_query_failed');
    if (error instanceof UnsafeOfficialTimingExecutionError) {transactionOpen = false;}
    if (transactionOpen) {
      try {
        await boundedControl(client, 'ROLLBACK', 'transaction_cleanup_failed', context);
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

async function acquireClient(database: Pick<Pool, 'connect'>, context: OfficialTimingExecutionContext): Promise<PoolClient> {
  const remaining = remainingMs(context);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new OfficialTimingExecutionError('connection_failed'));
      }
    }, remaining);
    database.connect().then(client => {
      if (settled) {
        client.release(new OfficialTimingExecutionError('connection_failed'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    }, () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new OfficialTimingExecutionError('connection_failed'));
      }
    });
  });
}

async function boundedControl(
  client: PoolClient,
  sql: string,
  code: 'transaction_cleanup_failed' | 'transaction_setup_failed',
  context: OfficialTimingExecutionContext
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.query(sql),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new UnsafeOfficialTimingExecutionError(code)), remainingMs(context));
      })
    ]);
  } catch (error) {
    if (error instanceof OfficialTimingExecutionError) {throw error;}
    throw new OfficialTimingExecutionError(code);
  } finally {
    if (timeout) {clearTimeout(timeout);}
  }
}

async function runBoundedQuery(
  client: PoolClient,
  compiled: OfficialTimingCompiledStatement,
  context: OfficialTimingExecutionContext
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new UnsafeOfficialTimingExecutionError('result_query_failed'));
      }
    }, remainingMs(context));
    client.query(compiled.statement, [...compiled.parameters]).then(result => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }, error => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timeout);
      if ((error as { code?: string })?.code === '57014') {
        reject(new UnsafeOfficialTimingExecutionError('statement_timeout'));
        return;
      }
      reject(new OfficialTimingExecutionError('result_query_failed'));
    });
  });
}

function validateRows(
  compiled: OfficialTimingCompiledStatement,
  result: QueryResult
): readonly [Readonly<Record<string, unknown>>] {
  if (result.rows.length !== 1) {
    throw new UnsafeOfficialTimingExecutionError('result_invalid');
  }
  const row = result.rows[0] as Record<string, unknown>;
  const expectedFields = compiled.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID
    ? ['driver_a_eligible_laps', 'driver_a_total_ms', 'driver_b_eligible_laps', 'driver_b_total_ms']
    : ['driver_a_eligible_laps', 'driver_a_ms_values', 'driver_b_eligible_laps', 'driver_b_ms_values'];
  if (Object.keys(row).sort(compareText).join(',') !== [...expectedFields].sort(compareText).join(',')) {
    throw new UnsafeOfficialTimingExecutionError('result_invalid');
  }
  for (const field of ['driver_a_eligible_laps', 'driver_b_eligible_laps']) {
    if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 0) {
      throw new UnsafeOfficialTimingExecutionError('result_invalid');
    }
  }
  if (compiled.metric_id === OFFICIAL_TIMING_EVENT_MEAN_METRIC_ID) {
    validateTotalMs(row.driver_a_total_ms);
    validateTotalMs(row.driver_b_total_ms);
  } else {
    validateMsValues(row.driver_a_ms_values, row.driver_a_eligible_laps);
    validateMsValues(row.driver_b_ms_values, row.driver_b_eligible_laps);
  }
  return [deepFreeze({ ...row })];
}

function validateTotalMs(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) {
    throw new UnsafeOfficialTimingExecutionError('result_invalid');
  }
}

function validateMsValues(value: unknown, eligibleLaps: unknown): void {
  if (value === null && eligibleLaps === 0) {
    return;
  }
  if (!Array.isArray(value) || value.length !== eligibleLaps ||
      !value.every(item => typeof item === 'string' && /^\d{1,15}$/.test(item)) ||
      !value.every((item, index, items) => index === 0 || BigInt(items[index - 1]) <= BigInt(item))) {
    throw new UnsafeOfficialTimingExecutionError('result_invalid');
  }
}

function remainingMs(context: OfficialTimingExecutionContext): number {
  const remaining = Math.floor(context.deadline_ms - (context.now_ms ?? Date.now()));
  if (remaining < 1) {
    throw new OfficialTimingExecutionError('transaction_setup_failed');
  }
  return Math.min(remaining, MAX_STATEMENT_TIMEOUT_MS);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing execution value is not canonically serializable');
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
