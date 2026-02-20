"use client"

import React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { ArrowRight, Command } from "lucide-react"

/**
 * Placeholder queries for the cycling animation
 */
const PLACEHOLDER_QUERIES = [
  "verstappen vs norris 2024",
  "who won monaco 2024",
  "fastest drivers at silverstone",
  "hamilton career summary",
  "leclerc vs sainz 2024",
  "head to head verstappen norris",
]

interface QueryInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (query: string) => void
  isLoading: boolean
}

export function QueryInput({ value, onChange, onSubmit, isLoading }: QueryInputProps) {
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [displayedPlaceholder, setDisplayedPlaceholder] = useState("")
  const [isTyping, setIsTyping] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  // Cycling placeholder with typing effect
  useEffect(() => {
    const targetText = PLACEHOLDER_QUERIES[placeholderIndex]
    let charIndex = 0
    let timeout: NodeJS.Timeout

    if (isTyping) {
      const typeChar = () => {
        if (charIndex <= targetText.length) {
          setDisplayedPlaceholder(targetText.slice(0, charIndex))
          charIndex++
          timeout = setTimeout(typeChar, 40 + Math.random() * 30)
        } else {
          // Pause before erasing
          timeout = setTimeout(() => setIsTyping(false), 2500)
        }
      }
      typeChar()
    } else {
      // Erase
      let eraseIndex = targetText.length
      const eraseChar = () => {
        if (eraseIndex >= 0) {
          setDisplayedPlaceholder(targetText.slice(0, eraseIndex))
          eraseIndex--
          timeout = setTimeout(eraseChar, 20)
        } else {
          setPlaceholderIndex((prev) => (prev + 1) % PLACEHOLDER_QUERIES.length)
          setIsTyping(true)
        }
      }
      eraseChar()
    }

    return () => clearTimeout(timeout)
  }, [placeholderIndex, isTyping])

  // Global "/" and Cmd+K shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // "/" shortcut (when not in an input)
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault()
        inputRef.current?.focus()
      }
      // Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (value.trim() && !isLoading) {
        onSubmit(value.trim())
      }
    },
    [value, isLoading, onSubmit]
  )

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="relative group">
        {/* Outer glow on focus */}
        <div className="absolute -inset-px bg-border/0 group-focus-within:bg-border/50 transition-colors" />
        <div className="relative flex items-center bg-surface border border-border group-focus-within:border-border/80 transition-colors">
          {/* Prompt indicator */}
          <div className="flex items-center pl-4 pr-2">
            <span className="text-muted-foreground font-mono text-sm select-none">
              {">"}
            </span>
          </div>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={displayedPlaceholder}
            disabled={isLoading}
            className="flex-1 bg-transparent py-4 pr-4 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 outline-none disabled:opacity-50"
            aria-label="Search F1 data"
            autoComplete="off"
            spellCheck={false}
          />

          {/* Submit hint */}
          <div className="flex items-center pr-4 gap-2">
            {value.trim() && (
              <button
                type="submit"
                disabled={isLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-foreground bg-foreground/10 hover:bg-foreground/15 transition-colors disabled:opacity-50"
                aria-label="Run query"
              >
                <span className="hidden sm:inline">run</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            )}
            {!value.trim() && (
              <div className="hidden sm:flex items-center gap-1 text-[10px] text-muted-foreground/60 font-mono">
                <Command className="w-3 h-3" />
                <span>K</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Subtle help text */}
      <div className="flex items-center justify-between mt-2 px-1">
        <p className="text-[11px] text-muted-foreground/50 font-mono">
          Ask anything about F1 statistics, driver comparisons, or circuit records.
        </p>
        {isLoading && (
          <div className="flex items-center gap-1" aria-label="Processing query">
            <span className="w-1 h-1 bg-foreground/60 pulse-dot" />
            <span className="w-1 h-1 bg-foreground/60 pulse-dot" />
            <span className="w-1 h-1 bg-foreground/60 pulse-dot" />
          </div>
        )}
      </div>
    </form>
  )
}
