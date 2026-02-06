// api response types for f1muse frontend

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none' | 'insufficient';
export type CoverageStatus = 'valid' | 'low_coverage' | 'insufficient';

export interface Confidence {
  level: ConfidenceLevel;
  coverage_status: CoverageStatus;
  sample_size: number;
  reason: string;
  reasons?: string[];
  coverage_percent?: number;
  shared_events?: number;
}

export interface Methodology {
  metric_type: string;
  data_source: string[];
  aggregation: string;
  normalization: string;
  formula: string;
  scope: string;
  exclusions: string[];
  filters_applied?: string[];
  assumptions?: string[];
  limitations?: string[];
}

export type ErrorCode =
  | 'INSUFFICIENT_COVERAGE'
  | 'INSUFFICIENT_DATA'
  | 'NOT_TEAMMATES'
  | 'NO_DATA'
  | 'INVALID_SEASON'
  | 'UNKNOWN_DRIVER'
  | 'UNKNOWN_TRACK'
  | 'UNKNOWN_TEAM'
  | 'METRIC_NOT_AVAILABLE'
  | 'PARTIAL_DATA'
  | 'VALIDATION_FAILED'
  | 'INTERNAL_ERROR';

export interface StructuredError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  suggestions: string[];
}

export interface AnalyticalResponse<T = unknown> {
  kind: string;
  input: Record<string, unknown>;
  result: T | null;
  confidence: Confidence;
  methodology: Methodology;
  warnings: string[];
  error?: StructuredError;
}

// answer format from nl-query
export interface AnswerPayload {
  query_kind: string;
  headline: string;
  bullets: string[];
  coverage: {
    level: ConfidenceLevel;
    summary: string;
  };
  followups: string[];
}

// nl-query specific response
export interface NlQueryResponse {
  request_id: string;
  error_type: string | null;
  query_kind: string | null;
  question: string;
  queryIntent: Record<string, unknown> | null;
  result: {
    intent?: Record<string, unknown>;
    result?: {
      type: string;
      payload: Record<string, unknown>;
    };
    interpretation?: {
      comparison_basis?: string;
      normalization_scope?: string;
      metric_definition?: string;
      confidence?: {
        coverage_level?: string;
        laps_considered?: number;
        notes?: string[];
      };
    };
  } | null;
  answer: AnswerPayload;
  cached: boolean;
  fallbacks: string[];
  metadata?: {
    llm_latency_ms?: number;
    sql_latency_ms?: number;
    total_latency_ms?: number;
    cache_key?: string;
  };
}

// suggestions endpoint response
export interface Suggestion {
  query_kind: string;
  text: string;
  description: string;
}

export interface SuggestionCategory {
  id: string;
  display_name: string;
  description: string;
  suggestions: Suggestion[];
}

export interface SuggestionsResponse {
  categories: SuggestionCategory[];
  metadata: {
    total_categories: number;
    total_suggestions: number;
    supported_query_kinds: number;
    last_updated?: string;
  };
}
