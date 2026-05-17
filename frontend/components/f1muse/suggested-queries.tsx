"use client"

import { ArrowUpRight } from "lucide-react"

interface SuggestedQueriesProps {
  onSelect: (query: string) => void
  visible: boolean
}

/**
 * Suggested queries that work with the real backend
 */
const SUGGESTED_QUERIES = [
  {
    query: "Antonelli vs Russell 2026",
    description: "Mercedes teammates — championship battle",
    category: "comparison",
  },
  {
    query: "who won Miami 2026",
    description: "Race results summary",
    category: "results",
  },
  {
    query: "fastest drivers at Suzuka 2026",
    description: "Track performance ranking",
    category: "ranking",
  },
  {
    query: "Leclerc vs Hamilton as teammates",
    description: "Ferrari's new pairing — career H2H",
    category: "comparison",
  },
  {
    query: "hamilton wins by circuit",
    description: "Career wins breakdown",
    category: "analysis",
  },
  {
    query: "qualifying results Australia 2026",
    description: "Season opener qualifying grid",
    category: "results",
  },
  {
    query: "head to head Antonelli Norris 2026",
    description: "Championship leader vs challenger",
    category: "comparison",
  },
  {
    query: "compare Norris and Piastri at Miami 2026",
    description: "Track-specific teammate comparison",
    category: "comparison",
  },
]

export function SuggestedQueries({ onSelect, visible }: SuggestedQueriesProps) {
  if (!visible) return null

  return (
    <section className="w-full animate-fade-in-up" aria-label="Suggested queries">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
          Explore
        </h2>
        <div className="flex-1 h-px bg-border/50" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 stagger-children">
        {SUGGESTED_QUERIES.map((suggestion) => (
          <button
            key={suggestion.query}
            type="button"
            onClick={() => onSelect(suggestion.query)}
            className="group flex items-start justify-between gap-3 p-3.5  border border-border/60 hover:border-border hover:bg-surface transition-all text-left"
          >
            <div className="flex-1 min-w-0">
              <p className="font-mono text-sm text-foreground/90 group-hover:text-foreground transition-colors truncate">
                {suggestion.query}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {suggestion.description}
              </p>
            </div>
            <div className="flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
