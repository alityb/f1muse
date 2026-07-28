import { describe, expect, it } from 'vitest';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { F1QLProgram } from '../../src/f1ql/ast';
import { AnswerFormatError, buildAnswerEnvelope, formatAnswerRows } from '../../src/f1ql/answer-format';

function approved(program: F1QLProgram) {
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved') throw new Error('fixture must be approved');
  return decision.capability;
}

const standings: F1QLProgram = {
  version: 1,
  root: {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } },
    group_by: ['driver_id'],
    measures: [{ as: 'points', function: 'max', field: 'points' }]
  }
};

describe('deterministic answer formatting', () => {
  it('sorts unranked standings and normalizes numeric strings without changing raw rows', () => {
    const rows = [{ driver_id: 'norris', points: '357.000' }, { driver_id: 'leclerc', points: null }];
    const envelope = buildAnswerEnvelope(standings, approved(standings), rows);
    expect(envelope.answer.facts).toEqual([
      { subject: 'leclerc', values: { points: null } },
      { subject: 'norris', values: { points: '357' } }
    ]);
    expect(envelope.rows).toEqual(rows);
    expect(envelope.program_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.metadata).toMatchObject({ source: 'final_driver_standings', coverage: { status: 'sufficient', rows_returned: 2 } });
  });

  it('preserves classification nulls and reports a reached limit', () => {
    const program: F1QLProgram = { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1 } };
    const formatted = formatAnswerRows(program, approved(program), [{
      driver_id: 'hadjar', finishing_position: null, points: '0.000', classification_status: 'dnf', status_reason: null
    }]);
    expect(formatted).toMatchObject({
      coverage: 'possibly_truncated',
      answer: { facts: [{ subject: 'hadjar', values: { finishing_position: null, points: '0', classification_status: 'dnf', status_reason: null } }] }
    });
  });

  it('treats a complete position selection as sufficient', () => {
    const program: F1QLProgram = { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { finishing_position: [2] } } };
    expect(formatAnswerRows(program, approved(program), [{ driver_id: 'piastri', finishing_position: 2, points: '18', classification_status: 'classified', status_reason: null }]))
      .toMatchObject({ coverage: 'sufficient', caveats: [] });
  });

  it('fails closed when selected classification positions are missing, duplicated, or substituted', () => {
    const program: F1QLProgram = { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 3, filters: { finishing_position: [1, 2, 3] } } };
    const row = (driver_id: string, finishing_position: number) => ({ driver_id, finishing_position, points: '0', classification_status: 'classified', status_reason: null });
    expect(() => formatAnswerRows(program, approved(program), [])).toThrow('Selected classification positions were incomplete');
    expect(() => formatAnswerRows(program, approved(program), [row('one', 1), row('two', 2)])).toThrow('Selected classification positions were incomplete');
    expect(() => formatAnswerRows(program, approved(program), [row('one', 1), row('other-one', 1), row('three', 3)])).toThrow('Selected classification positions were incomplete');
    expect(() => formatAnswerRows(program, approved(program), [row('one', 1), row('two', 2), row('four', 4)])).toThrow('Selected classification positions were incomplete');
  });

  it('formats qualifying and metadata source contracts', () => {
    const qualifying: F1QLProgram = { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 2, limit: 30, filters: { driver_id: 'piastri' } } };
    expect(formatAnswerRows(qualifying, approved(qualifying), [{ driver_id: 'piastri', qualifying_position: 1, best_time_ms: '90250', best_session: 'q3', eliminated_in_round: null, classification_status: 'classified' }]).answer.facts[0])
      .toEqual({ subject: 'piastri', values: { qualifying_position: '1', best_time_ms: '90250', best_session: 'q3', eliminated_in_round: null, classification_status: 'classified' } });

    const metadata: F1QLProgram = { version: 1, root: { op: 'event_metadata', season: 2025, round: 3, session_scope: 'race' } };
    expect(formatAnswerRows(metadata, approved(metadata), [{ event_id: 'japanese-grand-prix', event_name: 'Japanese Grand Prix', circuit_id: 'suzuka', date: '2025-04-06', session_scope: 'race' }]).answer.facts[0])
      .toMatchObject({ subject: 'Japanese Grand Prix', values: { date: '2025-04-06', session_scope: 'race' } });
  });

  it('treats empty rows as unavailable rather than factual zero', () => {
    expect(formatAnswerRows(standings, approved(standings), [])).toEqual({
      answer: { headline: 'No matching source rows were available.', facts: [] },
      coverage: 'empty',
      caveats: ['empty_result_is_not_zero']
    });
  });

  it('fails closed for malformed source rows', () => {
    expect(() => formatAnswerRows(standings, approved(standings), [{ points: 10 }])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(standings, approved(standings), [{ driver_id: 'norris', points: false }])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(standings, approved(standings), [{ driver_id: 'norris', points: 'not-a-number' }])).toThrow(AnswerFormatError);
  });

  it('normalizes decimals without losing integer precision', () => {
    const formatted = formatAnswerRows(standings, approved(standings), [{ driver_id: 'norris', points: '9007199254740993.000' }]);
    expect(formatted.answer.facts[0].values.points).toBe('9007199254740993');
  });
});
