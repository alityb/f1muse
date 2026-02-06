/**
 * NL Query Error Handling Tests
 *
 * Tests for Section A (Adversarial NL coverage hooks) and Section C (Failure-mode guarantees)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildErrorResponse,
  classifyError,
  getStatusCode,
  nlQueryCounters,
  NLQueryErrorType,
} from '../../src/api/nl-query-errors';

describe('Structured Error Typing', () => {
  describe('classifyError', () => {
    it('should classify routing errors', () => {
      expect(classifyError('missing_question')).toBe('routing_error');
      expect(classifyError('question_too_long')).toBe('routing_error');
      expect(classifyError('invalid_request')).toBe('routing_error');
    });

    it('should classify intent resolution errors', () => {
      expect(classifyError('llm_parsing_failed')).toBe('intent_resolution_error');
      expect(classifyError('llm_translation_failed')).toBe('intent_resolution_error');
      expect(classifyError('llm_not_configured')).toBe('intent_resolution_error');
    });

    it('should classify validation errors', () => {
      expect(classifyError('validation_failed')).toBe('validation_error');
      expect(classifyError('identity_resolution_failed')).toBe('validation_error');
      expect(classifyError('ambiguous_driver')).toBe('validation_error');
      expect(classifyError('ambiguous_track')).toBe('validation_error');
      expect(classifyError('not_teammates')).toBe('validation_error');
    });

    it('should classify execution errors', () => {
      expect(classifyError('execution_failed')).toBe('execution_error');
      expect(classifyError('database_error')).toBe('execution_error');
      expect(classifyError('query_timeout')).toBe('execution_error');
      // insufficient_data is execution_error - query ran but data was limited
      expect(classifyError('insufficient_data')).toBe('execution_error');
    });

    it('should default to internal_error for unknown codes', () => {
      expect(classifyError('unknown_error_code')).toBe('internal_error');
      expect(classifyError('')).toBe('internal_error');
    });
  });

  describe('getStatusCode', () => {
    it('should return 400 for routing errors', () => {
      expect(getStatusCode('routing_error')).toBe(400);
    });

    it('should return 422 for intent resolution errors', () => {
      expect(getStatusCode('intent_resolution_error')).toBe(422);
    });

    it('should return 400 for validation errors', () => {
      expect(getStatusCode('validation_error')).toBe(400);
    });

    it('should return 200 for execution errors (query ran but data limited)', () => {
      // execution_error returns 200 because the query executed successfully
      // but found no/insufficient data - this is not a server error
      expect(getStatusCode('execution_error')).toBe(200);
    });

    it('should return 500 for internal errors', () => {
      expect(getStatusCode('internal_error')).toBe(500);
    });
  });

  describe('buildErrorResponse', () => {
    it('should build structured error with all required fields', () => {
      const error = buildErrorResponse(
        'req-123',
        'missing_question',
        'Please provide a question',
        null,
        { suggestion: 'Include a question field' }
      );

      expect(error).toHaveProperty('request_id', 'req-123');
      expect(error).toHaveProperty('error_type', 'routing_error');
      expect(error).toHaveProperty('error_code', 'missing_question');
      expect(error).toHaveProperty('reason', 'Please provide a question');
      expect(error).toHaveProperty('query_kind', null);
      expect(error).toHaveProperty('suggestion', 'Include a question field');
    });

    it('should include query_kind when available', () => {
      const error = buildErrorResponse(
        'req-456',
        'validation_failed',
        'Driver not found',
        'teammate_gap_summary_season'
      );

      expect(error.query_kind).toBe('teammate_gap_summary_season');
    });

    it('should include optional details', () => {
      const error = buildErrorResponse(
        'req-789',
        'question_too_long',
        'Question too long',
        null,
        { details: { max_length: 500, actual_length: 600 } }
      );

      expect(error.details).toEqual({ max_length: 500, actual_length: 600 });
    });
  });
});

describe('NL Query Counters', () => {
  beforeEach(() => {
    nlQueryCounters.reset();
  });

  it('should track failures by type', () => {
    nlQueryCounters.increment('routing_error');
    nlQueryCounters.increment('routing_error');
    nlQueryCounters.increment('validation_error');

    const stats = nlQueryCounters.getStats();
    expect(stats.failures_by_type.routing_error).toBe(2);
    expect(stats.failures_by_type.validation_error).toBe(1);
    expect(stats.failures_by_type.internal_error).toBe(0);
  });

  it('should track unresolved intent count', () => {
    nlQueryCounters.incrementUnresolvedIntent();
    nlQueryCounters.incrementUnresolvedIntent();

    const stats = nlQueryCounters.getStats();
    expect(stats.unresolved_intent_count).toBe(2);
  });

  it('should track validation reject count', () => {
    nlQueryCounters.incrementValidationReject();

    const stats = nlQueryCounters.getStats();
    expect(stats.validation_reject_count).toBe(1);
  });

  it('should track total requests and success rate', () => {
    nlQueryCounters.incrementTotal();
    nlQueryCounters.incrementTotal();
    nlQueryCounters.incrementTotal();
    nlQueryCounters.incrementSuccess();
    nlQueryCounters.incrementSuccess();

    const stats = nlQueryCounters.getStats();
    expect(stats.total_requests).toBe(3);
    expect(stats.success_count).toBe(2);
    expect(stats.success_rate).toBeCloseTo(0.667, 2);
  });

  it('should reset all counters', () => {
    nlQueryCounters.incrementTotal();
    nlQueryCounters.incrementSuccess();
    nlQueryCounters.increment('routing_error');

    nlQueryCounters.reset();
    const stats = nlQueryCounters.getStats();

    expect(stats.total_requests).toBe(0);
    expect(stats.success_count).toBe(0);
    expect(stats.failures_by_type.routing_error).toBe(0);
  });

  it('buildErrorResponse should auto-increment counters', () => {
    nlQueryCounters.reset();

    buildErrorResponse('r1', 'llm_parsing_failed', 'Failed', null);
    buildErrorResponse('r2', 'validation_failed', 'Invalid', 'some_kind');

    const stats = nlQueryCounters.getStats();
    expect(stats.failures_by_type.intent_resolution_error).toBe(1);
    expect(stats.failures_by_type.validation_error).toBe(1);
    expect(stats.unresolved_intent_count).toBe(1);
    expect(stats.validation_reject_count).toBe(1);
  });
});

describe('Error Response Contract', () => {
  const allErrorTypes: NLQueryErrorType[] = [
    'routing_error',
    'intent_resolution_error',
    'validation_error',
    'execution_error',
    'internal_error',
  ];

  it('should always include request_id in error responses', () => {
    for (const errorType of ['missing_question', 'llm_parsing_failed', 'validation_failed']) {
      const error = buildErrorResponse('test-id', errorType, 'reason', null);
      expect(error.request_id).toBe('test-id');
    }
  });

  it('should always include error_type in error responses', () => {
    for (const errorType of ['missing_question', 'llm_parsing_failed', 'validation_failed']) {
      const error = buildErrorResponse('test-id', errorType, 'reason', null);
      expect(allErrorTypes).toContain(error.error_type);
    }
  });

  it('should always include query_kind (even if null) in error responses', () => {
    const errorWithKind = buildErrorResponse('id', 'validation_failed', 'reason', 'some_kind');
    const errorWithoutKind = buildErrorResponse('id', 'missing_question', 'reason', null);

    expect(errorWithKind).toHaveProperty('query_kind', 'some_kind');
    expect(errorWithoutKind).toHaveProperty('query_kind', null);
  });

  it('should return appropriate status codes for error types', () => {
    // 4xx range - client errors
    expect(getStatusCode('routing_error')).toBeGreaterThanOrEqual(400);
    expect(getStatusCode('routing_error')).toBeLessThan(500);
    expect(getStatusCode('intent_resolution_error')).toBeGreaterThanOrEqual(400);
    expect(getStatusCode('intent_resolution_error')).toBeLessThan(500);
    expect(getStatusCode('validation_error')).toBeGreaterThanOrEqual(400);
    expect(getStatusCode('validation_error')).toBeLessThan(500);

    // 200 - execution errors (query ran successfully but data limited)
    expect(getStatusCode('execution_error')).toBe(200);

    // 5xx range - server errors
    expect(getStatusCode('internal_error')).toBeGreaterThanOrEqual(500);
  });
});
