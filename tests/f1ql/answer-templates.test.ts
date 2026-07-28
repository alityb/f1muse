import { describe, expect, it } from 'vitest';
import { ANSWER_ALL_CLASSIFICATION_MAX_SEASON, ANSWER_ALL_CLASSIFICATION_MIN_SEASON, ANSWER_TEMPLATE_IDS, ANSWER_TEMPLATE_REGISTRY, ANSWER_TEMPLATE_REGISTRY_CONTRACT, ANSWER_TEMPLATE_REGISTRY_HASH, computeAnswerTemplateRegistryHash, materializeAnswerTemplate, validateAnswerTemplateVariables } from '../../src/f1ql/answer-templates';
import { normalizeF1QLProgram } from '../../src/f1ql/verified-programs';

describe('answer template registry', () => {
  const cases = [
    ['final_standings_points', { season: 2025, driver_ids: ['lando-norris'] }, 'aggregate'],
    ['final_standings_leader', { season: 2025 }, 'rank'],
    ['current_standings', { season: 2026 }, 'rank'],
    ['driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' }, 'aggregate'],
    ['driver_career_official_summary', { driver_id: 'lewis-hamilton' }, 'aggregate'],
    ['race_season_finishing_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }, 'race_season_finishing_position_h2h'],
    ['qualifying_season_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }, 'qualifying_season_position_h2h'],
    ['race_classification_all', { season: 2025, round: 7 }, 'event_classification'],
    ['race_classification_driver', { season: 2025, round: 7, driver_id: 'max-verstappen' }, 'event_classification'],
    ['race_classification_status', { season: 2025, round: 7, status: 'dsq' }, 'event_classification'],
    ['qualifying_classification_all', { season: 2025, round: 7 }, 'qualifying_classification'],
    ['qualifying_classification_driver', { season: 2025, round: 7, driver_id: 'max-verstappen' }, 'qualifying_classification'],
    ['qualifying_classification_status', { season: 2025, round: 7, status: 'dns' }, 'qualifying_classification'],
    ['race_classification_position', { season: 2025, round: 7, positions: [1, 2, 3] }, 'event_classification'],
    ['qualifying_classification_position', { season: 2025, round: 7, positions: [3] }, 'qualifying_classification'],
    ['race_date', { season: 2025, round: 7 }, 'event_metadata']
  ] as const;

  it('has an exact immutable versioned registry', () => {
    expect(ANSWER_TEMPLATE_REGISTRY).toEqual({ version: 'answer-templates-v8', template_ids: [...ANSWER_TEMPLATE_IDS], contracts: ANSWER_TEMPLATE_REGISTRY_CONTRACT });
    expect(ANSWER_TEMPLATE_IDS).toHaveLength(16);
    expect(Object.isFrozen(ANSWER_TEMPLATE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(ANSWER_TEMPLATE_IDS)).toBe(true);
    expect(Object.isFrozen(ANSWER_TEMPLATE_REGISTRY_CONTRACT)).toBe(true);
    expect(ANSWER_TEMPLATE_REGISTRY_HASH).toHaveLength(64);
  });

  it('hashes the explicit closed variable and materialization contract', () => {
    const changedContract = {
      ...ANSWER_TEMPLATE_REGISTRY_CONTRACT,
      race_date: { ...ANSWER_TEMPLATE_REGISTRY_CONTRACT.race_date, semantic: 'changed semantics' }
    };
    expect(computeAnswerTemplateRegistryHash(materializeAnswerTemplate, changedContract)).not.toBe(ANSWER_TEMPLATE_REGISTRY_HASH);
    expect(ANSWER_TEMPLATE_REGISTRY_CONTRACT.race_classification_status.variables.status.values).toEqual(['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn']);
    expect(ANSWER_TEMPLATE_REGISTRY_CONTRACT.qualifying_classification_status.variables.status.values).toEqual(['classified', 'dnf', 'dns']);
  });

  it('binds the registry hash to materialized template semantics, not only IDs', () => {
    const changed = computeAnswerTemplateRegistryHash((template, variables) => {
      const program = materializeAnswerTemplate(template, variables);
      if (template !== 'race_date' || program.root.op !== 'event_metadata') return program;
      return { ...program, root: { ...program.root, session_scope: 'qualifying' } };
    });
    expect(changed).not.toBe(ANSWER_TEMPLATE_REGISTRY_HASH);
    expect(computeAnswerTemplateRegistryHash()).toBe(ANSWER_TEMPLATE_REGISTRY_HASH);
  });

  it.each(cases)('materializes canonical %s', (template, variables, operation) => {
    const program = materializeAnswerTemplate(template, variables);
    expect(program.root.op).toBe(operation);
    expect(program).toEqual(normalizeF1QLProgram(program));
    expect(Object.isFrozen(program)).toBe(true);
  });

  it('owns official leader ordering, classification limits, and race session scope', () => {
    expect(materializeAnswerTemplate('final_standings_leader', { season: 2025 }).root).toMatchObject({ by: 'championship_position', direction: 'asc', limit: 1 });
    expect(materializeAnswerTemplate('race_classification_all', { season: 2025, round: 1 }).root).toMatchObject({ limit: 30 });
    expect(materializeAnswerTemplate('qualifying_classification_all', { season: 2025, round: 1 }).root).toMatchObject({ limit: 30 });
    expect(materializeAnswerTemplate('race_date', { season: 2025, round: 1 }).root).toMatchObject({ session_scope: 'race' });
  });

  it('owns latest-recorded official ordering and exact reviewed season', () => {
    expect(materializeAnswerTemplate('current_standings', { season: 2026 }).root).toEqual({
      op: 'rank',
      input: {
        op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2026 } }, group_by: ['driver_id'],
        measures: [{ as: 'championship_position', function: 'min', field: 'championship_position' }, { as: 'points', function: 'max', field: 'points' }]
      },
      by: 'championship_position', direction: 'asc', limit: 30
    });
    expect(() => materializeAnswerTemplate('current_standings', { season: 2025 })).toThrow();
    expect(() => materializeAnswerTemplate('current_standings', { season: 2027 })).toThrow();
  });

  it('owns the final driver season standing summary and integrity count', () => {
    expect(materializeAnswerTemplate('driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' }).root).toEqual({
      op: 'aggregate',
      input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025, driver_id: 'max-verstappen' } },
      group_by: ['driver_id'],
      measures: [
        { as: 'championship_position', function: 'min', field: 'championship_position' },
        { as: 'points', function: 'max', field: 'points' },
        { as: 'standing_rows', function: 'count' }
      ]
    });
  });

  it('owns the bounded final-standings career summary', () => {
    const root = materializeAnswerTemplate('driver_career_official_summary', { driver_id: 'lewis-hamilton' }).root;
    expect(root).toMatchObject({
      op: 'aggregate',
      input: { op: 'filter', where: { driver_id: 'lewis-hamilton' } },
      group_by: ['driver_id'],
      measures: [
        { as: 'best_championship_position', function: 'min', field: 'championship_position' },
        { as: 'recorded_final_standings_rows', function: 'count' }
      ]
    });
    if (root.op !== 'aggregate' || root.input.op !== 'filter') throw new Error('fixture must filter');
    expect(root.input.where.season).toEqual(Array.from({ length: 76 }, (_, index) => 1950 + index));
  });

  it('owns the exact ordered final-season race H2H root', () => {
    expect(materializeAnswerTemplate('race_season_finishing_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }).root).toEqual({
      op: 'race_season_finishing_position_h2h', metric: 'official_race_finishing_position_shared_events_v1', season: 2025,
      driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri'
    });
    expect(() => materializeAnswerTemplate('race_season_finishing_position_h2h', { season: 2026, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' })).toThrow();
    expect(() => materializeAnswerTemplate('race_season_finishing_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'lando-norris' })).toThrow();
  });

  it('owns the exact ordered final-season qualifying H2H root', () => {
    expect(materializeAnswerTemplate('qualifying_season_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' }).root).toEqual({
      op: 'qualifying_season_position_h2h', metric: 'official_qualifying_position_shared_events_v1', season: 2025,
      driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri'
    });
    expect(() => materializeAnswerTemplate('qualifying_season_position_h2h', { season: 2026, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' })).toThrow();
    expect(() => materializeAnswerTemplate('qualifying_season_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'lando-norris' })).toThrow();
  });

  it('materializes all final standings points without a driver filter', () => {
    const root = materializeAnswerTemplate('final_standings_points', { season: 2025 }).root;
    expect(root).toMatchObject({ op: 'aggregate', input: { op: 'filter', where: { season: 2025 } } });
    expect(root).not.toMatchObject({ input: { where: { driver_id: expect.anything() } } });
  });

  it('owns exact position filters and matching row limits', () => {
    expect(materializeAnswerTemplate('race_classification_position', { season: 2025, round: 1, positions: [1, 2, 3] }).root).toEqual({
      op: 'event_classification', season: 2025, round: 1, limit: 3, filters: { finishing_position: [1, 2, 3] }
    });
    expect(materializeAnswerTemplate('qualifying_classification_position', { season: 2025, round: 1, positions: [3] }).root).toEqual({
      op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { qualifying_position: [3] }
    });
  });

  it.each([
    ['race_classification_all', { season: 2025, round: 0 }],
    ['race_classification_all', { season: 1995, round: 1 }],
    ['race_classification_all', { season: 2027, round: 1 }],
    ['qualifying_classification_all', { season: 1995, round: 1 }],
    ['qualifying_classification_all', { season: 2027, round: 1 }],
    ['race_classification_driver', { season: 2025, round: 1, driver_id: 'Max Verstappen' }],
    ['qualifying_classification_status', { season: 2025, round: 1, status: 'dsq' }],
    ['final_standings_points', { season: [2024, 2025] }],
    ['final_standings_points', { season: 2025, driver_ids: ['lando-norris', 'lando-norris'] }],
    ['final_standings_leader', { season: 2026 }],
    ['driver_season_official_summary', { season: 2026, driver_id: 'max-verstappen' }],
    ['race_date', { season: 2025, round: 1, limit: 1 }],
    ['race_classification_position', { season: 2025, round: 1, positions: [2, 1] }],
    ['qualifying_classification_position', { season: 2025, round: 1, positions: [0] }]
  ])('rejects malformed or caller-controlled variables for %s', (template, variables) => {
    expect(() => materializeAnswerTemplate(template as never, variables)).toThrow();
  });

  it.each(['race_classification_all', 'qualifying_classification_all'] as const)('accepts exact reviewed all-classification season boundaries for %s', template => {
    expect(() => materializeAnswerTemplate(template, { season: ANSWER_ALL_CLASSIFICATION_MIN_SEASON, round: 1 })).not.toThrow();
    expect(() => materializeAnswerTemplate(template, { season: ANSWER_ALL_CLASSIFICATION_MAX_SEASON, round: 1 })).not.toThrow();
  });

  it('rejects unknown templates at runtime', () => {
    expect(() => materializeAnswerTemplate('drop_table' as never, {})).toThrow('Unknown answer template');
  });

  it('returns deeply frozen validated template variables detached from caller input', () => {
    const supplied = { season: 2025, driver_ids: ['lando-norris'] };
    const variables = validateAnswerTemplateVariables('final_standings_points', supplied);
    supplied.driver_ids[0] = 'mutated';
    expect(variables).toEqual({ season: 2025, driver_ids: ['lando-norris'] });
    expect(Object.isFrozen(variables)).toBe(true);
    expect(Object.isFrozen(variables.driver_ids)).toBe(true);
    expect(() => (variables.driver_ids as string[]).push('other')).toThrow();
  });
});
