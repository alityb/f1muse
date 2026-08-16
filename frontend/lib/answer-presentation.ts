const COLUMN_LABELS: Readonly<Record<string, string>> = {
  qualifying_position: "Position",
  finishing_position: "Position",
  championship_position: "Position",
  best_time_ms: "Best lap",
  best_session: "Session",
  eliminated_in_round: "Eliminated",
  classification_status: "Status",
  status_reason: "Reason",
  event_id: "Event",
  circuit_id: "Circuit",
  session_scope: "Session",
  finished_ahead_of: "Finished ahead of",
}

export function formatColumnLabel(key: string): string {
  return COLUMN_LABELS[key] ?? humanizeIdentifier(key)
}

export function formatSubject(subject: string): string {
  return humanizeIdentifier(subject)
}

export function formatFactValue(key: string, value: string | null): string {
  if (value === null) {
    return "—"
  }
  if (key === "best_time_ms") {
    return formatMilliseconds(value)
  }
  if (key.endsWith("_id") || key === "classification_status" || key === "finished_ahead_of") {
    return humanizeIdentifier(value)
  }
  return value
}

export function formatHeadline(headline: string, subjects: readonly string[]): string {
  return [...new Set(subjects)]
    .sort((left, right) => right.length - left.length)
    .reduce((result, subject) => result.replaceAll(subject, formatSubject(subject)), headline)
}

export function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}

function formatMilliseconds(value: string): string {
  if (!/^\d+$/.test(value)) {
    return value
  }
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds)) {
    return value
  }
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  const remainder = milliseconds % 1_000
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`
}
