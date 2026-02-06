import type { NlQueryResponse, SuggestionsResponse } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  console.log('[DEBUG request] fetching:', url);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (fetchError) {
    console.error('[DEBUG request] fetch threw:', fetchError);
    throw fetchError;
  }

  console.log('[DEBUG request] response status:', response.status);

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    console.error('[DEBUG request] error body:', errorBody);
    throw new ApiError(
      errorBody.message || `Request failed: ${response.status}`,
      response.status,
      errorBody.code
    );
  }

  const json = await response.json();
  console.log('[DEBUG request] parsed JSON ok, keys:', Object.keys(json));
  return json;
}

// natural language query - the primary endpoint
export async function nlQuery(question: string): Promise<NlQueryResponse> {
  const response = await request<NlQueryResponse>('/nl-query', {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
  // DEBUG: log raw response before any processing
  console.log('[DEBUG nlQuery] raw response:', JSON.stringify({
    error_type: response.error_type,
    query_kind: response.query_kind,
    has_answer: !!response.answer,
    has_result: !!response.result,
    answer_headline: response.answer?.headline,
  }));
  return response;
}

// fetch suggested queries
export async function getSuggestions(): Promise<SuggestionsResponse> {
  return request<SuggestionsResponse>('/suggestions');
}

// health check
export async function healthCheck(): Promise<{ status: string }> {
  return request<{ status: string }>('/health');
}

export { ApiError };
