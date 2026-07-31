import { createHash } from 'crypto';
import { F1QLProgram } from './ast';
import { F1QL_FACT_SPACE_VERSION } from './fact-space-version';
import { normalizeF1QLProgram } from './program-normalization';
import { F1QL_DEFINITIONS_VERSION } from './validation';

export { F1QL_FACT_SPACE_VERSION } from './fact-space-version';
export { getF1QLProgramHash, normalizeF1QLProgram } from './program-normalization';

export const F1QL_COMPILER_VERSION = 'core-v9';

export interface VerifiedProgram {
  id: string;
  program: F1QLProgram;
  definitions_version: string;
  compiler_version: string;
  fact_space_version: string;
}

export class VerifiedProgramError extends Error {}

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
