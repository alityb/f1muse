import { describe, expect, it } from 'vitest';
import { F1QLValidationError, validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';
import { lowerF1QL } from '../../src/f1ql/lower';

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
  it('validates lowered generic classification nodes against the phase 2 signature', () => {
    const core = lowerF1QL({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 3 } });
    expect(() => validateCoreProgram(core)).not.toThrow();

    if (core.root.op !== 'limit' || core.root.input.op !== 'sort') {
      throw new Error('Expected classification sort and limit');
    }
    (core.root.input as { by: string }).by = 'status_reason';
    expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
  });
  it('validates generic pace join and compare fields against the phase 2 signature', () => {
    const core = lowerF1QL({
      version: 1,
      root: { op: 'pace_delta', driver_a_id: 'max-verstappen', driver_b_id: 'lando-norris', scope: { season: 2025 } }
    });
    expect(() => validateCoreProgram(core)).not.toThrow();

    if (core.root.op !== 'delta') {
      throw new Error('Expected pace delta');
    }
    core.root.input.left.field = 'lap_time_seconds';
    expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
  });
});
