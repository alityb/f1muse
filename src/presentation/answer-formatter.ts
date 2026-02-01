import { QueryIntent } from '../types/query-intent';
import {
  QueryResult,
  QueryError,
  ResultPayload,
  DriverRankingPayload,
  CrossTeamTrackScopedDriverComparisonPayload,
  SeasonDriverVsDriverPayload,
  TeammateGapSummarySeasonPayload
} from '../types/results';

export interface AnswerHeadlineBlock {
  title: string;
  subtitle?: string;
}

export interface AnswerStatLine {
  label: string;
  value: string;
  context?: string;
}

export type CoverageLevel = 'high' | 'moderate' | 'low' | 'insufficient';

export interface AnswerCoverageBlock {
  level: CoverageLevel;
  summary: string;
}

export interface AnswerNotesBlock {
  bullets: string[];
}

export interface FormattedAnswer {
  query_kind: string;
  headline: AnswerHeadlineBlock;
  stats: AnswerStatLine[];
  coverage?: AnswerCoverageBlock;
  notes?: AnswerNotesBlock;
}

export type ExecutionResult = QueryResult['result'] | QueryError;

export interface AnswerFormatterInput {
  intent: QueryIntent;
  result: ExecutionResult;
}

const INTEGER_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatInt(value: number): string {
  return INTEGER_FORMATTER.format(Math.round(value));
}

function formatDecimal(value: number): string {
  return value.toFixed(3);
}

function determineFasterDriver(
  delta: number,
  driverA: string,
  driverB: string
): string | null {
  if (delta === 0) {
    return null;
  }
  return delta < 0 ? driverA : driverB;
}

function formatFailClosedAnswer(queryKind?: string): FormattedAnswer {
  return {
    query_kind: queryKind || 'unknown',
    headline: {
      title: 'Coverage is limited for this scope',
      subtitle: 'Only confirmed results are reported.'
    },
    coverage: {
      level: 'insufficient',
      summary: 'Coverage is limited for this scope.'
    },
    stats: [],
    notes: {
      bullets: [
        'No extrapolation is performed',
        'Try a different season, track, or driver pair'
      ]
    }
  };
}

function isQueryError(result: ExecutionResult): result is QueryError {
  return (result as QueryError).error !== undefined;
}

