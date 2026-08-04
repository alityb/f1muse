import { F1QLProgram } from './ast';

export const FINAL_STANDINGS_ROWS_CAVEAT = 'final_standings_rows_only' as const;
export const FINAL_STANDINGS_SOURCE_INTEGRITY_FIELD = '__f1ql_source_integrity_ok' as const;

export interface ResultCollectionEvidence {
  readonly row_limit: number;
  readonly has_more_rows: boolean;
}

export type ReviewedFinalStandingsDriverIds =
  | readonly []
  | readonly [string]
  | readonly [string, string]
  | readonly [string, string, string]
  | readonly [string, string, string, string];

// Validate the complete row-collection contract as one fail-closed gate.
// eslint-disable-next-line complexity
export function finalStandingsRowsResponseContract(
  rowCount: number,
  collection: ResultCollectionEvidence,
  requiredRowCount?: number
): {
  readonly coverage: 'empty' | 'possibly_truncated' | 'sufficient';
  readonly caveats: readonly string[];
} {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 ||
      !Number.isSafeInteger(collection.row_limit) || collection.row_limit < 1 ||
      typeof collection.has_more_rows !== 'boolean' ||
      rowCount > collection.row_limit ||
      (collection.has_more_rows && rowCount !== collection.row_limit) ||
      (requiredRowCount !== undefined &&
        (!Number.isSafeInteger(requiredRowCount) || requiredRowCount < 1 ||
          rowCount !== requiredRowCount || collection.has_more_rows))) {
    throw new Error('final standings result collection evidence is invalid');
  }
  if (rowCount === 0) {
    return { coverage: 'empty', caveats: ['empty_result_is_not_zero'] };
  }
  return {
    coverage: collection.has_more_rows ? 'possibly_truncated' : 'sufficient',
    caveats: collection.has_more_rows ? [FINAL_STANDINGS_ROWS_CAVEAT] : []
  };
}

export function finalStandingsResponseProjection(input: {
  readonly answer: unknown;
  readonly coverage: 'empty' | 'possibly_truncated' | 'sufficient';
  readonly caveats: readonly string[];
}) {
  return {
    answer: input.answer,
    coverage: input.coverage,
    caveats: [...input.caveats]
  };
}

// Keep the complete reviewed program-shape admission visible in one place.
// eslint-disable-next-line complexity
export function reviewedFinalStandingsPointsProgramScope(program: F1QLProgram): {
  readonly season: number;
  readonly driver_ids: ReviewedFinalStandingsDriverIds;
} | null {
  if (!isFinalStandingsPointsProgram(program)) {return null;}
  const root = program.root;
  if (root.op !== 'aggregate' || root.input.op !== 'filter') {return null;}
  const where = root.input.where;
  const keys = Object.keys(where).sort();
  if (keys.length === 1 && keys[0] === 'season') {
    return { season: where.season as number, driver_ids: [] };
  }
  const driverIds = where.driver_id;
  if (keys.length !== 2 || keys[0] !== 'driver_id' || keys[1] !== 'season' ||
      !Array.isArray(driverIds) || driverIds.length < 1 || driverIds.length > 4 ||
      driverIds.some(id => typeof id !== 'string' || !isCanonicalDriverId(id)) ||
      new Set(driverIds).size !== driverIds.length ||
      driverIds.some((id, index) => index > 0 && compareText(driverIds[index - 1], id) >= 0)) {
    return null;
  }
  return {
    season: where.season as number,
    driver_ids: [...driverIds] as unknown as ReviewedFinalStandingsDriverIds
  };
}

export function isFinalStandingsPointsProgram(program: F1QLProgram): boolean {
  const root = program.root;
  if (root.op !== 'aggregate' || root.input.op !== 'filter' || root.input.input.source !== 'standings' ||
      root.group_by.length !== 1 || root.group_by[0] !== 'driver_id' || root.measures.length !== 1 ||
      !Number.isSafeInteger(root.input.where.season)) {
    return false;
  }
  const measure = root.measures[0];
  const driverIds = root.input.where.driver_id;
  return measure.as === 'points' && measure.function === 'max' && measure.field === 'points' &&
    (driverIds === undefined || (Array.isArray(driverIds) && driverIds.length >= 1 && driverIds.length <= 4));
}

export function isUnfilteredFinalStandingsPointsProgram(program: F1QLProgram): boolean {
  return reviewedFinalStandingsPointsProgramScope(program)?.driver_ids.length === 0;
}

function isCanonicalDriverId(value: string): boolean {
  return value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
