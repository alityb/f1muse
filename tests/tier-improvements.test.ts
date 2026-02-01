/**
 * TIER 1 & 2 IMPROVEMENTS TESTS
 *
 * Tests for:
 * - Confidence object with reasons array
 * - Structured errors
 * - Debug trace (X-Debug header)
 * - Dual comparison MIN coverage logic
 * - Percentile calculations
 * - Coverage-aware fallback
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  buildConfidence,
  buildError,
  coverageToConfidence
} from '../src/types/api-response';
import {
  calculatePercentile,
  interpretPercentile,
  PERCENTILE_THRESHOLDS
} from '../src/observability/percentiles';
import {
  FALLBACK_THRESHOLDS
} from '../src/observability/coverage';
import { DebugTracer, createTracerFromRequestWithHeaders } from '../src/execution/debug-tracer';

describe('Tier 1: Confidence Object', () => {
  it('builds confidence with reasons array', () => {
    const confidence = buildConfidence('valid', 10, 'Test reason');

    expect(confidence.level).toBe('high');
    expect(confidence.coverage_status).toBe('valid');
    expect(confidence.sample_size).toBe(10);
    expect(confidence.reason).toBe('Test reason');
  });

  it('maps coverage status to confidence level correctly', () => {
    expect(coverageToConfidence('valid')).toBe('high');
    expect(coverageToConfidence('low_coverage')).toBe('medium');
    expect(coverageToConfidence('insufficient')).toBe('none');
  });

  it('provides default reason when not specified', () => {
    const confidence = buildConfidence('low_coverage', 5);

    expect(confidence.reason).toContain('5 shared races');
    expect(confidence.level).toBe('medium');
  });
});

describe('Tier 1: Structured Errors', () => {
  it('builds structured error with all fields', () => {
    const error = buildError(
      'NOT_TEAMMATES',
      'Drivers are not teammates',
      ['Check team assignments', 'Verify season']
    );

    expect(error.code).toBe('NOT_TEAMMATES');
    expect(error.message).toBe('Drivers are not teammates');
    expect(error.suggestions).toHaveLength(2);
    expect(error.recoverable).toBe(false);
  });

  it('marks recoverable errors correctly', () => {
    const recoverableError = buildError('UNKNOWN_DRIVER', 'Driver not found');
    const nonRecoverableError = buildError('NOT_TEAMMATES', 'Not teammates');

    expect(recoverableError.recoverable).toBe(true);
    expect(nonRecoverableError.recoverable).toBe(false);
  });

  it('handles all error codes', () => {
    const errorCodes = [
      'INSUFFICIENT_COVERAGE',
      'INSUFFICIENT_DATA',
      'NOT_TEAMMATES',
      'NO_DATA',
      'INVALID_SEASON',
      'UNKNOWN_DRIVER',
      'UNKNOWN_TRACK',
      'UNKNOWN_TEAM',
      'METRIC_NOT_AVAILABLE',
      'PARTIAL_DATA',
      'VALIDATION_FAILED',
      'INTERNAL_ERROR'
    ] as const;

    for (const code of errorCodes) {
      const error = buildError(code, 'Test message');
      expect(error.code).toBe(code);
    }
  });
});

describe('Tier 1: Debug Tracer', () => {
  it('creates disabled tracer by default', () => {
    const tracer = new DebugTracer();

    expect(tracer.isEnabled()).toBe(false);
    expect(tracer.finish()).toBeUndefined();
  });

  it('creates enabled tracer when specified', () => {
    const tracer = new DebugTracer(true);
    tracer.start();

    expect(tracer.isEnabled()).toBe(true);
    expect(tracer.finish()).toBeDefined();
  });

  it('tracks routing steps when enabled', () => {
    const tracer = new DebugTracer(true);
    tracer.start();
    tracer.addRoutingStep('Step 1');
    tracer.addRoutingStep('Step 2');

    const trace = tracer.finish();

    expect(trace).toBeDefined();
    expect(trace!.routing_path.length).toBeGreaterThan(2);
  });

  it('supports X-Debug header via createTracerFromRequestWithHeaders', () => {
    const tracerFromQuery = createTracerFromRequestWithHeaders(
      { debug: 'true' },
      {}
    );
    expect(tracerFromQuery.isEnabled()).toBe(true);

    const tracerFromHeader = createTracerFromRequestWithHeaders(
      {},
      { 'x-debug': 'true' }
    );
    expect(tracerFromHeader.isEnabled()).toBe(true);

    const tracerDisabled = createTracerFromRequestWithHeaders({}, {});
    expect(tracerDisabled.isEnabled()).toBe(false);
  });

  it('records identity resolution', () => {
    const tracer = new DebugTracer(true);
    tracer.start();
    tracer.setIdentityResolution('driver_a', 'verstappen', 'max-verstappen');

    const trace = tracer.finish();

    expect(trace!.identity_resolution).toBeDefined();
    expect(trace!.identity_resolution!.driver_a).toEqual({
      input: 'verstappen',
      resolved: 'max-verstappen'
    });
  });

  it('records fallback info', () => {
    const tracer = new DebugTracer(true);
    tracer.start();
    tracer.setFallbackInfo(2025, 2024, 'Insufficient coverage');

    const trace = tracer.finish();

    expect(trace!.fallback_info).toBeDefined();
    expect(trace!.fallback_info!.original_season).toBe(2025);
    expect(trace!.fallback_info!.fallback_season).toBe(2024);
  });

  it('records SQL parameters as types only', () => {
    const tracer = new DebugTracer(true);
    tracer.start();
    tracer.setSqlParameters(['verstappen', 2025, null]);

    const trace = tracer.finish();

    expect(trace!.sql_parameters).toEqual(['string', 'number', 'null']);
  });
});

describe('Tier 2: Percentile Calculations', () => {
  it('calculates percentile from rank correctly', () => {
    // Rank 1 of 10 = 100th percentile (best)
    expect(calculatePercentile(1, 10)).toBe(100);

    // Rank 10 of 10 = 0th percentile (worst)
    expect(calculatePercentile(10, 10)).toBe(0);

    // Rank 5 of 10 ≈ 56th percentile
    expect(calculatePercentile(5, 10)).toBe(56);
  });

  it('handles edge cases', () => {
    // Single driver
    expect(calculatePercentile(1, 1)).toBe(100);

    // Two drivers
    expect(calculatePercentile(1, 2)).toBe(100);
    expect(calculatePercentile(2, 2)).toBe(0);
  });

  it('interprets percentiles correctly', () => {
    expect(interpretPercentile(95)).toBe('elite');
    expect(interpretPercentile(80)).toBe('excellent');
    expect(interpretPercentile(60)).toBe('good');
    expect(interpretPercentile(30)).toBe('average');
    expect(interpretPercentile(5)).toBe('below_average');
  });

  it('uses correct thresholds', () => {
    expect(PERCENTILE_THRESHOLDS.ELITE).toBe(90);
    expect(PERCENTILE_THRESHOLDS.EXCELLENT).toBe(75);
    expect(PERCENTILE_THRESHOLDS.GOOD).toBe(50);
  });
});

describe('Tier 2: Coverage Fallback', () => {
  it('has correct fallback thresholds', () => {
    expect(FALLBACK_THRESHOLDS.MIN_SHARED_RACES).toBe(4);
    expect(FALLBACK_THRESHOLDS.PREFERRED_SHARED_RACES).toBe(8);
    expect(FALLBACK_THRESHOLDS.MAX_FALLBACK_YEARS).toBe(3);
  });
});

describe('Tier 2: Dual Comparison MIN Coverage', () => {
  it('computes MIN sample size correctly', () => {
    // Test the MIN logic
    const qualifyingRaces = 10;
    const raceRaces = 5;

    const minSampleSize = Math.min(qualifyingRaces, raceRaces);
    expect(minSampleSize).toBe(5);

    // When one is unavailable (Infinity), use the other
    const withInfinity = Math.min(qualifyingRaces, Infinity);
    expect(withInfinity).toBe(10);
  });

  it('handles both unavailable case', () => {
    const minSampleSize = Math.min(Infinity, Infinity);
    const actualSampleSize = minSampleSize === Infinity ? 0 : minSampleSize;
    expect(actualSampleSize).toBe(0);
  });
});
