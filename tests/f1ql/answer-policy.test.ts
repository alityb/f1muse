import { describe, expect, it } from 'vitest';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { F1QLProgram } from '../../src/f1ql/ast';

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
});
