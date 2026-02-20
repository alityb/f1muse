"use client"

import { Search } from "lucide-react"

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 animate-fade-in-up">
      <div className="w-10 h-10 bg-surface border border-border/60 flex items-center justify-center mb-4">
        <Search className="w-4 h-4 text-muted-foreground/50" />
      </div>
      <p className="text-sm text-muted-foreground/70 text-center max-w-sm">
        No results found for that query. Try one of the suggested queries below, or rephrase your question.
      </p>
    </div>
  )
}
