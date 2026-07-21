import { F1QLProgram } from './ast';
import { Pool } from 'pg';

export const F1QL_DEFINITIONS_VERSION = 'v1';
export const F1QL_SIGNATURES = {
  standings: { fields: ['driver_id', 'points', 'championship_position'], operators: ['filter', 'aggregate', 'rank'] },
  lap_pace: { fields: ['driver_id', 'lap_time_seconds', 'compound', 'clean_air_flag'], operators: ['pace_summary', 'pace_delta'] },
  event_classification: { fields: ['driver_id', 'team_id', 'classification_status', 'finishing_position'], operators: ['event_classification'] }
} as const;

export type F1QLValidationCode = 'definitions_version_mismatch' | 'complexity_exceeded' | 'coverage_unsupported' | 'participation_missing';

export class F1QLValidationError extends Error {
  constructor(public readonly code: F1QLValidationCode, message: string) {
    super(message);
  }
}

export async function validateParticipation(pool: Pool, program: F1QLProgram): Promise<void> {
  const root = program.root;
  const season = root.op === 'pace_delta' || root.op === 'pace_summary' ? root.scope.season : undefined;
  const drivers = root.op === 'pace_delta' ? [root.driver_a_id, root.driver_b_id] : root.op === 'pace_summary' ? [root.driver_id] : [];
  if (season === undefined || !drivers.length) return;
  const result = await pool.query(
    `SELECT DISTINCT REPLACE(driver_id, '_', '-') AS driver_id FROM season_entrant_driver WHERE year = $1 AND REPLACE(driver_id, '_', '-') = ANY($2::text[]) AND COALESCE(test_driver, false) = false`,
    [season, drivers]
  );
  if (result.rows.length !== drivers.length) {
    throw new F1QLValidationError('participation_missing', 'Driver did not participate in the requested season');
  }
}

export function validateF1QLProgram(program: F1QLProgram, definitionsVersion = F1QL_DEFINITIONS_VERSION): void {
  if (definitionsVersion !== F1QL_DEFINITIONS_VERSION) {
    throw new F1QLValidationError('definitions_version_mismatch', 'Definitions version is not active');
  }
  const nodes = countNodes(program.root);
  if (nodes > 12) {
    throw new F1QLValidationError('complexity_exceeded', 'Program exceeds the 12-node complexity budget');
  }
  if (program.root.op === 'event_classification' && program.root.round > 30) {
    throw new F1QLValidationError('coverage_unsupported', 'Round is outside supported event coverage');
  }
  if (program.root.op === 'aggregate' || program.root.op === 'rank') {
    const aggregate = program.root.op === 'rank' ? program.root.input : program.root;
    if (aggregate.input.op === 'source' && aggregate.input.source !== 'standings') {
      throw new F1QLValidationError('coverage_unsupported', 'Source is not supported');
    }
  }
}

function countNodes(root: F1QLProgram['root']): number {
  if (root.op === 'rank') return 3 + (root.input.input.op === 'filter' ? 1 : 0);
  if (root.op === 'aggregate') return 2 + (root.input.op === 'filter' ? 1 : 0);
  return 1;
}
