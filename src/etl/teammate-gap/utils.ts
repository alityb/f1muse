import { Pool } from 'pg';
import { createHash } from 'crypto';
import { TeammateGapETLConfig } from '../../config/teammate-gap';

export interface SchemaValidationResult {
  valid: boolean;
  error?: string;
}

export interface TableFingerprint {
  table_name: string;
  columns: Array<{ name: string; type: string }>;
  row_count: number;
  last_updated: string | null;
}

/**
 * Validate required columns exist in a table
 */
export async function validateTableSchema(
  pool: Pool,
  tableName: string,
  requiredColumns: Array<{ name: string; type: string }>
): Promise<SchemaValidationResult> {
  try {
    const result = await pool.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY column_name ASC
      `,
      [tableName]
    );

    if (result.rows.length === 0) {
      return {
        valid: false,
        error: `FAIL_CLOSED: Table "${tableName}" not found in schema`
      };
    }

    const actualColumns = new Map(
      result.rows.map(row => [row.column_name, row.data_type])
    );

    for (const required of requiredColumns) {
      const actualType = actualColumns.get(required.name);

      if (!actualType) {
        return {
          valid: false,
          error: `FAIL_CLOSED: Required column "${required.name}" missing from table "${tableName}"`
        };
      }

      const isCompatible = checkTypeCompatibility(actualType, required.type);
      if (!isCompatible) {
        return {
          valid: false,
          error: `FAIL_CLOSED: Column "${required.name}" in table "${tableName}" has type "${actualType}", expected "${required.type}"`
        };
      }
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `FAIL_CLOSED: Schema validation error for "${tableName}": ${err}`
    };
  }
}

/**
 * Check type compatibility (allow for Postgres type aliases)
 */
export function checkTypeCompatibility(actual: string, expected: string): boolean {
  const actualLower = actual.toLowerCase();
  const expectedLower = expected.toLowerCase();

  if (actualLower === expectedLower) {
    return true;
  }

  const numericTypes = ['numeric', 'decimal', 'double precision', 'doubleprecision', 'real'];
  if (numericTypes.includes(actualLower) && numericTypes.includes(expectedLower)) {
    return true;
  }

  const intTypes = ['integer', 'int', 'int4', 'bigint', 'int8', 'smallint', 'int2'];
  if (intTypes.includes(actualLower) && intTypes.includes(expectedLower)) {
    return true;
  }

  const textTypes = ['text', 'character varying', 'charactervarying', 'varchar', 'char', 'character'];
  if (textTypes.includes(actualLower) && textTypes.includes(expectedLower)) {
    return true;
  }

  if (actualLower === 'boolean' && expectedLower === 'boolean') {
    return true;
  }

  const tsTypes = [
    'timestamp with time zone',
    'timestampwithtimezone',
    'timestamptz',
    'timestamp without time zone',
    'timestampwithouttimezone',
    'timestamp'
  ];
  if (
    tsTypes.some(t => actualLower.includes(t.replace(/\s+/g, ''))) &&
    tsTypes.some(t => expectedLower.includes(t.replace(/\s+/g, '')))
  ) {
    return true;
  }

  if (actualLower === 'uuid' && expectedLower === 'uuid') {
    return true;
  }

  return false;
}

/**
 * Fingerprint a table for execution hash
 */
export async function fingerprintTable(
  pool: Pool,
  tableName: string
): Promise<TableFingerprint> {
  const columnsResult = await pool.query(
    `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY column_name ASC
    `,
    [tableName]
  );

  const columns = columnsResult.rows.map(row => ({
    name: row.column_name,
    type: row.data_type
  }));

  const countResult = await pool.query(`SELECT COUNT(*) AS count FROM ${escapeIdentifier(tableName)}`);
  const row_count = parseInt(countResult.rows[0].count, 10);

  let last_updated: string | null = null;
  const hasUpdatedAt = columns.some(col => col.name === 'updated_at');

  if (hasUpdatedAt) {
    const updatedResult = await pool.query(
      `SELECT MAX(updated_at) AS max_updated FROM ${escapeIdentifier(tableName)}`
    );
    const maxUpdated = updatedResult.rows[0]?.max_updated;
    last_updated = maxUpdated ? new Date(maxUpdated).toISOString() : null;
  }

  return {
    table_name: tableName,
    columns,
    row_count,
    last_updated
  };
}

/**
 * Escape SQL identifier
 */
export function escapeIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`FAIL_CLOSED: Invalid identifier "${identifier}"`);
  }
  return `"${identifier}"`;
}

/**
 * Compute execution hash from input fingerprints
 */
export function computeExecutionHash(
  inputFingerprints: TableFingerprint[],
  season: number,
  config: TeammateGapETLConfig,
  methodology: string
): string {
  const executionData = {
    season,
    config,
    methodology,
    input_tables: inputFingerprints.sort((a, b) => a.table_name.localeCompare(b.table_name))
  };

  const jsonStr = JSON.stringify(executionData);
  const hash = createHash('sha256');
  hash.update(jsonStr);
  return hash.digest('hex');
}
