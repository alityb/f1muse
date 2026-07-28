import { describe, expect, it } from 'vitest';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { F1QLProgram } from '../../src/f1ql/ast';
import { AnswerFormatError, buildAnswerEnvelope, formatAnswerRows } from '../../src/f1ql/answer-format';
import { materializeAnswerTemplate } from '../../src/f1ql/answer-templates';

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
  const h2h = materializeAnswerTemplate('race_season_finishing_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
  const h2hRow = {
    metric_id: 'official_race_finishing_position_shared_events_v1', season: 2025,
    driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri', driver_a_ahead: 1, driver_b_ahead: 1, ties: 1,
    shared_events: 3, driver_a_source_rows: 6, driver_b_source_rows: 4, distinct_source_keys: 10,
    duplicate_source_rows: 0, source_presence_ok: true, source_unique_keys_ok: true, source_integrity_ok: true
  };
  const qualifyingH2H = materializeAnswerTemplate('qualifying_season_position_h2h', { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'max-verstappen' });
  const qualifyingH2HRow = {
    ...h2hRow, metric_id: 'official_qualifying_position_shared_events_v1', driver_b_id: 'max-verstappen',
    driver_a_ahead: 2, driver_b_ahead: 1, ties: 1, shared_events: 4,
    driver_a_source_rows: 6, driver_b_source_rows: 5, distinct_source_keys: 11
  };
  const careerWins = materializeAnswerTemplate('driver_career_wins_by_circuit', { driver_id: 'lewis-hamilton' });
  const careerWinSentinels = {
    metric_id: 'official_race_p1_by_circuit_1950_2025_v1', driver_id: 'lewis-hamilton',
    winner_source_rows: 4, distinct_winner_event_keys: 4, duplicate_winner_rows: 0,
    metadata_source_rows: 4, distinct_metadata_event_keys: 4, missing_event_metadata_rows: 0,
    duplicate_event_metadata_rows: 0, missing_circuit_id_rows: 0, source_presence_ok: true, source_integrity_ok: true
  };

  it('formats canonical ordered career wins grouped by circuit ID', () => {
    expect(formatAnswerRows(careerWins, approved(careerWins), [
      { ...careerWinSentinels, circuit_id: 'silverstone', wins: 2 },
      { ...careerWinSentinels, circuit_id: 'albert-park', wins: 1 },
      { ...careerWinSentinels, circuit_id: 'monza', wins: 1 }
    ])).toEqual({
      answer: {
        headline: 'Official race wins by circuit through 2025 for lewis-hamilton.',
        facts: [
          { subject: 'silverstone', values: { wins: '2' } },
          { subject: 'albert-park', values: { wins: '1' } },
          { subject: 'monza', values: { wins: '1' } }
        ]
      },
      coverage: 'sufficient', caveats: ['completed_seasons_1950_2025_only', 'canonical_circuit_ids']
    });
  });

  it('fails closed for malformed, inconsistent, duplicated, or misordered career wins', () => {
    const valid = [
      { ...careerWinSentinels, circuit_id: 'silverstone', wins: 2 },
      { ...careerWinSentinels, circuit_id: 'albert-park', wins: 1 },
      { ...careerWinSentinels, circuit_id: 'monza', wins: 1 }
    ];
    for (const rows of [
      [{ ...valid[0], source_integrity_ok: false }],
      [{ ...valid[0], duplicate_winner_rows: 1 }],
      [{ ...valid[0], wins: 3 }],
      [valid[0], { ...valid[1], winner_source_rows: 5 }, valid[2]],
      [valid[0], valid[1], { ...valid[2], circuit_id: 'albert-park' }],
      [valid[1], valid[0], valid[2]],
      [valid[0], valid[2], valid[1]]
    ]) {
      expect(() => formatAnswerRows(careerWins, approved(careerWins), rows)).toThrow(AnswerFormatError);
    }
  });

  it('formats race H2H with explicit shared-position methodology', () => {
    expect(formatAnswerRows(h2h, approved(h2h), [h2hRow])).toEqual({
      answer: {
        headline: 'lando-norris and oscar-piastri finished ahead equally often. Final 2025 race finishing-position H2H.',
        facts: [{ subject: 'lando-norris vs oscar-piastri', values: { driver_a_ahead: '1', driver_b_ahead: '1', ties: '1', shared_events: '3' } }]
      },
      coverage: 'sufficient', caveats: ['shared_events_require_both_recorded_numeric_finishing_positions', 'null_or_one_sided_events_excluded']
    });
  });

  it('accepts a valid 24-round H2H result with 48 distinct source keys', () => {
    expect(formatAnswerRows(h2h, approved(h2h), [{
      ...h2hRow, driver_a_ahead: 12, driver_b_ahead: 10, ties: 2, shared_events: 24,
      driver_a_source_rows: 24, driver_b_source_rows: 24, distinct_source_keys: 48
    }])).toMatchObject({
      coverage: 'sufficient',
      answer: { headline: 'lando-norris finished ahead more often. Final 2025 race finishing-position H2H.' }
    });
  });

  it('fails closed for malformed or integrity-failed race H2H data', () => {
    expect(() => formatAnswerRows(h2h, approved(h2h), [])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(h2h, approved(h2h), [h2hRow, h2hRow])).toThrow(AnswerFormatError);
    for (const mutation of [
      { metric_id: 'other' }, { driver_a_id: 'other' }, { source_integrity_ok: false }, { source_presence_ok: false },
      { source_unique_keys_ok: false }, { duplicate_source_rows: 1 }, { driver_a_source_rows: 0 }, { shared_events: 0 },
      { driver_a_ahead: 31 }, { ties: -1 }, { shared_events: 4 }, { distinct_source_keys: 9 }, { distinct_source_keys: 61 },
      { driver_a_source_rows: 31, distinct_source_keys: 35 }, { driver_a_source_rows: 2, distinct_source_keys: 6 }
    ]) {
      expect(() => formatAnswerRows(h2h, approved(h2h), [{ ...h2hRow, ...mutation }])).toThrow(AnswerFormatError);
    }
  });

  it('formats only qualifying-position H2H without time-gap or teammate claims', () => {
    expect(formatAnswerRows(qualifyingH2H, approved(qualifyingH2H), [qualifyingH2HRow])).toEqual({
      answer: {
        headline: 'lando-norris qualified ahead more often. Final 2025 qualifying-position H2H.',
        facts: [{ subject: 'lando-norris vs max-verstappen', values: { driver_a_ahead: '2', driver_b_ahead: '1', ties: '1', shared_events: '4' } }]
      },
      coverage: 'sufficient',
      caveats: ['shared_events_require_both_recorded_numeric_qualifying_positions', 'no_qualifying_time_gap_or_teammate_claim']
    });
  });

  it('fails closed for malformed or integrity-failed qualifying H2H data', () => {
    for (const mutation of [
      { metric_id: 'other' }, { season: 2024 }, { driver_b_id: 'other' }, { source_integrity_ok: false },
      { source_presence_ok: false }, { source_unique_keys_ok: false }, { driver_a_source_rows: 0 },
      { driver_b_source_rows: 31 }, { distinct_source_keys: 0 }, { distinct_source_keys: 61 },
      { duplicate_source_rows: 1 }, { shared_events: 0 }, { shared_events: 6 }, { ties: 2 }
    ]) {
      expect(() => formatAnswerRows(qualifyingH2H, approved(qualifyingH2H), [{ ...qualifyingH2HRow, ...mutation }])).toThrow(AnswerFormatError);
    }
  });
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

  it('formats latest-recorded standings with distinct in-progress semantics', () => {
    const current = materializeAnswerTemplate('current_standings', { season: 2026 });
    const formatted = formatAnswerRows(current, approved(current), [
      { driver_id: 'lando-norris', championship_position: '1', points: '42.000' },
      { driver_id: 'oscar-piastri', championship_position: 2, points: 42 }
    ]);
    expect(formatted).toEqual({
      answer: {
        headline: 'Latest recorded 2026 driver standings.',
        facts: [
          { subject: 'lando-norris', values: { championship_position: '1', points: '42' } },
          { subject: 'oscar-piastri', values: { championship_position: '2', points: '42' } }
        ]
      },
      coverage: 'sufficient', caveats: ['season_in_progress']
    });
  });

  it('fails closed for missing, duplicate, or non-increasing current positions', () => {
    const current = materializeAnswerTemplate('current_standings', { season: 2026 });
    const row = (driver_id: string, championship_position?: unknown) => ({ driver_id, championship_position, points: 1 });
    expect(() => formatAnswerRows(current, approved(current), [row('one')])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(current, approved(current), [row('one', 1), row('other-one', 1)])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(current, approved(current), [row('two', 2), row('one', 1)])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(current, approved(current), [row('one', 1), row('three', 3)])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(current, approved(current), [row('two', 2)])).toThrow(AnswerFormatError);
  });

  it('formats only final recorded season-summary facts', () => {
    const summary = materializeAnswerTemplate('driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' });
    expect(formatAnswerRows(summary, approved(summary), [{ driver_id: 'max-verstappen', championship_position: 3, points: '25.000', standing_rows: '1' }])).toEqual({
      answer: {
        headline: 'Official final 2025 championship standing summary for max-verstappen.',
        facts: [{ subject: 'max-verstappen', values: { championship_position: '3', points: '25' } }]
      },
      coverage: 'sufficient', caveats: []
    });
  });

  it('fails closed for duplicate, substituted, or mismatched season-summary rows', () => {
    const summary = materializeAnswerTemplate('driver_season_official_summary', { season: 2025, driver_id: 'max-verstappen' });
    const row = { driver_id: 'max-verstappen', championship_position: 3, points: 25, standing_rows: 1 };
    expect(() => formatAnswerRows(summary, approved(summary), [row, row])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(summary, approved(summary), [{ ...row, driver_id: 'lando-norris' }])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(summary, approved(summary), [{ ...row, standing_rows: 2 }])).toThrow(AnswerFormatError);
    for (const championship_position of [null, 0, -1, 1.5]) {
      expect(() => formatAnswerRows(summary, approved(summary), [{ ...row, championship_position }])).toThrow(AnswerFormatError);
    }
    expect(formatAnswerRows(summary, approved(summary), [{ ...row, championship_position: 31 }]).answer.facts[0].values.championship_position).toBe('31');
  });

  it('formats only bounded final-standings career facts', () => {
    const summary = materializeAnswerTemplate('driver_career_official_summary', { driver_id: 'lewis-hamilton' });
    expect(formatAnswerRows(summary, approved(summary), [{ driver_id: 'lewis-hamilton', best_championship_position: 1, recorded_final_standings_rows: '2' }])).toEqual({
      answer: {
        headline: 'Recorded final championship standings career summary for lewis-hamilton.',
        facts: [{ subject: 'lewis-hamilton', values: { best_championship_position: '1', recorded_final_standings_rows: '2' } }]
      },
      coverage: 'sufficient', caveats: ['final_standings_rows_only']
    });
  });

  it('fails closed for malformed career-summary rows', () => {
    const summary = materializeAnswerTemplate('driver_career_official_summary', { driver_id: 'lewis-hamilton' });
    const row = { driver_id: 'lewis-hamilton', best_championship_position: 1, recorded_final_standings_rows: 2 };
    expect(() => formatAnswerRows(summary, approved(summary), [row, row])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(summary, approved(summary), [{ ...row, driver_id: 'other-driver' }])).toThrow(AnswerFormatError);
    for (const value of [null, 0, -1, 1.5]) {
      expect(() => formatAnswerRows(summary, approved(summary), [{ ...row, best_championship_position: value }])).toThrow(AnswerFormatError);
      expect(() => formatAnswerRows(summary, approved(summary), [{ ...row, recorded_final_standings_rows: value }])).toThrow(AnswerFormatError);
    }
  });
});
