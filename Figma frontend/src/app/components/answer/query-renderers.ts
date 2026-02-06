/**
 * Query Type Registry
 *
 * Maps all 19 backend query kinds to their display configurations.
 * Each query type defines:
 * - extractStat: Pull the ONE primary stat to show as headline
 * - formatStat: How to display the stat (with units, sign, etc.)
 * - detailsLabel: What to call the expandable section
 * - detailsFields: Which fields to show in expanded view
 */

/**
 * Frontend capability gate: only these query kinds have full UI support.
 * Queries outside this list will show a graceful fallback with raw JSON.
 *
 * All 19 backend query kinds are now supported:
 * - Driver summaries: career, season, profile, trend
 * - Comparisons: season vs, track-scoped, head-to-head, multi
 * - Teammate gaps: season, dual (quali vs race)
 * - Qualifying: pole count, q3 count, rankings, gaps
 * - Rankings: track fastest, q3 rankings
 * - Results: race results, matchup lookup
 */
export const FRONTEND_SUPPORTED_KINDS = [
  // Driver Summaries
  'driver_career_summary',
  'driver_season_summary',
  'driver_profile_summary',
  'driver_trend_summary',
  'driver_performance_vector',

  // Cross-team Comparisons
  'season_driver_vs_driver',
  'cross_team_track_scoped_driver_comparison',
  'driver_multi_comparison',

  // Teammate Comparisons
  'teammate_gap_summary_season',
  'teammate_gap_dual_comparison',

  // Head-to-Head
  'driver_head_to_head_count',
  'driver_matchup_lookup',

  // Qualifying Stats
  'driver_pole_count',
  'driver_q3_count',
  'season_q3_rankings',
  'qualifying_gap_teammates',
  'qualifying_gap_drivers',

  // Rankings
  'track_fastest_drivers',

  // Race Results
  'race_results_summary',
] as const;

export type SupportedQueryKind = typeof FRONTEND_SUPPORTED_KINDS[number];

/**
 * Check if a query kind is fully supported by the frontend UI
 */
export function isQueryKindSupported(queryKind: string | null): boolean {
  if (!queryKind) return false;
  return (FRONTEND_SUPPORTED_KINDS as readonly string[]).includes(queryKind);
}

/**
 * Normalization units mapping: what unit suffix to display for each normalization type
 */
export const NORMALIZATION_UNITS: Record<string, string> = {
  'session_median_percent': '%',
  'none': 's',
  'raw': 's',
  'team_baseline': '%',
};

/**
 * Get the unit suffix for a normalization type.
 * Throws an explicit error for unknown values to catch mismatches early.
 */
export function getUnitsForNormalization(normalization: string | null | undefined): string {
  if (!normalization) {
    return '%'; // Default to percent for undefined (most common case)
  }
  const units = NORMALIZATION_UNITS[normalization];
  if (units === undefined) {
    throw new Error(`Unknown normalization type: '${normalization}'. Expected one of: ${Object.keys(NORMALIZATION_UNITS).join(', ')}`);
  }
  return units;
}

export interface QueryRenderer {
  extractStat: (payload: Record<string, unknown>) => string | number | null;
  formatStat: (value: string | number) => string;
  detailsLabel: string;
  detailsFields: string[];
}

// Helper formatters
const formatPercent = (v: string | number) => {
  const n = Number(v);
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
};

// For absolute gap values (no sign needed - context from headline)
const formatPercentAbs = (v: string | number) => {
  const n = Math.abs(Number(v));
  return `${n.toFixed(2)}%`;
};

