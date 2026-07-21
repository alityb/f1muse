import fixture from '../fixtures/retirement-reason-sample.json';
import {
  normalizeRetirementReason,
  type RetirementReasonCategory
} from '../../src/f1ql/retirement-reasons';

describe('retirement reason normalization', () => {
  it('normalizes sampled source labels conservatively', () => {
    for (const sample of fixture) {
      expect(normalizeRetirementReason(sample.raw_reason)).toBe(
        sample.canonical_reason as RetirementReasonCategory
      );
    }
  });

  it('keeps null and unrecognized labels in the explicit unknown bucket', () => {
    expect(normalizeRetirementReason(null)).toBe('unknown');
    expect(normalizeRetirementReason('Turbocharger')).toBe('unknown');
  });
});
