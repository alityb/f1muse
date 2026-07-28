import { describe, expect, it } from 'vitest';
import { AnswerDriverIdentityResolver } from '../../src/identity/answer-identity-resolvers';

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
});
