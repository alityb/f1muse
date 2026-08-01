import { createHash } from 'node:crypto';
import { Pool, PoolClient, QueryResult } from 'pg';
import {
  F1QLRequestDeadlineError,
  F1QLResultLimitError,
  F1QLStatementTimeoutError
} from './executor';
import {
  assertSemanticCapabilityAuthorizationActive,
  consumeSemanticCapabilityAuthorization,
  SemanticCapabilityAuthorizationConsumptionContext,
  SemanticCapabilityAuthorizationError,
  VerifiedSemanticCapabilityAuthorization,
  verifySemanticCapabilityAuthorization
} from './semantic-capability-authorization';
import {
  getSemanticPlanProofParent,
  VerifiedSemanticPlanProof,
  verifySemanticPlanProof
} from './semantic-plan-proof';
import { F1QLValidationError } from './validation';

export const SEMANTIC_PLAN_EXECUTION_RESULT_VERSION = 'semantic-plan-execution-result-v1' as const;

const verifiedSemanticPlanExecutionResultBrand: unique symbol = Symbol('verifiedSemanticPlanExecutionResult');
const activeResults = new WeakSet<object>();
const resultBindings = new WeakMap<object, SemanticPlanExecutionResultBinding>();

export interface SemanticPlanExecutionResult {
  readonly version: typeof SEMANTIC_PLAN_EXECUTION_RESULT_VERSION;
  readonly authorization_hash: string;
  readonly semantic_plan_proof_hash: string;
  readonly planned_f1ql_hash: string;
  readonly core_hash: string;
  readonly compiled_hash: string;
  readonly row_count: number;
  readonly rows_sha256: string;
  readonly result_hash: string;
}

export type VerifiedSemanticPlanExecutionResult = SemanticPlanExecutionResult & {
  readonly [verifiedSemanticPlanExecutionResultBrand]: true;
};

