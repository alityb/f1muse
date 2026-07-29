"use client"

import { useState } from "react"
import { ChevronDown, Database, FileCheck2, ShieldCheck } from "lucide-react"
import { type AnswerEnvelope, type AnswerFact } from "@/lib/api-client"

interface QueryResultViewProps {
  response: AnswerEnvelope
}

export function QueryResultView({ response }: QueryResultViewProps) {
  const { answer, metadata } = response

  return (
    <div className="w-full animate-fade-in-up space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-foreground tracking-tight text-balance">
            F1QL answer
          </h2>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            {humanize(metadata.source)}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
          <span title={response.program_hash}>{response.program_hash.slice(0, 8)}</span>
          <span className="w-px h-3 bg-border/50" />
          <span>{metadata.coverage.rows_returned} rows</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-3 border-b border-border/30">
        <TrustBadge icon={<Database className="w-3 h-3" />} label="Source" value={humanize(metadata.source)} />
        <TrustBadge icon={<ShieldCheck className="w-3 h-3" />} label="Coverage" value={humanize(metadata.coverage.status)} />
        <TrustBadge icon={<FileCheck2 className="w-3 h-3" />} label="Program" value={humanize(response.program.root.op)} />
      </div>

      <section className="space-y-4" aria-labelledby="answer-headline">
        <div className="p-4 bg-surface/50 border border-border/30">
          <p id="answer-headline" className="text-sm text-foreground leading-relaxed">
            {answer.headline}
          </p>
        </div>

        {answer.facts.length > 0 && <FactsTable facts={answer.facts} />}
      </section>

      {metadata.caveats.length > 0 && (
        <div className="space-y-1.5 border-l border-border/60 pl-3">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50">Coverage notes</p>
          {metadata.caveats.map((caveat) => (
            <p key={caveat} className="text-xs text-muted-foreground leading-relaxed">
              {humanize(caveat)}
            </p>
          ))}
        </div>
      )}

      <AnswerProvenance response={response} />
    </div>
  )
}

function FactsTable({ facts }: { facts: AnswerFact[] }) {
  const keys = Array.from(new Set(facts.flatMap((fact) => Object.keys(fact.values))))

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-border/60">
            <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
              Subject
            </th>
            {keys.map((key) => (
              <th key={key} className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 last:pr-0 uppercase tracking-wider whitespace-nowrap">
                {humanize(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {facts.map((fact, index) => (
            <tr key={`${fact.subject}-${index}`} className={`border-b border-border/20 ${index % 2 === 1 ? "bg-surface/30" : ""}`}>
              <td className="py-2.5 pr-4 text-xs font-mono text-foreground/90 whitespace-nowrap">{humanize(fact.subject)}</td>
              {keys.map((key) => (
                <td key={key} className="py-2.5 px-4 last:pr-0 text-right text-xs font-mono text-muted-foreground whitespace-nowrap">
                  {fact.values[key] ?? "-"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TrustBadge({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground/50">{icon}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">{label}</span>
      <span className="text-[11px] font-mono text-muted-foreground">{value}</span>
    </div>
  )
}

function AnswerProvenance({ response }: { response: AnswerEnvelope }) {
  const [isOpen, setIsOpen] = useState(false)
  const metadata = response.metadata
  const items = [
    ["Definitions", metadata.definitions_version],
    ["Compiler", metadata.compiler_version],
    ["Fact space", metadata.fact_space_version],
    ["Program hash", response.program_hash],
  ]

  return (
    <div className="border border-border/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="w-full flex items-center justify-between p-3 hover:bg-surface/50 transition-colors"
        aria-expanded={isOpen}
      >
        <span className="text-xs font-mono text-muted-foreground">F1QL provenance</span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <div className="border-t border-border/50 p-4 animate-fade-in-up space-y-4">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed font-mono text-muted-foreground bg-surface/30 border border-border/20 p-3">
            {response.rendering}
          </pre>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {items.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">{label}</p>
                <p className="text-[11px] font-mono text-muted-foreground leading-relaxed break-all">{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}
