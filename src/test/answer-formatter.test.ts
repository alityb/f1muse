import { describe, it, expect } from 'vitest';
import { formatAnswer } from '../presentation/answer-formatter';
import { QueryIntent } from '../types/query-intent';
import { QueryError } from '../types/results';

const baseIntent = {
  season: 2023,
  metric: 'avg_true_pace',
  normalization: 'none',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'test'
} as const;

describe('Answer formatter', () => {
  it('formats teammate gap summary answers', () => {
    const intent: QueryIntent = {
      ...baseIntent,
      kind: 'teammate_gap_summary_season',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      team_id: 'MCL',
      season: 2025,
      metric: 'teammate_gap_raw',
      normalization: 'team_baseline'
    };

    const result = {
      type: 'teammate_gap_summary_season',
      payload: {
        type: 'teammate_gap_summary_season',
        season: 2025,
        team_id: 'MCL',
        driver_primary_id: 'lando_norris',
        driver_secondary_id: 'oscar_piastri',
        gap_seconds: -0.123,
        gap_seconds_abs: 0.123,
        gap_pct: null,
        gap_pct_abs: null,
        shared_races: 8,
        faster_driver_primary_count: 5,
        coverage_status: 'valid',
        gap_band: 'meaningful_advantage'
      }
    };

    const formatted = formatAnswer({ intent, result });
    expect(formatted.headline.title).toBe('lando_norris vs oscar_piastri — 2025');
    expect(formatted.stats[0].label).toBe('Race pace gap');
    expect(formatted.stats[0].context).toBe('lando_norris advantage');
  });

  it('formats cross-team season comparisons', () => {
    const intent: QueryIntent = {
      ...baseIntent,
      kind: 'season_driver_vs_driver',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'fernando_alonso'
    };

    const result = {
      type: 'season_driver_vs_driver',
      payload: {
        type: 'season_driver_vs_driver',
        season: 2023,
        driver_a: 'max_verstappen',
        driver_b: 'fernando_alonso',
        metric: 'avg_true_pace',
        driver_a_value: 89.2,
        driver_b_value: 89.6,
        difference: -0.4,
        normalization: 'none',
        driver_a_laps: 120,
        driver_b_laps: 120,
        laps_considered: 240
      }
    };

    const formatted = formatAnswer({ intent, result });
    expect(formatted.headline.title).toBe('max_verstappen vs fernando_alonso — 2023');
    expect(formatted.stats[0].label).toBe('Pace difference');
    expect(formatted.stats[0].context).toBe('max_verstappen faster');
  });

  it('formats track-scoped comparisons', () => {
    const intent: QueryIntent = {
      ...baseIntent,
      kind: 'cross_team_track_scoped_driver_comparison',
      track_id: 'suzuka',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'fernando_alonso'
    };

    const result = {
      type: 'cross_team_track_scoped_driver_comparison',
      payload: {
        type: 'cross_team_track_scoped_driver_comparison',
        season: 2023,
        track_id: 'suzuka',
        metric: 'avg_true_pace',
        driver_a: 'max_verstappen',
        driver_b: 'fernando_alonso',
        driver_a_value: 89.2,
        driver_b_value: 89.6,
        pace_delta: -0.4,
        compound_context: 'mixed',
        driver_a_laps: 25,
        driver_b_laps: 25,
        laps_considered: 50
      }
    };

    const formatted = formatAnswer({ intent, result });
    expect(formatted.headline.title).toBe('max_verstappen vs fernando_alonso — suzuka 2023');
    expect(formatted.stats[0].label).toBe('Pace gap');
  });

  it('formats track pace rankings', () => {
    const intent: QueryIntent = {
      ...baseIntent,
      kind: 'track_fastest_drivers',
      track_id: 'suzuka'
    };

    const result = {
      type: 'driver_ranking',
      payload: {
        type: 'driver_ranking',
        season: 2023,
        track_id: 'suzuka',
        metric: 'avg_true_pace',
        ranking_basis: 'lower_is_faster',
        entries: [
          { driver_id: 'max_verstappen', value: 89.1, laps_considered: 60 },
          { driver_id: 'lando_norris', value: 89.4, laps_considered: 58 },
          { driver_id: 'oscar_piastri', value: 89.7, laps_considered: 55 }
        ]
      }
    };

    const formatted = formatAnswer({ intent, result });
    expect(formatted.headline.title).toBe('Fastest drivers — suzuka 2023');
    expect(formatted.stats[0].label).toBe('P1');
    expect(formatted.stats[0].value).toBe('max_verstappen — 89.100s');
  });

  it('formats fail-closed answers for errors', () => {
    const intent: QueryIntent = {
      ...baseIntent,
      kind: 'season_driver_vs_driver',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'fernando_alonso'
    };

    const error: QueryError = {
      error: 'execution_failed',
      reason: 'INSUFFICIENT_DATA: not enough laps'
    };

    const formatted = formatAnswer({ intent, result: error });
    expect(formatted.headline.title).toBe('Coverage is limited for this scope');
    expect(formatted.coverage?.level).toBe('insufficient');
  });
});
