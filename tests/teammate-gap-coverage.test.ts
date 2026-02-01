/**
 * TEAMMATE GAP COVERAGE TESTS
 *
 * Tests for teammate gap coverage functionality including:
 * - low_coverage handling in interpretation
 * - Diagnostics JSON mode
 * - Coverage status tiers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TEAMMATE_GAP_THRESHOLDS,
  getCoverageStatus,
  isResultAllowed,
  COVERAGE_STATUS_COPY
} from '../src/config/teammate-gap';

describe('Teammate Gap Configuration', () => {
  describe('TEAMMATE_GAP_THRESHOLDS', () => {
    it('should have correct threshold values', () => {
      expect(TEAMMATE_GAP_THRESHOLDS.valid_shared_races).toBe(8);
      expect(TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races).toBe(4);
    });

    it('valid threshold should be greater than low_coverage', () => {
      expect(TEAMMATE_GAP_THRESHOLDS.valid_shared_races).toBeGreaterThan(
        TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races
      );
    });
  });

  describe('getCoverageStatus', () => {
    it('should return "valid" for shared races >= 8', () => {
      expect(getCoverageStatus(8)).toBe('valid');
      expect(getCoverageStatus(10)).toBe('valid');
      expect(getCoverageStatus(12)).toBe('valid');
    });

    it('should return "low_coverage" for shared races >= 4 but below valid thresholds', () => {
      expect(getCoverageStatus(4)).toBe('low_coverage');
      expect(getCoverageStatus(6)).toBe('low_coverage');
      expect(getCoverageStatus(7)).toBe('low_coverage');
    });

    it('should return "insufficient" for shared races < 4', () => {
      expect(getCoverageStatus(0)).toBe('insufficient');
      expect(getCoverageStatus(1)).toBe('insufficient');
      expect(getCoverageStatus(3)).toBe('insufficient');
    });
  });

  describe('isResultAllowed', () => {
    it('should allow "valid" status', () => {
      expect(isResultAllowed('valid')).toBe(true);
    });

    it('should allow "low_coverage" status', () => {
      expect(isResultAllowed('low_coverage')).toBe(true);
    });

    it('should NOT allow "insufficient" status', () => {
      expect(isResultAllowed('insufficient')).toBe(false);
    });
  });

  describe('COVERAGE_STATUS_COPY', () => {
    it('should have no copy for valid status', () => {
      expect(COVERAGE_STATUS_COPY.valid).toBeNull();
    });

    it('should have directional warning for low_coverage', () => {
      expect(COVERAGE_STATUS_COPY.low_coverage).toBe(
        'Low sample size — results are directional, not definitive.'
      );
    });

    it('should have insufficient explanation for insufficient', () => {
      expect(COVERAGE_STATUS_COPY.insufficient).toBe(
        'Teammate gaps are reported only when drivers share enough races.'
      );
    });
  });
});

describe('Coverage Tier Boundaries', () => {
  it('should correctly classify boundary values', () => {
    // At boundaries
    expect(getCoverageStatus(8)).toBe('valid');
    expect(getCoverageStatus(7)).toBe('low_coverage');
    expect(getCoverageStatus(4)).toBe('low_coverage');
    expect(getCoverageStatus(3)).toBe('insufficient');
  });

  it('should maintain fail-closed behavior for insufficient', () => {
    const insufficientSamples = [
      { races: 0 },
      { races: 1 },
      { races: 2 },
      { races: 3 }
    ];
    for (const sample of insufficientSamples) {
      const status = getCoverageStatus(sample.races);
      expect(isResultAllowed(status)).toBe(false);
    }
  });

  it('should allow results for usable coverage', () => {
    const usableSamples = [
      { races: 4 },
      { races: 5 },
      { races: 7 },
      { races: 8 },
      { races: 9 }
    ];
    for (const sample of usableSamples) {
      const status = getCoverageStatus(sample.races);
      expect(isResultAllowed(status)).toBe(true);
    }
  });
});

describe('Low Coverage Handling', () => {
  it('should identify low_coverage as allowing results', () => {
    expect(isResultAllowed('low_coverage')).toBe(true);
  });

  it('should have different copy for low_coverage vs valid', () => {
    expect(COVERAGE_STATUS_COPY.low_coverage).not.toEqual(COVERAGE_STATUS_COPY.valid);
    expect(COVERAGE_STATUS_COPY.low_coverage).toContain('directional');
  });

  it('should have different copy for low_coverage vs insufficient', () => {
    expect(COVERAGE_STATUS_COPY.low_coverage).not.toEqual(COVERAGE_STATUS_COPY.insufficient);
    expect(COVERAGE_STATUS_COPY.insufficient).toContain('share enough races');
  });
});
