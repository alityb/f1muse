/**
 * F1Muse F1QL answer client.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000"

export interface AnswerFact {
  subject: string
  values: Record<string, string | null>
}

export interface AnswerEnvelope {
  mode: "gated_execution"
  program: {
    version: number
    root: {
      op: string
      [key: string]: unknown
    }
  }
  program_hash: string
  answer: {
    headline: string
    facts: AnswerFact[]
  }
  rows: Array<Record<string, unknown>>
  rendering: string
  metadata: {
    source: string
    definitions_version: string
    compiler_version: string
    fact_space_version: string
    coverage: {
      status: "sufficient" | "empty" | "possibly_truncated"
      rows_returned: number
    }
    caveats: string[]
  }
}

export interface APIError {
  request_id?: string
  error_type: string
  message: string
  suggestion?: string
  details?: Record<string, unknown>
  options?: string[]
}

export async function executeQuery(question: string): Promise<AnswerEnvelope> {
  const response = await fetch(`${API_BASE_URL}/nl-query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question }),
  })

  const data: unknown = await response.json()

  if (!response.ok || !isAnswerEnvelope(data)) {
    throw toAPIError(data, response.ok)
  }

  return data
}

function isAnswerEnvelope(value: unknown): value is AnswerEnvelope {
  if (!isRecord(value) || value.mode !== "gated_execution") {
    return false
  }
  if (!isRecord(value.answer) || typeof value.answer.headline !== "string" || !Array.isArray(value.answer.facts)) {
    return false
  }
  if (!isRecord(value.metadata) || !isRecord(value.metadata.coverage)) {
    return false
  }

  return (
    typeof value.program_hash === "string" &&
    typeof value.rendering === "string" &&
    typeof value.metadata.source === "string" &&
    typeof value.metadata.coverage.status === "string" &&
    typeof value.metadata.coverage.rows_returned === "number" &&
    Array.isArray(value.metadata.caveats) &&
    Array.isArray(value.rows)
  )
}

function toAPIError(value: unknown, responseWasOk: boolean): APIError {
  const data = isRecord(value) ? value : {}
  const errorType = stringValue(data.error_type) || stringValue(data.error) || "request_failed"
  const reason = stringValue(data.reason)
  const invalidEnvelope = responseWasOk && errorType === "request_failed"

  return {
    request_id: stringValue(data.request_id),
    error_type: invalidEnvelope ? "invalid_answer_response" : errorType,
    message: stringValue(data.message) || reason || (invalidEnvelope ? "The service returned an invalid answer." : "Request failed"),
    suggestion: stringValue(data.suggestion),
    details: isRecord(data.details) ? data.details : undefined,
    options: Array.isArray(data.options) ? data.options.filter((item): item is string => typeof item === "string") : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