const formatSeconds = (v: string | number) => {
  const n = Number(v);
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(3)}s`;
};

// For absolute gap values in seconds (exported for potential external use)
export const formatSecondsAbs = (v: string | number) => {
  const n = Math.abs(Number(v));
  return `${n.toFixed(3)}s`;
};

const formatHeadToHead = (v: string | number) => String(v);
const formatCount = (v: string | number) => String(v);

// Registry of all 19 query kinds
export const queryRenderers: Record<string, QueryRenderer> = {
  // Race/Event Results
  race_results_summary: {
    extractStat: (p) => p.winner_name as string || p.winner as string || null,
    formatStat: (v) => String(v),
    detailsLabel: 'Race Results',
    detailsFields: ['winner', 'winner_name', 'podium', 'fastest_lap', 'pole_sitter', 'total_laps'],
  },

  // Driver Summaries
  driver_career_summary: {
    extractStat: (p) => p.career_wins as number ?? p.championships as number ?? null,
    formatStat: formatCount,
    detailsLabel: 'Career Stats',
    detailsFields: ['championships', 'career_wins', 'career_podiums', 'seasons_raced'],
  },

  driver_season_summary: {
    extractStat: (p) => p.wins as number ?? null,
    formatStat: formatCount,
    detailsLabel: 'Season Stats',
    detailsFields: ['wins', 'podiums', 'dnfs', 'race_count', 'avg_race_pace', 'laps_considered'],
  },

  driver_profile_summary: {
    extractStat: (p) => p.wins as number ?? null,
    formatStat: formatCount,
    detailsLabel: 'Profile',
    detailsFields: ['team', 'nationality', 'wins', 'podiums', 'championships'],
  },

  driver_trend_summary: {
    extractStat: (p) => p.trend_direction as string ?? p.avg_position_change as number ?? null,
    formatStat: (v) => typeof v === 'number' ? formatPercent(v) : String(v),
    detailsLabel: 'Performance Trend',
    detailsFields: ['trend_direction', 'recent_avg', 'season_avg', 'position_change'],
  },

  // Cross-team Comparisons (season-wide)
  season_driver_vs_driver: {
    // Backend returns: difference (in percent), driver_a_value, driver_b_value
    extractStat: (p) => {
      const diff = p.difference as number;
      if (diff !== undefined && diff !== null) {
        return Math.abs(diff); // Always show positive, context comes from headline
      }
      return null;
    },
    formatStat: formatPercentAbs,
    detailsLabel: 'Comparison',
    detailsFields: ['driver_a', 'driver_b', 'difference', 'shared_races', 'driver_a_value', 'driver_b_value', 'laps_considered'],
  },

  // Track-scoped Comparisons
  cross_team_track_scoped_driver_comparison: {
    extractStat: (p) => p.gap_seconds as number ?? p.gap_percent as number ?? null,
    formatStat: (v) => {
      const n = Number(v);
      // If it looks like seconds (small number), format as seconds
      return Math.abs(n) < 10 ? formatSeconds(v) : formatPercent(v);
    },
    detailsLabel: 'Track Comparison',
    detailsFields: ['track_id', 'driver_a_avg', 'driver_b_avg', 'gap_seconds', 'laps_compared'],
  },

  track_fastest_drivers: {
    extractStat: (p) => {
      const rankings = p.rankings as unknown[] | undefined;
      if (rankings?.[0] && typeof rankings[0] === 'object') {
        return (rankings[0] as Record<string, unknown>).driver_id as string;
      }
      return p.fastest_driver as string ?? null;
    },
    formatStat: (v) => String(v),
    detailsLabel: 'Track Rankings',
    detailsFields: ['rankings', 'track_id', 'session_scope', 'metric'],
  },

  // Teammate Comparisons
  teammate_gap_summary_season: {
    // Backend returns: gap_pct_abs, gap_pct, gap_seconds_abs, gap_seconds
    extractStat: (p) => {
      const gapPctAbs = p.gap_pct_abs as number;
      if (gapPctAbs !== undefined && gapPctAbs !== null) {
        return gapPctAbs; // Use absolute value - context comes from headline
      }
      const gapSecondsAbs = p.gap_seconds_abs as number;
      if (gapSecondsAbs !== undefined && gapSecondsAbs !== null) {
        return gapSecondsAbs;
      }
      return null;
    },
    formatStat: formatPercentAbs,
    detailsLabel: 'Teammate Gap',
    detailsFields: ['driver_primary_id', 'driver_secondary_id', 'gap_pct', 'gap_seconds', 'shared_races', 'team_id', 'gap_band'],
  },

  teammate_gap_dual_comparison: {
    extractStat: (p) => p.quali_gap_percent as number ?? p.race_gap_percent as number ?? null,
    formatStat: formatPercent,
    detailsLabel: 'Quali vs Race',
    detailsFields: ['quali_gap_percent', 'race_gap_percent', 'quali_gap_seconds', 'race_gap_seconds', 'shared_races'],
  },

  // Qualifying Stats
  driver_pole_count: {
    extractStat: (p) => p.pole_count as number ?? null,
    formatStat: formatCount,
    detailsLabel: 'Pole Stats',
    detailsFields: ['pole_count', 'fastest_time_count', 'total_sessions', 'pole_rate_percent', 'front_row_count', 'avg_grid_position'],
  },

  driver_q3_count: {
    extractStat: (p) => p.q3_appearances as number ?? p.q3_count as number ?? null,
    formatStat: formatCount,
    detailsLabel: 'Q3 Stats',
    detailsFields: ['q3_appearances', 'q2_eliminations', 'q1_eliminations', 'total_sessions', 'q3_rate_percent', 'avg_qualifying_position'],
  },

  season_q3_rankings: {
    extractStat: (p) => {
      // Backend returns entries array
      const entries = p.entries as unknown[] | undefined;
      if (entries?.[0] && typeof entries[0] === 'object') {
        return (entries[0] as Record<string, unknown>).driver_id as string;
      }
      // Fallback to rankings
      const rankings = p.rankings as unknown[] | undefined;
      if (rankings?.[0] && typeof rankings[0] === 'object') {
        return (rankings[0] as Record<string, unknown>).driver_id as string;
      }
      return null;
    },
    formatStat: (v) => String(v),
    detailsLabel: 'Q3 Rankings',
    detailsFields: ['entries', 'rankings', 'season', 'total_drivers'],
  },

  qualifying_gap_teammates: {
    extractStat: (p) => p.gap_seconds as number ?? p.gap_percent as number ?? null,
    formatStat: formatSeconds,
    detailsLabel: 'Qualifying Gap',
    detailsFields: ['driver_a_id', 'driver_b_id', 'gap_seconds', 'gap_percent', 'sessions_compared', 'team'],
  },

  qualifying_gap_drivers: {
    extractStat: (p) => p.gap_seconds as number ?? p.gap_percent as number ?? null,
    formatStat: formatSeconds,
    detailsLabel: 'Qualifying Gap',
    detailsFields: ['driver_a_id', 'driver_b_id', 'gap_seconds', 'gap_percent', 'sessions_compared'],
  },

  // Head-to-Head
  driver_head_to_head_count: {
    extractStat: (p) => {
      const a = p.driver_a_wins as number;
      const b = p.driver_b_wins as number;
      if (a !== undefined && b !== undefined) {
        return `${a}–${b}`;
      }
      return null;
    },
    formatStat: formatHeadToHead,
    detailsLabel: 'Head-to-Head',
    detailsFields: ['driver_a_id', 'driver_b_id', 'driver_a_wins', 'driver_b_wins', 'ties', 'shared_events'],
  },

  // Advanced/Multi-driver
  driver_performance_vector: {
    extractStat: (p) => p.overall_score as number ?? p.pace_score as number ?? null,
    formatStat: (v) => Number(v).toFixed(1),
    detailsLabel: 'Performance Vector',
    detailsFields: ['pace_score', 'consistency_score', 'qualifying_score', 'racecraft_score', 'overall_score'],
  },

  driver_multi_comparison: {
    extractStat: (p) => {
      const results = p.results as unknown[] | undefined;
      if (results?.[0] && typeof results[0] === 'object') {
        return (results[0] as Record<string, unknown>).driver_id as string;
      }
      return null;
    },
    formatStat: (v) => String(v),
    detailsLabel: 'Multi-Driver Comparison',
    detailsFields: ['results', 'metric', 'season'],
  },

  driver_matchup_lookup: {
    extractStat: (p) => {
      const a = p.driver_a_wins as number;
      const b = p.driver_b_wins as number;
      if (a !== undefined && b !== undefined) {
        return `${a}–${b}`;
      }
      return p.result as string ?? null;
    },
    formatStat: formatHeadToHead,
    detailsLabel: 'Matchup',
    detailsFields: ['driver_a_id', 'driver_b_id', 'driver_a_wins', 'driver_b_wins', 'context'],
  },
};

/**
 * Get the primary stat for display as headline number
 */
export function extractPrimaryStat(
  payload: unknown,
  queryKind: string | null
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (!queryKind) return null;

  const renderer = queryRenderers[queryKind];
  if (!renderer) return null;

  const p = payload as Record<string, unknown>;
  const rawValue = renderer.extractStat(p);

  if (rawValue === null || rawValue === undefined) return null;

  return renderer.formatStat(rawValue);
}

/**
 * Get renderer config for a query kind
 */
export function getRenderer(queryKind: string | null): QueryRenderer | null {
  if (!queryKind) return null;
  return queryRenderers[queryKind] || null;
}

/**
 * Format field labels for display
 */
export function formatFieldLabel(key: string): string {
  return key
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format any field value for display
 */
export function formatFieldValue(value: unknown, key: string): string {
  if (value === null || value === undefined) return '—';

  if (typeof value === 'number') {
    // Percent fields
    if (key.includes('percent') || key.includes('rate')) {
      const sign = value >= 0 ? '+' : '';
      return `${sign}${value.toFixed(2)}%`;
    }
    // Time/gap fields
    if (key.includes('seconds') || key.includes('gap') && !key.includes('percent')) {
      const sign = value >= 0 ? '+' : '';
      return `${sign}${value.toFixed(3)}s`;
    }
    // Averages
    if (key.includes('avg') || key.includes('average')) {
      return value.toFixed(2);
    }
    // Counts
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  if (Array.isArray(value)) {
    return `${value.length} items`;
  }

  return String(value);
}
