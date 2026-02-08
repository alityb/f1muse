"use client"

import { F1MuseWordmark } from "./logo"
import { ExternalLink } from "lucide-react"

const NAV_LINKS = [
  { label: "Docs", href: "#" },
  { label: "Methodology", href: "#" },
  { label: "GitHub", href: "https://github.com/alityb/f1muse", external: true },
]

export function Header() {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-border/50">
      <F1MuseWordmark />
      <nav className="flex items-center gap-1" aria-label="Primary navigation">
        {NAV_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors hover:bg-surface"
            {...(link.external
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {link.label}
            {link.external && (
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            )}
          </a>
        ))}
        <div className="ml-3 hidden sm:flex items-center gap-1.5 px-2 py-1 border border-border text-[10px] text-muted-foreground font-mono">
          <kbd className="text-foreground/70">{"/"}</kbd>
          <span>to search</span>
        </div>
      </nav>
    </header>
  )
}
