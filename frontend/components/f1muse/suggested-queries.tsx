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
    query: "Show the latest recorded 2026 driver standings.",
    description: "Latest recorded standings",
  },
  {
    query: "Who won the 2025 Australian Grand Prix?",
    description: "Official race winner",
  },
  {
    query: "Show the podium for the 2025 Australian Grand Prix.",
    description: "Official race podium",
  },
  {
    query: "Who took pole at the 2025 Australian Grand Prix?",
    description: "Official qualifying pole",
  },
  {
    query: "Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?",
    description: "Race classification head-to-head",
  },
  {
    query: "Who outqualified whom more often in 2025, Norris or Piastri?",
    description: "Qualifying classification head-to-head",
  },
  {
    query: "At which circuits has Lewis Hamilton won races?",
    description: "Official career race wins",
  },
  {
    query: "Compare the official 2025 results of Norris and Piastri.",
    description: "Official results comparison",
  },
]

export function SuggestedQueries({ onSelect, visible }: SuggestedQueriesProps) {
  if (!visible) {
    return null
  }

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
