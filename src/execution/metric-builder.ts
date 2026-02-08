import { Metric, MetricScope, MetricUnits, DataSource } from '../types/semantic';

/**
 * MetricBuilder - Factory for creating self-describing Metric objects.
 *
 * Use this to wrap all numeric values in responses with proper labels, units, and context.
 * The frontend should never have to guess what a number means.
 */
export const MetricBuilder = {
  /**
   * Build a generic metric with all fields specified.
   */
  build<T = number>(params: {
    key: string;
    label: string;
    value: T;
    scope?: MetricScope;
    units?: MetricUnits;
    source?: DataSource;
  }): Metric<T> {
    return { ...params };
  },

  // ==========================================
  // Count Metrics (F1DB sourced)
  // ==========================================

  /**
   * Race wins count
   */
  wins: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'wins',
      label: 'Wins',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Podium finishes count
   */
  podiums: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'podiums',
      label: 'Podiums',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * DNF (Did Not Finish) count
   */
  dnfs: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'dnfs',
      label: 'DNFs',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Championship titles count
   */
  championships: (value: number): Metric<number> =>
    MetricBuilder.build({
      key: 'championships',
      label: 'Championships',
      value,
      scope: { type: 'career' },
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Pole positions count
   */
  poles: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'poles',
      label: 'Poles',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Seasons raced count
   */
  seasonsRaced: (value: number): Metric<number> =>
    MetricBuilder.build({
      key: 'seasons_raced',
      label: 'Seasons',
      value,
      scope: { type: 'career' },
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Race count (number of races in scope)
   */
  raceCount: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'race_count',
      label: 'Races',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Shared races between drivers
   */
  sharedRaces: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'shared_races',
      label: 'Shared Races',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Shared events count (for head-to-head)
   */
  sharedEvents: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'shared_events',
      label: 'Shared Events',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Laps considered in analysis
   */
  lapsConsidered: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'laps_considered',
      label: 'Laps Analyzed',
      value,
      scope,
      units: 'count',
      source: 'Lap Data',
    }),

  // ==========================================
  // Percentage Metrics (Lap Data sourced)
  // ==========================================

  /**
   * Pace gap as percentage (negative = faster)
   */
  gapPercent: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'gap_percent',
      label: 'Pace Gap',
      value,
      scope,
      units: 'percent',
      source: 'Lap Data',
    }),

  /**
   * Symmetric percent difference (track-length invariant)
   */
  gapPct: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'gap_pct',
      label: 'Gap',
      value,
      scope,
      units: 'percent',
      source: 'Lap Data',
    }),

  /**
   * Normalized pace value (session median percent)
   */
  normalizedPace: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'normalized_pace',
      label: 'Normalized Pace',
      value,
      scope,
      units: 'percent',
      source: 'Lap Data',
    }),

  // ==========================================
  // Time Metrics (Lap Data sourced)
  // ==========================================

  /**
   * Pace gap in seconds (negative = faster)
   */
  gapSeconds: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'gap_seconds',
      label: 'Time Gap',
      value,
      scope,
      units: 'seconds',
      source: 'Lap Data',
    }),

  /**
   * Absolute lap time in seconds (for P1 in rankings)
   * Frontend should format as MM:SS.sss
   */
  lapTime: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'lap_time',
      label: 'Lap Time',
      value,
      scope,
      units: 'lap_time',
      source: 'Lap Data',
    }),

  /**
   * Average race pace in seconds
   */
  avgRacePace: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'avg_race_pace',
      label: 'Avg Race Pace',
      value,
      scope,
      units: 'seconds',
      source: 'Lap Data',
    }),

  // ==========================================
  // Position Metrics
  // ==========================================

  /**
   * Average position (lower is better)
   */
  avgPosition: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'avg_position',
      label: 'Avg Position',
      value,
      scope,
      units: 'positions',
      source: 'F1DB',
    }),

  /**
   * Position gap between drivers
   */
  positionGap: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'position_gap',
      label: 'Position Gap',
      value,
      scope,
      units: 'positions',
      source: 'F1DB',
    }),

  // ==========================================
  // Percentile Metrics (Computed)
  // ==========================================

  /**
   * Qualifying percentile rank (100 = fastest)
   */
  qualifyingPercentile: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'qualifying_percentile',
      label: 'Qualifying Rank',
      value,
      scope,
      units: 'percentile',
      source: 'Computed',
    }),

  /**
   * Race pace percentile rank (100 = fastest)
   */
  racePacePercentile: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'race_pace_percentile',
      label: 'Race Pace Rank',
      value,
      scope,
      units: 'percentile',
      source: 'Computed',
    }),

  /**
   * Consistency score (100 = most consistent)
   */
  consistencyScore: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'consistency_score',
      label: 'Consistency',
      value,
      scope,
      units: 'percentile',
      source: 'Computed',
    }),

  // ==========================================
  // Head-to-Head Metrics
  // ==========================================

  /**
   * Head-to-head win count
   */
  h2hWins: (value: number, driverName: string, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'h2h_wins',
      label: `${driverName} Wins`,
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),

  /**
   * Ties in head-to-head comparison
   */
  h2hTies: (value: number, scope: MetricScope): Metric<number> =>
    MetricBuilder.build({
      key: 'h2h_ties',
      label: 'Ties',
      value,
      scope,
      units: 'count',
      source: 'F1DB',
    }),
};
