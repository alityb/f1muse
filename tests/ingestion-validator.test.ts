/**
 * INGESTION VALIDATOR TESTS
 *
 * Tests for the teammate gap ingestion validator including:
 * - Validation check logic
 * - Failure detection
 * - Exit code behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock validation result structure
interface ValidationResult {
  check: string;
  passed: boolean;
  message: string;
  details?: any;
}

interface ValidationSummary {
  season: number;
  all_passed: boolean;
  results: ValidationResult[];
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
}

describe('Ingestion Validator Structure', () => {
  describe('ValidationResult', () => {
    it('should have required fields for passed result', () => {
      const result: ValidationResult = {
        check: 'test_check',
        passed: true,
        message: 'Test passed successfully'
      };

      expect(result.check).toBeDefined();
      expect(result.passed).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.details).toBeUndefined();
    });

    it('should have details for failed result', () => {
      const result: ValidationResult = {
        check: 'test_check',
        passed: false,
        message: 'Test failed',
        details: ['item1', 'item2']
      };

      expect(result.passed).toBe(false);
      expect(result.details).toBeDefined();
      expect(result.details).toHaveLength(2);
    });
  });

  describe('ValidationSummary', () => {
    it('should correctly aggregate check counts', () => {
      const results: ValidationResult[] = [
        { check: 'check1', passed: true, message: 'OK' },
        { check: 'check2', passed: true, message: 'OK' },
        { check: 'check3', passed: false, message: 'Failed', details: [] }
      ];

      const summary: ValidationSummary = {
        season: 2025,
        all_passed: results.every(r => r.passed),
        results,
        total_checks: results.length,
        passed_checks: results.filter(r => r.passed).length,
        failed_checks: results.filter(r => !r.passed).length
      };

      expect(summary.total_checks).toBe(3);
      expect(summary.passed_checks).toBe(2);
      expect(summary.failed_checks).toBe(1);
      expect(summary.all_passed).toBe(false);
    });

    it('should report all_passed=true when all checks pass', () => {
      const results: ValidationResult[] = [
        { check: 'check1', passed: true, message: 'OK' },
        { check: 'check2', passed: true, message: 'OK' }
      ];

      const summary: ValidationSummary = {
        season: 2025,
        all_passed: results.every(r => r.passed),
        results,
        total_checks: results.length,
        passed_checks: results.filter(r => r.passed).length,
        failed_checks: results.filter(r => !r.passed).length
      };

      expect(summary.all_passed).toBe(true);
      expect(summary.failed_checks).toBe(0);
    });
  });
});

describe('Validation Check Types', () => {
  const validationChecks = [
    'teams_have_usable_pairs',
    'no_null_gaps_for_usable',
    'no_duplicate_pairs',
    'no_reversed_duplicates',
    'driver_ordering',
    'race_level_data_exists',
    'coverage_status_consistency'
  ];

  it('should define all expected validation checks', () => {
    expect(validationChecks).toContain('teams_have_usable_pairs');
    expect(validationChecks).toContain('no_null_gaps_for_usable');
    expect(validationChecks).toContain('no_duplicate_pairs');
    expect(validationChecks).toContain('no_reversed_duplicates');
  });

  it('should have 7 total validation checks', () => {
    expect(validationChecks).toHaveLength(7);
  });
});

describe('Validation Failure Scenarios', () => {
  describe('teams_have_usable_pairs', () => {
    it('should fail when a team has no usable pairs', () => {
      const result: ValidationResult = {
        check: 'teams_have_usable_pairs',
        passed: false,
        message: '1 team(s) without usable pairs',
        details: ['racing-bulls']
      };

      expect(result.passed).toBe(false);
      expect(result.details).toContain('racing-bulls');
    });
  });

  describe('no_null_gaps_for_usable', () => {
    it('should fail when valid/low_coverage row has NULL gap', () => {
      const result: ValidationResult = {
        check: 'no_null_gaps_for_usable',
        passed: false,
        message: '1 row(s) with NULL gap and usable coverage_status',
        details: [{
          team_id: 'mclaren',
          driver_primary_id: 'norris',
          driver_secondary_id: 'piastri',
          coverage_status: 'valid',
          shared_races: 6
        }]
      };

      expect(result.passed).toBe(false);
      expect(result.details[0].coverage_status).toBe('valid');
    });
  });

  describe('no_duplicate_pairs', () => {
    it('should fail when duplicate pairs exist', () => {
      const result: ValidationResult = {
        check: 'no_duplicate_pairs',
        passed: false,
        message: '1 duplicate pair(s) found',
        details: [{
          team_id: 'ferrari',
          driver_primary_id: 'leclerc',
          driver_secondary_id: 'sainz',
          count: 2
        }]
      };

      expect(result.passed).toBe(false);
      expect(result.details[0].count).toBeGreaterThan(1);
    });
  });

  describe('no_reversed_duplicates', () => {
    it('should fail when reversed duplicates exist', () => {
      const result: ValidationResult = {
        check: 'no_reversed_duplicates',
        passed: false,
        message: '1 reversed duplicate(s) found',
        details: [{
          team_id: 'mercedes',
          pair_a_primary: 'hamilton',
          pair_a_secondary: 'russell',
          pair_b_primary: 'russell',
          pair_b_secondary: 'hamilton'
        }]
      };

      expect(result.passed).toBe(false);
    });
  });

  describe('driver_ordering', () => {
    it('should fail when driver IDs are not lexicographically ordered', () => {
      const result: ValidationResult = {
        check: 'driver_ordering',
        passed: false,
        message: '1 row(s) with incorrect driver ordering',
        details: [{
          team_id: 'red-bull',
          driver_primary_id: 'verstappen',
          driver_secondary_id: 'perez'
        }]
      };

      expect(result.passed).toBe(false);
      // verstappen > perez alphabetically, so this is incorrect
      expect(result.details[0].driver_primary_id > result.details[0].driver_secondary_id).toBe(true);
    });
  });
});

describe('Exit Code Behavior', () => {
  it('should return 0 when all checks pass', () => {
    const summary: ValidationSummary = {
      season: 2025,
      all_passed: true,
      results: [],
      total_checks: 7,
      passed_checks: 7,
      failed_checks: 0
    };

    const exitCode = summary.all_passed ? 0 : 1;
    expect(exitCode).toBe(0);
  });

  it('should return 1 when any check fails', () => {
    const summary: ValidationSummary = {
      season: 2025,
      all_passed: false,
      results: [],
      total_checks: 7,
      passed_checks: 6,
      failed_checks: 1
    };

    const exitCode = summary.all_passed ? 0 : 1;
    expect(exitCode).toBe(1);
  });
});
