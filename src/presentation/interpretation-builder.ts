import { Pool } from 'pg';
import { QueryExecutor } from '../execution/query-executor';
import { DriverResolver } from '../identity/driver-resolver';
import { QueryIntent } from '../types/query-intent';
import { AnalyticalResponse } from '../types/api-response';
import {
  QueryResult,
  QueryError,
  SeasonDriverSummaryPayload,
  SeasonDriverVsDriverPayload,
  DriverRankingPayload,
  CrossTeamTrackScopedDriverComparisonPayload,
  TeammateGapSummarySeasonPayload,
  TeammateGapDualComparisonPayload,
  DriverCareerSummaryPayload,
  RaceResultsSummaryPayload
} from '../types/results';
import { TEAMMATE_GAP_THRESHOLDS } from '../config/teammate-gap';

export type FallbackReason =
  | 'insufficient_shared_laps'
  | 'driver_not_in_season'
  | 'no_teammate_overlap'
  | 'low_coverage_sample';

export interface FallbackStep {
  reason: FallbackReason;
  from_kind: string;
  to_kind: string;
  note: string;
}

export type CoverageLevel = 'high' | 'moderate' | 'weak' | 'insufficient';

export interface AnswerCoverage {
  level: CoverageLevel;
  summary: string;
}

export interface BuiltAnswer {
  query_kind: string;
  headline: string;
  bullets: string[];
  coverage: AnswerCoverage;
  followups: string[];
  fallbacks?: FallbackStep[];
}

export interface InterpretationBuilderInput {
  pool: Pool;
  executor: QueryExecutor;
  intent: QueryIntent;
  raw_question?: string;
}

export interface InterpretationBuilderOutput {
  intent: QueryIntent;
  result: QueryResult | QueryError;
  answer: BuiltAnswer;
  fallbacks: FallbackStep[];
  supplemental_results?: QueryResult[];
  canonical_response?: AnalyticalResponse<TeammateGapDualComparisonPayload>;
}

type MetricIntent = Exclude<QueryIntent, { kind: 'race_results_summary' }>;

const INTEGER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const TEAMMATE_GAP_MIN_SHARED_RACES = TEAMMATE_GAP_THRESHOLDS.low_coverage_shared_races;

function formatInt(value: number): string {
  return INTEGER_FORMATTER.format(Math.round(value));
}

function formatDecimal(value: number): string {
  return value.toFixed(3);
}

function formatSignedDecimal(value: number): string {
  let sign = '';
  if (value > 0) { sign = '+'; }
  else if (value < 0) { sign = '-'; }
  return `${sign}${formatDecimal(Math.abs(value))}`;
}