export interface SemanticPlanExecutionOptions {
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

interface SemanticPlanExecutionResultBinding {
  readonly result: VerifiedSemanticPlanExecutionResult;
  readonly proof: VerifiedSemanticPlanProof;
  readonly authorization: VerifiedSemanticCapabilityAuthorization;
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly max_response_bytes: number;
  readonly context: Omit<SemanticCapabilityAuthorizationConsumptionContext, 'now_ms'>;
  readonly now: () => number;
}

export async function executeAuthorizedSemanticPlan(
  pool: Pool,
  authorizationInput: VerifiedSemanticCapabilityAuthorization,
  proofInput: VerifiedSemanticPlanProof,
  context: Omit<SemanticCapabilityAuthorizationConsumptionContext, 'now_ms'>,
  options: SemanticPlanExecutionOptions = {}
): Promise<VerifiedSemanticPlanExecutionResult> {
  const proof = verifySemanticPlanProof(proofInput);
  const authorization = verifySemanticCapabilityAuthorization(authorizationInput);
  const parent = getSemanticPlanProofParent(proof);
  assertExecutionBindings(authorization, proof, parent.cost.units, parent.cost.requested_rows);

  const now = options.now ?? Date.now;
  const deadlineMs = executionDeadline(now(), authorization.runtime_ceilings.request_timeout_ms, options.deadlineMs);
  const boundedOptions = { ...options, deadlineMs };
  throwIfAborted(options.signal);
  effectiveStatementTimeout(authorization.runtime_ceilings.statement_timeout_ms, boundedOptions, now);
  consumeSemanticCapabilityAuthorization(authorization, activeContext(context, now()));

  const client = await acquireClient(pool, options.signal, deadlineMs, now);
  let transactionState: 'none' | 'open' | 'uncertain' = 'none';
  let discardClient = false;
  let timeoutMs = authorization.runtime_ceilings.statement_timeout_ms;
  let deadlineLimited = false;
  try {
    throwIfAborted(options.signal);
    assertSemanticCapabilityAuthorizationActive(authorization, activeContext(context, now()));
    effectiveStatementTimeout(timeoutMs, boundedOptions, now);
    transactionState = 'uncertain';
    await queryBounded(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', undefined, boundedOptions, now);
    transactionState = 'open';
    ({ timeoutMs, deadlineLimited } = effectiveStatementTimeout(timeoutMs, boundedOptions, now));
    await setStatementTimeout(client, timeoutMs, boundedOptions, now);
    await validatePlannedParticipation(client, parent.participation, boundedOptions, now);
    assertSemanticCapabilityAuthorizationActive(authorization, activeContext(context, now()));
    throwIfAborted(options.signal);
    ({ timeoutMs, deadlineLimited } = effectiveStatementTimeout(
      authorization.runtime_ceilings.statement_timeout_ms,
      boundedOptions,
      now
    ));
    await setStatementTimeout(client, timeoutMs, boundedOptions, now);
    const queryResult = await queryBounded(client, parent.compiled.sql, parent.compiled.params, boundedOptions, now);
    throwIfAborted(options.signal);
    assertSemanticCapabilityAuthorizationActive(authorization, activeContext(context, now()));
    if (queryResult.rows.length > parent.cost.requested_rows ||
        queryResult.rows.length > authorization.runtime_ceilings.max_rows) {
      throw new F1QLResultLimitError(Math.min(parent.cost.requested_rows, authorization.runtime_ceilings.max_rows));
    }
    const rows = snapshotRows(queryResult.rows);
    transactionState = 'uncertain';
    await queryBounded(client, 'COMMIT', undefined, boundedOptions, now);
    transactionState = 'none';
    assertSemanticCapabilityAuthorizationActive(authorization, activeContext(context, now()));
    return mintExecutionResult(authorization, proof, rows, context, now);
  } catch (error) {
    if (transactionState === 'open') {
      try {
        await queryBounded(client, 'ROLLBACK', undefined, boundedOptions, now);
        transactionState = 'none';
      } catch {
        discardClient = true;
      }
    }
    if (transactionState === 'uncertain' || error instanceof F1QLRequestDeadlineError || options.signal?.aborted) {
      discardClient = true;
    }
    if ((error as { code?: string }).code === '57014') {
      throw deadlineLimited ? new F1QLRequestDeadlineError() : new F1QLStatementTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export function verifySemanticPlanExecutionResult(input: unknown): VerifiedSemanticPlanExecutionResult {
  if (!input || typeof input !== 'object' || !activeResults.has(input) || !Object.isFrozen(input)) {
    throw new Error('semantic plan execution result provenance is invalid');
  }
  const result = input as VerifiedSemanticPlanExecutionResult;
  const binding = resultBindings.get(result);
  if (!binding || !Object.isFrozen(binding.context) || !Object.isFrozen(binding.rows) ||
      binding.rows.some(row => !Object.isFrozen(row))) {
    throw new Error('semantic plan execution result binding is invalid');
  }
  const proof = verifySemanticPlanProof(binding.proof);
  const authorization = verifySemanticCapabilityAuthorization(binding.authorization);
  const { result_hash: resultHash, ...draft } = result;
  if (result[verifiedSemanticPlanExecutionResultBrand] !== true ||
      result.version !== SEMANTIC_PLAN_EXECUTION_RESULT_VERSION ||
      result.semantic_plan_proof_hash !== proof.proof_hash ||
      result.authorization_hash !== authorization.authorization_hash ||
      result.planned_f1ql_hash !== proof.planned_f1ql_hash ||
      result.core_hash !== proof.core_hash || result.compiled_hash !== proof.compiled_hash ||
      binding.max_response_bytes !== authorization.runtime_ceilings.max_response_bytes ||
      result.row_count !== binding.rows.length || result.rows_sha256 !== sha256(stableSerialize(binding.rows)) ||
      resultHash !== sha256(stableSerialize(draft))) {
    throw new Error('semantic plan execution result binding is invalid');
  }
  return result;
}

/** @internal Formatting boundary; application routes must use formatSemanticPlanResult. */
export function getSemanticPlanExecutionResultBinding(input: unknown): Readonly<{
  proof: VerifiedSemanticPlanProof;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  max_response_bytes: number;
  assert_active: () => void;
}> {
  const result = verifySemanticPlanExecutionResult(input);
  const binding = resultBindings.get(result)!;
  const assertActive = () => {
    assertSemanticCapabilityAuthorizationActive(
      binding.authorization,
      activeContext(binding.context, binding.now())
    );
  };
  assertActive();
  return Object.freeze({
    proof: binding.proof,
    rows: binding.rows,
    max_response_bytes: binding.max_response_bytes,
    assert_active: assertActive
  });
}

function assertExecutionBindings(
  authorization: VerifiedSemanticCapabilityAuthorization,
  proof: VerifiedSemanticPlanProof,
  workUnits: number,
  requestedRows: number
): void {
  if (authorization.catalog_hash !== proof.catalog_hash ||
      authorization.semantic_evidence_hash !== proof.semantic_evidence_hash ||
      authorization.candidate_set_hash !== proof.candidate_set_hash ||
      authorization.resolution_evidence_hash !== proof.resolution_evidence_hash ||
      authorization.answer_plan_hash !== proof.answer_plan_hash ||
      authorization.planned_f1ql_hash !== proof.planned_f1ql_hash ||
      authorization.core_hash !== proof.core_hash || authorization.topology_hash !== proof.topology_hash ||
      authorization.semantic_plan_proof_hash !== proof.proof_hash ||
      authorization.semantic_plan_proof_version !== proof.version ||
      authorization.interaction.work_units !== workUnits || authorization.interaction.rows !== requestedRows ||
      workUnits > authorization.runtime_ceilings.max_work_units ||
      requestedRows > authorization.runtime_ceilings.max_rows) {
    throw new SemanticCapabilityAuthorizationError('authorization_binding_mismatch');
  }
}

function activeContext(
  context: Omit<SemanticCapabilityAuthorizationConsumptionContext, 'now_ms'>,
  nowMs: number
): SemanticCapabilityAuthorizationConsumptionContext {
  return { ...context, now_ms: nowMs };
}

async function validatePlannedParticipation(
  client: Pick<PoolClient, 'query'>,
  decision: ReturnType<typeof getSemanticPlanProofParent>['participation'],
  options: SemanticPlanExecutionOptions,
  now: () => number
): Promise<void> {
  if (decision.type === 'not_required') {return;}
  for (const requirement of decision.requirements) {
    const result = await queryBounded(
      client,
      `SELECT DISTINCT REPLACE(driver_id, '_', '-') AS driver_id FROM f1ql.answer_season_participation WHERE season = $1 AND REPLACE(driver_id, '_', '-') = ANY($2::text[])`,
      [requirement.season, requirement.driver_ids],
      options,
      now
    );
    const actual = result.rows.map(row => row.driver_id).sort(compareText);
    if (!sameStrings(actual, requirement.driver_ids)) {
      throw new F1QLValidationError('participation_missing', 'Driver did not participate in the requested season');
    }
  }
}

function mintExecutionResult(
  authorization: VerifiedSemanticCapabilityAuthorization,
  proof: VerifiedSemanticPlanProof,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  context: Omit<SemanticCapabilityAuthorizationConsumptionContext, 'now_ms'>,
  now: () => number
): VerifiedSemanticPlanExecutionResult {
  const draft = {
    [verifiedSemanticPlanExecutionResultBrand]: true as const,
    version: SEMANTIC_PLAN_EXECUTION_RESULT_VERSION,
    authorization_hash: authorization.authorization_hash,
    semantic_plan_proof_hash: proof.proof_hash,
    planned_f1ql_hash: proof.planned_f1ql_hash,
    core_hash: proof.core_hash,
    compiled_hash: proof.compiled_hash,
    row_count: rows.length,
    rows_sha256: sha256(stableSerialize(rows))
  };
  const result: VerifiedSemanticPlanExecutionResult = Object.freeze({
    ...draft,
    result_hash: sha256(stableSerialize(draft))
  });
  const binding = Object.freeze({
    result,
    proof,
    authorization,
    rows,
    max_response_bytes: authorization.runtime_ceilings.max_response_bytes,
    context: Object.freeze({ ...context }),
    now
  });
  activeResults.add(result);
  resultBindings.set(result, binding);
  return result;
}

function snapshotRows(input: readonly Record<string, unknown>[]): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (!Array.isArray(input)) {throw new Error('semantic plan execution rows must be an array');}
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      throw new Error('semantic plan execution rows must be dense');
    }
    const row = input[index];
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(row))) {
      throw new Error('semantic plan execution row must be a plain object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(row);
    if (Reflect.ownKeys(row).some(key => typeof key !== 'string') ||
        Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) {
      throw new Error('semantic plan execution row has an invalid property shape');
    }
    rows.push(Object.freeze(Object.fromEntries(Object.keys(row).map(key => [key, snapshotValue(descriptors[key].value)]))));
  }
  return Object.freeze(rows);
}

function snapshotValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {return value;}
  if (typeof value === 'number' && Number.isFinite(value)) {return value;}
  if (value instanceof Date && !Number.isNaN(value.valueOf()) && value.getHours() === 0 &&
      value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0) {
    return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  throw new Error('semantic plan execution row contains an unsupported value');
}

async function setStatementTimeout(
  client: Pick<PoolClient, 'query'>,
  timeoutMs: number,
  options: SemanticPlanExecutionOptions,
  now: () => number
): Promise<void> {
  await queryBounded(
    client,
    "SELECT set_config('statement_timeout', $1, true)",
    [`${timeoutMs}ms`],
    options,
    now
  );
}

function effectiveStatementTimeout(
  configured: number,
  options: SemanticPlanExecutionOptions,
  now: () => number
): { timeoutMs: number; deadlineLimited: boolean } {
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new SemanticCapabilityAuthorizationError('authorization_binding_mismatch');
  }
  if (options.deadlineMs === undefined) {return { timeoutMs: configured, deadlineLimited: false };}
  const remaining = Math.floor(options.deadlineMs - now());
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new F1QLRequestDeadlineError();
  }
  return { timeoutMs: Math.min(configured, remaining), deadlineLimited: remaining <= configured };
}

