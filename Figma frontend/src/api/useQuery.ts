import { useState, useCallback, useRef } from 'react';
import { nlQuery } from './client';
import type { NlQueryResponse } from './types';

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QueryState {
  status: QueryStatus;
  activeQuestion: string | null;
  data: NlQueryResponse | null;
  error: string | null;
}

export function useF1Query() {
  const [state, setState] = useState<QueryState>({
    status: 'idle',
    activeQuestion: null,
    data: null,
    error: null,
  });

  // track current request to handle race conditions
  const requestIdRef = useRef(0);
  const activeQuestionRef = useRef<string | null>(null);

  const submit = useCallback(async (question: string) => {
    const currentRequestId = ++requestIdRef.current;
    activeQuestionRef.current = question;

    // clear data immediately to prevent stale display
    setState({
      status: 'loading',
      activeQuestion: question,
      data: null,
      error: null,
    });

    try {
      console.log('[DEBUG useQuery] calling nlQuery for:', question);
      const response = await nlQuery(question);
      console.log('[DEBUG useQuery] got response, error_type:', response.error_type);

      // guard: ignore stale responses
      if (currentRequestId !== requestIdRef.current) {
        console.log('[DEBUG useQuery] ignoring stale response');
        return;
      }

      // guard: verify response matches active query
      if (activeQuestionRef.current !== question) {
        console.log('[DEBUG useQuery] ignoring mismatched query');
        return;
      }

      console.log('[DEBUG useQuery] setting success state');
      setState({
        status: 'success',
        activeQuestion: question,
        data: response,
        error: null,
      });
    } catch (err) {
      console.error('[DEBUG useQuery] caught error:', err);
      // ignore stale errors
      if (currentRequestId !== requestIdRef.current) return;
      if (activeQuestionRef.current !== question) return;

      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred';
      console.log('[DEBUG useQuery] setting error state:', message);

      setState({
        status: 'error',
        activeQuestion: question,
        data: null,
        error: message,
      });
    }
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current++;
    activeQuestionRef.current = null;
    setState({
      status: 'idle',
      activeQuestion: null,
      data: null,
      error: null,
    });
  }, []);

  return {
    ...state,
    submit,
    reset,
    isLoading: state.status === 'loading',
    hasResult: state.status === 'success' && state.data !== null,
    hasError: state.status === 'error',
  };
}
