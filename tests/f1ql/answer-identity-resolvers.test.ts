import { describe, expect, it } from 'vitest';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver } from '../../src/identity/answer-identity-resolvers';
import { acceptedEventNames } from '../../src/identity/event-resolver';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';

describe('answer event identity resolution', () => {
  it('scopes the Silverstone to British Grand Prix alias to the contracted 2025 season', async () => {
    const database = {
      query: async (_statement: string, parameters: unknown[]) => ({ rows: [
        { season: parameters[0], round: 12, identity: 'British Grand Prix' }
      ] })
    };
    const resolver = new AnswerEventIdentityResolver(database as never);

    expect(acceptedEventNames('Silverstone', 2025)).toContain('british grand prix');
    expect(acceptedEventNames('Silverstone', 2020)).not.toContain('british grand prix');
    await expect(resolver.resolve(2025, 'Silverstone')).resolves.toEqual({ type: 'resolved', season: 2025, round: 12 });
    await expect(resolver.resolve(2020, 'Silverstone')).resolves.toEqual({ type: 'missing' });
  });
});

describe('answer driver identity inventory', () => {
  it('ignores inactive function-word collisions without hiding active or material inactive identities', async () => {
    const database = {
      query: async () => ({ rows: [
        { driver_id: 'inactive-for-a', identity: 'for', participation_source: null },
        { driver_id: 'inactive-for-b', identity: 'FOR', participation_source: null },
        { driver_id: 'active-max', identity: 'Max', participation_source: 'entrant' },
        { driver_id: 'inactive-sample', identity: 'Sample Driver', participation_source: null }
      ] })
    };
    const resolver = new AnswerDriverIdentityResolver(database as never);

    await expect(resolver.inventoryMentions('Results for Max and Sample Driver', 2025)).resolves.toEqual([
      { text: 'Max', start: 12, end: 15, candidates: ['active-max'], active_candidates: ['active-max'] },
      { text: 'Sample Driver', start: 20, end: 33, candidates: ['inactive-sample'], active_candidates: [] }
    ]);
  });

  it('preserves every literal candidate when resolving without a season', async () => {
    let sql = '';
    const database = {
      query: async (statement: string) => {
        sql = statement;
        return { rows: [
          { driver_id: 'alex-one', identity: 'Alex Smith' },
          { driver_id: 'alex-two', identity: 'Alex Smith' }
        ] };
      }
    };
    const resolver = new AnswerDriverIdentityResolver(database as never);

    await expect(resolver.inventoryMentions('Show Alex Smith official career summary.')).resolves.toEqual([
      { text: 'Alex Smith', start: 5, end: 15, candidates: ['alex-one', 'alex-two'], active_candidates: ['alex-one', 'alex-two'] }
    ]);
    expect(sql).toContain('FROM f1ql.answer_driver_identity');
    expect(sql).not.toContain('answer_season_participation');
  });

  it('ignores historical-driver collisions in the exact public career and comparison questions', async () => {
    const database = {
      query: async (statement: string) => ({ rows: statement.includes('answer_season_participation')
        ? [
            { driver_id: 'bob-anderson', identity: 'and', participation_source: null },
            { driver_id: 'conny-andersson', identity: 'and', participation_source: null },
            { driver_id: 'lando-norris', identity: 'Norris', participation_source: 'entrant' },
            { driver_id: 'oscar-piastri', identity: 'Piastri', participation_source: 'entrant' }
          ]
        : [
            { driver_id: 'masahiro-hasemi', identity: 'has' },
            { driver_id: 'lewis-hamilton', identity: 'Lewis Hamilton' }
          ] })
    };
    const resolver = new AnswerDriverIdentityResolver(database as never);
    const career = createAnswerQuestionContract('At which circuits has Lewis Hamilton won races?');
    const comparison = createAnswerQuestionContract('Compare the official 2025 results of Norris and Piastri.');

    await expect(resolver.inventoryMentions(career.normalized_question)).resolves.toEqual([
      { text: 'Lewis Hamilton', start: 22, end: 36, candidates: ['lewis-hamilton'], active_candidates: ['lewis-hamilton'] }
    ]);
    await expect(deriveAnswerIntent(career, resolver)).resolves.toMatchObject({ type: 'driver_career_wins_by_circuit' });
    await expect(resolver.inventoryMentions(comparison.normalized_question, 2025)).resolves.toEqual([
      { text: 'Norris', start: 37, end: 43, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
      { text: 'Piastri', start: 48, end: 55, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
    ]);
    await expect(deriveAnswerIntent(comparison, resolver)).resolves.toMatchObject({ type: 'official_driver_results_comparison' });
  });
});
