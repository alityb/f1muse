import { describe, expect, it } from 'vitest';
import { F1QLValidationError, validateF1QLProgram } from '../../src/f1ql/validation';

describe('F1QL validation gates', () => {
  const program = { version: 1 as const, root: { op: 'pace_summary' as const, driver_id: 'max-verstappen', scope: { season: 2025 } } };
  it('accepts supported programs under the active definitions version', () => expect(() => validateF1QLProgram(program)).not.toThrow());
  it('rejects stale definitions versions with a typed error', () => {
    expect(() => validateF1QLProgram(program, { definitionsVersion: 'stale' })).toThrow(F1QLValidationError);
  });
  it('rejects programs exceeding a configured complexity budget', () => {
    expect(() => validateF1QLProgram(program, { maxNodes: 0 })).toThrow(expect.objectContaining({ code: 'complexity_exceeded' }));
  });
  it('rejects unsupported signature fields with a field-level typed error', () => {
    const invalid = { ...program, root: { ...program.root, filters: { unsupported: true } } } as any;
    expect(() => validateF1QLProgram(invalid)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
  });
  it('rejects unsupported coverage with a typed error', () => {
    const invalid = { version: 1 as const, root: { op: 'event_classification' as const, season: 2025, round: 31, limit: 1 } };
    expect(() => validateF1QLProgram(invalid)).toThrow(expect.objectContaining({ code: 'coverage_unsupported' }));
  });
  it('reads the active definitions version through the refresh path', () => {
    process.env.F1QL_DEFINITIONS_VERSION = 'stale';
    expect(() => validateF1QLProgram(program)).toThrow(expect.objectContaining({ code: 'definitions_version_mismatch' }));
    delete process.env.F1QL_DEFINITIONS_VERSION;
  });
});
