/**
 * Structured Error Types for NL Query Endpoint
 *
 * All nl-query failures map to one of these error types:
 * - routing_error: Request validation failures (missing/invalid input)
 * - intent_resolution_error: LLM failed to parse user intent
 * - validation_error: Intent parsed but fails business rules
 * - execution_error: SQL/database execution failure
 * - internal_error: Unexpected server error
 */

export type NLQueryErrorType =
  | 'routing_error'
  | 'intent_resolution_error'
  | 'validation_error'
  | 'execution_error'
  | 'internal_error'
  | 'llm_unavailable';

export interface NLQueryStructuredError {
  request_id: string;
  error_type: NLQueryErrorType;
  error_code: string;
  reason: string;
  query_kind: string | null;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface NLQuerySuccessResponse {
  request_id: string;
  error_type: null;
  query_kind: string;
  question: string;
  queryIntent: unknown;
  result: unknown;
  answer: string;
  cached: boolean;
  fallbacks?: unknown[];
  supplemental_results?: unknown[];
  canonical_response?: unknown;
  metadata: {
    llm_latency_ms?: number;
    sql_latency_ms?: number;
    total_latency_ms: number;
    cache_key?: string;
    llmBackend?: string;
    fallbackUsed?: boolean;
  };
}

/**
 * Internal counters for failure tracking
 * These are lightweight in-memory counters for observability
 */
class NLQueryCounters {
  private failures: Record<NLQueryErrorType, number> = {
    routing_error: 0,
    intent_resolution_error: 0,
    validation_error: 0,
    execution_error: 0,
    internal_error: 0,
    llm_unavailable: 0,
  };

  private unresolvedIntentCount = 0;
  private validationRejectCount = 0;
  private totalRequests = 0;
  private successCount = 0;

  increment(type: NLQueryErrorType): void {
    this.failures[type]++;
  }

  incrementUnresolvedIntent(): void {
    this.unresolvedIntentCount++;
  }

  incrementValidationReject(): void {
    this.validationRejectCount++;
  }

  incrementTotal(): void {
    this.totalRequests++;
  }

  incrementSuccess(): void {
    this.successCount++;
  }

  getStats(): {
    failures_by_type: Record<NLQueryErrorType, number>;
    unresolved_intent_count: number;
    validation_reject_count: number;
    total_requests: number;
    success_count: number;
    success_rate: number;
  } {
    const successRate = this.totalRequests > 0
      ? this.successCount / this.totalRequests
      : 0;

    return {
      failures_by_type: { ...this.failures },
      unresolved_intent_count: this.unresolvedIntentCount,
      validation_reject_count: this.validationRejectCount,
      total_requests: this.totalRequests,
      success_count: this.successCount,
      success_rate: Math.round(successRate * 1000) / 1000,
    };
  }

  reset(): void {
    this.failures = {
      routing_error: 0,
      intent_resolution_error: 0,
      validation_error: 0,
      execution_error: 0,
      internal_error: 0,
      llm_unavailable: 0,
    };
    this.unresolvedIntentCount = 0;
    this.validationRejectCount = 0;
    this.totalRequests = 0;
    this.successCount = 0;
  }
}

export const nlQueryCounters = new NLQueryCounters();

/**
 * Map legacy error codes to structured error types
 */
export function classifyError(errorCode: string): NLQueryErrorType {
  const routingErrors = [
    'missing_question',
    'question_too_long',
    'invalid_request',
  ];

  const intentResolutionErrors = [
    'llm_parsing_failed',
    'llm_translation_failed',
    'llm_not_configured',
  ];

  const llmUnavailableErrors = [
    'llm_unavailable',
    'llm_queue_timeout',
    'llm_rate_limited',
  ];

  const validationErrors = [
    'validation_failed',
    'identity_resolution_failed',
    'intent_resolution_failed',
    'ambiguous_driver',
    'ambiguous_track',
    'not_teammates',
  ];

  // execution errors return HTTP 200 - query ran but data was limited
  const executionErrors = [
    'execution_failed',
    'database_error',
    'query_timeout',
    'insufficient_data',  // moved from validation - data exists but coverage limited
  ];

  if (routingErrors.includes(errorCode)) {
    return 'routing_error';
  }
  if (llmUnavailableErrors.includes(errorCode)) {
    return 'llm_unavailable';
  }
  if (intentResolutionErrors.includes(errorCode)) {
    return 'intent_resolution_error';
  }
  if (validationErrors.includes(errorCode)) {
    return 'validation_error';
  }
  if (executionErrors.includes(errorCode)) {
    return 'execution_error';
  }

  return 'internal_error';
}

/**
 * Build a structured error response
 */
export function buildErrorResponse(
  requestId: string,
  errorCode: string,
  reason: string,
  queryKind: string | null,
  options?: {
    suggestion?: string;
    details?: Record<string, unknown>;
  }
): NLQueryStructuredError {
  const errorType = classifyError(errorCode);
  nlQueryCounters.increment(errorType);

  if (errorType === 'intent_resolution_error') {
    nlQueryCounters.incrementUnresolvedIntent();
  }
  if (errorType === 'validation_error') {
    nlQueryCounters.incrementValidationReject();
  }

  return {
    request_id: requestId,
    error_type: errorType,
    error_code: errorCode,
    reason,
    query_kind: queryKind,
    suggestion: options?.suggestion,
    details: options?.details,
  };
}

/**
 * Get HTTP status code for error type
 */
export function getStatusCode(errorType: NLQueryErrorType): number {
  switch (errorType) {
    case 'routing_error':
      return 400;
    case 'intent_resolution_error':
      return 422; // Unprocessable Entity - LLM couldn't understand
    case 'validation_error':
      return 400;
    case 'execution_error':
      return 200; // Query executed successfully but found no/insufficient data - not a server error
    case 'llm_unavailable':
      return 503; // Service Unavailable - LLM capacity exhausted
    case 'internal_error':
      return 500;
    default:
      return 500;
  }
}