function executionDeadline(startedAt: number, requestTimeoutMs: number, callerDeadline: number | undefined): number {
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new SemanticCapabilityAuthorizationError('authorization_binding_mismatch');
  }
  const runtimeDeadline = startedAt + requestTimeoutMs;
  if (!Number.isSafeInteger(runtimeDeadline) ||
      (callerDeadline !== undefined && !Number.isSafeInteger(callerDeadline))) {
    throw new SemanticCapabilityAuthorizationError('authorization_binding_mismatch');
  }
  return callerDeadline === undefined ? runtimeDeadline : Math.min(runtimeDeadline, callerDeadline);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new F1QLRequestDeadlineError();
  }
}

function acquireClient(
  pool: Pool,
  signal: AbortSignal | undefined,
  deadlineMs: number,
  now: () => number
): Promise<PoolClient> {
  throwIfAborted(signal);
  requireRemainingDeadline(deadlineMs, now);
  return boundedOperation(() => pool.connect(), deadlineMs, signal, now, client => client.release(true));
}

async function queryBounded(
  client: Pick<PoolClient, 'query'>,
  sql: string,
  params: unknown[] | undefined,
  options: SemanticPlanExecutionOptions,
  now: () => number
): Promise<QueryResult<Record<string, unknown>>> {
  if (options.deadlineMs === undefined) {throw new F1QLRequestDeadlineError();}
  requireRemainingDeadline(options.deadlineMs, now);
  return boundedOperation(
    () => (params === undefined ? client.query(sql) : client.query(sql, params)) as Promise<QueryResult<Record<string, unknown>>>,
    options.deadlineMs,
    options.signal,
    now
  );
}

function boundedOperation<T>(
  createOperation: () => Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  now: () => number,
  onLateSuccess?: (value: T) => void
): Promise<T> {
  const remaining = requireRemainingDeadline(deadlineMs, now);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {return false;}
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
      return true;
    };
    const onAbort = () => finish(() => reject(
      signal?.reason instanceof Error ? signal.reason : new F1QLRequestDeadlineError()
    ));
    const timer = setTimeout(() => finish(() => reject(new F1QLRequestDeadlineError())), remaining);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    let operation: Promise<T>;
    try {
      operation = createOperation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    operation.then(value => {
      if (!finish(() => resolve(value))) {onLateSuccess?.(value);}
    }, error => finish(() => reject(error)));
  });
}

function requireRemainingDeadline(deadlineMs: number, now: () => number): number {
  const remaining = Math.floor(deadlineMs - now());
  if (!Number.isSafeInteger(remaining) || remaining < 1) {throw new F1QLRequestDeadlineError();}
  return remaining;
}

function sameStrings(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: unknown, right: unknown): number {
  if (typeof left !== 'string' || typeof right !== 'string') {return 0;}
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
