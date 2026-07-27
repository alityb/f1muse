import { describe, expect, it } from 'vitest';
import { getF1QLCacheKey, getF1QLProgramHash, getVerifiedProgram, listVerifiedPrograms, VerifiedProgramError } from '../../src/f1ql/verified-programs';

const baseProgram = {
  version: 1,
  root: {
    op: 'pace_summary',
    driver_id: 'max-verstappen',
    scope: { season: 2026, rounds: [3, 1, 2] },
    filters: { compound: 'MEDIUM', clean_air_only: true }
  }
} as const;

describe('verified F1QL programs', () => {
  it('normalizes semantic set ordering before hashing and keying', () => {
    const reordered = { ...baseProgram, root: { ...baseProgram.root, scope: { ...baseProgram.root.scope, rounds: [2, 3, 1] } } };
    expect(getF1QLProgramHash(baseProgram)).toBe(getF1QLProgramHash(reordered));
    expect(getF1QLCacheKey(baseProgram)).toBe(getF1QLCacheKey(reordered));
    expect(getF1QLProgramHash(baseProgram)).toBe('5a348036618a52658766148bda67053a65826661ab7e9f4b137bf231f6eb6617');
    expect(getF1QLCacheKey(baseProgram)).toBe('110428c603d3383e6f8ff023ca031899fbf95d5b23fdd9257ace7f0a2c5ed65d');
  });

  it('changes hashes for semantic changes', () => {
    const changed = { ...baseProgram, root: { ...baseProgram.root, filters: { ...baseProgram.root.filters, clean_air_only: false } } };
    expect(getF1QLProgramHash(baseProgram)).not.toBe(getF1QLProgramHash(changed));
  });

  it('exposes only version-compatible verified programs', () => {
    expect(listVerifiedPrograms().map(program => program.id)).toContain('2025-driver-standings');
    expect(getVerifiedProgram('2025-driver-standings').root.op).toBe('aggregate');
    expect(() => getVerifiedProgram('missing')).toThrow(VerifiedProgramError);
  });
});
