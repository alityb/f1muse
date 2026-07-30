import { createHash } from 'crypto';
import { F1QLProgram } from './ast';
import { parseF1QLProgram } from './schema';
import { F1QL_DEFINITIONS_VERSION } from './validation';

export const F1QL_COMPILER_VERSION = 'core-v9';
export const F1QL_FACT_SPACE_VERSION = 'source-views-v3';

export interface VerifiedProgram {
  id: string;
  program: F1QLProgram;
  definitions_version: string;
  compiler_version: string;
  fact_space_version: string;
}

export class VerifiedProgramError extends Error {}

function normalizeValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeValue(item));
    if (key === 'classification_status' || key === 'rounds' || key === 'season' || key === 'driver_id') {
      return [...normalized].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
    }
    return normalized;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([childKey, item]) => [childKey, normalizeValue(item, childKey)]));
  }
  return value;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export function normalizeF1QLProgram(input: unknown): F1QLProgram {
  return normalizeValue(parseF1QLProgram(input)) as F1QLProgram;
}

export function getF1QLProgramHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeF1QLProgram(input))).digest('hex');
}

export function getF1QLCacheKey(input: unknown): string {
  return createHash('sha256').update(JSON.stringify({
    program: normalizeF1QLProgram(input),
    definitions_version: F1QL_DEFINITIONS_VERSION,
    compiler_version: F1QL_COMPILER_VERSION,
    fact_space_version: F1QL_FACT_SPACE_VERSION
  })).digest('hex');
}

const verifiedPrograms: readonly VerifiedProgram[] = [
  {
    id: '2025-driver-standings',
    program: {
      version: 1,
      root: {
        op: 'aggregate',
        input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } },
        group_by: ['driver_id'],
        measures: [{ as: 'points', function: 'sum', field: 'points' }]
      }
    },
    definitions_version: F1QL_DEFINITIONS_VERSION,
    compiler_version: F1QL_COMPILER_VERSION,
    fact_space_version: F1QL_FACT_SPACE_VERSION
  }
];

export function getVerifiedProgram(id: string): F1QLProgram {
  const verified = verifiedPrograms.find(program => program.id === id);
  if (!verified) {
    throw new VerifiedProgramError('Verified program was not found');
  }
  if (verified.definitions_version !== F1QL_DEFINITIONS_VERSION || verified.compiler_version !== F1QL_COMPILER_VERSION || verified.fact_space_version !== F1QL_FACT_SPACE_VERSION) {
    throw new VerifiedProgramError('Verified program is incompatible with the active F1QL versions');
  }
  return normalizeF1QLProgram(verified.program);
}

export function listVerifiedPrograms(): readonly Omit<VerifiedProgram, 'program'>[] {
  return verifiedPrograms.map(({ program: _program, ...verified }) => verified);
}
