import { describe, expect, it } from 'vitest';
import { F1QLValidationError, validateCoreProgram, validateF1QLProgram } from '../../src/f1ql/validation';
import { lowerF1QL } from '../../src/f1ql/lower';
import { parseF1QLProgram } from '../../src/f1ql/schema';

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
  it('requires canonical bounded classification position sets', () => {
    expect(parseF1QLProgram({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 3, filters: { finishing_position: [1, 2, 3] } } }).root)
      .toMatchObject({ filters: { finishing_position: [1, 2, 3] } });
    expect(() => parseF1QLProgram({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 2, filters: { finishing_position: [2, 1] } } })).toThrow();
    expect(() => parseF1QLProgram({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { finishing_position: [1, 2, 3] } } })).toThrow();
    expect(() => parseF1QLProgram({ version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { qualifying_position: [31] } } })).toThrow();
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

    const qualifyingCore = lowerF1QL({ version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 3 } });
    expect(() => validateCoreProgram(qualifyingCore)).not.toThrow();
    if (qualifyingCore.root.op !== 'limit' || qualifyingCore.root.input.op !== 'sort') {
      throw new Error('Expected qualifying classification sort and limit');
    }
    (qualifyingCore.root.input as { by: string }).by = 'best_time_ms';
    expect(() => validateCoreProgram(qualifyingCore)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));

    const eventMetadataCore = lowerF1QL({ version: 1, root: { op: 'event_metadata', season: 2025, round: 1 } });
    expect(() => validateCoreProgram(eventMetadataCore)).not.toThrow();
    if (eventMetadataCore.root.op !== 'filter') {
      throw new Error('Expected event metadata filter');
    }
    (eventMetadataCore.root.where as Record<string, unknown>).unsupported = true;
    expect(() => validateCoreProgram(eventMetadataCore)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
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
  it('validates the closed official lap-window surface and lowered core contract', () => {
    const official = {
      version: 1,
      root: {
        op: 'official_lap_window_median_compare',
        metric: 'official_non_deleted_non_pit_window_median_v1',
        season: 2022,
        round: 14,
        driver_a_id: 'max-verstappen',
        driver_b_id: 'fernando-alonso',
        lap_start: 3,
        lap_end: 10
      }
    };
    const parsed = parseF1QLProgram(official);
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    const core = lowerF1QL(parsed);
    expect(() => validateCoreProgram(core)).not.toThrow();
    if (core.root.op !== 'delta') throw new Error('Expected official lap delta');
    core.root.metric_id = undefined;
    expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));

    const mutated = lowerF1QL(parsed);
    if (mutated.root.op !== 'delta' || mutated.root.input.input.left.op !== 'aggregate' || mutated.root.input.input.left.input.op !== 'filter') {
      throw new Error('Expected filtered official lap aggregate');
    }
    (mutated.root.input.input.left.input.where as { complete_requested_window: boolean }).complete_requested_window = false;
    expect(() => validateCoreProgram(mutated)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));

    expect(() => parseF1QLProgram({ ...official, root: { ...official.root, driver_b_id: 'max-verstappen' } })).toThrow('requires two different drivers');
    expect(() => parseF1QLProgram({ ...official, root: { ...official.root, lap_end: 53 } })).toThrow('at most 50 laps');
    expect(() => parseF1QLProgram({ ...official, root: { ...official.root, metric: 'clean_air' } })).toThrow();
  });
  it('validates the closed official event-mean surface and every lowered invariant', () => {
    const official = {
      version: 1,
      root: {
        op: 'official_event_mean_compare',
        metric: 'official_non_deleted_non_pit_event_mean_v1',
        season: 2022,
        round: 14,
        driver_a_id: 'max-verstappen',
        driver_b_id: 'fernando-alonso'
      }
    };
    const parsed = parseF1QLProgram(official);
    expect(() => validateF1QLProgram(parsed)).not.toThrow();
    expect(() => validateCoreProgram(lowerF1QL(parsed))).not.toThrow();

    const mutate = (change: (core: any) => void) => {
      const core = lowerF1QL(parsed);
      change(core);
      expect(() => validateCoreProgram(core)).toThrow(expect.objectContaining({ code: 'signature_invalid' }));
    };
    mutate(core => { core.version = 2; });
    mutate(core => { core.root.input.op = 'unknown'; });
    mutate(core => { core.root.input.input.op = 'unknown'; });
    mutate(core => { core.root.input.input.type = 'left'; });
    mutate(core => { core.root.input.left.as = 'wrong'; });
    mutate(core => { core.root.input.right.field = 'median_lap_time_seconds'; });
    mutate(core => { core.root.input.input.left.input.where.complete_event = false; });
    mutate(core => { core.root.input.input.right.minimum_rows = 1; });

    expect(() => parseF1QLProgram({ ...official, root: { ...official.root, driver_b_id: 'max-verstappen' } })).toThrow('requires two different drivers');
    expect(() => parseF1QLProgram({ ...official, root: { ...official.root, metric: 'official_non_deleted_non_pit_window_median_v1' } })).toThrow();
    expect(() => parseF1QLProgram({ ...official, root: { ...official.root, extra: true } })).toThrow();
  });
});
