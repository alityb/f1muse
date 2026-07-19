import { Pool } from 'pg';
import { compileF1QL } from './compiler';
import { F1QLResult } from './ast';
import { parseF1QLProgram } from './schema';
import { renderF1QL } from './render';
import { lowerF1QL } from './lower';

export async function executeF1QL(pool: Pool, input: unknown): Promise<F1QLResult> {
  const program = parseF1QLProgram(input);
  const coreProgram = lowerF1QL(program);
  const compiled = compileF1QL(coreProgram);
  const result = await pool.query(compiled.sql, compiled.params);

  return {
    program,
    core_program: coreProgram,
    rendering: renderF1QL(program),
    rows: result.rows
  };
}
