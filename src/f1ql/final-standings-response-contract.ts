import { F1QLProgram } from './ast';

export const FINAL_STANDINGS_ROWS_CAVEAT = 'final_standings_rows_only' as const;

export interface ResultCollectionEvidence {
  readonly row_limit: number;
  readonly has_more_rows: boolean;
}

export function finalStandingsRowsResponseContract(
  rowCount: number,
  collection: ResultCollectionEvidence
): {
  readonly coverage: 'empty' | 'possibly_truncated' | 'sufficient';
  readonly caveats: readonly string[];
} {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 ||
      !Number.isSafeInteger(collection.row_limit) || collection.row_limit < 1 ||
      typeof collection.has_more_rows !== 'boolean' ||
      rowCount > collection.row_limit ||
      (collection.has_more_rows && rowCount !== collection.row_limit)) {
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

export function isUnfilteredFinalStandingsPointsProgram(program: F1QLProgram): boolean {
  const root = program.root;
  if (root.op !== 'aggregate' || root.input.op !== 'filter' || root.input.input.source !== 'standings' ||
      root.group_by.length !== 1 || root.group_by[0] !== 'driver_id' || root.measures.length !== 1) {
    return false;
  }
  const measure = root.measures[0];
  return measure.as === 'points' && measure.function === 'max' && measure.field === 'points' &&
    Number.isSafeInteger(root.input.where.season) && Object.keys(root.input.where).length === 1;
}
