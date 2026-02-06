import { memo } from 'react';
import { getRenderer, formatFieldLabel, formatFieldValue, getUnitsForNormalization } from './query-renderers';

interface Interpretation {
  comparison_basis?: string;
  normalization_scope?: string;
  metric_definition?: string;
  confidence?: {
    coverage_level?: string;
    laps_considered?: number;
    notes?: string[];
  };
}

interface ExpandableDetailsProps {
  result: unknown;
  interpretation?: Interpretation | null;
  queryKind: string | null;
}

export const ExpandableDetails = memo(function ExpandableDetails({
  result,
  interpretation,
  queryKind,
}: ExpandableDetailsProps) {
  const renderer = getRenderer(queryKind);

  return (
    <div className="py-4 space-y-6">
      {/* Result data - query-specific fields */}
      {result !== null && result !== undefined && (
        <ResultData result={result} queryKind={queryKind ?? null} renderer={renderer} />
      )}

      {/* Methodology - hidden details for nerds */}
      {interpretation && <MethodologySection interpretation={interpretation} />}
    </div>
  );
});

/**
 * Render result data based on query type
 * Uses the renderer to determine which fields to show
 */
function ResultData({
  result,
  queryKind,
  renderer,
}: {
  result: unknown;
  queryKind: string | null;
  renderer: ReturnType<typeof getRenderer>;
}) {
  if (!result || typeof result !== 'object') return null;

  const r = result as Record<string, unknown>;
  const label = renderer?.detailsLabel || 'Data';
  const fieldsToShow = renderer?.detailsFields || Object.keys(r).slice(0, 8);

  // Special handling for rankings/arrays
  if ('rankings' in r && Array.isArray(r.rankings)) {
    return <RankingsView rankings={r.rankings} label={label} />;
  }

  if ('results' in r && Array.isArray(r.results)) {
    return <RankingsView rankings={r.results} label={label} />;
  }

  // Handle entries array (used by season_q3_rankings, track_fastest_drivers)
  if ('entries' in r && Array.isArray(r.entries)) {
    return <RankingsView rankings={r.entries} label={label} />;
  }

  // Head-to-head specific view
  if ('driver_a_wins' in r && 'driver_b_wins' in r) {
    return <HeadToHeadView data={r} />;
  }

  // Season driver vs driver comparison (normalized pace)
  if (queryKind === 'season_driver_vs_driver' && 'driver_a' in r && 'driver_b' in r) {
    return <SeasonComparisonView data={r} label={label} />;
  }

  // Gap comparison view (teammates, qualifying)
  if (('gap_seconds' in r || 'gap_percent' in r) && 'driver_a_id' in r) {
    return <GapComparisonView data={r} label={label} />;
  }

  // Dual comparison (quali vs race)
  if ('quali_gap_percent' in r && 'race_gap_percent' in r) {
    return <DualGapView data={r} />;
  }

  // Generic field display using renderer config
  const displayFields = fieldsToShow
    .filter((key) => {
      const val = r[key];
      return val !== null && val !== undefined && !Array.isArray(val);
    })
    .slice(0, 6);

  if (displayFields.length === 0) return null;

  return (
    <div>
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        {label}
      </h4>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {displayFields.map((key) => (
          <StatCell
            key={key}
            label={formatFieldLabel(key)}
            value={formatFieldValue(r[key], key)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Rankings/leaderboard view
 */
function RankingsView({
  rankings,
  label,
}: {
  rankings: unknown[];
  label: string;
}) {
  if (rankings.length === 0) return null;

  return (
    <div>
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        {label}
      </h4>
      <div className="space-y-2">
        {rankings.slice(0, 5).map((item, i) => {
          if (typeof item !== 'object' || item === null) return null;
          const entry = item as Record<string, unknown>;
          const driver = entry.driver_id || entry.driver || entry.name;
          const value =
            entry.avg_pace ||
            entry.gap_percent ||
            entry.q3_count ||
            entry.q3_appearances ||
            entry.q3_rate_percent ||
            entry.score ||
            entry.value;

          return (
            <div
              key={i}
              className="flex items-baseline justify-between py-1 border-b border-neutral-800/50 last:border-0"
            >
              <span className="text-sm text-white">
                <span className="text-neutral-500 text-xs mr-2">{i + 1}.</span>
                {String(driver)}
              </span>
              {value !== undefined && (
                <span className="text-xs text-neutral-400 tabular-nums">
                  {typeof value === 'number' ? value.toFixed(3) : String(value)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Head-to-head comparison view
 */
function HeadToHeadView({ data }: { data: Record<string, unknown> }) {
  const driverA = data.driver_a_id || 'Driver A';
  const driverB = data.driver_b_id || 'Driver B';
  const winsA = data.driver_a_wins as number;
  const winsB = data.driver_b_wins as number;
  const ties = data.ties as number | undefined;
  const events = data.shared_events || data.shared_races;

  return (
    <div>
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        Head-to-Head
      </h4>
      <div className="flex items-center justify-between py-2">
        <div className="text-center flex-1">
          <p className="text-xs text-neutral-500 mb-1">{String(driverA)}</p>
          <p className="text-2xl text-white font-bold tabular-nums">{winsA}</p>
        </div>
        <div className="text-neutral-600 text-lg px-3">–</div>
        <div className="text-center flex-1">
          <p className="text-xs text-neutral-500 mb-1">{String(driverB)}</p>
          <p className="text-2xl text-white font-bold tabular-nums">{winsB}</p>
        </div>
      </div>
      <div className="flex justify-center gap-4 mt-2 text-xs text-neutral-500">
        {ties !== undefined && ties > 0 && <span>{String(ties)} ties</span>}
        {events !== undefined && <span>{String(events)} events</span>}
      </div>
    </div>
  );
}

/**
 * Season driver vs driver comparison view (with normalization-aware units)
 */
function SeasonComparisonView({
  data,
  label,
}: {
  data: Record<string, unknown>;
  label: string;
}) {
  const driverA = data.driver_a || 'Driver A';
  const driverB = data.driver_b || 'Driver B';
  const difference = data.difference as number | undefined;
  const driverAValue = data.driver_a_value as number | undefined;
  const driverBValue = data.driver_b_value as number | undefined;
  const sharedRaces = data.shared_races as number | undefined;
  const lapsConsidered = data.laps_considered as number | undefined;
  const normalization = data.normalization as string | undefined;

  // Get proper units for this normalization type
  const units = getUnitsForNormalization(normalization);
  const isPercent = units === '%';

  const formatValue = (v: number) => {
    if (isPercent) {
      return `${v.toFixed(2)}%`;
    }
    return `${v >= 0 ? '+' : ''}${v.toFixed(3)}s`;
  };

  return (
    <div>
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        {label}
      </h4>
      <div className="space-y-3">
        <div className="flex justify-between items-baseline">
          <span className="text-xs text-neutral-500">{String(driverA)} vs {String(driverB)}</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {driverAValue !== undefined && (
            <StatCell
              label={String(driverA)}
              value={formatValue(driverAValue)}
            />
          )}
          {driverBValue !== undefined && (
            <StatCell
              label={String(driverB)}
              value={formatValue(driverBValue)}
            />
          )}
          {difference !== undefined && (
            <StatCell
              label="Difference"
              value={isPercent ? `${Math.abs(difference).toFixed(2)}%` : `${difference >= 0 ? '+' : ''}${difference.toFixed(3)}s`}
            />
          )}
          {sharedRaces !== undefined && (
            <StatCell label="Shared Races" value={String(sharedRaces)} />
          )}
          {lapsConsidered !== undefined && (
            <StatCell label="Laps" value={String(lapsConsidered)} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Gap comparison view (for pace/qualifying comparisons)
 */
function GapComparisonView({
  data,
  label,
}: {
  data: Record<string, unknown>;
  label: string;
}) {
  const driverA = data.driver_a_id || 'Driver A';
  const driverB = data.driver_b_id || 'Driver B';
  const gapSec = data.gap_seconds as number | undefined;
  const gapPct = data.gap_percent as number | undefined;
  const races = data.shared_races || data.sessions_compared;

  return (
    <div>
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        {label}
      </h4>
      <div className="space-y-3">
        <div className="flex justify-between items-baseline">
          <span className="text-xs text-neutral-500">{String(driverA)} vs {String(driverB)}</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {gapSec !== undefined && (
            <StatCell
              label="Gap (time)"
              value={`${gapSec >= 0 ? '+' : ''}${gapSec.toFixed(3)}s`}
            />
          )}
          {gapPct !== undefined && (
            <StatCell
              label="Gap (%)"
              value={`${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}%`}
            />
          )}
          {races !== undefined && <StatCell label="Races" value={String(races)} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Dual gap view (qualifying vs race pace)
 */
function DualGapView({ data }: { data: Record<string, unknown> }) {
  const qualiGap = data.quali_gap_percent as number;
  const raceGap = data.race_gap_percent as number;
  const qualiSec = data.quali_gap_seconds as number | undefined;
  const raceSec = data.race_gap_seconds as number | undefined;

  return (
    <div>
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        Qualifying vs Race
      </h4>
      <div className="grid grid-cols-2 gap-4">
        <div className="p-3 bg-neutral-900/50 rounded">
          <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-2">
            Qualifying
          </p>
          <p className="text-lg text-white font-semibold tabular-nums">
            {qualiGap >= 0 ? '+' : ''}{qualiGap.toFixed(2)}%
          </p>
          {qualiSec !== undefined && (
            <p className="text-xs text-neutral-500 mt-1">
              {qualiSec >= 0 ? '+' : ''}{qualiSec.toFixed(3)}s
            </p>
          )}
        </div>
        <div className="p-3 bg-neutral-900/50 rounded">
          <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-2">
            Race
          </p>
          <p className="text-lg text-white font-semibold tabular-nums">
            {raceGap >= 0 ? '+' : ''}{raceGap.toFixed(2)}%
          </p>
          {raceSec !== undefined && (
            <p className="text-xs text-neutral-500 mt-1">
              {raceSec >= 0 ? '+' : ''}{raceSec.toFixed(3)}s
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Methodology section - technical details for those who want them
 */
function MethodologySection({ interpretation }: { interpretation: Interpretation }) {
  const { comparison_basis, normalization_scope, metric_definition, confidence } = interpretation;

  const hasContent = comparison_basis || normalization_scope || metric_definition || confidence?.notes?.length;
  if (!hasContent) return null;

  return (
    <div className="pt-4 border-t border-neutral-800/50">
      <h4 className="text-[10px] text-neutral-600 uppercase tracking-widest mb-3 font-medium">
        Methodology
      </h4>
      <div className="space-y-2 text-xs text-neutral-500">
        {comparison_basis && (
          <p>
            <span className="text-neutral-600">Basis:</span> {comparison_basis}
          </p>
        )}
        {normalization_scope && (
          <p>
            <span className="text-neutral-600">Normalization:</span> {normalization_scope}
          </p>
        )}
        {metric_definition && (
          <p>
            <span className="text-neutral-600">Metric:</span> {metric_definition}
          </p>
        )}
        {confidence?.notes && confidence.notes.length > 0 && (
          <p>
            <span className="text-neutral-600">Notes:</span> {confidence.notes.join('; ')}
          </p>
        )}
        {confidence?.laps_considered && (
          <p>
            <span className="text-neutral-600">Sample:</span> {confidence.laps_considered} laps
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Simple stat cell component
 */
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-neutral-600 uppercase tracking-wider mb-0.5">
        {label}
      </p>
      <p className="text-base text-white font-medium tabular-nums tracking-tight">
        {value}
      </p>
    </div>
  );
}
