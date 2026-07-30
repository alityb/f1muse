import { CompiledF1QL } from './compiler';
import { PlannedCoreProgram } from './core';
import { compilePlannedF1QL } from './planned-compiler';
import {
  decidePlannedParticipation,
  estimatePlannedF1QLCost,
  getPlannedCoreProgramHash,
  getPlannedF1QLProgramHash,
  lowerPlannedF1QL,
  parsePlannedF1QLProgram,
  PlannedF1QLCost,
  PlannedF1QLProgram,
  PlannedParticipationDecision,
  validatePlannedCoreProgram
} from './planned-f1ql';

const verifiedPlannedParentBrand: unique symbol = Symbol('verifiedPlannedParent');
const verifiedParents = new WeakSet<object>();

export interface VerifiedPlannedF1QLParent {
  readonly [verifiedPlannedParentBrand]: true;
  readonly program: PlannedF1QLProgram;
  readonly program_hash: string;
  readonly cost: PlannedF1QLCost;
  readonly participation: PlannedParticipationDecision;
  readonly core_program: PlannedCoreProgram;
  readonly core_hash: string;
  readonly compiled: CompiledF1QL;
}

export function preparePlannedF1QLParent(input: unknown): VerifiedPlannedF1QLParent {
  const program = parsePlannedF1QLProgram(input);
  const cost = estimatePlannedF1QLCost(program);
  const participation = decidePlannedParticipation(program);
  const coreProgram = lowerPlannedF1QL(program);
  validatePlannedCoreProgram(coreProgram);
  const parent: VerifiedPlannedF1QLParent = deepFreeze({
    [verifiedPlannedParentBrand]: true as const,
    program,
    program_hash: getPlannedF1QLProgramHash(program),
    cost,
    participation,
    core_program: coreProgram,
    core_hash: getPlannedCoreProgramHash(coreProgram),
    compiled: compilePlannedF1QL(coreProgram)
  });
  verifiedParents.add(parent);
  return parent;
}

export function verifyPlannedF1QLParent(input: unknown): VerifiedPlannedF1QLParent {
  if (!input || typeof input !== 'object' || !verifiedParents.has(input)) {
    throw new Error('planned F1QL parent provenance is invalid');
  }
  const parent = input as VerifiedPlannedF1QLParent;
  const program = parsePlannedF1QLProgram(parent.program);
  const core = lowerPlannedF1QL(program);
  if (parent.program_hash !== getPlannedF1QLProgramHash(program) || parent.core_hash !== getPlannedCoreProgramHash(core) ||
      parent.core_hash !== getPlannedCoreProgramHash(parent.core_program)) {
    throw new Error('planned F1QL parent binding is invalid');
  }
  return parent;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
