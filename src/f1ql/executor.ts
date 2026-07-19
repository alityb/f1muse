import { Pool } from 'pg';
import { compileF1QL } from './compiler';
import { F1QLResult } from './ast';
import { parseF1QLProgram } from './schema';
import { renderF1QL } from './render';
import { lowerF1QL } from './lower';
import { enforceF1QLCostLimits, F1QLCostLimitError, MAX_F1QL_RESPONSE_ROWS } from './limits';

export { F1QLCostLimitError } from './limits';

export async function executeF1QL(pool: Pool, input: unknown): Promise<F1QLResult> {
  const program = parseF1QLProgram(input);
  enforceF1QLCostLimits(program);
  const coreProgram = lowerF1QL(program);
  const compiled = compileF1QL(coreProgram);
  const result = await pool.query(compiled.sql, compiled.params);
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
