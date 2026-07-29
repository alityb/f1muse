import { describe, expect, it } from 'vitest';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { F1QLProgram } from '../../src/f1ql/ast';
import { materializeAnswerTemplate } from '../../src/f1ql/answer-templates';

const standingsAggregate = (season: number | number[] | undefined, driver_id?: string | string[]): F1QLProgram => ({
  version: 1,
  root: {
    op: 'aggregate',
    input: season === undefined && driver_id === undefined
      ? { op: 'source', source: 'standings' }
      : { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season, driver_id } },
    group_by: ['driver_id'],
    measures: [{ as: 'points', function: 'max', field: 'points' }]
  }
});

describe('Phase 7 answer capability policy', () => {
  it.each([
    {
      name: 'latest-recorded current standings',
      program: materializeAnswerTemplate('current_standings', { season: 2026 }),
      source: 'current_driver_standings'
    },
    {
      name: 'official driver season summary',
      program: materializeAnswerTemplate('driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' }),
      source: 'final_driver_standings'
    },
    {
      name: 'official driver career summary',
      program: materializeAnswerTemplate('driver_career_official_summary', { driver_id: 'lewis-hamilton' }),
      source: 'final_driver_standings'
    },
    {
      name: 'pinned final championship-position ranking',
      program: materializeAnswerTemplate('final_standings_driver_ranking', { season: 2025, driver_ids: ['max-verstappen', 'lando-norris', 'oscar-piastri'] }),
      source: 'final_driver_standings'
    },
    {
      name: 'final-season race finishing-position H2H',
      program: materializeAnswerTemplate('race_season_finishing_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }),
      source: 'race_classification'
    },
    {
      name: 'final-season qualifying-position H2H',
      program: materializeAnswerTemplate('qualifying_season_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }),
      source: 'qualifying_classification'
    },
    {
      name: 'official driver results comparison',
      program: materializeAnswerTemplate('official_driver_results_comparison', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }),
      source: 'official_driver_results_comparison'
    },
    {
      name: 'single-event race finishing-position comparison',
      program: materializeAnswerTemplate('race_event_finishing_position_comparison', { season: 2025, round: 12, driver_a_id: 'max-verstappen', driver_b_id: 'lando-norris' }),
      source: 'race_classification'
    },
    {
      name: 'one-season final standings',
      program: standingsAggregate(2025),
      source: 'final_driver_standings'
    },
    {
      name: 'bounded driver standings ranking',
      program: { version: 1, root: { op: 'rank', input: standingsAggregate(2024, ['charles-leclerc', 'carlos-sainz-jr']).root, by: 'points', direction: 'desc', limit: 2 } } as F1QLProgram,
      source: 'final_driver_standings'
    },
    {
      name: 'race classification with driver',
      program: { version: 1, root: { op: 'event_classification', season: 2025, round: 7, limit: 30, filters: { driver_id: 'max-verstappen' } } } as F1QLProgram,
      source: 'race_classification'
    },
    {
      name: 'race classification with status',
      program: { version: 1, root: { op: 'event_classification', season: 2025, round: 7, limit: 30, filters: { classification_status: ['classified'] } } } as F1QLProgram,
      source: 'race_classification'
    },
    {
      name: 'qualifying classification',
      program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 7, limit: 30 } } as F1QLProgram,
      source: 'qualifying_classification'
    },
    {
      name: 'race-date event metadata',
      program: { version: 1, root: { op: 'event_metadata', season: 2025, round: 7, session_scope: 'race' } } as F1QLProgram,
      source: 'race_date_metadata'
    }
  ])('approves $name', ({ program, source }) => {
    const decision = authorizeAnswerProgram(program);
    expect(decision).toMatchObject({ type: 'approved', capability: { source } });
  });

  it('rejects mutations of the final championship-position ranking', () => {
    const program = materializeAnswerTemplate('final_standings_driver_ranking', { season: 2025, driver_ids: ['max-verstappen', 'lando-norris', 'oscar-piastri'] });
    if (program.root.op !== 'rank' || program.root.input.input.op !== 'filter') throw new Error('ranking fixture shape changed');
    for (const root of [
      { ...program.root, direction: 'desc' as const },
      { ...program.root, limit: 2 },
      { ...program.root, by: 'standing_rows' },
      { ...program.root, input: { ...program.root.input, measures: program.root.input.measures.slice(0, 1) } },
      { ...program.root, input: { ...program.root.input, input: { ...program.root.input.input, where: { ...program.root.input.input.where, season: 2026 } } } },
      { ...program.root, input: { ...program.root.input, input: { ...program.root.input.input, where: { ...program.root.input.input.where, season: 1949 } } } },
      { ...program.root, input: { ...program.root.input, input: { ...program.root.input.input, where: { ...program.root.input.input.where, season: 2024.5 } } } },
      { ...program.root, input: { ...program.root.input, input: { ...program.root.input.input, where: { ...program.root.input.input.where, season: Number.NaN } } } },
      { ...program.root, input: { ...program.root.input, input: { ...program.root.input.input, where: { ...program.root.input.input.where, driver_id: ['max-verstappen', 'lando-norris'] } } } }
    ]) {
      expect(authorizeAnswerProgram({ version: 1, root } as F1QLProgram).type).toBe('rejected');
    }
  });

  it.each([
    {
      name: 'pace summary',
      program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } } as F1QLProgram,
      reason: 'pace_source_disabled'
    },
    {
      name: 'pace delta',
      program: { version: 1, root: { op: 'pace_delta', driver_a_id: 'max-verstappen', driver_b_id: 'lando-norris', scope: { season: 2025 } } } as F1QLProgram,
      reason: 'pace_source_disabled'
    },
    {
      name: 'official lap-window comparison',
      program: {
        version: 1,
        root: {
          op: 'official_lap_window_median_compare',
          metric: 'official_non_deleted_non_pit_window_median_v1',
          season: 2022,
          round: 14,
          driver_a_id: 'max-verstappen',
          driver_b_id: 'fernando-alonso',
          lap_start: 3,
          lap_end: 10
        }
      } as F1QLProgram,
      reason: 'capability_unsupported'
    },
    { name: 'unscoped standings', program: standingsAggregate(undefined), reason: 'temporal_scope_unsupported' },
    { name: 'multi-season standings', program: standingsAggregate([2024, 2025]), reason: 'temporal_scope_unsupported' },
    { name: 'ongoing standings', program: standingsAggregate(2026), reason: 'interim_standings_unsupported' },
    { name: 'future standings', program: standingsAggregate(2100), reason: 'interim_standings_unsupported' },
    {
      name: 'oversized driver set',
      program: standingsAggregate(2025, ['a', 'b', 'c', 'd', 'e']),
      reason: 'entity_set_too_large'
    },
    {
      name: 'race team filter',
      program: { version: 1, root: { op: 'event_classification', season: 2025, round: 7, limit: 30, filters: { team_id: 'ferrari' } } } as F1QLProgram,
      reason: 'team_filter_unsupported'
    },
    {
      name: 'qualifying team filter',
      program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 7, limit: 30, filters: { team_id: 'ferrari' } } } as F1QLProgram,
      reason: 'team_filter_unsupported'
    },
    {
      name: 'combined classification filters',
      program: { version: 1, root: { op: 'event_classification', season: 2025, round: 7, limit: 30, filters: { driver_id: 'max-verstappen', classification_status: ['classified'] } } } as F1QLProgram,
      reason: 'classification_filter_combination_unsupported'
    },
    {
      name: 'multiple classification statuses',
      program: { version: 1, root: { op: 'event_classification', season: 2025, round: 7, limit: 30, filters: { classification_status: ['dnf', 'dns'] } } } as F1QLProgram,
      reason: 'classification_filter_combination_unsupported'
    },
    {
      name: 'qualifying-session metadata',
      program: { version: 1, root: { op: 'event_metadata', season: 2025, round: 7, session_scope: 'qualifying' } } as F1QLProgram,
      reason: 'session_scope_unsupported'
    },
    {
      name: 'unknown operation',
      program: { version: 1, root: { op: 'drop_everything', input: standingsAggregate(2025).root } } as unknown as F1QLProgram,
      reason: 'capability_unsupported'
    }
  ])('rejects $name', ({ program, reason }) => {
    expect(authorizeAnswerProgram(program)).toEqual({ type: 'rejected', reason });
  });

  it('approves isolated position selection and rejects position composites', () => {
    expect(authorizeAnswerProgram({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 3, filters: { finishing_position: [1, 2, 3] } } })).toMatchObject({
      type: 'approved', capability: { source: 'race_classification', filters: ['position'] }
    });
    expect(authorizeAnswerProgram({ version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { qualifying_position: [2], driver_id: 'lando-norris' } } })).toEqual({
      type: 'rejected', reason: 'classification_filter_combination_unsupported'
    });
    expect(authorizeAnswerProgram({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { finishing_position: [1, 2, 3] } } })).toEqual({
      type: 'rejected', reason: 'classification_filter_combination_unsupported'
    });
  });

  it('authorizes only the exact reviewed current-standings shape', () => {
    const current = materializeAnswerTemplate('current_standings', { season: 2026 });
    if (current.root.op !== 'rank') throw new Error('fixture must rank');
    const mutations: F1QLProgram[] = [
      { ...current, root: { ...current.root, direction: 'desc' } },
      { ...current, root: { ...current.root, by: 'points' } },
      { ...current, root: { ...current.root, limit: 29 } },
      { ...current, root: { ...current.root, input: { ...current.root.input, measures: [{ as: 'points', function: 'max', field: 'points' }] } } },
      { ...current, root: { ...current.root, input: { ...current.root.input, input: { ...current.root.input.input, where: { season: 2026, driver_id: 'lando-norris' } } } } }
    ];
    for (const program of mutations) {
      expect(authorizeAnswerProgram(program)).toEqual({ type: 'rejected', reason: 'interim_standings_unsupported' });
    }
  });

  it('rejects malformed season-summary integrity shapes', () => {
    const summary = materializeAnswerTemplate('driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' });
    if (summary.root.op !== 'aggregate') throw new Error('fixture must aggregate');
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, measures: summary.root.measures.slice(0, 2) } })).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, measures: [...summary.root.measures.slice(0, 2), { as: 'standing_rows', function: 'sum', field: 'points' }] } })).toEqual({
      type: 'rejected', reason: 'capability_unsupported'
    });
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, input: { ...summary.root.input, where: { season: 2025, driver_id: ['max-verstappen'] } } } })).toEqual({
      type: 'rejected', reason: 'capability_unsupported'
    });
  });

  it('rejects malformed or broadened career-summary shapes', () => {
    const summary = materializeAnswerTemplate('driver_career_official_summary', { driver_id: 'lewis-hamilton' });
    if (summary.root.op !== 'aggregate' || summary.root.input.op !== 'filter') throw new Error('fixture must aggregate');
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, measures: summary.root.measures.slice(0, 1) } })).toEqual({ type: 'rejected', reason: 'temporal_scope_unsupported' });
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, input: { ...summary.root.input, where: { ...summary.root.input.where, season: [1950, 2025] } } } })).toEqual({
      type: 'rejected', reason: 'temporal_scope_unsupported'
    });
    const seasons = summary.root.input.where.season as number[];
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, input: { ...summary.root.input, where: { ...summary.root.input.where, season: [...seasons.slice(0, -1), 2026] } } } })).toEqual({
      type: 'rejected', reason: 'temporal_scope_unsupported'
    });
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, input: { ...summary.root.input, where: { ...summary.root.input.where, driver_id: ['lewis-hamilton'] } } } })).toEqual({
      type: 'rejected', reason: 'temporal_scope_unsupported'
    });
    expect(authorizeAnswerProgram({ ...summary, root: { ...summary.root, input: { ...summary.root.input, input: { op: 'source', source: 'other' } } } } as never)).toEqual({
      type: 'rejected', reason: 'temporal_scope_unsupported'
    });
  });

  it('authorizes only the exact race H2H root shape', () => {
    const h2h = materializeAnswerTemplate('race_season_finishing_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
    const root = h2h.root;
    if (root.op !== 'race_season_finishing_position_h2h') throw new Error('fixture must be H2H');
    for (const mutated of [
      { ...root, season: 2026 }, { ...root, driver_b_id: root.driver_a_id }, { ...root, driver_a_id: 'Lando Norris' }, { ...root, metric: 'other' }, { ...root, round: 1 }
    ]) {
      expect(authorizeAnswerProgram({ version: 1, root: mutated } as unknown as F1QLProgram)).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    }
  });

  it('authorizes only the exact qualifying H2H root shape and metric', () => {
    const h2h = materializeAnswerTemplate('qualifying_season_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
    const root = h2h.root;
    if (root.op !== 'qualifying_season_position_h2h') throw new Error('fixture must be H2H');
    for (const mutated of [
      { ...root, season: 2026 }, { ...root, driver_b_id: root.driver_a_id }, { ...root, driver_a_id: 'Lando Norris' },
      { ...root, metric: 'official_race_finishing_position_shared_events_v1' }, { ...root, round: 1 }
    ]) {
      expect(authorizeAnswerProgram({ version: 1, root: mutated } as unknown as F1QLProgram)).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    }
  });

  it('authorizes only the exact official driver-results comparison root', () => {
    const comparison = materializeAnswerTemplate('official_driver_results_comparison', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
    const root = comparison.root;
    if (root.op !== 'official_driver_results_comparison') throw new Error('fixture must be comparison');
    for (const mutated of [
      { ...root, season: 2026 }, { ...root, driver_b_id: root.driver_a_id }, { ...root, driver_a_id: 'Lando Norris' },
      { ...root, metric: 'official_race_finishing_position_shared_events_v1' }, { ...root, include_pace: true }
    ]) {
      expect(authorizeAnswerProgram({ version: 1, root: mutated } as unknown as F1QLProgram)).toEqual({ type: 'rejected', reason: 'capability_unsupported' });
    }
  });
});
