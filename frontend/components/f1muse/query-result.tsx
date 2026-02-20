"use client"

import { useState } from "react"
import { Lightbulb, Database, ShieldCheck, Beaker } from "lucide-react"
import {
  type NLQueryResponse,
  type ResultPayload,
  type DriverRef,
  type TrackRef,
  type Metric,
  type OrderedDriverPair,
  type Coverage,
  type StructuredAnswer,
  getDriverName,
  getTrackName,
  formatMetricValue,
  getPayload,
} from "@/lib/api-client"

interface QueryResultViewProps {
  response: NLQueryResponse
}

export function QueryResultView({ response }: QueryResultViewProps) {
  const payload = getPayload(response)
  const queryKind = response.query_kind

  // Build title and subtitle from response
  const title = buildTitle(response)
  const subtitle = buildSubtitle(response)

  return (
    <div className="w-full animate-fade-in-up space-y-5">
      {/* Result header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium text-foreground tracking-tight text-balance">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            {subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
          <span>{response.request_id.slice(0, 8)}</span>
          {response.debug?.rows_returned !== undefined && (
            <>
              <span className="w-px h-3 bg-border/50" />
              <span>{response.debug.rows_returned} rows</span>
            </>
          )}
        </div>
      </div>

      {/* Trust signals bar */}
      <TrustSignals response={response} />

      {/* Natural language answer (headline) */}
      {response.answer && <AnswerSection answer={response.answer} />}

      {/* Content based on query_kind */}
      {payload && <ResultRenderer queryKind={queryKind} payload={payload} response={response} />}

      {/* Related queries */}
      {response.answer && typeof response.answer !== 'string' && response.answer.followups?.length > 0 && (
        <RelatedQueries followups={response.answer.followups} />
      )}

      {/* Data provenance */}
      <DataProvenance response={response} />
    </div>
  )
}

/**
 * Trust signals showing data source and methodology
 */
function TrustSignals({ response }: { response: NLQueryResponse }) {
  const interpretation = response.result?.interpretation
  const metadata = response.result?.metadata

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-3 border-b border-border/30">
      {response.queryIntent?.season && (
        <TrustBadge
          icon={<Database className="w-3 h-3" />}
          label="Season"
          value={String(response.queryIntent.season)}
        />
      )}
      {metadata?.data_scope && (
        <TrustBadge
          icon={<Database className="w-3 h-3" />}
          label="Scope"
          value={metadata.data_scope}
        />
      )}
      {interpretation?.normalization_scope && (
        <TrustBadge
          icon={<Beaker className="w-3 h-3" />}
          label="Method"
          value={interpretation.normalization_scope}
        />
      )}
      {interpretation?.confidence?.coverage_level && (
        <TrustBadge
          icon={<ShieldCheck className="w-3 h-3" />}
          label="Confidence"
          value={interpretation.confidence.coverage_level}
        />
      )}
    </div>
  )
}

function TrustBadge({
  icon,
  label,
  value
}: {
  icon?: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      {icon && <span className="text-muted-foreground/50">{icon}</span>}
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
        {label}
      </span>
      <span className="text-[11px] font-mono text-muted-foreground">{value}</span>
    </div>
  )
}

/**
 * Pipeline explainer - "How this answer was computed"
 */
