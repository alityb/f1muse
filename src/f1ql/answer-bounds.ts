import { AnswerCapability, authorizeAnswerProgram } from './answer-policy';
import { F1QLProgram } from './ast';
import { MAX_F1QL_RESPONSE_ROWS } from './limits';

export const ANSWER_WORK_MODEL_VERSION = 'answer-work-v1';

export class AnswerBoundError extends Error {
  constructor(readonly bound: 'work_units' | 'rows' | 'response_bytes', readonly actual: number, readonly maximum: number) {
    super(`Answer ${bound} exceeded ${maximum}`);
    this.name = 'AnswerBoundError';
  }
}

export class AnswerWorkModelError extends Error {}

export interface AnswerWorkEstimate {
  version: typeof ANSWER_WORK_MODEL_VERSION;
  units: number;
  requested_rows: number;
}

export function estimateAnswerWork(program: F1QLProgram, capability: AnswerCapability): AnswerWorkEstimate {
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved' || JSON.stringify(decision.capability) !== JSON.stringify(capability)) {
    throw new AnswerWorkModelError('Program and approved capability did not match');
  }
  const root = program.root;
  if (capability.source === 'race_date_metadata' && root.op === 'event_metadata') {
    return estimate(5, 1);
  }
  if ((capability.source === 'race_classification' && root.op === 'event_classification') ||
      (capability.source === 'qualifying_classification' && root.op === 'qualifying_classification')) {
    return estimate(10 + root.limit, root.limit);
  }
  if (capability.source === 'final_driver_standings' && (root.op === 'aggregate' || root.op === 'rank')) {
    const aggregate = root.op === 'rank' ? root.input : root;
    const driverId = aggregate.input.op === 'filter' ? aggregate.input.where.driver_id : undefined;
    const driverCount = estimatedStandingsDrivers(driverId);
    const requestedRows = root.op === 'rank' ? Math.min(root.limit, driverCount) : driverCount;
    return estimate(20 + driverCount + aggregate.measures.length * 5 + (root.op === 'rank' ? 5 : 0), requestedRows);
  }
  throw new AnswerWorkModelError('Approved capability had no work model');
}

export function enforceAnswerWorkBudget(program: F1QLProgram, capability: AnswerCapability, maximum: number, maxRows = MAX_F1QL_RESPONSE_ROWS): AnswerWorkEstimate {
  validateMaximum(maximum, 'work_units');
  validateMaximum(maxRows, 'rows');
  const estimate = estimateAnswerWork(program, capability);
  if (estimate.units > maximum) {
    throw new AnswerBoundError('work_units', estimate.units, maximum);
  }
  if (estimate.requested_rows > maxRows) {
    throw new AnswerBoundError('rows', estimate.requested_rows, maxRows);
  }
  return estimate;
}

export function enforceAnswerRows(rows: Array<Record<string, unknown>>, maximum: number): void {
  validateMaximum(maximum, 'rows');
  if (rows.length > maximum) {
    throw new AnswerBoundError('rows', rows.length, maximum);
  }
}

export function serializeAnswerResponse(response: unknown, maximumBytes: number): string {
  validateMaximum(maximumBytes, 'response_bytes');
  const serialized = JSON.stringify(response);
  if (typeof serialized !== 'string') {
    throw new AnswerWorkModelError('Answer response was not serializable');
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximumBytes) {
    throw new AnswerBoundError('response_bytes', bytes, maximumBytes);
  }
  return serialized;
}

function estimate(units: number, requestedRows: number): AnswerWorkEstimate {
  return { version: ANSWER_WORK_MODEL_VERSION, units, requested_rows: requestedRows };
}

function estimatedStandingsDrivers(driverId: string | string[] | undefined): number {
  if (driverId === undefined) {
    return MAX_F1QL_RESPONSE_ROWS;
  }
  return Array.isArray(driverId) ? driverId.length : 1;
}

function validateMaximum(maximum: number, bound: AnswerBoundError['bound']): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new AnswerBoundError(bound, maximum, 0);
  }
}
