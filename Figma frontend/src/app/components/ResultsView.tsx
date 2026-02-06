import { memo } from 'react';
import type { NlQueryResponse } from '@/api/types';
import { AnswerDisplay } from './answer/AnswerDisplay';
import { ErrorDisplay } from './answer/ErrorDisplay';
import { UnsupportedQueryDisplay } from './answer/UnsupportedQueryDisplay';
import { isQueryKindSupported } from './answer/query-renderers';

interface ResultsViewProps {
  data: NlQueryResponse | null;
  question: string | null;
  error: string | null;
  isLoading?: boolean;
  onSuggestionClick?: (suggestion: string) => void;
}

export const ResultsView = memo(function ResultsView({
  data,
  question,
  error,
  isLoading = false,
  onSuggestionClick,
}: ResultsViewProps) {
  // DEBUG: log decision inputs
  console.log('[DEBUG ResultsView] inputs:', JSON.stringify({
    has_data: !!data,
    has_error: !!error,
    error_value: error,
    data_error_type: data?.error_type,
    data_query_kind: data?.query_kind,
    has_answer: !!data?.answer,
  }));

  // Network or unexpected error
  if (error && !data) {
    console.log('[DEBUG ResultsView] BRANCH: network error (error && !data)');

    return (
      <ErrorDisplay
        message={error}
        question={question}
        onSuggestionClick={onSuggestionClick}
      />
    );
  }

  // API returned an error in the response
  if (data?.error_type) {
    console.log('[DEBUG ResultsView] BRANCH: api error (data?.error_type)', data.error_type);
    const errorAnswer =
      (data as any).details?.answer?.headline ||
      (data as any).reason ||
      'Unable to answer this question';
    return (
      <ErrorDisplay
        message={errorAnswer}
        question={question}
        onSuggestionClick={onSuggestionClick}
      />
    );
  }

  // Successful response
  if (data) {
    console.log('[DEBUG ResultsView] BRANCH: success (data exists, no error_type)');
    const displayQuestion = data.question || question;

    // Check if the query kind is supported by the frontend
    const queryKind = data.query_kind || null;
    if (!isQueryKindSupported(queryKind)) {
      console.log('[DEBUG ResultsView] BRANCH: unsupported query kind', queryKind);
      return (
        <UnsupportedQueryDisplay
          queryKind={queryKind}
          data={data}
        />
      );
    }

    return (
      <AnswerDisplay
        data={data}
        question={displayQuestion}
        isLoading={isLoading}
      />
    );
  }

  return null;
});
