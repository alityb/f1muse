/**
 * Semantic Types for F1Muse Presentation Layer
 *
 * These types ensure self-describing, context-rich data flows from backend to frontend.
 * No raw IDs or naked numbers should leak to the UI.
 */

/**
 * Self-describing driver reference - never expose raw IDs
 */
export interface DriverRef {
  /** Internal identifier: max_verstappen */
  id: string;
  /** Display name: Max Verstappen */
  name: string;
  /** Abbreviation: VER (optional) */
  short_name?: string;
}

/**
 * Scope context for a metric
 */
export type MetricScope =
  | { type: 'career' }
  | { type: 'season'; year: number }
  | { type: 'track'; track_id: string; track_name?: string }
  | { type: 'session'; session_type: string; season: number };

/**
 * Units for metric values
 */
export type MetricUnits = 'count' | 'percent' | 'seconds' | 'positions' | 'percentile' | 'lap_time';

/**
 * Data source provenance
 */
export type DataSource = 'F1DB' | 'Lap Data' | 'Computed';

/**
 * Self-describing metric with context
 *
 * Every number in the response should be wrapped in this type so the frontend
 * never has to guess what a value means or how to format it.
 */
export interface Metric<T = number> {
  /** Machine key: wins, gap_percent */
  key: string;
  /** Display label: Wins, Pace Gap */
  label: string;
  /** The actual value */
  value: T;
  /** Context: career, season_2024, track-scoped */
  scope?: MetricScope;
  /** Units: count, percent, seconds */
  units?: MetricUnits;
  /** Provenance: F1DB, Lap Data, Computed */
  source?: DataSource;
}

/**
 * Ordered driver pair preserving user intent
 *
 * If user says "Compare A to B", we preserve that order even if SQL returns B vs A.
 */
export interface OrderedDriverPair {
  /** Tuple of exactly two drivers in user-specified order */
  drivers: [DriverRef, DriverRef];
  /** How the order was determined */
  order_source: 'user_query' | 'alphabetic';
}

/**
 * Coverage information for statistical reliability
 */
export interface Coverage {
  /** Coverage classification */
  status: 'valid' | 'low_coverage' | 'insufficient';
  /** Number of data points */
  sample_size: number;
  /** What the sample represents */
  sample_type: 'races' | 'laps' | 'sessions' | 'events';
}

/**
 * Track reference with full context
 */
export interface TrackRef {
  /** Internal identifier: monza, monaco */
  id: string;
  /** Display name: Monza, Monaco */
  name: string;
  /** Full circuit name: Autodromo Nazionale Monza */
  circuit_name?: string;
}

/**
 * Team/constructor reference
 */
export interface TeamRef {
  /** Internal identifier: mclaren, red_bull */
  id: string;
  /** Display name: McLaren, Red Bull Racing */
  name: string;
  /** Short name: MCL, RBR */
  short_name?: string;
}

/**
 * Type guard to check if a value is a Metric
 */
export function isMetric<T>(value: unknown): value is Metric<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    'label' in value &&
    'value' in value
  );
}

/**
 * Type guard to check if a value is a DriverRef
 */
export function isDriverRef(value: unknown): value is DriverRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value &&
    typeof (value as DriverRef).id === 'string' &&
    typeof (value as DriverRef).name === 'string'
  );
}
