import { Pool } from 'pg';
import { compileF1QL } from './compiler';
import { F1QLResult } from './ast';
import { parseF1QLProgram } from './schema';
import { renderF1QL } from './render';
import { lowerF1QL } from './lower';
import { enforceF1QLCostLimits, F1QLCostLimitError, MAX_F1QL_RESPONSE_ROWS } from './limits';
import { validateCoreProgram, validateF1QLProgram, validateParticipation } from './validation';
import { getVerifiedProgram } from './verified-programs';

export { F1QLCostLimitError } from './limits';

export class F1QLStatementTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`F1QL statement exceeded the ${timeoutMs}ms timeout`);
  }
}

export class F1QLResultLimitError extends F1QLCostLimitError {
  constructor(maxRows: number) {
    super(`Program returned more than ${maxRows} rows`);
    this.name = 'F1QLResultLimitError';
  }
}

export interface F1QLExecutionOptions {
  statementTimeoutMs?: number;
  maxRows?: number;
}

export async function executeF1QL(pool: Pool, input: unknown, options: F1QLExecutionOptions = {}): Promise<F1QLResult> {
  const program = parseF1QLProgram(input);
  validateF1QLProgram(program);
  enforceF1QLCostLimits(program);
  await validateParticipation(pool, program);
  const coreProgram = lowerF1QL(program);
  validateCoreProgram(coreProgram);
  const compiled = compileF1QL(coreProgram);
  const maxRows = validatedMaxRows(options.maxRows);
  const bounded = addCollectionSentinel(compiled.sql, compiled.params, maxRows, answerOrderBy(program));
  const result = await executeF1QLReadOnly(pool, bounded.sql, bounded.params, options);
  if (result.rows.length > maxRows) {
    throw new F1QLResultLimitError(maxRows);
  }

  return {
    program,
    core_program: coreProgram,
    rendering: renderF1QL(program),
    rows: result.rows
  };
}

export function addCollectionSentinel(sql: string, params: unknown[], maxRows: number, orderBy?: string): { sql: string; params: unknown[] } {
  const validated = validatedMaxRows(maxRows);
  return {
    sql: `SELECT * FROM (${sql}) AS f1ql_bounded_result${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT $${params.length + 1}`,
    params: [...params, validated + 1]
  };
}

function answerOrderBy(program: F1QLResult['program']): string | undefined {
  const root = program.root;
  if (root.op === 'rank') {
    return `${root.by} ${root.direction.toUpperCase()}, driver_id ASC`;
  }
  if (root.op === 'aggregate') {
    return 'driver_id ASC';
  }
  if (root.op === 'event_classification') {
    return 'finishing_position ASC NULLS LAST, driver_id ASC';
  }
  if (root.op === 'qualifying_classification') {
    return 'qualifying_position ASC NULLS LAST, driver_id ASC';
  }
  if (root.op === 'event_metadata') {
    return 'event_id ASC';
  }
  return undefined;
}

function validatedMaxRows(value: number | undefined): number {
  const maxRows = value ?? MAX_F1QL_RESPONSE_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_F1QL_RESPONSE_ROWS) {
    throw new F1QLCostLimitError(`maxRows must be between 1 and ${MAX_F1QL_RESPONSE_ROWS}`);
  }
  return maxRows;
}

export async function executeVerifiedF1QL(pool: Pool, id: string, options: F1QLExecutionOptions = {}): Promise<F1QLResult> {
  return executeF1QL(pool, getVerifiedProgram(id), options);
}

export async function executeF1QLReadOnly(pool: Pool, sql: string, params: unknown[], options: F1QLExecutionOptions = {}) {
  const timeoutMs = options.statementTimeoutMs ?? Number(process.env.F1QL_STATEMENT_TIMEOUT_MS ?? 10_000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '57014') {
      throw new F1QLStatementTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    client.release();
  }
}
