import { describe, expect, it } from 'vitest';
import { AnswerCapability, authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { AnswerBoundError, enforceAnswerRows, enforceAnswerWorkBudget, enforceVerifiedAnswerWorkBudget, estimateAnswerWork, estimateVerifiedAnswerWork, serializeAnswerResponse } from '../../src/f1ql/answer-bounds';
import { F1QLProgram } from '../../src/f1ql/ast';
import { materializeAnswerTemplate } from '../../src/f1ql/answer-templates';
import { addCollectionSentinel, F1QLCostLimitError } from '../../src/f1ql/executor';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { proveAnswerIntent } from '../../src/f1ql/answer-semantic-proof';

const programs: F1QLProgram[] = [
  { version: 1, root: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'max', field: 'points' }] } },
  { version: 1, root: { op: 'rank', input: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025, driver_id: ['a', 'b'] } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'max', field: 'points' }] }, by: 'points', direction: 'desc', limit: 2 } },
  { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 30 } },
  { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 20 } },
  { version: 1, root: { op: 'event_metadata', season: 2025, round: 1, session_scope: 'race' } },
  materializeAnswerTemplate('current_standings', { season: 2026 })
];

function capability(program: F1QLProgram): AnswerCapability {
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved') throw new Error('fixture must be approved');
  return decision.capability;
}

describe('answer bounds', () => {
  it.each(['race_season_finishing_position_h2h', 'qualifying_season_position_h2h'] as const)('charges two complete season branches and requests one %s row', template => {
    const h2h = materializeAnswerTemplate(template, { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
    expect(estimateAnswerWork(h2h, capability(h2h))).toEqual({ version: 'answer-work-v6', units: 60, requested_rows: 1 });
  });
  it.each(programs)('estimates approved work deterministically for $root.op', program => {
    const first = estimateAnswerWork(program, capability(program));
    expect(first).toEqual(estimateAnswerWork(program, capability(program)));
    expect(first.units).toBeGreaterThan(0);
    expect(first.requested_rows).toBeGreaterThan(0);
  });

  it('enforces the exact work-unit boundary', () => {
    const program = programs[2];
    const approved = capability(program);
    const estimate = estimateAnswerWork(program, approved);
    expect(enforceAnswerWorkBudget(program, approved, estimate.units)).toEqual(estimate);
    expect(() => enforceAnswerWorkBudget(program, approved, estimate.units - 1)).toThrow(AnswerBoundError);
  });

  it('bounds a driver season summary to one row and 36 work units', () => {
    const summary = materializeAnswerTemplate('driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' });
    expect(estimateAnswerWork(summary, capability(summary))).toEqual({ version: 'answer-work-v6', units: 36, requested_rows: 1 });
  });

  it('charges all 76 final seasons while bounding a driver career summary to one row', () => {
    const summary = materializeAnswerTemplate('driver_career_official_summary', { driver_id: 'lewis-hamilton' });
    expect(estimateAnswerWork(summary, capability(summary))).toEqual({ version: 'answer-work-v6', units: 107, requested_rows: 1 });
  });

  it('charges both 76-season career-win sources and bounds grouped circuits', () => {
    const wins = materializeAnswerTemplate('driver_career_wins_by_circuit', { driver_id: 'lewis-hamilton' });
    expect(estimateAnswerWork(wins, capability(wins))).toEqual({ version: 'answer-work-v6', units: 172, requested_rows: 100 });
  });

  it('bounds the pinned three-driver final ranking to three rows', () => {
    const ranking = materializeAnswerTemplate('final_standings_driver_ranking', { season: 2025, driver_ids: ['max-verstappen', 'lando-norris', 'oscar-piastri'] });
    expect(estimateAnswerWork(ranking, capability(ranking))).toEqual({ version: 'answer-work-v6', units: 38, requested_rows: 3 });
  });

  it('enforces row and exact UTF-8 byte boundaries', () => {
    const rows = [{ driver_id: 'norris' }, { driver_id: 'piastri' }];
    expect(() => enforceAnswerRows(rows, 1)).toThrowError(expect.objectContaining({ bound: 'rows', actual: 2 }));
    const response = { event: 'São Paulo' };
    const serialized = JSON.stringify(response);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    expect(serializeAnswerResponse(response, bytes)).toBe(serialized);
    expect(() => serializeAnswerResponse(response, bytes - 1)).toThrowError(expect.objectContaining({ bound: 'response_bytes', actual: bytes }));
  });

  it('adds a max-plus-one collection sentinel without changing existing parameters', () => {
    expect(addCollectionSentinel('SELECT * FROM source WHERE season = $1 ORDER BY position', [2025], 10, 'position ASC, driver_id ASC')).toEqual({
      sql: 'SELECT * FROM (SELECT * FROM source WHERE season = $1 ORDER BY position) AS f1ql_bounded_result ORDER BY position ASC, driver_id ASC LIMIT $2',
      params: [2025, 11]
    });
    expect(() => addCollectionSentinel('SELECT 1', [], 101)).toThrow(F1QLCostLimitError);
  });

  it('rejects invalid maxima and mismatched capability tuples', () => {
    const program = programs[4];
    expect(() => enforceAnswerRows([], Number.NaN)).toThrow(AnswerBoundError);
    expect(() => serializeAnswerResponse({}, Number.POSITIVE_INFINITY)).toThrow(AnswerBoundError);
    expect(() => estimateAnswerWork(program, { ...capability(program), season: 2024 })).toThrow('did not match');
  });

  it('estimates route work only from a module-verified semantic proof', async () => {
    const question = 'Who led the 2025 standings?';
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 12, end: 16 }
    }, {
      resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' })
    }, { inventoryMentions: async () => [] });
    const estimate = estimateVerifiedAnswerWork(proof);
    expect(enforceVerifiedAnswerWorkBudget(proof, estimate.units, estimate.requested_rows)).toEqual(estimate);
    expect(() => estimateVerifiedAnswerWork({ ...proof } as never)).toThrow();
  });
});
