"use client"

import { useState, useCallback, useRef } from "react"
import { Header } from "@/components/f1muse/header"
import { QueryInput } from "@/components/f1muse/query-input"
import { SuggestedQueries } from "@/components/f1muse/suggested-queries"
import { QueryResultView } from "@/components/f1muse/query-result"
import { StatusBar } from "@/components/f1muse/status-bar"
import { EmptyState } from "@/components/f1muse/empty-state"
import { F1MuseLogo } from "@/components/f1muse/logo"
import {
  executeQuery,
  type NLQueryResponse,
  type APIError,
} from "@/lib/api-client"

type QueryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: NLQueryResponse }
  | { status: 'error'; error: APIError }

export default function Page() {
  const [query, setQuery] = useState("")
  const [queryState, setQueryState] = useState<QueryState>({ status: 'idle' })
  const [activeQuery, setActiveQuery] = useState("")
  const resultRef = useRef<HTMLDivElement>(null)

  const handleSubmit = useCallback(
    async (queryText: string) => {
      setQueryState({ status: 'loading' })
      setActiveQuery(queryText)

      try {
        const response = await executeQuery(queryText)
        setQueryState({ status: 'success', data: response })

        // Scroll to results
        setTimeout(() => {
          resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
        }, 100)
      } catch (err) {
        const apiError = err as APIError
        setQueryState({
          status: 'error',
          error: {
            request_id: apiError.request_id || 'unknown',
            error_type: apiError.error_type || 'unknown_error',
            message: apiError.message || 'An unexpected error occurred',
            suggestion: apiError.suggestion,
            details: apiError.details,
          }
        })
      }
    },
    []
  )

  const handleSuggestionSelect = useCallback(
    (suggestion: string) => {
      setQuery(suggestion)
      handleSubmit(suggestion)
    },
    [handleSubmit]
  )

  const hasSearched = queryState.status !== 'idle'
  const isLoading = queryState.status === 'loading'

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 pb-16">
        {/* Hero area - query input */}
        <div
          className={`w-full max-w-2xl transition-all duration-500 ease-out ${
            hasSearched ? "pt-8" : "pt-[20vh]"
          }`}
        >
          {/* Brand mark above input when in hero mode */}
          {!hasSearched && (
            <div className="flex flex-col items-center mb-8 animate-fade-in-up">
              <F1MuseLogo size={40} />
              <h1 className="mt-4 text-xl font-medium text-foreground tracking-tight text-balance text-center">
                Structured F1 Analytics
              </h1>
              <p className="mt-2 text-sm text-muted-foreground text-center max-w-md leading-relaxed">
                Ask natural-language questions about Formula 1. Answers are computed from validated SQL templates against official timing data.
              </p>
            </div>
          )}

          <QueryInput
            value={query}
            onChange={setQuery}
            onSubmit={handleSubmit}
            isLoading={isLoading}
          />
        </div>

        {/* Active query display */}
        {hasSearched && activeQuery && (
          <div className="w-full max-w-2xl mt-6">
            <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground/50">
              <span>{">"}</span>
              <span>{activeQuery}</span>
            </div>
          </div>
        )}

        {/* Results area */}
        <div ref={resultRef} className="w-full max-w-2xl mt-6">
          {isLoading && (
            <div className="flex items-center gap-3 py-12">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-foreground/40 pulse-dot" />
                <span className="w-1.5 h-1.5 bg-foreground/40 pulse-dot" />
                <span className="w-1.5 h-1.5 bg-foreground/40 pulse-dot" />
              </div>
              <span className="text-xs font-mono text-muted-foreground/50">
                Processing query...
              </span>
            </div>
          )}

          {queryState.status === 'success' && (
            <QueryResultView response={queryState.data} />
          )}

          {queryState.status === 'error' && (
            <ErrorDisplay error={queryState.error} />
          )}

          {!isLoading && hasSearched && queryState.status !== 'success' && queryState.status !== 'error' && (
            <EmptyState />
          )}
        </div>

        {/* Suggested queries */}
        <div className="w-full max-w-2xl mt-10">
          <SuggestedQueries
            onSelect={handleSuggestionSelect}
            visible={!isLoading}
          />
        </div>
      </main>

      <StatusBar />
    </div>
  )
}

function ErrorDisplay({ error }: { error: APIError }) {
  return (
    <div className="w-full p-6 border border-red-500/20 bg-red-500/5">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-5 h-5 bg-red-500/20 flex items-center justify-center">
          <span className="text-red-500 text-xs">!</span>
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-foreground">
            {getErrorTitle(error.error_type)}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {error.message}
          </p>
          {error.suggestion && (
            <p className="mt-2 text-xs text-muted-foreground/70">
              {error.suggestion}
            </p>
          )}
          <p className="mt-3 text-[10px] font-mono text-muted-foreground/40">
            Request ID: {error.request_id}
          </p>
        </div>
      </div>
    </div>
  )
}

function getErrorTitle(errorType: string): string {
  const titles: Record<string, string> = {
    missing_question: 'Missing Question',
    question_too_long: 'Question Too Long',
    llm_translation_failed: 'Translation Failed',
    llm_parsing_failed: 'Parsing Failed',
    llm_not_configured: 'Service Not Configured',
    llm_unavailable: 'Service Temporarily Unavailable',
    validation_failed: 'Validation Failed',
    execution_failed: 'Query Failed',
    insufficient_data: 'Insufficient Data',
    no_data: 'No Data Found',
    internal_error: 'Internal Error',
  }
  return titles[errorType] || 'Error'
}