function DataProvenance({ response }: { response: NLQueryResponse }) {
  const [isOpen, setIsOpen] = useState(false)
  const interpretation = response.result?.interpretation
  const metadata = response.result?.metadata
  const payload = getPayload(response)

  // Build pipeline steps from response data
  const queryKind = response.query_kind?.replace(/_/g, ' ') || 'query'
  const templateId = metadata?.sql_template_id || 'unknown'
  const rowCount = response.debug?.rows_returned || metadata?.rows || 0
  const season = (payload as any)?.season || ''

  const steps = [
    {
      label: "Parse",
      detail: `Identified ${queryKind} query${season ? ` for ${season}` : ''}`,
    },
    {
      label: "Template",
      detail: `Matched SQL template: ${templateId}`,
    },
    {
      label: "Execute",
      detail: `Queried ${rowCount} result${rowCount !== 1 ? 's' : ''} from database`,
    },
    {
      label: "Validate",
      detail: interpretation?.comparison_basis || "Cross-referenced with official FIA data",
    },
    {
      label: "Format",
      detail: interpretation?.normalization_scope || interpretation?.metric_definition || "Normalized to standard output format",
    },
  ]

  const metadataItems = [
    { label: "Season", value: season?.toString() },
    { label: "Source", value: "FIA Official Timing" },
    {
      label: "Normalization",
      value: interpretation?.normalization_scope || interpretation?.metric_definition || "Standard"
    },
    {
      label: "Performance",
      value: `${templateId.split('_')[0]}, ${rowCount} rows`
    },
  ].filter(item => item.value)

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
        <svg
          className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="border-t border-border/50 p-4 animate-fade-in-up">
          {/* Pipeline steps */}
          <div className="flex flex-col gap-0">
            {steps.map((step, i) => (
              <div key={step.label} className="flex items-start gap-3">
                {/* Vertical connector */}
                <div className="flex flex-col items-center">
                  <div className="w-5 h-5 bg-surface border border-border flex items-center justify-center flex-shrink-0 rounded-full">
                    <svg className="w-2.5 h-2.5 text-foreground/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  {i < steps.length - 1 && (
                    <div className="w-px h-6 bg-border/60" />
                  )}
                </div>

                <div className="pb-3 -mt-0.5">
                  <p className="text-xs font-medium text-foreground/80">
                    {step.label}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                    {step.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Metadata grid */}
          <div className="mt-4 pt-4 border-t border-border/40 grid grid-cols-2 sm:grid-cols-4 gap-4">
            {metadataItems.map((item) => (
              <div key={item.label}>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
                  {item.label}
                </p>
                <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Structured answer section
 */
function AnswerSection({ answer }: { answer: StructuredAnswer | string }) {
  // Handle legacy string format
  if (typeof answer === 'string') {
    return (
      <div className="p-4 bg-surface/50 border border-border/30">
        <div className="flex items-start gap-3">
          <Lightbulb className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {answer}
          </p>
        </div>
      </div>
    )
  }

  // Structured answer format
  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="p-4 bg-surface/50 border border-border/30">
        <div className="flex items-start gap-3">
          <Lightbulb className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-sm text-foreground leading-relaxed">
            {answer.headline}
          </p>
        </div>
      </div>

      {/* Bullets */}
      {answer.bullets?.length > 0 && (
        <ul className="space-y-1 pl-4">
          {answer.bullets.map((bullet, i) => (
            <li key={i} className="text-xs text-muted-foreground leading-relaxed flex items-baseline gap-2">
              <span className="text-muted-foreground/50">•</span>
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Related queries section
 */
function RelatedQueries({ followups }: { followups: string[] }) {
  return (
    <div className="pt-2">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">
        Related queries
      </p>
      <div className="flex flex-wrap gap-2">
        {followups.map((followup, i) => (
          <span
            key={i}
            className="text-[11px] px-2 py-1 bg-surface border border-border/30 text-muted-foreground font-mono cursor-pointer hover:bg-surface/80 transition-colors"
          >
            {followup}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Main result renderer - switches on query_kind
 */
function ResultRenderer({
  queryKind,
  payload,
  response
}: {
  queryKind: string | null
  payload: ResultPayload
  response: NLQueryResponse
}) {
  // Dispatch to appropriate renderer based on query_kind
  switch (queryKind) {
    case 'driver_season_summary':
      return <DriverSeasonSummaryView payload={payload as any} />

    case 'season_driver_vs_driver':
    case 'cross_team_track_scoped_driver_comparison':
      return <DriverComparisonView payload={payload as any} />

    case 'track_fastest_drivers':
    case 'driver_ranking':
      return <DriverRankingView payload={payload as any} />

    case 'race_results_summary':
      return <RaceResultsView payload={payload as any} />

    case 'teammate_gap_summary_season':
      return <TeammateGapView payload={payload as any} />

    case 'teammate_gap_dual_comparison':
      return <TeammateGapDualView payload={payload as any} />

    case 'driver_career_summary':
      return <DriverCareerView payload={payload as any} />

    case 'driver_head_to_head_count':
    case 'driver_matchup_lookup':
      return <HeadToHeadView payload={payload as any} />

    case 'driver_performance_vector':
      return <PerformanceVectorView payload={payload as any} />

    case 'driver_multi_comparison':
      return <MultiComparisonView payload={payload as any} />

    case 'driver_vs_driver_comprehensive':
      return <DriverVsDriverComprehensiveView payload={payload as any} />

    case 'driver_career_wins_by_circuit':
      return <WinsByCircuitView payload={payload as any} />

    case 'teammate_comparison_career':
      return <TeammateComparisonCareerView payload={payload as any} />

    case 'qualifying_results_summary':
      return <QualifyingResultsView payload={payload as any} />

    case 'driver_pole_count':
      return <PoleCountView payload={payload as any} />

    case 'driver_career_pole_count':
      return <CareerPoleCountView payload={payload as any} />

    case 'driver_q3_count':
      return <Q3CountView payload={payload as any} />

    case 'season_q3_rankings':
      return <Q3RankingsView payload={payload as any} />

    case 'qualifying_gap_teammates':
    case 'qualifying_gap_drivers':
      return <QualifyingGapView payload={payload as any} />

    default:
      // Fallback: render raw payload as JSON
      return <GenericResultView payload={payload} />
  }
}

/**
 * Driver Season Summary renderer
 */
function DriverSeasonSummaryView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver || payload.driver_id)
  const metrics = payload.metrics

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">{driverName} - {payload.season} Season</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <StatCard
          label={metrics?.wins?.label || "Wins"}
          value={metrics?.wins?.value ?? payload.wins}
        />
        <StatCard
          label={metrics?.podiums?.label || "Podiums"}
          value={metrics?.podiums?.value ?? payload.podiums}
        />
        <StatCard
          label={metrics?.poles?.label || "Poles"}
          value={metrics?.poles?.value ?? payload.poles ?? 0}
        />
        <StatCard
          label={metrics?.dnfs?.label || "DNFs"}
          value={metrics?.dnfs?.value ?? payload.dnfs}
        />
        <StatCard
          label={metrics?.race_count?.label || "Races"}
          value={metrics?.race_count?.value ?? payload.race_count}
        />
        {(metrics?.avg_race_pace || payload.avg_race_pace) && (
          <StatCard
            label={metrics?.avg_race_pace?.label || "Avg Race Pace"}
            value={formatMetricValue(metrics?.avg_race_pace || payload.avg_race_pace, 'seconds')}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Driver Comparison renderer (season vs season, track scoped)
 * Clean card-based design showing pace gap with baseline format
 */
function DriverComparisonView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined
  const metrics = payload.metrics

  const driverA = drivers?.drivers?.[0] || { id: payload.driver_a, name: getDriverName(payload.driver_a) }
  const driverB = drivers?.drivers?.[1] || { id: payload.driver_b, name: getDriverName(payload.driver_b) }

  // Get values
  const gap = metrics?.pace_delta?.value ?? metrics?.difference?.value ?? payload.pace_delta ?? payload.difference ?? 0
  const lapsA = metrics?.driver_a_laps?.value ?? payload.driver_a_laps ?? payload.coverage?.driver_a_laps ?? 0
  const lapsB = metrics?.driver_b_laps?.value ?? payload.driver_b_laps ?? payload.coverage?.driver_b_laps ?? 0
  const valueA = metrics?.driver_a_value?.value ?? payload.driver_a_value ?? 0
  const valueB = metrics?.driver_b_value?.value ?? payload.driver_b_value ?? 0

  // Detect if values are percentages or lap times
  // Check explicit units field, or infer from value magnitude (lap times are typically 60-120+ seconds)
  const units = metrics?.driver_a_value?.units ?? payload.units
  const isPercent = units === 'percent' || (Math.abs(valueA) < 10 && Math.abs(valueB) < 10)

  // Coverage model
  const coverage = payload.coverage as { driver_a_laps: number; driver_b_laps: number; basis_laps: number; confidence: 'high' | 'medium' | 'low' } | undefined
  const basisLaps = coverage?.basis_laps ?? Math.min(lapsA, lapsB)
  const confidence = coverage?.confidence ?? (basisLaps >= 30 ? 'high' : basisLaps >= 10 ? 'medium' : 'low')

  // Determine who's faster (negative = faster for both percent and seconds)
  const aFaster = valueA < valueB
  const bFaster = valueB < valueA
  const absGap = Math.abs(gap)

  // Format lap time as m:ss.xxx
  const formatLapTime = (seconds: number): string => {
    if (seconds < 0 || seconds > 300) return '-' // Guard against invalid values
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toFixed(3).padStart(6, '0')}`
  }

  // Format value based on whether it's percent or lap time
  const formatValue = (value: number, isFaster: boolean): string => {
    if (isPercent) {
      // For percentage-based comparisons, show "baseline" for faster driver
      if (isFaster) {
        return 'baseline'
      }
      return `+${absGap.toFixed(3)}%`
    } else {
      // For lap time comparisons, show actual time for faster, gap for slower
      if (isFaster) {
        return formatLapTime(value)
      }
      return `+${absGap.toFixed(3)}s`
    }
  }

  // Get short driver names
  const getShortName = (driver: DriverRef) => {
    const name = driver.name || driver.id
    const parts = name.split(' ')
    if (parts.length >= 2) {
      return `${parts[0][0]}. ${parts.slice(1).join(' ').toUpperCase()}`
    }
    return name.toUpperCase()
  }

  // Confidence colors
  const confidenceColors: Record<string, string> = {
    high: 'bg-green-500/20 text-green-600',
    medium: 'bg-yellow-500/20 text-yellow-600',
    low: 'bg-red-500/20 text-red-600',
  }

  return (
    <div className="space-y-4">
      {/* Main comparison cards */}
      <div className="grid grid-cols-2 gap-3">
        {/* Driver A */}
        <div className={`p-4  border ${aFaster ? 'bg-green-500/5 border-green-500/20' : 'bg-surface/30 border-border/20'}`}>
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            {getShortName(driverA)}
          </span>
          <p className={`text-2xl font-mono mt-2 ${aFaster ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
            {formatValue(valueA, aFaster)}
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-2 font-mono">
            {lapsA} laps analyzed
          </p>
        </div>

        {/* Driver B */}
        <div className={`p-4  border ${bFaster ? 'bg-green-500/5 border-green-500/20' : 'bg-surface/30 border-border/20'}`}>
          <span className="text-xs text-muted-foreground uppercase tracking-wider">
            {getShortName(driverB)}
          </span>
          <p className={`text-2xl font-mono mt-2 ${bFaster ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
            {formatValue(valueB, bFaster)}
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-2 font-mono">
            {lapsB} laps analyzed
          </p>
        </div>
      </div>

      {/* Coverage indicator */}
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 text-[10px] font-mono ${confidenceColors[confidence]}`}>
          {confidence}
        </span>
        <span className="text-[10px] text-muted-foreground/50 font-mono">
          {basisLaps} lap comparison basis
        </span>
      </div>
    </div>
  )
}

function ComparisonRow({
  metric,
  valueA,
  valueB,
  advantage,
  highlight = false
}: {
  metric: string
  valueA: string
  valueB: string
  advantage: 'A' | 'B' | 'neutral'
  highlight?: boolean
}) {
  return (
    <tr className={`border-b border-border/20 ${highlight ? 'bg-surface/30' : ''}`}>
      <td className="py-2.5 pr-4 text-xs text-muted-foreground font-mono">
        {metric}
      </td>
      <td className={`py-2.5 px-4 text-right text-xs font-mono ${
        advantage === 'A' ? 'text-foreground font-medium' : 'text-muted-foreground'
      }`}>
        {valueA}
      </td>
      <td className={`py-2.5 pl-4 text-right text-xs font-mono ${
        advantage === 'B' ? 'text-foreground font-medium' : 'text-muted-foreground'
      }`}>
        {valueB}
      </td>
    </tr>
  )
}

/**
 * Driver Ranking renderer
 */
function DriverRankingView({ payload }: { payload: any }) {
  const entries = payload.entries || []

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-border/60">
            <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider w-8">
              #
            </th>
            <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
              Driver
            </th>
            <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
              Time / Gap
            </th>
            <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 pl-4 uppercase tracking-wider">
              Laps
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry: any, i: number) => (
            <tr
              key={`${entry.driver_id}-${i}`}
              className={`border-b border-border/20 ${i % 2 === 0 ? '' : 'bg-surface/30'}`}
            >
              <td className="py-2.5 pr-4 text-xs font-mono text-muted-foreground/50">
                {i + 1}
              </td>
              <td className="py-2.5 pr-4">
                <span className="text-xs font-mono text-foreground/90">
                  {getDriverName(entry.driver || entry.driver_id)}
                </span>
              </td>
              <td className="py-2.5 px-4 text-right text-xs font-mono text-foreground/80">
                {formatMetricValue(entry.pace ?? entry.value, 'seconds')}
              </td>
              <td className="py-2.5 pl-4 text-right text-xs font-mono text-muted-foreground">
                {entry.laps?.value ?? entry.laps_considered}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Race Results renderer
 */
function RaceResultsView({ payload }: { payload: any }) {
  const podium = payload.podium || []
  const fullResults = payload.full_results || payload.top10 || []
  const results = fullResults.length > 0 ? fullResults : podium

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-foreground">
          {payload.race_name || `${getTrackName(payload.track || payload.track_id)} ${payload.season}`}
        </h3>
        {payload.race_date && (
          <span className="text-[10px] font-mono text-muted-foreground/50">
            {payload.race_date}
          </span>
        )}
      </div>

      {payload.winner_name && (
        <div className="p-3  bg-surface/50 border border-border/30">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Winner</span>
          <p className="text-sm font-medium text-foreground mt-1">{payload.winner_name}</p>
          {payload.winner_time && (
            <p className="text-xs font-mono text-muted-foreground mt-0.5">{payload.winner_time}</p>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider w-8">
                Pos
              </th>
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
                Driver
              </th>
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
                Team
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 pl-4 uppercase tracking-wider">
                Time/Gap
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((entry: any, i: number) => (
              <tr
                key={`${entry.driver_id}-${entry.position}-${i}`}
                className={`border-b border-border/20 ${i % 2 === 0 ? '' : 'bg-surface/30'}`}
              >
                <td className="py-2.5 pr-4 text-xs font-mono text-muted-foreground/50">
                  {entry.position}
                </td>
                <td className="py-2.5 pr-4">
                  <span className="text-xs font-mono text-foreground/90">
                    {getDriverName(entry.driver || entry.driver_name || entry.driver_id)}
                  </span>
                </td>
                <td className="py-2.5 px-4 text-xs font-mono text-muted-foreground">
                  {entry.constructor_name}
                </td>
                <td className="py-2.5 pl-4 text-right text-xs font-mono text-muted-foreground">
                  {entry.race_time || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Teammate Gap renderer
 */
function TeammateGapView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined
  const metrics = payload.metrics

  const driverA = drivers?.drivers?.[0] || { id: payload.driver_primary_id, name: getDriverName(payload.driver_primary_id) }
  const driverB = drivers?.drivers?.[1] || { id: payload.driver_secondary_id, name: getDriverName(payload.driver_secondary_id) }

  const gapSeconds = metrics?.gap_seconds?.value ?? payload.gap_seconds ?? 0
  const faster = gapSeconds < 0 ? 'A' : 'B'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Teammate Comparison</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">
          {payload.season} - {payload.team_id}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4  border ${faster === 'A' ? 'border-foreground/20 bg-surface/50' : 'border-border/30'}`}>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
            {faster === 'A' ? 'Faster' : ''}
          </span>
          <p className="text-sm font-medium text-foreground mt-1">{getDriverName(driverA)}</p>
        </div>
        <div className={`p-4  border ${faster === 'B' ? 'border-foreground/20 bg-surface/50' : 'border-border/30'}`}>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
            {faster === 'B' ? 'Faster' : ''}
          </span>
          <p className="text-sm font-medium text-foreground mt-1">{getDriverName(driverB)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label={metrics?.gap_seconds?.label || "Gap (seconds)"}
          value={formatMetricValue(metrics?.gap_seconds ?? payload.gap_seconds, 'seconds')}
        />
        {(metrics?.gap_pct || payload.gap_pct) && (
          <StatCard
            label={metrics?.gap_pct?.label || "Gap (%)"}
            value={formatMetricValue(metrics?.gap_pct ?? payload.gap_pct, 'percent')}
          />
        )}
        <StatCard
          label={metrics?.shared_races?.label || "Shared Races"}
          value={metrics?.shared_races?.value ?? payload.shared_races}
        />
        <StatCard
          label="Classification"
          value={formatGapBand(payload.gap_band)}
        />
      </div>

      <CoverageIndicator coverage={payload.coverage} className="mt-4" />
    </div>
  )
}

/**
 * Teammate Gap Dual Comparison renderer (quali vs race)
 */
function TeammateGapDualView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined

  const driverA = drivers?.drivers?.[0] || { id: payload.driver_primary_id, name: getDriverName(payload.driver_primary_id) }
  const driverB = drivers?.drivers?.[1] || { id: payload.driver_secondary_id, name: getDriverName(payload.driver_secondary_id) }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Qualifying vs Race Pace</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">{payload.season}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-4  border border-border/30">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Qualifying</span>
          <p className="text-sm font-medium text-foreground mt-1">
            {payload.qualifying?.available
              ? `${formatMetricValue(payload.qualifying.gap_percent, 'percent')}`
              : 'N/A'}
          </p>
          {payload.qualifying?.winner && (
            <p className="text-xs text-muted-foreground mt-1">
              Faster: {getDriverName(payload.qualifying.winner === driverA.id ? driverA : driverB)}
            </p>
          )}
        </div>
        <div className="p-4  border border-border/30">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Race Pace</span>
          <p className="text-sm font-medium text-foreground mt-1">
            {payload.race_pace?.available
              ? `${formatMetricValue(payload.race_pace.gap_percent, 'percent')}`
              : 'N/A'}
          </p>
          {payload.race_pace?.winner && (
            <p className="text-xs text-muted-foreground mt-1">
              Faster: {getDriverName(payload.race_pace.winner === driverA.id ? driverA : driverB)}
            </p>
          )}
        </div>
      </div>

      <div className="p-3  bg-surface/30 border border-border/20">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Summary</span>
        <p className="text-xs text-foreground mt-1">
          {payload.overall_summary?.same_winner === true
            ? `Same driver faster in both (${payload.overall_summary.advantage_area})`
            : payload.overall_summary?.same_winner === false
              ? 'Different drivers faster in qualifying vs race'
              : 'Insufficient data for comparison'}
        </p>
      </div>
    </div>
  )
}

/**
 * Driver Career Summary renderer
 */
function DriverCareerView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver || payload.driver_id)
  const metrics = payload.metrics

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">{driverName} - Career Summary</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label={metrics?.championships?.label || "Championships"}
          value={metrics?.championships?.value ?? payload.championships}
        />
        <StatCard
          label={metrics?.career_wins?.label || "Career Wins"}
          value={metrics?.career_wins?.value ?? payload.career_wins}
        />
        <StatCard
          label={metrics?.career_podiums?.label || "Career Podiums"}
          value={metrics?.career_podiums?.value ?? payload.career_podiums}
        />
        <StatCard
          label={metrics?.career_poles?.label || "Career Poles"}
          value={metrics?.career_poles?.value ?? payload.career_poles ?? 0}
        />
        <StatCard
          label={metrics?.seasons_raced?.label || "Seasons"}
          value={metrics?.seasons_raced?.value ?? payload.seasons_raced}
        />
      </div>
    </div>
  )
}

/**
 * Head-to-Head Count renderer
 */
function HeadToHeadView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined
  const metrics = payload.metrics

  const driverA = drivers?.drivers?.[0] || { id: payload.driver_primary_id, name: getDriverName(payload.driver_primary_id) }
  const driverB = drivers?.drivers?.[1] || { id: payload.driver_secondary_id, name: getDriverName(payload.driver_secondary_id) }

  const winsA = metrics?.primary_wins?.value ?? payload.primary_wins ?? 0
  const winsB = metrics?.secondary_wins?.value ?? payload.secondary_wins ?? 0
  const ties = metrics?.ties?.value ?? payload.ties ?? 0
  const total = metrics?.shared_events?.value ?? payload.shared_events ?? 0

  const metricLabel = payload.metric === 'qualifying_position' ? 'Qualifying' : 'Race Finish'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{metricLabel} Head-to-Head</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">{payload.season}</span>
      </div>

      <div className="flex items-center justify-center gap-8 py-4">
        <div className="text-center">
          <p className="text-2xl font-bold text-foreground">{winsA}</p>
          <p className="text-xs text-muted-foreground mt-1">{getDriverName(driverA)}</p>
        </div>
        <div className="text-center">
          <p className="text-lg text-muted-foreground">-</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-foreground">{winsB}</p>
          <p className="text-xs text-muted-foreground mt-1">{getDriverName(driverB)}</p>
        </div>
      </div>

      <div className="flex justify-center gap-4 text-xs text-muted-foreground">
        {ties > 0 && <span>Ties: {ties}</span>}
        <span>Total events: {total}</span>
      </div>

      <CoverageIndicator coverage={payload.coverage} className="mt-4" />
    </div>
  )
}

/**
 * Performance Vector renderer
 */
function PerformanceVectorView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver || payload.driver_id)

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">{driverName} - Performance Profile</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {payload.qualifying_percentile !== null && (
          <StatCard
            label="Qualifying"
            value={`${payload.qualifying_percentile}th`}
            subtitle="percentile"
          />
        )}
        {payload.race_pace_percentile !== null && (
          <StatCard
            label="Race Pace"
            value={`${payload.race_pace_percentile}th`}
            subtitle="percentile"
          />
        )}
        {payload.consistency_score !== null && (
          <StatCard
            label="Consistency"
            value={`${payload.consistency_score}`}
            subtitle="score"
          />
        )}
        {payload.street_delta !== null && (
          <StatCard
            label="Street Circuits"
            value={formatMetricValue(payload.street_delta, 'percent')}
            subtitle="vs median"
          />
        )}
        {payload.wet_delta !== null && (
          <StatCard
            label="Wet Conditions"
            value={formatMetricValue(payload.wet_delta, 'percent')}
            subtitle="vs median"
          />
        )}
      </div>
    </div>
  )
}

/**
 * Multi-Driver Comparison renderer
 */
function MultiComparisonView({ payload }: { payload: any }) {
  const entries = payload.entries || []

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-foreground">Driver Comparison</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">
          {payload.ranked_drivers} of {payload.total_drivers} drivers
        </span>
      </div>

      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-border/60">
            <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider w-8">
              Rank
            </th>
            <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
              Driver
            </th>
            <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
              {entries[0]?.metric?.label || payload.metric}
            </th>
            <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 pl-4 uppercase tracking-wider">
              Laps
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry: any, i: number) => (
            <tr
              key={`${entry.driver_id}-${entry.rank}-${i}`}
              className={`border-b border-border/20 ${entry.rank % 2 === 0 ? 'bg-surface/30' : ''}`}
            >
              <td className="py-2.5 pr-4 text-xs font-mono text-muted-foreground/50">
                {entry.rank}
              </td>
              <td className="py-2.5 pr-4">
                <span className="text-xs font-mono text-foreground/90">
                  {getDriverName(entry.driver || entry.driver_id)}
                </span>
              </td>
              <td className="py-2.5 px-4 text-right text-xs font-mono text-foreground/80">
                {formatMetricValue(entry.metric ?? entry.metric_value)}
              </td>
              <td className="py-2.5 pl-4 text-right text-xs font-mono text-muted-foreground">
                {entry.laps?.value ?? entry.laps_considered}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <CoverageIndicator coverage={payload.coverage} className="mt-4" />
    </div>
  )
}

/**
 * Driver vs Driver Comprehensive renderer - Clean table design
 */
function DriverVsDriverComprehensiveView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined
  const driverA = drivers?.drivers?.[0] || { id: 'driver_a', name: 'Driver A' }
  const driverB = drivers?.drivers?.[1] || { id: 'driver_b', name: 'Driver B' }

  // Extract stats
  const statsA = payload.stats?.driver_a
  const statsB = payload.stats?.driver_b
  const h2h = payload.head_to_head
  const pace = payload.pace

  // Calculate stats
  const pointsA = statsA?.points?.value ?? 0
  const pointsB = statsB?.points?.value ?? 0
  const raceCountA = statsA?.race_count?.value ?? 0
  const raceCountB = statsB?.race_count?.value ?? 0
  const fastestLapsA = statsA?.fastest_laps?.value ?? 0
  const fastestLapsB = statsB?.fastest_laps?.value ?? 0
  const sprintPointsA = statsA?.sprint_points?.value ?? 0
  const sprintPointsB = statsB?.sprint_points?.value ?? 0

  // Calculate points per race weekend
  const ptsPerRaceA = raceCountA > 0 ? (pointsA / raceCountA).toFixed(1) : '0'
  const ptsPerRaceB = raceCountB > 0 ? (pointsB / raceCountB).toFixed(1) : '0'

  // Determine faster driver for pace (lower/more negative = faster)
  const paceA = pace?.driver_a_avg_pace_pct?.value ?? null
  const paceB = pace?.driver_b_avg_pace_pct?.value ?? null
  const aFaster = paceA !== null && paceB !== null && paceA < paceB
  const bFaster = paceA !== null && paceB !== null && paceB < paceA

  // Format pace as "baseline" or "+X.XX%"
  const formatPaceDisplay = (value: number | null, isBaseline: boolean) => {
    if (value === null) return '-'
    if (isBaseline) return 'baseline'
    // Show delta from baseline driver (always positive for non-baseline)
    const delta = Math.abs(paceA !== null && paceB !== null ? paceA - paceB : 0)
    return `+${delta.toFixed(3)}%`
  }

  // Get driver short name (e.g., "M. VERSTAPPEN")
  const getShortDisplayName = (driver: DriverRef) => {
    const name = driver.name || driver.id
    const parts = name.split(' ')
    if (parts.length >= 2) {
      return `${parts[0][0]}. ${parts.slice(1).join(' ').toUpperCase()}`
    }
    return name.toUpperCase()
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-border/60">
            <th className="text-left text-[11px] font-normal text-muted-foreground pb-3 pr-4 uppercase tracking-wider">
              Metric
            </th>
            <th className="text-right text-[11px] font-normal pb-3 px-4 uppercase tracking-wider">
              <span className="text-foreground font-medium">{getShortDisplayName(driverA)}</span>
            </th>
            <th className="text-right text-[11px] font-normal pb-3 pl-4 uppercase tracking-wider">
              <span className="text-foreground/80">{getShortDisplayName(driverB)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {/* Championship Points */}
          <ComprehensiveRow
            label="Championship Points"
            valueA={pointsA}
            valueB={pointsB}
            displayA={`${pointsA} pts`}
            displayB={`${pointsB} pts`}
            higherIsBetter
          />

          {/* Race Wins */}
          <ComprehensiveRow
            label="Race Wins"
            valueA={statsA?.wins?.value ?? 0}
            valueB={statsB?.wins?.value ?? 0}
            higherIsBetter
          />

          {/* Pole Positions */}
          <ComprehensiveRow
            label="Pole Positions"
            valueA={statsA?.poles?.value ?? 0}
            valueB={statsB?.poles?.value ?? 0}
            higherIsBetter
          />

          {/* Avg. Qualifying Gap - using baseline format */}
          {payload.qualifying_gap?.shared_sessions > 0 && (() => {
            const qualGapPct = payload.qualifying_gap?.gap_pct?.value ?? null
            // For qualifying gap: negative means A is faster, positive means A is slower
            const aFasterQual = qualGapPct !== null && qualGapPct < 0
            const bFasterQual = qualGapPct !== null && qualGapPct > 0
            const formatQualGap = (isBaseline: boolean) => {
              if (qualGapPct === null) return '-'
              if (isBaseline) return 'baseline'
              return `+${Math.abs(qualGapPct).toFixed(3)}%`
            }
            return (
              <tr className="border-b border-border/20">
                <td className="py-3 pr-4 text-xs text-muted-foreground">Avg. Qualifying Gap</td>
                <td className={`py-3 px-4 text-right text-xs font-mono ${aFasterQual ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {formatQualGap(aFasterQual)}
                </td>
                <td className={`py-3 pl-4 text-right text-xs font-mono ${bFasterQual ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {formatQualGap(bFasterQual)}
                </td>
              </tr>
            )
          })()}

          {/* Avg. Race Pace - using baseline format */}
          {pace?.shared_races > 0 && (
            <tr className="border-b border-border/20">
              <td className="py-3 pr-4 text-xs text-muted-foreground">Avg. Race Pace</td>
              <td className={`py-3 px-4 text-right text-xs font-mono ${aFaster ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                {formatPaceDisplay(paceA, aFaster)}
              </td>
              <td className={`py-3 pl-4 text-right text-xs font-mono ${bFaster ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                {formatPaceDisplay(paceB, bFaster)}
              </td>
            </tr>
          )}

          {/* Podium Finishes */}
          <ComprehensiveRow
            label="Podium Finishes"
            valueA={statsA?.podiums?.value ?? 0}
            valueB={statsB?.podiums?.value ?? 0}
            higherIsBetter
          />

          {/* DNFs */}
          <ComprehensiveRow
            label="DNFs"
            valueA={statsA?.dnfs?.value ?? 0}
            valueB={statsB?.dnfs?.value ?? 0}
            higherIsBetter={false}
          />

          {/* Fastest Laps */}
          <ComprehensiveRow
            label="Fastest Laps"
            valueA={fastestLapsA}
            valueB={fastestLapsB}
            higherIsBetter
          />

          {/* Points per Race Weekend */}
          <ComprehensiveRow
            label="Points per Race"
            valueA={parseFloat(ptsPerRaceA)}
            valueB={parseFloat(ptsPerRaceB)}
            displayA={ptsPerRaceA}
            displayB={ptsPerRaceB}
            higherIsBetter
          />

          {/* Sprint Points (only show if someone has sprint points) */}
          {(sprintPointsA > 0 || sprintPointsB > 0) && (
            <ComprehensiveRow
              label="Sprint Points"
              valueA={sprintPointsA}
              valueB={sprintPointsB}
              higherIsBetter
            />
          )}

          {/* Qualifying H2H */}
          {h2h?.qualifying && (
            <ComprehensiveRow
              label="Qualifying H2H"
              valueA={h2h.qualifying.a_wins}
              valueB={h2h.qualifying.b_wins}
              higherIsBetter
            />
          )}

          {/* Race Finish H2H */}
          {h2h?.race_finish && (
            <ComprehensiveRow
              label="Race Finish H2H"
              valueA={h2h.race_finish.a_wins}
              valueB={h2h.race_finish.b_wins}
              higherIsBetter
            />
          )}
        </tbody>
      </table>

      {/* Coverage and shared races note */}
      <div className="mt-3 pt-3 border-t border-border/20 flex items-center justify-between">
        <CoverageIndicator coverage={payload.coverage} />
        {pace?.shared_races > 0 && (
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            {pace.shared_races} shared races analyzed
          </span>
        )}
      </div>
    </div>
  )
}

function ComprehensiveRow({
  label,
  valueA,
  valueB,
  displayA,
  displayB,
  higherIsBetter = true
}: {
  label: string
  valueA: number
  valueB: number
  displayA?: string
  displayB?: string
  higherIsBetter?: boolean
}) {
  const aWins = higherIsBetter ? valueA > valueB : valueA < valueB
  const bWins = higherIsBetter ? valueB > valueA : valueB < valueA

  return (
    <tr className="border-b border-border/20">
      <td className="py-3 pr-4 text-xs text-muted-foreground">{label}</td>
      <td className={`py-3 px-4 text-right text-xs font-mono ${aWins ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
        {displayA ?? valueA}
      </td>
      <td className={`py-3 pl-4 text-right text-xs font-mono ${bWins ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
        {displayB ?? valueB}
      </td>
    </tr>
  )
}

/**
 * Wins by Circuit renderer
 */
function WinsByCircuitView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver)
  const circuits = payload.circuits || []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{driverName} - Career Wins by Circuit</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">
          {payload.total_wins} total wins
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
                Circuit
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
                Wins
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 pl-4 uppercase tracking-wider">
                Last Win
              </th>
            </tr>
          </thead>
          <tbody>
            {circuits.map((circuit: any, i: number) => (
              <tr
                key={`${circuit.track?.id || 'track'}-${i}`}
                className={`border-b border-border/20 ${i % 2 === 0 ? '' : 'bg-surface/30'}`}
              >
                <td className="py-2.5 pr-4 text-xs font-mono text-foreground/90">
                  {getTrackName(circuit.track)}
                </td>
                <td className="py-2.5 px-4 text-right text-xs font-mono text-foreground/80">
                  {circuit.wins}
                </td>
                <td className="py-2.5 pl-4 text-right text-xs font-mono text-muted-foreground">
                  {circuit.last_win_year}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Teammate Comparison Career renderer
 */
function TeammateComparisonCareerView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined
  const driverA = drivers?.drivers?.[0] || { id: 'driver_a', name: 'Driver A' }
  const driverB = drivers?.drivers?.[1] || { id: 'driver_b', name: 'Driver B' }
  const seasons = payload.seasons || []
  const aggregate = payload.aggregate

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">
          {getDriverName(driverA)} vs {getDriverName(driverB)} - Teammate History
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">
          {aggregate?.seasons_together ?? 0} seasons together
        </span>
      </div>

      {/* Aggregate Summary */}
      {aggregate && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <StatCard
            label="Seasons"
            value={aggregate.seasons_together}
          />
          <StatCard
            label="Shared Races"
            value={aggregate.total_shared_races}
          />
          <StatCard
            label="Overall H2H"
            value={`${aggregate.total_faster_primary_count ?? 0}-${(aggregate.total_shared_races ?? 0) - (aggregate.total_faster_primary_count ?? 0)}`}
          />
          <StatCard
            label="Avg Gap"
            value={formatMetricValue(aggregate.avg_gap_pct ?? aggregate.avg_gap_seconds, aggregate.avg_gap_pct !== undefined ? 'percent' : 'seconds')}
          />
          <StatCard
            label="Overall Winner"
            value={aggregate.overall_winner === 'primary' ? getDriverName(driverA)
                 : aggregate.overall_winner === 'secondary' ? getDriverName(driverB)
                 : 'Draw'}
          />
        </div>
      )}

      {/* Per-Season Breakdown */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
                Season
              </th>
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
                Team
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
                Gap
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
                Races
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 pl-4 uppercase tracking-wider">
                H2H
              </th>
            </tr>
          </thead>
          <tbody>
            {seasons.map((season: any, i: number) => (
              <tr
                key={season.season}
                className={`border-b border-border/20 ${i % 2 === 0 ? '' : 'bg-surface/30'}`}
              >
                <td className="py-2.5 pr-4 text-xs font-mono text-foreground/90">
                  {season.season}
                </td>
                <td className="py-2.5 px-4 text-xs text-muted-foreground">
                  {season.team?.name || season.team_id}
                </td>
                <td className="py-2.5 px-4 text-right text-xs font-mono text-foreground/80">
                  {formatMetricValue(season.gap_pct ?? season.gap_seconds, season.gap_pct !== undefined ? 'percent' : 'seconds')}
                </td>
                <td className="py-2.5 px-4 text-right text-xs font-mono text-muted-foreground">
                  {season.shared_races}
                </td>
                <td className="py-2.5 pl-4 text-right text-xs font-mono text-muted-foreground">
                  {season.faster_primary_count}-{season.shared_races - season.faster_primary_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Qualifying Results renderer
 */
function QualifyingResultsView({ payload }: { payload: any }) {
  const fullGrid = payload.full_grid || payload.top10 || payload.front_row || []

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-foreground">
          {getTrackName(payload.track || payload.track_name || payload.track_id)} {payload.season} Qualifying
        </h3>
        {payload.round && (
          <span className="text-[10px] font-mono text-muted-foreground/50">
            Round {payload.round}
          </span>
        )}
      </div>

      {payload.pole_sitter_name && (
        <div className="p-3  bg-surface/50 border border-border/30">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Pole Position</span>
          <p className="text-sm font-medium text-foreground mt-1">{payload.pole_sitter_name}</p>
          {payload.pole_time && (
            <p className="text-xs font-mono text-muted-foreground mt-0.5">{payload.pole_time}</p>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-2 uppercase tracking-wider w-8">
                Pos
              </th>
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-2 uppercase tracking-wider">
                Driver
              </th>
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 px-2 uppercase tracking-wider">
                Team
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-2 uppercase tracking-wider">
                Q1
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-2 uppercase tracking-wider">
                Q2
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-2 uppercase tracking-wider">
                Q3
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-2 uppercase tracking-wider">
                Gap
              </th>
            </tr>
          </thead>
          <tbody>
            {fullGrid.map((entry: any, i: number) => (
              <tr
                key={`${entry.driver_id}-${entry.position}-${i}`}
                className={`border-b border-border/20 ${i % 2 === 0 ? '' : 'bg-surface/30'}`}
              >
                <td className="py-2.5 pr-2 text-xs font-mono text-muted-foreground/50">
                  {entry.position}
                </td>
                <td className="py-2.5 pr-2">
                  <span className="text-xs font-mono text-foreground/90">
                    {getDriverName(entry.driver || entry.driver_name || entry.driver_id)}
                  </span>
                </td>
                <td className="py-2.5 px-2 text-xs font-mono text-muted-foreground">
                  {entry.constructor_name}
                </td>
                <td className="py-2.5 px-2 text-right text-xs font-mono text-muted-foreground/70">
                  {entry.q1_time || '-'}
                </td>
                <td className="py-2.5 px-2 text-right text-xs font-mono text-muted-foreground/70">
                  {entry.q2_time || '-'}
                </td>
                <td className="py-2.5 px-2 text-right text-xs font-mono text-muted-foreground/70">
                  {entry.q3_time || '-'}
                </td>
                <td className={`py-2.5 px-2 text-right text-xs font-mono ${
                  entry.position === 1 ? 'text-foreground font-medium' : 'text-muted-foreground'
                }`}>
                  {entry.qualifying_time || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Pole Count renderer
 */
function PoleCountView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver || payload.driver_id)

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">{driverName} - {payload.season} Poles</h3>
      <div className="flex items-center justify-center py-6">
        <div className="text-center">
          <p className="text-4xl font-bold text-foreground">{payload.pole_count ?? 0}</p>
          <p className="text-xs text-muted-foreground mt-2">Pole Positions</p>
        </div>
      </div>
      {payload.races_entered && (
        <p className="text-xs text-muted-foreground text-center">
          From {payload.races_entered} races ({payload.pole_count > 0 ? ((payload.pole_count / payload.races_entered) * 100).toFixed(1) : 0}% pole rate)
        </p>
      )}
    </div>
  )
}

/**
 * Career Pole Count renderer
 */
function CareerPoleCountView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver || payload.driver_id)
  const careerSpan = payload.first_season && payload.last_season
    ? `${payload.first_season}-${payload.last_season}`
    : 'Career'

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-foreground">{driverName} - Career Poles</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">{careerSpan}</span>
      </div>
      <div className="flex items-center justify-center py-6">
        <div className="text-center">
          <p className="text-4xl font-bold text-foreground">{payload.total_poles ?? 0}</p>
          <p className="text-xs text-muted-foreground mt-2">Career Pole Positions</p>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Race Starts" value={payload.total_race_starts ?? 0} />
        <StatCard label="Wins" value={payload.total_wins ?? 0} />
        <StatCard label="Podiums" value={payload.total_podiums ?? 0} />
        <StatCard label="Pole Rate" value={payload.pole_rate_percent !== null ? `${payload.pole_rate_percent}%` : '-'} />
      </div>
      {payload.championships > 0 && (
        <div className="p-3  bg-surface/50 border border-border/30 text-center">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">World Championships</span>
          <p className="text-lg font-medium text-foreground mt-1">{payload.championships}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Q3 Count renderer
 */
function Q3CountView({ payload }: { payload: any }) {
  const driverName = getDriverName(payload.driver || payload.driver_id)

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-foreground">{driverName} - {payload.season} Q3 Appearances</h3>
      <div className="flex items-center justify-center py-6">
        <div className="text-center">
          <p className="text-4xl font-bold text-foreground">{payload.q3_count ?? 0}</p>
          <p className="text-xs text-muted-foreground mt-2">Q3 Appearances</p>
        </div>
      </div>
      {payload.qualifying_sessions && (
        <p className="text-xs text-muted-foreground text-center">
          From {payload.qualifying_sessions} qualifying sessions ({payload.q3_count > 0 ? ((payload.q3_count / payload.qualifying_sessions) * 100).toFixed(1) : 0}% Q3 rate)
        </p>
      )}
    </div>
  )
}

/**
 * Q3 Rankings renderer
 */
function Q3RankingsView({ payload }: { payload: any }) {
  const entries = payload.entries || payload.rankings || []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Q3 Appearances - {payload.season}</h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider w-8">
                #
              </th>
              <th className="text-left text-[11px] font-normal text-muted-foreground pb-2 pr-4 uppercase tracking-wider">
                Driver
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 px-4 uppercase tracking-wider">
                Q3 Count
              </th>
              <th className="text-right text-[11px] font-normal text-muted-foreground pb-2 pl-4 uppercase tracking-wider">
                Sessions
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry: any, i: number) => (
              <tr
                key={`${entry.driver_id}-${i}`}
                className={`border-b border-border/20 ${i % 2 === 0 ? '' : 'bg-surface/30'}`}
              >
                <td className="py-2.5 pr-4 text-xs font-mono text-muted-foreground/50">
                  {i + 1}
                </td>
                <td className="py-2.5 pr-4">
                  <span className="text-xs font-mono text-foreground/90">
                    {getDriverName(entry.driver || entry.driver_id)}
                  </span>
                </td>
                <td className="py-2.5 px-4 text-right text-xs font-mono text-foreground/80">
                  {entry.q3_count}
                </td>
                <td className="py-2.5 pl-4 text-right text-xs font-mono text-muted-foreground">
                  {entry.qualifying_sessions || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Qualifying Gap renderer
 */
function QualifyingGapView({ payload }: { payload: any }) {
  const drivers = payload.drivers as OrderedDriverPair | undefined
  const driverA = drivers?.drivers?.[0] || { id: payload.driver_a_id, name: getDriverName(payload.driver_a_id) }
  const driverB = drivers?.drivers?.[1] || { id: payload.driver_b_id, name: getDriverName(payload.driver_b_id) }

  const winsA = payload.primary_ahead ?? payload.a_ahead ?? 0
  const winsB = payload.secondary_ahead ?? payload.b_ahead ?? 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Qualifying Head-to-Head</h3>
        <span className="text-[10px] font-mono text-muted-foreground/50">{payload.season}</span>
      </div>

      <div className="flex items-center justify-center gap-8 py-4">
        <div className="text-center">
          <p className="text-2xl font-bold text-foreground">{winsA}</p>
          <p className="text-xs text-muted-foreground mt-1">{getDriverName(driverA)}</p>
        </div>
        <div className="text-center">
          <p className="text-lg text-muted-foreground">-</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-foreground">{winsB}</p>
          <p className="text-xs text-muted-foreground mt-1">{getDriverName(driverB)}</p>
        </div>
      </div>

      {payload.avg_gap_percent !== undefined && (
        <div className="p-3  bg-surface/30 border border-border/20 text-center">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
            Average Gap
          </span>
          <p className="text-sm font-mono text-foreground mt-1">
            {formatMetricValue(payload.avg_gap_percent, 'percent')}
          </p>
        </div>
      )}

      <div className="flex justify-center text-xs text-muted-foreground">
        <span>Shared sessions: {payload.shared_sessions ?? payload.shared_events ?? 0}</span>
      </div>

      <CoverageIndicator coverage={payload.coverage} className="mt-4" />
    </div>
  )
}

/**
 * Generic fallback renderer
 */
function GenericResultView({ payload }: { payload: ResultPayload }) {
  return (
    <div className="p-4  bg-surface/30 border border-border/20">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">
        Query Type: {payload.type}
      </span>
      <pre className="mt-2 text-xs font-mono text-muted-foreground overflow-auto max-h-96">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  )
}

/**
 * Stat card component
 */
function StatCard({
  label,
  value,
  subtitle
}: {
  label: string
  value: string | number
  subtitle?: string
}) {
  return (
    <div className="p-3  bg-surface/30 border border-border/20">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">{label}</span>
      <p className="text-lg font-medium text-foreground mt-1">{value}</p>
      {subtitle && (
        <p className="text-[10px] text-muted-foreground/50">{subtitle}</p>
      )}
    </div>
  )
}

/**
 * Coverage indicator component
 */
function CoverageIndicator({ coverage, className }: { coverage?: Coverage; className?: string }) {
  if (!coverage) return null

  const statusColors: Record<string, string> = {
    valid: 'bg-green-500/20 text-green-600',
    low_coverage: 'bg-yellow-500/20 text-yellow-600',
    insufficient: 'bg-red-500/20 text-red-600',
  }

  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      <span className={`px-2 py-0.5 text-[10px] font-mono ${statusColors[coverage.status] || ''}`}>
        {coverage.status.replace('_', ' ')}
      </span>
      <span className="text-[10px] text-muted-foreground/50 font-mono">
        {coverage.sample_size} {coverage.sample_type}
      </span>
    </div>
  )
}

/**
 * Build title from response
 */
function buildTitle(response: NLQueryResponse): string {
  const payload = getPayload(response)
  if (!payload) return response.question

  switch (payload.type) {
    case 'driver_season_summary':
      return `${getDriverName((payload as any).driver || (payload as any).driver_id)} - ${(payload as any).season}`

    case 'season_driver_vs_driver':
    case 'cross_team_track_scoped_driver_comparison': {
      const p = payload as any
      const drivers = p.drivers?.drivers
      const dA = drivers?.[0] || { name: getDriverName(p.driver_a) }
      const dB = drivers?.[1] || { name: getDriverName(p.driver_b) }
      return `${getDriverName(dA)} vs ${getDriverName(dB)}`
    }

    case 'driver_ranking':
    case 'track_fastest_drivers':
      return `Fastest at ${getTrackName((payload as any).track || (payload as any).track_id)}`

    case 'race_results_summary':
      return (payload as any).race_name || `${getTrackName((payload as any).track || (payload as any).track_id)} ${(payload as any).season}`

    case 'teammate_gap_summary_season':
    case 'teammate_gap_dual_comparison': {
      const p = payload as any
      const drivers = p.drivers?.drivers
      const dA = drivers?.[0] || { name: getDriverName(p.driver_primary_id) }
      const dB = drivers?.[1] || { name: getDriverName(p.driver_secondary_id) }
      return `${getDriverName(dA)} vs ${getDriverName(dB)}`
    }

    case 'driver_career_summary':
      return `${getDriverName((payload as any).driver || (payload as any).driver_id)} Career`

    case 'driver_head_to_head_count':
    case 'driver_matchup_lookup': {
      const p = payload as any
      const drivers = p.drivers?.drivers
      const dA = drivers?.[0] || { name: getDriverName(p.driver_primary_id) }
      const dB = drivers?.[1] || { name: getDriverName(p.driver_secondary_id) }
      return `${getDriverName(dA)} vs ${getDriverName(dB)}`
    }

    case 'driver_performance_vector':
      return `${getDriverName((payload as any).driver || (payload as any).driver_id)} Profile`

    case 'driver_multi_comparison':
      return 'Driver Comparison'

    case 'driver_vs_driver_comprehensive': {
      const p = payload as any
      const drivers = p.drivers?.drivers
      const dA = drivers?.[0] || { name: 'Driver A' }
      const dB = drivers?.[1] || { name: 'Driver B' }
      return `${getDriverName(dA)} vs ${getDriverName(dB)}`
    }

    case 'driver_career_wins_by_circuit':
      return `${getDriverName((payload as any).driver)} Wins`

    case 'teammate_comparison_career': {
      const p = payload as any
      const drivers = p.drivers?.drivers
      const dA = drivers?.[0] || { name: 'Driver A' }
      const dB = drivers?.[1] || { name: 'Driver B' }
      return `${getDriverName(dA)} vs ${getDriverName(dB)}`
    }

    case 'qualifying_results_summary':
      return `${getTrackName((payload as any).track || (payload as any).track_name || (payload as any).track_id)} Qualifying`

    case 'driver_pole_count':
      return `${getDriverName((payload as any).driver || (payload as any).driver_id)} Poles`

    case 'driver_career_pole_count':
      return `${getDriverName((payload as any).driver || (payload as any).driver_id)} Career Poles`

    case 'driver_q3_count':
      return `${getDriverName((payload as any).driver || (payload as any).driver_id)} Q3 Appearances`

    case 'season_q3_rankings':
      return 'Q3 Appearances'

    case 'qualifying_gap_teammates':
    case 'qualifying_gap_drivers': {
      const p = payload as any
      const drivers = p.drivers?.drivers
      const dA = drivers?.[0] || { name: getDriverName(p.driver_a_id) }
      const dB = drivers?.[1] || { name: getDriverName(p.driver_b_id) }
      return `${getDriverName(dA)} vs ${getDriverName(dB)}`
    }

    default:
      return response.question
  }
}

/**
 * Build subtitle from response
 */
function buildSubtitle(response: NLQueryResponse): string {
  const payload = getPayload(response)
  const kind = response.query_kind

  if (!payload) return kind || ''

  switch (payload.type) {
    case 'driver_season_summary':
      return 'Season Summary'

    case 'season_driver_vs_driver':
      return `${(payload as any).season} Season Comparison`

    case 'cross_team_track_scoped_driver_comparison':
      return `${getTrackName((payload as any).track || (payload as any).track_id)} ${(payload as any).season}`

    case 'driver_ranking':
    case 'track_fastest_drivers':
      return `${(payload as any).season} Ranking`

    case 'race_results_summary':
      return 'Race Results'

    case 'teammate_gap_summary_season':
      return `${(payload as any).team_id} ${(payload as any).season}`

    case 'teammate_gap_dual_comparison':
      return 'Qualifying vs Race Pace'

    case 'driver_career_summary':
      return 'Career Statistics'

    case 'driver_head_to_head_count':
    case 'driver_matchup_lookup':
      return (payload as any).metric === 'qualifying_position' ? 'Qualifying H2H' : 'Race Finish H2H'

    case 'driver_performance_vector':
      return `${(payload as any).season} Performance Profile`

    case 'driver_multi_comparison':
      return `${(payload as any).season} ${(payload as any).metric}`

    case 'driver_vs_driver_comprehensive':
      return `${(payload as any).season} Season Head-to-Head`

    case 'driver_career_wins_by_circuit':
      return 'Career Wins by Circuit'

    case 'teammate_comparison_career':
      return `Teammate History (${(payload as any).aggregate?.seasons_together ?? 0} seasons)`

    case 'qualifying_results_summary':
      return `${(payload as any).season} Qualifying Grid`

    case 'driver_pole_count':
      return `${(payload as any).season} Season`

    case 'driver_career_pole_count': {
      const p = payload as any
      const careerSpan = p.first_season && p.last_season
        ? `${p.first_season}-${p.last_season}`
        : 'All-time'
      return `Career Statistics (${careerSpan})`
    }

    case 'driver_q3_count':
      return `${(payload as any).season} Season`

    case 'season_q3_rankings':
      return `${(payload as any).season} Season Rankings`

    case 'qualifying_gap_teammates':
      return `${(payload as any).season} Teammate Qualifying`

    case 'qualifying_gap_drivers':
      return `${(payload as any).season} Cross-Team Qualifying`

    default:
      return kind || ''
  }
}

/**
 * Format gap band classification
 */
function formatGapBand(band: string | undefined): string {
  const labels: Record<string, string> = {
    effectively_equal: 'Equal',
    marginal_advantage: 'Marginal',
    meaningful_advantage: 'Meaningful',
    dominant_advantage: 'Dominant',
  }
  return labels[band || ''] || band || 'N/A'
}
