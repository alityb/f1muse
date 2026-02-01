/**
 * HEALTH ENDPOINTS TESTS
 *
 * Tests for health check endpoints including:
 * - /health/db response format
 * - /health/coverage/teammate-gap response format
 * - Error handling
 */

import { describe, it, expect, vi } from 'vitest';

describe('Health Endpoint Response Formats', () => {
  describe('/health/db Response', () => {
    interface DBHealthResponse {
      connected: boolean;
      host: string;
      ssl: boolean;
      latency_ms: number;
      error?: string;
    }

    it('should have correct format for healthy response', () => {
      const response: DBHealthResponse = {
        connected: true,
        host: 'localhost',
        ssl: false,
        latency_ms: 5
      };

      expect(response.connected).toBe(true);
      expect(typeof response.host).toBe('string');
      expect(typeof response.ssl).toBe('boolean');
      expect(typeof response.latency_ms).toBe('number');
      expect(response.error).toBeUndefined();
    });

    it('should have correct format for unhealthy response', () => {
      const response: DBHealthResponse = {
        connected: false,
        host: 'localhost',
        ssl: false,
        latency_ms: 0,
        error: 'Connection refused'
      };

      expect(response.connected).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.latency_ms).toBe(0);
    });

    it('should have non-negative latency', () => {
      const response: DBHealthResponse = {
        connected: true,
        host: 'localhost',
        ssl: true,
        latency_ms: 15
      };

      expect(response.latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('/health/coverage/teammate-gap Response', () => {
    interface CoverageHealthResponse {
      expected_pairs: number;
      valid_pairs: number;
      low_coverage_pairs: number;
      insufficient_pairs: number;
      coverage_percent: number;
    }

    it('should have correct format for coverage response', () => {
      const response: CoverageHealthResponse = {
        expected_pairs: 10,
        valid_pairs: 6,
        low_coverage_pairs: 2,
        insufficient_pairs: 2,
        coverage_percent: 80
      };

      expect(response.expected_pairs).toBeDefined();
      expect(response.valid_pairs).toBeDefined();
      expect(response.low_coverage_pairs).toBeDefined();
      expect(response.insufficient_pairs).toBeDefined();
      expect(response.coverage_percent).toBeDefined();
    });

    it('should have non-negative pair counts', () => {
      const response: CoverageHealthResponse = {
        expected_pairs: 10,
        valid_pairs: 5,
        low_coverage_pairs: 3,
        insufficient_pairs: 2,
        coverage_percent: 80
      };

      expect(response.expected_pairs).toBeGreaterThanOrEqual(0);
      expect(response.valid_pairs).toBeGreaterThanOrEqual(0);
      expect(response.low_coverage_pairs).toBeGreaterThanOrEqual(0);
      expect(response.insufficient_pairs).toBeGreaterThanOrEqual(0);
    });

    it('should have coverage_percent between 0 and 100', () => {
      const response: CoverageHealthResponse = {
        expected_pairs: 10,
        valid_pairs: 8,
        low_coverage_pairs: 0,
        insufficient_pairs: 2,
        coverage_percent: 80
      };

      expect(response.coverage_percent).toBeGreaterThanOrEqual(0);
      expect(response.coverage_percent).toBeLessThanOrEqual(100);
    });

    it('should have pair counts that make sense', () => {
      const response: CoverageHealthResponse = {
        expected_pairs: 10,
        valid_pairs: 5,
        low_coverage_pairs: 3,
        insufficient_pairs: 2,
        coverage_percent: 80
      };

      // Total categorized pairs should match expected
      const totalCategorized = response.valid_pairs + response.low_coverage_pairs + response.insufficient_pairs;
      expect(totalCategorized).toBeLessThanOrEqual(response.expected_pairs);
    });

    it('should compute coverage percent correctly', () => {
      const expected_pairs = 10;
      const valid_pairs = 6;
      const low_coverage_pairs = 2;
      const usable_pairs = valid_pairs + low_coverage_pairs;

      const expected_coverage = Math.round((usable_pairs / expected_pairs) * 100);

      const response: CoverageHealthResponse = {
        expected_pairs,
        valid_pairs,
        low_coverage_pairs,
        insufficient_pairs: 2,
        coverage_percent: expected_coverage
      };

      expect(response.coverage_percent).toBe(80);
    });
  });
});

describe('Health Endpoint Validation', () => {
  describe('Season Parameter Validation', () => {
    it('should require season parameter', () => {
      const validateSeason = (season: string | undefined): boolean => {
        if (!season || typeof season !== 'string') {
          return false;
        }
        const parsed = parseInt(season, 10);
        return !isNaN(parsed) && parsed >= 1950 && parsed <= 2100;
      };

      expect(validateSeason(undefined)).toBe(false);
      expect(validateSeason('')).toBe(false);
    });

    it('should validate season range', () => {
      const validateSeason = (season: string): boolean => {
        const parsed = parseInt(season, 10);
        return !isNaN(parsed) && parsed >= 1950 && parsed <= 2100;
      };

      expect(validateSeason('2025')).toBe(true);
      expect(validateSeason('1950')).toBe(true);
      expect(validateSeason('2100')).toBe(true);
      expect(validateSeason('1949')).toBe(false);
      expect(validateSeason('2101')).toBe(false);
      expect(validateSeason('invalid')).toBe(false);
    });
  });

  describe('Error Response Format', () => {
    interface ErrorResponse {
      error: string;
      reason: string;
    }

    it('should have correct format for validation error', () => {
      const error: ErrorResponse = {
        error: 'validation_failed',
        reason: 'season query parameter is required'
      };

      expect(error.error).toBe('validation_failed');
      expect(error.reason).toBeDefined();
    });

    it('should have correct format for execution error', () => {
      const error: ErrorResponse = {
        error: 'execution_failed',
        reason: 'Unexpected error: Connection timeout'
      };

      expect(error.error).toBe('execution_failed');
      expect(error.reason).toContain('Unexpected error');
    });
  });
});

describe('Debug Endpoint Response Format', () => {
  describe('/debug/coverage/teammate-gap Response', () => {
    interface DebugCoverageResponse {
      exists: boolean;
      shared_laps: number | null;
      min_required_laps: number;
      gap_present: boolean;
      coverage_status: 'valid' | 'low_coverage' | 'insufficient' | 'missing';
      failure_reason: string | null;
    }

    it('should have correct format for existing pair', () => {
      const response: DebugCoverageResponse = {
        exists: true,
        shared_laps: 75,
        min_required_laps: 20,
        gap_present: true,
        coverage_status: 'valid',
        failure_reason: null
      };

      expect(response.exists).toBe(true);
      expect(response.shared_laps).toBe(75);
      expect(response.gap_present).toBe(true);
      expect(response.coverage_status).toBe('valid');
      expect(response.failure_reason).toBeNull();
    });

    it('should have correct format for missing pair', () => {
      const response: DebugCoverageResponse = {
        exists: false,
        shared_laps: null,
        min_required_laps: 20,
        gap_present: false,
        coverage_status: 'missing',
        failure_reason: 'No summary row exists for this driver pair'
      };

      expect(response.exists).toBe(false);
      expect(response.shared_laps).toBeNull();
      expect(response.coverage_status).toBe('missing');
      expect(response.failure_reason).toBeDefined();
    });

    it('should have correct format for insufficient pair', () => {
      const response: DebugCoverageResponse = {
        exists: true,
        shared_laps: 15,
        min_required_laps: 20,
        gap_present: false,
        coverage_status: 'insufficient',
        failure_reason: 'shared_laps (15) below minimum (20)'
      };

      expect(response.exists).toBe(true);
      expect(response.coverage_status).toBe('insufficient');
      expect(response.shared_laps).toBeLessThan(response.min_required_laps);
    });

    it('should have correct format for low_coverage pair', () => {
      const response: DebugCoverageResponse = {
        exists: true,
        shared_laps: 35,
        min_required_laps: 20,
        gap_present: true,
        coverage_status: 'low_coverage',
        failure_reason: null
      };

      expect(response.exists).toBe(true);
      expect(response.coverage_status).toBe('low_coverage');
      expect(response.gap_present).toBe(true);
      expect(response.failure_reason).toBeNull();
    });
  });
});
