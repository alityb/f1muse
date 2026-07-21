import { Pool } from 'pg';
import { F1QLProgram } from './ast';

export const F1QL_DEFINITIONS_VERSION = 'v1';
export const F1QL_SIGNATURES = {
  standings: { fields: ['season', 'driver_id', 'points', 'championship_position'], operators: ['source', 'filter', 'aggregate', 'rank'] },
  lap_pace: { fields: ['driver_id', 'lap_time_seconds', 'compound', 'clean_air_flag'], operators: ['pace_summary', 'pace_delta'] },
  event_classification: { fields: ['driver_id', 'team_id', 'classification_status', 'finishing_position'], operators: ['event_classification'] }
} as const;

export type F1QLValidationCode = 'definitions_version_mismatch' | 'complexity_exceeded' | 'coverage_unsupported' | 'participation_missing' | 'signature_invalid';

export class F1QLValidationError extends Error {
  constructor(public readonly code: F1QLValidationCode, message: string) {
    super(message);
  }
}

export interface F1QLValidationOptions {
  definitionsVersion?: string;
  maxNodes?: number;
}

export function refreshF1QLDefinitionsVersion(): string {
  return process.env.F1QL_DEFINITIONS_VERSION ?? F1QL_DEFINITIONS_VERSION;
}

export async function validateParticipation(pool: Pool, program: F1QLProgram): Promise<void> {
  const { season, drivers } = getParticipationScope(program);
  if (season === undefined || drivers.length === 0) {
    return;
  }
  const result = await pool.query(
    `SELECT DISTINCT REPLACE(driver_id, '_', '-') AS driver_id FROM season_entrant_driver WHERE year = $1 AND REPLACE(driver_id, '_', '-') = ANY($2::text[]) AND COALESCE(test_driver, false) = false`,
    [season, drivers]
  );
  if (result.rows.length !== drivers.length) {
    throw new F1QLValidationError('participation_missing', 'Driver did not participate in the requested season');
  }
}

function getParticipationScope(program: F1QLProgram): { season?: number; drivers: string[] } {
  const root = program.root;
  if (root.op === 'pace_delta') {
    return { season: root.scope.season, drivers: [root.driver_a_id, root.driver_b_id] };
  }
  if (root.op === 'pace_summary') {
    return { season: root.scope.season, drivers: [root.driver_id] };
  }
  if (root.op === 'event_classification') {
    return { season: root.season, drivers: root.filters?.driver_id ? [root.filters.driver_id] : [] };
  }
  const aggregate = root.op === 'rank' ? root.input : root;
  if (aggregate.input.op !== 'filter' || typeof aggregate.input.where.season !== 'number' || !aggregate.input.where.driver_id) {
    return { drivers: [] };
  }
  const drivers = Array.isArray(aggregate.input.where.driver_id)
    ? aggregate.input.where.driver_id
    : [aggregate.input.where.driver_id];
  return { season: aggregate.input.where.season, drivers };
}

export function validateF1QLProgram(program: F1QLProgram, options: F1QLValidationOptions = {}): void {
  const definitionsVersion = options.definitionsVersion ?? refreshF1QLDefinitionsVersion();
  if (definitionsVersion !== F1QL_DEFINITIONS_VERSION) {
    throw new F1QLValidationError('definitions_version_mismatch', 'Definitions version is not active');
  }
  const maxNodes = options.maxNodes ?? 12;
  if (countNodes(program.root) > maxNodes) {
    throw new F1QLValidationError('complexity_exceeded', `Program exceeds the ${maxNodes}-node complexity budget`);
  }
  validateSignature(program);
  if (program.root.op === 'event_classification' && program.root.round > 30) {
    throw new F1QLValidationError('coverage_unsupported', 'Round is outside supported event coverage');
  }
}

function validateSignature(program: F1QLProgram): void {
  const root = program.root;
  if (root.op === 'pace_summary' || root.op === 'pace_delta') {
    const fields = ['driver_id', 'lap_time_seconds', ...Object.keys(root.filters ?? {}).map((field) => field === 'clean_air_only' ? 'clean_air_flag' : field)];
    assertSignature('lap_pace', root.op, fields);
    return;
  }
  if (root.op === 'event_classification') {
    assertSignature('event_classification', root.op, ['finishing_position', ...Object.keys(root.filters ?? {})]);
    return;
  }
  const aggregate = root.op === 'rank' ? root.input : root;
  const source = aggregate.input.op === 'filter' ? aggregate.input.input : aggregate.input;
  if (source.source !== 'standings') {
    throw new F1QLValidationError('coverage_unsupported', `Source ${source.source} is not supported`);
  }
  const operators = root.op === 'rank' ? ['source', 'aggregate', 'rank'] : ['source', 'aggregate'];
  const fields: string[] = [...aggregate.group_by, ...aggregate.measures.flatMap((measure) => measure.field ? [measure.field] : [])];
  if (aggregate.input.op === 'filter') {
    operators.push('filter');
    fields.push(...Object.keys(aggregate.input.where));
  }
  for (const operator of operators) {
    assertSignature('standings', operator, []);
  }
  assertSignature('standings', 'aggregate', fields);
}

function assertSignature(source: keyof typeof F1QL_SIGNATURES, operator: string, fields: string[]): void {
  const signature = F1QL_SIGNATURES[source];
  if (!signature.operators.includes(operator as never)) {
    throw new F1QLValidationError('signature_invalid', `${operator} is not allowed for ${source}`);
  }
  for (const field of fields) {
    if (!signature.fields.includes(field as never)) {
      throw new F1QLValidationError('signature_invalid', `${field} is not a supported ${source} field`);
    }
  }
}

function countNodes(root: F1QLProgram['root']): number {
  if (root.op === 'rank') {
    return 3 + (root.input.input.op === 'filter' ? 1 : 0);
  }
  if (root.op === 'aggregate') {
    return 2 + (root.input.op === 'filter' ? 1 : 0);
  }
  return 1;
}
