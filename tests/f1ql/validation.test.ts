import { describe, expect, it } from 'vitest';
import { F1QLValidationError, validateF1QLProgram } from '../../src/f1ql/validation';

describe('F1QL validation gates', () => {
  const program = { version: 1 as const, root: { op: 'pace_summary' as const, driver_id: 'max-verstappen', scope: { season: 2025 } } };
  it('accepts supported programs under the active definitions version', () => expect(() => validateF1QLProgram(program)).not.toThrow());
  it('rejects stale definitions versions with a typed error', () => {
    expect(() => validateF1QLProgram(program, 'stale')).toThrow(F1QLValidationError);
  });
});