export function formatAnswer(input: AnswerFormatterInput): FormattedAnswer {
  const { intent, result } = input;

  if (!intent || typeof (intent as any).kind !== 'string') {
    return formatFailClosedAnswer('unknown');
  }

  if (isQueryError(result)) {
    return formatFailClosedAnswer(intent.kind);
  }

  const payload = result.payload as ResultPayload;

  switch (intent.kind) {
    case 'race_results_summary': {
      // NEW: Race results from F1DB (Statmuse-style with emojis)
      const data = payload as any; // TODO: Add proper type
      const podium = data.podium || [];
      const top10 = data.top10 || [];

      const medalEmojis = ['🥇', '🥈', '🥉'];
      const podiumStats = podium.slice(0, 3).map((entry: any, index: number) => ({
        label: `${medalEmojis[index]} P${index + 1}`,
        value: `${entry.driver_name} (${entry.constructor_name})`
      }));

      const stats: AnswerStatLine[] = [
        ...podiumStats,
        { label: '', value: '---' },
        ...top10.slice(3).map((entry: any, index: number) => ({
          label: `P${index + 4}`,
          value: `${entry.driver_name} (${entry.constructor_name})`
        })),
        { label: '', value: '---' },
        { label: 'Race distance', value: `${data.laps_completed || 'N/A'} laps` },
        { label: 'Winning time', value: data.winner_time || 'N/A' }
      ];

      return {
        query_kind: intent.kind,
        headline: {
          title: `${intent.track_id} ${intent.season} — Race Results 🏁`
        },
        stats
      };
    }

    case 'teammate_gap_summary_season': {
      // PRIMARY performance metric - teammate-relative (race pace)
      const data = payload as TeammateGapSummarySeasonPayload;
      const gapPct = data.gap_pct !== null ? data.gap_pct : null;
      const faster = determineFasterDriver(
        gapPct !== null ? gapPct : data.gap_seconds,
        data.driver_primary_id,
        data.driver_secondary_id
      );
      const gapPctLabel = gapPct !== null
        ? `${formatDecimal(Math.abs(gapPct))}%`
        : `${formatDecimal(Math.abs(data.gap_seconds))}s`;

      return {
        query_kind: intent.kind,
        headline: {
          title: `${intent.driver_a_id} vs ${intent.driver_b_id} — ${intent.season}`,
          subtitle: faster
            ? `${faster} was ${gapPctLabel} faster on race pace`
            : 'Even match'
        },
        stats: [
          {
            label: 'Race pace gap',
            value: gapPctLabel,
            context: faster ? `${faster} advantage` : 'No clear edge'
          },
          {
            label: 'Head-to-head',
            value: `${data.faster_driver_primary_count}–${data.shared_races - data.faster_driver_primary_count} in ${data.shared_races} races`
          }
        ],
        notes: {
          bullets: [
            'Symmetric percent difference (track-length invariant)',
            'Based on median race lap times (valid laps only)',
            'Controls for car performance (same team)'
          ]
        }
      };
    }

    case 'season_driver_vs_driver': {
      // Cross-team season comparison (raw pace, no normalization)
      const data = payload as SeasonDriverVsDriverPayload;
      const faster = determineFasterDriver(data.difference, data.driver_a, data.driver_b);

      return {
        query_kind: intent.kind,
        headline: {
          title: `${data.driver_a} vs ${data.driver_b} — ${intent.season}`,
          subtitle: 'Cross-team comparison (raw pace)'
        },
        stats: [
          {
            label: 'Pace difference',
            value: `${formatDecimal(Math.abs(data.difference))}s per lap`,
            context: faster ? `${faster} faster` : 'Even pace'
          },
          {
            label: 'Sample',
            value: `${formatInt(data.laps_considered)} laps`
          }
        ],
        notes: {
          bullets: [
            'This comparison does NOT normalize for car performance',
            'Faster car = faster lap times'
          ]
        }
      };
    }

    case 'cross_team_track_scoped_driver_comparison': {
      // Track-scoped comparison (raw pace)
      const data = payload as CrossTeamTrackScopedDriverComparisonPayload;
      const paceDelta = data.pace_delta;
      const faster = determineFasterDriver(paceDelta, data.driver_a, data.driver_b);

      return {
        query_kind: intent.kind,
        headline: {
          title: `${data.driver_a} vs ${data.driver_b} — ${intent.track_id} ${intent.season}`
        },
        stats: [
          {
            label: 'Pace gap',
            value: `${formatDecimal(Math.abs(paceDelta))}s per lap`,
            context: faster ? `${faster} faster` : 'Even'
          },
          {
            label: 'Sample',
            value: `${formatInt(data.laps_considered)} laps`
          }
        ],
        notes: {
          bullets: [
            'Raw pace at this track only',
            'No car performance adjustment'
          ]
        }
      };
    }

    case 'track_fastest_drivers': {
      // Driver ranking at track
      const data = payload as DriverRankingPayload;
      const entries = data.entries.slice(0, 10);

      const stats: AnswerStatLine[] = entries.map((entry, index) => ({
        label: `P${index + 1}`,
        value: `${entry.driver_id} — ${formatDecimal(entry.value)}s`,
        context: `${formatInt(entry.laps_considered)} laps`
      }));

      return {
        query_kind: intent.kind,
        headline: {
          title: `Fastest drivers — ${intent.track_id} ${intent.season}`
        },
        stats
      };
    }

    case 'driver_season_summary': {
      // Single driver season stats
      const data = payload as any; // TODO: Add proper type

      return {
        query_kind: intent.kind,
        headline: {
          title: `${intent.driver_id} — ${intent.season} Season`
        },
        stats: [
          {
            label: 'Races',
            value: `${data.race_count || 'N/A'} races`
          },
          {
            label: 'Points',
            value: `${data.points || 'N/A'} points`
          },
          {
            label: 'Avg finish',
            value: data.avg_finish ? `P${formatDecimal(data.avg_finish)}` : 'N/A'
          }
        ]
      };
    }

    case 'driver_career_summary': {
      // Career-spanning stats
      const data = payload as any; // TODO: Add proper type

      return {
        query_kind: intent.kind,
        headline: {
          title: `${intent.driver_id} — Career`
        },
        stats: [
          {
            label: 'Seasons',
            value: `${data.seasons_raced || 'N/A'} seasons`
          },
          {
            label: 'Races',
            value: `${data.races_entered || 'N/A'} races`
          },
          {
            label: 'Wins',
            value: `${data.wins || 0} wins`
          },
          {
            label: 'Podiums',
            value: `${data.podiums || 0} podiums`
          },
          {
            label: 'Championships',
            value: `${data.championships || 0} titles`
          }
        ]
      };
    }

    default: {
      const fallbackKind = (intent as { kind?: string }).kind || 'unknown';
      return formatFailClosedAnswer(fallbackKind);
    }
  }
}
