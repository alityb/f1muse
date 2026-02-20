"use client"

import { useState } from "react"
import { ChevronDown, Check } from "lucide-react"

interface PipelineStep {
  label: string
  detail: string
  status: "complete" | "active" | "pending"
}

interface PipelineMetadata {
  season?: string
  source?: string
  normalization?: string
  templates?: number
  computeTime?: string
}

interface PipelineExplainerProps {
  steps?: PipelineStep[]
  metadata?: PipelineMetadata
}

/**
 * Pipeline explainer component
 *
 * Note: This component was designed for mock data that included a pipeline visualization.
 * With the real backend, pipeline steps are not provided. Instead, the query-result.tsx
 * component shows data provenance through the DataProvenance component.
 *
 * This component is kept for backwards compatibility but may not render anything
 * if steps/metadata are not provided.
 */
export function PipelineExplainer({ steps, metadata }: PipelineExplainerProps) {
  const [isOpen, setIsOpen] = useState(false)

  // Don't render if no data
  if (!steps?.length && !metadata) {
    return null
  }

  return (
    <div className="border border-border/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 hover:bg-surface/50 transition-colors"
        aria-expanded={isOpen}
      >
        <span className="text-xs font-mono text-muted-foreground">
          How this answer was computed
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="border-t border-border/50 p-4 animate-fade-in-up">
          {/* Pipeline steps */}
          {steps?.length && (
            <div className="flex flex-col gap-0">
              {steps.map((step, i) => (
                <div key={step.label} className="flex items-start gap-3">
                  {/* Vertical connector */}
                  <div className="flex flex-col items-center">
                    <div className="w-5 h-5 bg-surface border border-border flex items-center justify-center flex-shrink-0">
                      <Check className="w-2.5 h-2.5 text-foreground/70" />
                    </div>
                    {i < steps.length - 1 && (
                      <div className="w-px h-6 bg-border/60" />
                    )}
                  </div>

                  <div className="pb-3 -mt-0.5">
                    <p className="text-xs font-mono font-medium text-foreground/80">
                      {step.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                      {step.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Metadata grid */}
          {metadata && (
            <div className={`${steps?.length ? 'mt-4 pt-4 border-t border-border/40' : ''} grid grid-cols-2 sm:grid-cols-4 gap-3`}>
              {metadata.season && <MetaItem label="Season" value={metadata.season} />}
              {metadata.source && <MetaItem label="Source" value={metadata.source} />}
              {metadata.normalization && <MetaItem label="Normalization" value={metadata.normalization} />}
              {(metadata.templates || metadata.computeTime) && (
                <MetaItem
                  label="Performance"
                  value={`${metadata.templates ? metadata.templates + ' templates' : ''}${metadata.computeTime ? ', ' + metadata.computeTime : ''}`}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
        {label}
      </p>
      <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">
        {value}
      </p>
    </div>
  )
}