function humanizeId(value: string): string {
  if (!value) {
    return value;
  }
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(part => part.length > 0)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

type TeammateGapDiagnosticReason =
  | 'no_row'
  | 'gap_null'
  | 'low_shared_races'
  | 'failure_reason'
  | 'unknown';

interface TeammateGapDiagnostics {
  reason: TeammateGapDiagnosticReason;
  shared_races?: number;
}

function resolveCoverageLevel(level: string | undefined): CoverageLevel {
  switch (level) {
    case 'high':
      return 'high';
    case 'moderate':
      return 'moderate';
    case 'low':
      return 'weak';
    case 'insufficient':
      return 'insufficient';
    default:
      return 'insufficient';
  }
}

function coverageSummary(label: string, count: number, level: CoverageLevel): AnswerCoverage {
  return {
    level,
    summary: `${label}: ${formatInt(count)} (${level})`
  };
}

function compoundSummary(intent: MetricIntent): string {
  const scope = intent.session_scope || 'race';
  const mix = intent.compound_context === 'per_compound' ? 'per-compound' : 'mixed';
  return `${scope}-${mix}`;
}

function overlapPercent(lapsA: number, lapsB: number): number {
  const maxLaps = Math.max(lapsA, lapsB);
  if (maxLaps === 0) {
    return 0;
  }
  return Math.round((Math.min(lapsA, lapsB) / maxLaps) * 100);
}

function determineFasterDriver(delta: number, driverA: string, driverB: string): string | null {
  if (delta === 0) {
    return null;
  }
  return delta < 0 ? driverA : driverB;
}

function buildFailClosedAnswer(intent: QueryIntent, fallbacks: FallbackStep[]): BuiltAnswer {
  return {
    query_kind: intent.kind,
    headline: 'Coverage is limited for this scope',
    bullets: [
      'Only confirmed results are reported',
      'Try a different season, track, or driver pair'
    ],
    coverage: {
      level: 'insufficient',
      summary: 'Coverage: limited'
    },
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

async function loadTeammateGapDiagnostics(
  pool: Pool,
  intent: Extract<QueryIntent, { kind: 'teammate_gap_summary_season' }>
): Promise<TeammateGapDiagnostics> {
  const driverA = intent.driver_a_id;
  const driverB = intent.driver_b_id;

  if (!driverA || !driverB) {
    return { reason: 'unknown' };
  }

  let result;
  try {
    result = await pool.query(
      `
      SELECT
        COALESCE(gap_percent, driver_pair_gap_percent) AS gap_percent,
        driver_pair_gap_seconds,
        shared_races,
        failure_reason
      FROM teammate_gap_season_summary_2025
      WHERE season = $1
        AND (
          (driver_primary_id = $2 AND driver_secondary_id = $3)
          OR (driver_primary_id = $3 AND driver_secondary_id = $2)
        )
      LIMIT 1
      `,
      [intent.season, driverA, driverB]
    );
  } catch {
    return { reason: 'unknown' };
  }

  if (result.rows.length === 0) {
    return { reason: 'no_row' };
  }

  const row = result.rows[0];
  const sharedRacesRaw = row.shared_races;
  let sharedRacesParsed: number;
  if (typeof sharedRacesRaw === 'number') {
    sharedRacesParsed = sharedRacesRaw;
  } else if (sharedRacesRaw) {
    sharedRacesParsed = parseInt(sharedRacesRaw, 10);
  } else {
    sharedRacesParsed = NaN;
  }
  const sharedRaces = Number.isFinite(sharedRacesParsed) ? sharedRacesParsed : undefined;

  const failureReason = typeof row.failure_reason === 'string' ? row.failure_reason.trim() : '';
  if (failureReason) {
    return { reason: 'failure_reason', shared_races: sharedRaces };
  }

  if (sharedRaces !== undefined && sharedRaces < TEAMMATE_GAP_MIN_SHARED_RACES) {
    return { reason: 'low_shared_races', shared_races: sharedRaces };
  }

  if (row.gap_percent === null || row.gap_percent === undefined) {
    return { reason: 'gap_null', shared_races: sharedRaces };
  }

  return { reason: 'unknown', shared_races: sharedRaces };
}

function buildTeammateGapDiagnosticAnswer(
  intent: Extract<QueryIntent, { kind: 'teammate_gap_summary_season' }>,
  diagnostics: TeammateGapDiagnostics,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driverA = intent.driver_a_id ? humanizeId(intent.driver_a_id) : 'the driver';
  const driverB = intent.driver_b_id ? humanizeId(intent.driver_b_id) : 'the teammate';
  const pairLabel = intent.driver_a_id && intent.driver_b_id
    ? `${driverA} and ${driverB}`
    : 'the driver pair';

  // User-facing transparency copy for insufficient data
  const transparencyCopy = 'Teammate gaps are reported only when drivers share enough representative races.';

  let bullets: string[] = [];
  let summary = 'Coverage: limited';

  switch (diagnostics.reason) {
    case 'no_row':
      bullets = [
        `No season-level teammate gap is available for ${pairLabel} in ${intent.season}.`,
        transparencyCopy
      ];
      summary = 'Coverage: no season-level gap available';
      break;
    case 'low_shared_races': {
      const sharedRaces = diagnostics.shared_races ?? 0;
      bullets = [
        `Shared races did not meet reliability threshold (${formatInt(sharedRaces)} of ${TEAMMATE_GAP_MIN_SHARED_RACES} minimum).`,
        transparencyCopy
      ];
      summary = 'Coverage: shared races below threshold';
      break;
    }
    case 'gap_null':
      bullets = [
        `Season-level teammate gap is not available for ${pairLabel} in ${intent.season}.`,
        transparencyCopy
      ];
      summary = 'Coverage: gap value not available';
      break;
    case 'failure_reason':
      bullets = [
        `Coverage is limited for ${pairLabel} in ${intent.season}.`,
        transparencyCopy
      ];
      summary = 'Coverage: limited for this pair';
      break;
    default:
      bullets = [
        `Coverage is limited for ${pairLabel} in ${intent.season}.`,
        transparencyCopy
      ];
      summary = 'Coverage: limited';
      break;
  }

  return {
    query_kind: intent.kind,
    headline: 'Coverage is limited for this scope',
    bullets,
    coverage: {
      level: 'insufficient',
      summary
    },
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function buildFollowups(intent: QueryIntent): string[] {
  switch (intent.kind) {
    case 'cross_team_track_scoped_driver_comparison':
      return [
        `Compare them over the full ${intent.season} season`,
        `Show only clean air laps at ${humanizeId(intent.track_id)} ${intent.season}`,
        `Show ${humanizeId(intent.driver_a_id)} season summary`
      ];

    case 'season_driver_vs_driver':
      return [
        `Compare them at a specific track in ${intent.season}`,
        `Show ${humanizeId(intent.driver_a_id)} season summary`,
        `Show ${humanizeId(intent.driver_b_id)} season summary`
      ];

    case 'driver_season_summary':
      return [
        `Compare ${humanizeId(intent.driver_id)} to another driver in ${intent.season}`,
        `Compare ${humanizeId(intent.driver_id)} at a specific track`,
        `Show ${humanizeId(intent.driver_id)} career summary`
      ];

    case 'driver_career_summary':
      return [
        `Show ${humanizeId(intent.driver_id)} season summary`,
        `Compare ${humanizeId(intent.driver_id)} to another driver`,
        `Compare ${humanizeId(intent.driver_id)} at a specific track`
      ];

    case 'teammate_gap_summary_season': {
      const primaryLabel = intent.driver_a_id ? humanizeId(intent.driver_a_id) : 'the driver';
      return [
        `Compare them over the full ${intent.season} season`,
        `Compare them at a specific track in ${intent.season}`,
        `Show ${primaryLabel} season summary`
      ];
    }

    case 'track_fastest_drivers':
      return [
        `Compare two drivers at ${humanizeId(intent.track_id)} ${intent.season}`,
        `Show clean air laps only`,
        `Compare to another track in ${intent.season}`
      ];

    case 'race_results_summary':
      return [
        `Compare drivers' pace at ${humanizeId(intent.track_id)} ${intent.season}`,
        `Show fastest drivers at ${humanizeId(intent.track_id)}`,
        `Show other race results from ${intent.season}`
      ];

    default:
      return [
        'Compare two drivers over a season',
        'Compare two drivers at a specific track',
        'Show a driver season summary'
      ];
  }
}

function withDefaults(intent: MetricIntent): MetricIntent {
  const updated: any = { ...intent };

  if (!updated.metric) {
    if (intent.kind === 'teammate_gap_summary_season') {
      updated.metric = 'teammate_gap_raw';
    } else {
      updated.metric = 'avg_true_pace';
    }
  }

  if (!updated.normalization) {
    if (intent.kind === 'teammate_gap_summary_season') {
      updated.normalization = 'team_baseline';
    } else {
      updated.normalization = 'none';
    }
  }

  if (updated.clean_air_only === undefined || updated.clean_air_only === null) {
    updated.clean_air_only = false;
  }

  if (!updated.compound_context) {
    updated.compound_context = 'mixed';
  }

  if (!updated.session_scope) {
    // Track queries and season pace queries both use 'race' to match pre-computed data
    updated.session_scope = 'race';
  }

  return updated as MetricIntent;
}

function buildSeasonComparisonIntent(base: MetricIntent): MetricIntent {
  return withDefaults({
    kind: 'season_driver_vs_driver',
    driver_a_id: (base as any).driver_a_id,
    driver_b_id: (base as any).driver_b_id,
    season: base.season,
    metric: 'avg_true_pace',
    normalization: 'none',
    clean_air_only: false,
    compound_context: 'mixed',
    session_scope: 'all',
    raw_query: base.raw_query
  } as MetricIntent);
}

async function getLatestSeasonForDriver(pool: Pool, driverId: string): Promise<number | null> {
  const result = await pool.query(
    `
    SELECT MAX(year) AS season
    FROM (
      SELECT year FROM season_entrant_driver
      WHERE driver_id = $1 AND test_driver IS NOT TRUE
      UNION
      SELECT year FROM driver_season_entries
      WHERE driver_id = $1
    ) seasons
    `,
    [driverId]
  );

  const season = result.rows[0]?.season;
  return season === null || season === undefined ? null : parseInt(season, 10);
}

async function isDriverActiveInSeason(pool: Pool, driverId: string, season: number): Promise<boolean> {
  const result = await pool.query(
    `
    SELECT 1
    FROM (
      SELECT 1 FROM season_entrant_driver
      WHERE driver_id = $1 AND year = $2 AND test_driver IS NOT TRUE
      UNION
      SELECT 1 FROM driver_season_entries
      WHERE driver_id = $1 AND year = $2
    ) active
    LIMIT 1
    `,
    [driverId, season]
  );

  return result.rows.length > 0;
}

async function getLatestCommonSeason(pool: Pool, driverAId: string, driverBId: string): Promise<number | null> {
  const result = await pool.query(
    `
    SELECT MAX(a.year) AS season
    FROM (
      SELECT year FROM season_entrant_driver
      WHERE driver_id = $1 AND test_driver IS NOT TRUE
      UNION
      SELECT year FROM driver_season_entries
      WHERE driver_id = $1
    ) a
    INNER JOIN (
      SELECT year FROM season_entrant_driver
      WHERE driver_id = $2 AND test_driver IS NOT TRUE
      UNION
      SELECT year FROM driver_season_entries
      WHERE driver_id = $2
    ) b
      ON a.year = b.year
    `,
    [driverAId, driverBId]
  );

  const season = result.rows[0]?.season;
  return season === null || season === undefined ? null : parseInt(season, 10);
}

async function applySeasonFallback(
  pool: Pool,
  resolver: DriverResolver,
  intent: MetricIntent
): Promise<{ intent: MetricIntent; fallback?: FallbackStep }> {
  const updated: any = { ...intent };

  const resolveField = async (field: string): Promise<void> => {
    const value = updated[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return;
    }

    const result = await resolver.resolve(value, { season: intent.season });
    if (result.success && result.f1db_driver_id) {
      updated[field] = result.f1db_driver_id;
    }
  };

  await resolveField('driver_a_id');
  await resolveField('driver_b_id');
  await resolveField('driver_id');

  const driverA = updated.driver_a_id;
  const driverB = updated.driver_b_id;
  const driverSingle = updated.driver_id;

  if (driverA && driverB) {
    const driverAActive = await isDriverActiveInSeason(pool, driverA, intent.season);
    const driverBActive = await isDriverActiveInSeason(pool, driverB, intent.season);
    if (driverAActive && driverBActive) {
      return { intent: updated as MetricIntent };
    }

    const latestSeason = await getLatestCommonSeason(pool, driverA, driverB);
    if (latestSeason && latestSeason !== intent.season) {
      return {
        intent: { ...updated, season: latestSeason },
        fallback: {
          reason: 'driver_not_in_season',
          from_kind: intent.kind,
          to_kind: intent.kind,
          note: `Drivers were not active in ${intent.season}. Using ${latestSeason} instead.`
        }
      };
    }
  }

  if (driverSingle) {
    const driverActive = await isDriverActiveInSeason(pool, driverSingle, intent.season);
    if (driverActive) {
      return { intent: updated as MetricIntent };
    }

    const latestSeason = await getLatestSeasonForDriver(pool, driverSingle);
    if (latestSeason && latestSeason !== intent.season) {
      return {
        intent: { ...updated, season: latestSeason },
        fallback: {
          reason: 'driver_not_in_season',
          from_kind: intent.kind,
          to_kind: intent.kind,
          note: `${humanizeId(driverSingle)} was not active in ${intent.season}. Using ${latestSeason} instead.`
        }
      };
    }
  }

  return { intent: updated as MetricIntent };
}

function buildFallbackNote(intent: QueryIntent, reason: FallbackReason): string {
  switch (reason) {
    case 'insufficient_shared_laps':
      if ('track_id' in intent && intent.track_id) {
        return `Shared laps are below minimum at ${humanizeId(intent.track_id)} ${intent.season} -`;
      }
      return 'Shared laps are below minimum for a reliable comparison -';
    case 'no_teammate_overlap':
      return `No valid teammate overlap found for ${intent.season} -`;
    case 'low_coverage_sample':
      return 'Coverage is limited for this scope -';
    case 'driver_not_in_season':
      return '';
    default:
      return '';
  }
}

function classifyError(intent: QueryIntent, error: QueryError): FallbackReason | null {
  if (error.error === 'validation_failed') {
    if (error.reason.includes('Teammate validation failed') || error.reason.includes('Cannot resolve teammate pair')) {
      return 'no_teammate_overlap';
    }
    if (error.reason.includes('track_id is required')) {
      return 'insufficient_shared_laps';
    }
  }

  if (error.error === 'execution_failed') {
    if (error.reason.includes('INSUFFICIENT_DATA')) {
      if (intent.kind === 'cross_team_track_scoped_driver_comparison') {
        return 'insufficient_shared_laps';
      }
      if (intent.kind === 'teammate_gap_summary_season') {
        return 'no_teammate_overlap';
      }
      return 'low_coverage_sample';
    }
    if (error.reason.includes('No data found')) {
      if (intent.kind === 'cross_team_track_scoped_driver_comparison') {
        return 'insufficient_shared_laps';
      }
      return 'low_coverage_sample';
    }
  }

  if (error.error === 'intent_resolution_failed') {
    if (error.reason.includes('Unknown track')) {
      return 'insufficient_shared_laps';
    }
  }

  return null;
}

function nextIntentForFallback(intent: MetricIntent, reason: FallbackReason): MetricIntent | null {
  switch (intent.kind) {
    case 'cross_team_track_scoped_driver_comparison':
      if ((intent as any).driver_a_id && (intent as any).driver_b_id) {
        return buildSeasonComparisonIntent(intent);
      }
      return null;

    case 'season_driver_vs_driver':
      if (reason === 'low_coverage_sample') {
        return null;
      }
      if ((intent as any).driver_a_id && (intent as any).driver_b_id) {
        return buildSeasonComparisonIntent(intent);
      }
      return null;

    case 'teammate_gap_summary_season':
      return null;

    default:
      return null;
  }
}

function shouldDowngradeForCoverage(_intent: QueryIntent, _result: QueryResult): FallbackReason | null {
  return null;
}

function buildFallbackSteps(
  intent: QueryIntent,
  reason: FallbackReason,
  next: QueryIntent
): FallbackStep {
  return {
    reason,
    from_kind: intent.kind,
    to_kind: next.kind,
    note: buildFallbackNote(intent, reason)
  };
}

function summarizeTrackComparison(
  intent: Extract<QueryIntent, { kind: 'cross_team_track_scoped_driver_comparison' }>,
  payload: CrossTeamTrackScopedDriverComparisonPayload,
  confidence: any,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driverA = humanizeId(payload.driver_a);
  const driverB = humanizeId(payload.driver_b);
  const track = humanizeId(payload.track_id);
  const paceDelta = payload.pace_delta;
  const faster = determineFasterDriver(paceDelta, driverA, driverB);
  const sharedLaps = confidence.shared_overlap_laps || confidence.laps_considered || 0;
  const overlapPct = overlapPercent(payload.driver_a_laps, payload.driver_b_laps);

  const summary = `${faster || 'Neither driver'} was faster at ${track} ${intent.season} by ` +
    `${formatDecimal(Math.abs(paceDelta))}s per lap on average.`;

  const coverageLevel = resolveCoverageLevel(confidence.coverage_level);
  const coverage = coverageSummary('Shared laps', sharedLaps, coverageLevel);

  const bullets = [
    `${driverA} avg pace: ${formatDecimal(payload.driver_a_value)}s`,
    `${driverB} avg pace: ${formatDecimal(payload.driver_b_value)}s`,
    `Shared lap coverage: ${overlapPct}% (${formatInt(sharedLaps)} shared laps)`,
    `Compound mix: ${compoundSummary(intent)}`
  ];

  return {
    query_kind: intent.kind,
    headline: buildHeadline(summary, fallbacks),
    bullets,
    coverage,
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function summarizeSeasonComparison(
  intent: Extract<QueryIntent, { kind: 'season_driver_vs_driver' }>,
  payload: SeasonDriverVsDriverPayload,
  confidence: any,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driverA = humanizeId(payload.driver_a);
  const driverB = humanizeId(payload.driver_b);
  const difference = payload.difference;
  const faster = determineFasterDriver(difference, driverA, driverB);
  const overlapPct = overlapPercent(payload.driver_a_laps, payload.driver_b_laps);

  const summary = `${faster || 'Neither driver'} was faster over the ${intent.season} season by ` +
    `${formatDecimal(Math.abs(difference))}s per lap on average.`;

  const coverageLevel = resolveCoverageLevel(confidence.coverage_level);
  const coverage = coverageSummary('Season laps', payload.laps_considered, coverageLevel);

  const bullets = [
    `${driverA} avg pace: ${formatDecimal(payload.driver_a_value)}s`,
    `${driverB} avg pace: ${formatDecimal(payload.driver_b_value)}s`,
    `Coverage overlap: ${overlapPct}% (${formatInt(payload.driver_a_laps)} vs ${formatInt(payload.driver_b_laps)} laps)`,
    'Scope: raw pace (no normalization)'
  ];

  if (confidence.sample_balance_flag === 'imbalanced') {
    bullets[bullets.length - 1] = 'Scope: raw pace (no normalization); sample imbalance';
  }

  return {
    query_kind: intent.kind,
    headline: buildHeadline(summary, fallbacks),
    bullets,
    coverage,
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function summarizeSeasonSummary(
  intent: QueryIntent,
  payload: SeasonDriverSummaryPayload,
  confidence: any,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driver = humanizeId(payload.driver_id);
  const avgPace = payload.avg_race_pace !== null
    ? `${formatDecimal(payload.avg_race_pace)}s`
    : 'n/a';

  const summary = `${driver} ${intent.season}: ${formatInt(payload.wins)} wins, ` +
    `${formatInt(payload.podiums)} podiums, ${formatInt(payload.dnfs)} DNFs.`;

  const coverageLevel = resolveCoverageLevel(confidence.coverage_level);
  const coverage = coverageSummary('Valid laps', payload.laps_considered, coverageLevel);

  const bullets = [
    `Wins/Podiums: ${formatInt(payload.wins)} wins, ${formatInt(payload.podiums)} podiums`,
    `DNFs: ${formatInt(payload.dnfs)}`,
    `Race count: ${formatInt(payload.race_count)}`,
    `Avg race pace: ${avgPace}`
  ];

  return {
    query_kind: intent.kind,
    headline: buildHeadline(summary, fallbacks),
    bullets,
    coverage,
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function summarizeTeammateGap(
  intent: QueryIntent,
  payload: TeammateGapSummarySeasonPayload,
  confidence: any,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driverA = humanizeId(payload.driver_primary_id);
  const driverB = humanizeId(payload.driver_secondary_id);
  const faster = determineFasterDriver(payload.gap_seconds, driverA, driverB);

  const summary = faster
    ? `${faster} was faster than ${faster === driverA ? driverB : driverA} in ${intent.season} by ` +
      `${formatDecimal(Math.abs(payload.gap_seconds))}s per lap on average.`
    : `No clear advantage between ${driverA} and ${driverB} in ${intent.season} ` +
      `(${formatDecimal(Math.abs(payload.gap_seconds))}s per lap gap).`;

  const coverageLevel = resolveCoverageLevel(confidence.coverage_level);
  const coverage = coverageSummary('Races', payload.shared_races, coverageLevel);

  // Calculate head-to-head record
  const fasterSecondaryCount = payload.shared_races - payload.faster_driver_primary_count;

  const bullets = [
    `Race pace gap: ${payload.gap_pct !== null ? formatDecimal(Math.abs(payload.gap_pct)) + '%' : formatDecimal(Math.abs(payload.gap_seconds)) + 's'}`,
    `Head-to-head: ${payload.faster_driver_primary_count}–${fasterSecondaryCount} across ${payload.shared_races} races`,
    `Coverage status: ${payload.coverage_status}`,
    'Metric: symmetric_percent_diff'
  ];

  // Add methodology note
  bullets.push('Based on median race lap times (valid, non-pit, non-in/out laps).');

  // Add low_coverage note if applicable (directional, not definitive)
  if (payload.coverage_status === 'low_coverage') {
    bullets.push('Low sample size — results are directional, not definitive.');
  }

  return {
    query_kind: intent.kind,
    headline: buildHeadline(summary, fallbacks),
    bullets,
    coverage,
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function summarizeTeammateGapDualComparison(
  intent: QueryIntent,
  payload: TeammateGapDualComparisonPayload,
  confidence: any,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driverPrimary = humanizeId(payload.driver_primary_id);
  const driverSecondary = humanizeId(payload.driver_secondary_id);

  const formatGap = (gapPercent: number | null, gapSeconds: number | null): string => {
    if (gapPercent !== null) {
      return `${formatDecimal(Math.abs(gapPercent))}%`;
    }
    if (gapSeconds !== null) {
      return `${formatDecimal(Math.abs(gapSeconds))}s`;
    }
    return 'n/a';
  };

  const formatWinner = (winner: string | null): string => {
    if (!winner) {
      return 'unavailable';
    }
    if (winner === 'equal') {
      return 'equal';
    }
    return humanizeId(winner);
  };

  const qualifyingGapLabel = payload.qualifying.available
    ? formatGap(payload.qualifying.gap_percent, payload.qualifying.gap_seconds)
    : 'unavailable';
  const raceGapLabel = payload.race_pace.available
    ? formatGap(payload.race_pace.gap_percent, payload.race_pace.gap_seconds)
    : 'unavailable';

  const qualifyingWinner = payload.qualifying.available
    ? formatWinner(payload.qualifying.winner)
    : 'unavailable';
  const raceWinner = payload.race_pace.available
    ? formatWinner(payload.race_pace.winner)
    : 'unavailable';

  let sameWinnerLabel: string;
  if (payload.overall_summary.same_winner === null) {
    sameWinnerLabel = 'partial';
  } else if (payload.overall_summary.same_winner) {
    sameWinnerLabel = 'yes';
  } else {
    sameWinnerLabel = 'no';
  }

  const summary = `${driverPrimary} vs ${driverSecondary} ${intent.season}: ` +
    `advantage area ${payload.overall_summary.advantage_area}.`;

  const coverageLevel = resolveCoverageLevel(confidence.coverage_level);
  const sharedRaces = Math.max(payload.qualifying.shared_races, payload.race_pace.shared_races);
  const coverage = coverageSummary('Shared races', sharedRaces, coverageLevel);

  const bullets = [
    `Qualifying gap: ${qualifyingGapLabel} (${qualifyingWinner})`,
    `Race pace gap: ${raceGapLabel} (${raceWinner})`,
    `Same winner: ${sameWinnerLabel}`,
    `Coverage: qualifying ${payload.qualifying.coverage_status}, race ${payload.race_pace.coverage_status}`
  ];

  return {
    query_kind: intent.kind,
    headline: buildHeadline(summary, fallbacks),
    bullets,
    coverage,
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function summarizeCareerSummary(
  intent: QueryIntent,
  payload: DriverCareerSummaryPayload,
  confidence: any,
  fallbacks: FallbackStep[]
): BuiltAnswer {
  const driver = humanizeId(payload.driver_id);
  const trend = payload.pace_trend_per_season !== null
    ? `${formatSignedDecimal(payload.pace_trend_per_season)} per season` +
      (payload.pace_trend_start_season && payload.pace_trend_end_season
        ? ` (${payload.pace_trend_start_season} to ${payload.pace_trend_end_season})`
        : '')
    : 'n/a';

  const summary = `${driver} career: ${formatInt(payload.championships)} championships, ` +
    `${formatInt(payload.career_wins)} wins, ${formatInt(payload.career_podiums)} podiums.`;

  const coverageLevel = resolveCoverageLevel(confidence.coverage_level);
  const coverage = coverageSummary('Seasons', payload.seasons_raced, coverageLevel);

  const bullets = [
    `Championships: ${formatInt(payload.championships)}`,
    `Seasons raced: ${formatInt(payload.seasons_raced)}`,
    `Wins/Podiums: ${formatInt(payload.career_wins)} wins, ${formatInt(payload.career_podiums)} podiums`,
    `Avg pace trend: ${trend}`
  ];

  return {
    query_kind: intent.kind,
    headline: buildHeadline(summary, fallbacks),
    bullets,
    coverage,
    followups: buildFollowups(intent),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined
  };
}

function buildRaceResultsInterpretation(
  result: QueryResult
): InterpretationBuilderOutput {
  const intent = result.intent as Extract<QueryIntent, { kind: 'race_results_summary' }>;
  const payload = result.result.payload as RaceResultsSummaryPayload;
  const fallbacks: FallbackStep[] = [];

  const raceLabel = payload.race_name || humanizeId(intent.track_id);
  const top10 = payload.top10 || [];
  const podium = payload.podium && payload.podium.length > 0 ? payload.podium : top10.slice(0, 3);
  const winner = podium[0];

  const summary = winner
    ? `${winner.driver_name} won ${raceLabel} ${intent.season}.`
    : `${raceLabel} ${intent.season} race results.`;

  const podiumLabel = podium.length > 0
    ? podium.map(entry => `${entry.driver_name} (${entry.constructor_name})`).join(', ')
    : 'n/a';

  const topFive = top10.slice(0, 5).map(entry => entry.driver_name).join(', ');
  const timingParts: string[] = [];
  if (payload.winner_time) {
    timingParts.push(`Winner time: ${payload.winner_time}`);
  }
  if (payload.laps_completed !== null && payload.laps_completed !== undefined) {
    timingParts.push(`Laps: ${payload.laps_completed}`);
  }
  const timingLine = timingParts.length > 0 ? timingParts.join(' | ') : 'Timing data not available';

  const bullets = [
    `Podium: ${podiumLabel}`,
    topFive ? `Top 5: ${topFive}` : undefined,
    timingLine
  ].filter((bullet): bullet is string => Boolean(bullet)).slice(0, 4);

  return {
    intent,
    result,
    answer: {
      query_kind: intent.kind,
      headline: buildHeadline(summary, fallbacks),
      bullets,
      coverage: {
        level: 'high',
        summary: 'Official race results'
      },
      followups: buildFollowups(intent)
    },
    fallbacks
  };
}

function buildTrackFastestDriversInterpretation(
  result: QueryResult
): InterpretationBuilderOutput {
  const intent = result.intent as Extract<QueryIntent, { kind: 'track_fastest_drivers' }>;
  const payload = result.result.payload as DriverRankingPayload;
  const fallbacks: FallbackStep[] = [];

  const topEntries = payload.entries.slice(0, 5);
  const topDrivers = topEntries.map(entry => humanizeId(entry.driver_id));
  const trackLabel = humanizeId(intent.track_id);

  const summary = topDrivers.length > 0
    ? `Fastest at ${trackLabel} ${intent.season}: ${topDrivers[0]}.`
    : `No lap data available for ${trackLabel} ${intent.season}.`;

  const topThree = topEntries.slice(0, 3).map(entry => humanizeId(entry.driver_id)).join(', ');
  const nextTwo = topEntries.slice(3, 5).map(entry => humanizeId(entry.driver_id)).join(', ');
  const bullets = [
    topThree ? `Top 3: ${topThree}` : 'No ranked laps available',
    nextTwo ? `Next: ${nextTwo}` : undefined,
    'Scope: track-bounded ranking'
  ].filter((bullet): bullet is string => Boolean(bullet)).slice(0, 4);

  const coverageLevel = resolveCoverageLevel(result.interpretation.confidence.coverage_level);
  const lapsConsidered = result.interpretation.confidence.laps_considered || 0;
  const coverage = coverageSummary('Min laps per driver', lapsConsidered, coverageLevel);

  return {
    intent,
    result,
    answer: {
      query_kind: intent.kind,
      headline: buildHeadline(summary, fallbacks),
      bullets,
      coverage,
      followups: buildFollowups(intent)
    },
    fallbacks
  };
}

/**
 * Build generic interpretation for TIER 2 and ADVANCED queries
 *
 * These queries don't have specialized interpretation logic yet,
 * so we return a simple success response with the result payload.
 */
function buildGenericInterpretation(
  result: QueryResult
): InterpretationBuilderOutput {
  const intent = result.intent;
  const fallbacks: FallbackStep[] = [];

  const coverageLevel = resolveCoverageLevel(result.interpretation.confidence.coverage_level);
  const lapsConsidered = result.interpretation.confidence.laps_considered || 0;

  return {
    intent,
    result,
    answer: {
      query_kind: intent.kind,
      headline: `Query completed successfully`,
      bullets: [
        `Query type: ${humanizeId(intent.kind)}`,
        `Season: ${intent.season}`
      ],
      coverage: {
        level: coverageLevel,
        summary: `Sample size: ${formatInt(lapsConsidered)}`
      },
      followups: buildFollowups(intent)
    },
    fallbacks
  };
}

function buildHeadline(summary: string, fallbacks: FallbackStep[]): string {
  const notes = fallbacks
    .map(step => step.note)
    .filter(note => note && note.length > 0);

  if (notes.length === 0) {
    return summary;
  }

  return `${notes.join(' ')} ${summary}`.trim();
}

export async function buildInterpretationResponse(
  input: InterpretationBuilderInput
): Promise<InterpretationBuilderOutput> {
  const { pool, executor, intent } = input;

  if (intent.kind === 'race_results_summary') {
    const result = await executor.execute(intent);
    if ('error' in result) {
      return {
        intent,
        result,
        answer: buildFailClosedAnswer(intent, []),
        fallbacks: []
      };
    }
    return buildRaceResultsInterpretation(result);
  }

  if (intent.kind === 'track_fastest_drivers') {
    // Apply defaults for track_fastest_drivers (metric, normalization, etc.)
    const intentWithDefaults = withDefaults(intent) as typeof intent;
    const result = await executor.execute(intentWithDefaults);
    if ('error' in result) {
      return {
        intent: intentWithDefaults,
        result,
        answer: buildFailClosedAnswer(intentWithDefaults, []),
        fallbacks: []
      };
    }
    return buildTrackFastestDriversInterpretation(result);
  }

  const directExecutionKinds = new Set([
    'driver_profile_summary',
    'driver_trend_summary',
    'driver_head_to_head_count',
    'driver_performance_vector',
    'driver_multi_comparison',
    'driver_matchup_lookup',
    // QUALIFYING QUERY TYPES
    'driver_pole_count',
    'driver_q3_count',
    'season_q3_rankings',
    'qualifying_gap_teammates',
    'qualifying_gap_drivers'
  ]);

  if (directExecutionKinds.has(intent.kind)) {
    const intentWithDefaults = withDefaults(intent as MetricIntent);
    const result = await executor.execute(intentWithDefaults);
    if ('error' in result) {
      return {
        intent: intentWithDefaults,
        result,
        answer: buildFailClosedAnswer(intentWithDefaults, []),
        fallbacks: []
      };
    }
    return buildGenericInterpretation(result);
  }

  let currentIntent = withDefaults(intent);
  const fallbacks: FallbackStep[] = [];
  const resolver = new DriverResolver(pool);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seasonAdjusted = await applySeasonFallback(pool, resolver, currentIntent);
    currentIntent = seasonAdjusted.intent;
    if (seasonAdjusted.fallback) {
      fallbacks.push(seasonAdjusted.fallback);
    }

    const result = await executor.execute(currentIntent);

    if ('error' in result) {
      if (currentIntent.kind === 'teammate_gap_dual_comparison') {
        return {
          intent: currentIntent,
          result,
          answer: buildFailClosedAnswer(currentIntent, fallbacks),
          fallbacks,
          canonical_response: executor.buildDualComparisonErrorResponse(
            currentIntent as Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
            result
          )
        };
      }

      if (currentIntent.kind === 'teammate_gap_summary_season' &&
          result.error === 'execution_failed' &&
          result.reason.includes('INSUFFICIENT_DATA')) {
        const diagnostics = await loadTeammateGapDiagnostics(
          pool,
          currentIntent as Extract<QueryIntent, { kind: 'teammate_gap_summary_season' }>
        );
        return {
          intent: currentIntent,
          result,
          answer: buildTeammateGapDiagnosticAnswer(
            currentIntent as Extract<QueryIntent, { kind: 'teammate_gap_summary_season' }>,
            diagnostics,
            fallbacks
          ),
          fallbacks
        };
      }

      const reason = classifyError(currentIntent, result);
      const next = reason ? nextIntentForFallback(currentIntent, reason) : null;

      if (reason && next) {
        fallbacks.push(buildFallbackSteps(currentIntent, reason, next));
        currentIntent = next;
        continue;
      }

      return {
        intent: currentIntent,
        result,
        answer: buildFailClosedAnswer(currentIntent, fallbacks),
        fallbacks
      };
    }

    const downgradeReason = shouldDowngradeForCoverage(currentIntent, result);
    if (downgradeReason) {
      const next = nextIntentForFallback(currentIntent, downgradeReason);
      if (next) {
        fallbacks.push(buildFallbackSteps(currentIntent, downgradeReason, next));
        currentIntent = next;
        continue;
      }
    }

    const payload = result.result.payload as any;
    const confidence = result.interpretation.confidence;

    switch (currentIntent.kind) {
      case 'cross_team_track_scoped_driver_comparison':
        return {
          intent: currentIntent,
          result,
          answer: summarizeTrackComparison(
            currentIntent,
            payload as CrossTeamTrackScopedDriverComparisonPayload,
            confidence,
            fallbacks
          ),
          fallbacks
        };

      case 'season_driver_vs_driver':
        return {
          intent: currentIntent,
          result,
          answer: summarizeSeasonComparison(
            currentIntent,
            payload as SeasonDriverVsDriverPayload,
            confidence,
            fallbacks
          ),
          fallbacks
        };

      case 'driver_season_summary':
        return {
          intent: currentIntent,
          result,
          answer: summarizeSeasonSummary(currentIntent, payload as SeasonDriverSummaryPayload, confidence, fallbacks),
          fallbacks
        };

      case 'driver_career_summary':
        return {
          intent: currentIntent,
          result,
          answer: summarizeCareerSummary(currentIntent, payload as DriverCareerSummaryPayload, confidence, fallbacks),
          fallbacks
        };

      case 'teammate_gap_summary_season':
        return {
          intent: currentIntent,
          result,
          answer: summarizeTeammateGap(currentIntent, payload as TeammateGapSummarySeasonPayload, confidence, fallbacks),
          fallbacks
        };

      case 'teammate_gap_dual_comparison':
        return {
          intent: currentIntent,
          result,
          answer: summarizeTeammateGapDualComparison(
            currentIntent,
            payload as TeammateGapDualComparisonPayload,
            confidence,
            fallbacks
          ),
          fallbacks,
          canonical_response: executor.buildDualComparisonResponseFromPayload(
            currentIntent as Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>,
            payload as TeammateGapDualComparisonPayload
          )
        };
    }
  }

  const error: QueryError = {
    error: 'execution_failed',
    reason: 'Fallback attempts exceeded'
  };

  return {
    intent: currentIntent,
    result: error,
    answer: buildFailClosedAnswer(currentIntent, fallbacks),
    fallbacks
  };
}
