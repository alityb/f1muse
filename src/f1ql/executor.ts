import { Pool } from 'pg';
import { compileF1QL } from './compiler';
import { F1QLResult } from './ast';
import { parseF1QLProgram } from './schema';
import { renderF1QL } from './render';
import { lowerF1QL } from './lower';
import { enforceF1QLCostLimits, F1QLCostLimitError, MAX_F1QL_RESPONSE_ROWS } from './limits';
import { validateCoreProgram, validateF1QLProgram, validateParticipation } from './validation';

export { F1QLCostLimitError } from './limits';

export class F1QLStatementTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`F1QL statement exceeded the ${timeoutMs}ms timeout`);
  }
}

export interface F1QLExecutionOptions {
  statementTimeoutMs?: number;
}

export async function executeF1QL(pool: Pool, input: unknown, options: F1QLExecutionOptions = {}): Promise<F1QLResult> {
  const program = parseF1QLProgram(input);
  validateF1QLProgram(program);
  enforceF1QLCostLimits(program);
  await validateParticipation(pool, program);
  const coreProgram = lowerF1QL(program);
  validateCoreProgram(coreProgram);
  const compiled = compileF1QL(coreProgram);
  const result = await executeF1QLReadOnly(pool, compiled.sql, compiled.params, options);
  if (result.rows.length > MAX_F1QL_RESPONSE_ROWS) {
    throw new F1QLCostLimitError(`Program returned more than ${MAX_F1QL_RESPONSE_ROWS} rows`);
  }

  return {
    program,
    core_program: coreProgram,
    rendering: renderF1QL(program),
    rows: result.rows
  };
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
