'use client';

import { memo } from 'react';

interface TrustSignalsProps {
  season?: number | string | null;
  normalization?: string | null;
  queryKind?: string | null;
}

/**
 * Data source categorization (from QUERY_CONTRACT.md):
 * - F1DB: Official race/qualifying results, standings, career statistics
 * - Lap Data: Lap-by-lap timing data for pace calculations
 * - Mixed: Combines multiple data sources
 */
const F1DB_QUERY_KINDS = new Set([
  'driver_career_summary',
  'driver_head_to_head_count',
  'driver_matchup_lookup',
  'race_results_summary',
  'driver_pole_count',
  'driver_q3_count',
  'season_q3_rankings',
  'qualifying_gap_drivers',
]);

const LAP_DATA_QUERY_KINDS = new Set([
  'driver_season_summary',
  'driver_trend_summary',
  'driver_performance_vector',
  'driver_multi_comparison',
  'season_driver_vs_driver',
  'cross_team_track_scoped_driver_comparison',
  'teammate_gap_summary_season',
  'teammate_gap_dual_comparison',
  'track_fastest_drivers',
  'qualifying_gap_teammates',
]);

const MIXED_QUERY_KINDS = new Set([
  'driver_profile_summary',
]);

/**
 * Get human-readable normalization label
 */
function getNormalizationLabel(normalization: string | null | undefined): string | null {
  if (!normalization) return null;

  const labels: Record<string, string> = {
    'session_median_percent': 'Session-median normalized',
    'none': 'Raw lap times',
    'raw': 'Raw lap times',
    'team_baseline': 'Team-baseline normalized',
  };

  return labels[normalization] || null;
}

/**
 * Get data source label based on query kind
 */
function getDataSourceLabel(queryKind: string | null | undefined): string | null {
  if (!queryKind) return null;

  if (F1DB_QUERY_KINDS.has(queryKind)) {
    return 'F1DB official records';
  }

  if (LAP_DATA_QUERY_KINDS.has(queryKind)) {
    return 'Lap data';
  }

  if (MIXED_QUERY_KINDS.has(queryKind)) {
    return 'Mixed sources';
  }

  return null;
}

/**
 * Badge component for individual trust signals
 */
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium text-neutral-400 bg-neutral-900/50 border border-neutral-800 rounded">
      {children}
    </span>
  );
}

/**
 * Trust Signals: Always-visible badges showing data context
 * Displayed prominently (not hidden behind "details") so users know the basis of the answer.
 */
export const TrustSignals = memo(function TrustSignals({
  season,
  normalization,
  queryKind,
}: TrustSignalsProps) {
  const seasonLabel = season ? `${season} season` : null;
  const normLabel = getNormalizationLabel(normalization);
  const dataSourceLabel = getDataSourceLabel(queryKind);

  // Don't render if no signals to show
  if (!seasonLabel && !normLabel && !dataSourceLabel) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {seasonLabel && <Badge>{seasonLabel}</Badge>}
      {normLabel && <Badge>{normLabel}</Badge>}
      {dataSourceLabel && <Badge>{dataSourceLabel}</Badge>}
    </div>
  );
});
