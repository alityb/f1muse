import { describe, expect, it } from 'vitest';
import { hydrateAndParseAnswerIntent, parseAnswerIntent, parseUntrustedAnswerIntentCandidate } from '../../src/f1ql/answer-intent';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';

const reference = (question: string, text: string) => {
  const utf16Start = question.indexOf(text);
  const start = Array.from(question.slice(0, utf16Start)).length;
  return { text, start, end: start + Array.from(text).length };
};

describe('answer-specific intent contract', () => {
  const cases = [
    { question: '2025 standings points for Lando Norris', intent: { type: 'final_standings_points', season: 2025, season_reference: undefined, driver_references: undefined } },
    { question: 'Who led the 2025 standings?', intent: { type: 'final_standings_leader', season: 2025, season_reference: undefined } },
    { question: 'All 2025 Monaco race results', intent: { type: 'race_classification_all', season: 2025, season_reference: undefined, event_reference: undefined } },
    { question: 'Max in the 2025 Monaco race', intent: { type: 'race_classification_driver', season: 2025, season_reference: undefined, event_reference: undefined, driver_reference: undefined } },
    { question: 'DNFs in the 2025 Monaco race', intent: { type: 'race_classification_status', season: 2025, season_reference: undefined, event_reference: undefined, status: 'dnf', status_reference: undefined } },
    { question: 'All 2025 Monaco qualifying results', intent: { type: 'qualifying_classification_all', season: 2025, season_reference: undefined, event_reference: undefined } },
    { question: 'Max in 2025 Monaco qualifying', intent: { type: 'qualifying_classification_driver', season: 2025, season_reference: undefined, event_reference: undefined, driver_reference: undefined } },
    { question: 'DNS in 2025 Monaco qualifying', intent: { type: 'qualifying_classification_status', season: 2025, season_reference: undefined, event_reference: undefined, status: 'dns', status_reference: undefined } },
    { question: 'When was the 2025 Monaco race?', intent: { type: 'race_date', season: 2025, season_reference: undefined, event_reference: undefined } }
  ] as const;

  it.each(cases)('parses $intent.type using literal references', ({ question, intent }) => {
    const value: Record<string, unknown> = { ...intent, season_reference: reference(question, '2025') };
    if ('event_reference' in intent) {
      value.event_reference = reference(question, 'Monaco');
    }
    if ('driver_reference' in intent) {
      value.driver_reference = reference(question, 'Max');
    }
    if ('status_reference' in intent) {
      value.status_reference = reference(question, intent.status === 'dnf' ? 'DNFs' : 'DNS');
    }
    if (intent.type === 'final_standings_points') {
      value.driver_references = [reference(question, 'Lando Norris')];
    }
    expect(parseAnswerIntent(value, createAnswerQuestionContract(question))).toMatchObject({ type: intent.type });
  });

  it('accepts explicit clarification and unsupported outcomes', () => {
    const question = createAnswerQuestionContract('Which season?');
    expect(parseAnswerIntent({ type: 'clarification', reason: 'season_missing' }, question)).toEqual({ type: 'clarification', reason: 'season_missing' });
    expect(parseAnswerIntent({ type: 'unsupported', reason: 'pace_source_disabled' }, question)).toEqual({ type: 'unsupported', reason: 'pace_source_disabled' });
  });

  it('validates exact literal spans after astral Unicode using code-point offsets', () => {
    const text = '🏁 Max in the 2025 Monaco race';
    const intent = {
      type: 'race_classification_driver', season: 2025,
      season_reference: reference(text, '2025'), event_reference: reference(text, 'Monaco'), driver_reference: reference(text, 'Max')
    };
    expect(parseAnswerIntent(intent, createAnswerQuestionContract(text))).toMatchObject(intent);
    expect(() => parseAnswerIntent({ ...intent, driver_reference: { text: 'Max', start: 3, end: 6 } }, createAnswerQuestionContract(text))).toThrow();
  });

  it('hydrates exact text-only references with Unicode code-point spans', () => {
    const text = '🏁 Max in the 2025 Monaco race';
    const intent = hydrateAndParseAnswerIntent({
      type: 'race_classification_driver', season: 2025,
      season_reference: { text: '2025' }, event_reference: { text: 'Monaco' }, driver_reference: { text: 'Max' }
    }, createAnswerQuestionContract(text));
    expect(intent).toEqual({
      type: 'race_classification_driver', season: 2025,
      season_reference: reference(text, '2025'), event_reference: reference(text, 'Monaco'), driver_reference: reference(text, 'Max')
    });
  });

  it('hydrates all final standings points with no driver references', () => {
    const text = 'Show all final 2025 standings points.';
    expect(hydrateAndParseAnswerIntent({
      type: 'final_standings_points', season: 2025,
      season_reference: { text: '2025' }, driver_references: []
    }, createAnswerQuestionContract(text))).toEqual({
      type: 'final_standings_points', season: 2025,
      season_reference: reference(text, '2025'), driver_references: []
    });
  });

  it('hydrates a trusted result-selection reference without accepting position arrays', () => {
    const text = 'Show the top five finishers at the 2025 Australian Grand Prix.';
    expect(hydrateAndParseAnswerIntent({
      type: 'race_top_n', season: 2025, position: 5,
      season_reference: { text: '2025' }, event_reference: { text: 'Australian Grand Prix' }, selection_reference: { text: 'top five finishers' }
    }, createAnswerQuestionContract(text))).toEqual({
      type: 'race_top_n', season: 2025, position: 5,
      season_reference: reference(text, '2025'), event_reference: reference(text, 'Australian Grand Prix'), selection_reference: reference(text, 'top five finishers')
    });
    expect(() => parseUntrustedAnswerIntentCandidate({
      type: 'race_top_n', season: 2025, position: 5, positions: [1, 2, 3, 4, 5],
      season_reference: { text: '2025' }, event_reference: { text: 'Australian Grand Prix' }, selection_reference: { text: 'top five finishers' }
    })).toThrow();
  });

  it.each(['the second round', 'round two'])('hydrates an exact word round event reference: %s', eventReference => {
    const text = `Show all 2025 race results for ${eventReference}`;
    const intent = hydrateAndParseAnswerIntent({
      type: 'race_classification_all', season: 2025,
      season_reference: { text: '2025' }, event_reference: { text: eventReference }
    }, createAnswerQuestionContract(text));
    expect(intent.event_reference).toEqual(reference(text, eventReference));
  });

  it('fails closed when text-only references are missing, repeated, or contain offsets', () => {
    const question = createAnswerQuestionContract('Max beat Max in the 2025 Monaco race');
    const base = { type: 'race_classification_driver', season: 2025, season_reference: { text: '2025' }, event_reference: { text: 'Monaco' } };
    expect(() => hydrateAndParseAnswerIntent({ ...base, driver_reference: { text: 'Max' } }, question)).toThrow();
    expect(() => hydrateAndParseAnswerIntent({ ...base, driver_reference: { text: 'Lando' } }, question)).toThrow();
    expect(() => parseUntrustedAnswerIntentCandidate({ ...base, driver_reference: { text: 'Max', start: 0, end: 3 } })).toThrow();
  });

  it('normalizes a wrong candidate status enum from the unique complete trusted cue', () => {
    const text = 'Which drivers did not finish the race at round 1 in 2025?';
    const intent = hydrateAndParseAnswerIntent({
      type: 'race_classification_status', season: 2025, status: 'dns',
      season_reference: { text: '2025' }, event_reference: { text: '1' }, status_reference: { text: 'not finish' }
    }, createAnswerQuestionContract(text));
    expect(intent).toMatchObject({ status: 'dnf', status_reference: reference(text, 'did not finish') });

    const repeated = createAnswerQuestionContract('Show DNFs and DNSs in the 2025 race results at round 1');
    const unresolved = hydrateAndParseAnswerIntent({
      type: 'race_classification_status', season: 2025, status: 'dns',
      season_reference: { text: '2025' }, event_reference: { text: '1' }, status_reference: { text: 'DNSs' }
    }, repeated);
    expect(unresolved).toMatchObject({ status: 'dns', status_reference: reference(repeated.normalized_question, 'DNSs') });
  });

  it.each([
    ['Show all classified drivers in the 2025 Monaco race results', 'race_classification_all', 'race_classification_status'],
    ['Show all classified drivers in 2025 Monaco qualifying', 'qualifying_classification_all', 'qualifying_classification_status']
  ] as const)('normalizes %s from %s to %s using the trusted status cue', (text, candidateType, expectedType) => {
    const intent = hydrateAndParseAnswerIntent({
      type: candidateType, season: 2025, season_reference: { text: '2025' }, event_reference: { text: 'Monaco' }
    }, createAnswerQuestionContract(text));
    expect(intent).toMatchObject({
      type: expectedType, season: 2025, season_reference: reference(text, '2025'),
      event_reference: reference(text, 'Monaco'), status: 'classified', status_reference: reference(text, 'classified')
    });
  });

  it.each(['DSQs', 'not-classified', 'withdrawn'])('rejects unsupported qualifying status normalization for %s', statusText => {
    const text = `Show all ${statusText} drivers in 2025 Monaco qualifying`;
    expect(() => hydrateAndParseAnswerIntent({
      type: 'qualifying_classification_all', season: 2025,
      season_reference: { text: '2025' }, event_reference: { text: 'Monaco' }
    }, createAnswerQuestionContract(text))).toThrow();
  });

  it('does not convert classification-all with zero or multiple status cues', () => {
    const candidate = { type: 'race_classification_all' as const, season: 2025, season_reference: { text: '2025' }, event_reference: { text: 'Monaco' } };
    expect(hydrateAndParseAnswerIntent(candidate, createAnswerQuestionContract('Show all drivers in the 2025 Monaco race results')).type).toBe('race_classification_all');
    expect(hydrateAndParseAnswerIntent(candidate, createAnswerQuestionContract('Show DNFs and DNSs in the 2025 Monaco race results')).type).toBe('race_classification_all');
  });

  it('does not convert driver-specific or cross-session classification intents', () => {
    const driverText = 'Show classified driver Max in the 2025 Monaco race results';
    expect(hydrateAndParseAnswerIntent({
      type: 'race_classification_driver', season: 2025, season_reference: { text: '2025' },
      event_reference: { text: 'Monaco' }, driver_reference: { text: 'Max' }
    }, createAnswerQuestionContract(driverText)).type).toBe('race_classification_driver');

    const crossSessionText = 'Show classified drivers in 2025 Monaco qualifying';
    expect(hydrateAndParseAnswerIntent({
      type: 'race_classification_all', season: 2025, season_reference: { text: '2025' }, event_reference: { text: 'Monaco' }
    }, createAnswerQuestionContract(crossSessionText)).type).toBe('race_classification_all');
  });

  it('rejects a status reference that is not contained in the single trusted cue', () => {
    const question = createAnswerQuestionContract('Show DNFs in the 2025 race results at round 1');
    expect(() => hydrateAndParseAnswerIntent({
      type: 'race_classification_status', season: 2025, status: 'dns',
      season_reference: { text: '2025' }, event_reference: { text: '1' }, status_reference: { text: 'classified' }
    }, question)).toThrow();
  });

  it('hydrates repeated driver references by exact left-to-right occurrence count', () => {
    const text = 'Final 2025 standings points for Max Verstappen and Max Verstappen.';
    const base = { type: 'final_standings_points' as const, season: 2025, season_reference: { text: '2025' } };
    const intent = hydrateAndParseAnswerIntent({
      ...base, driver_references: [{ text: 'Max Verstappen' }, { text: 'Max Verstappen' }]
    }, createAnswerQuestionContract(text));
    expect(intent.driver_references).toEqual([
      { text: 'Max Verstappen', start: 32, end: 46 },
      { text: 'Max Verstappen', start: 51, end: 65 }
    ]);
    expect(() => hydrateAndParseAnswerIntent({ ...base, driver_references: [{ text: 'Max Verstappen' }] }, createAnswerQuestionContract(text))).toThrow();
  });

  it('rejects extras, canonical IDs, invalid status boundaries, and nonliteral spans', () => {
    const text = 'Max in the 2025 Monaco race';
    const question = createAnswerQuestionContract(text);
    const valid = { type: 'race_classification_driver', season: 2025, season_reference: reference(text, '2025'), event_reference: reference(text, 'Monaco'), driver_reference: reference(text, 'Max') };
    expect(() => parseAnswerIntent({ ...valid, driver_id: 'max-verstappen' }, question)).toThrow();
    expect(() => parseAnswerIntent({ ...valid, driver_reference: { text: 'Verstappen', start: 0, end: 10 } }, question)).toThrow();
    expect(() => parseAnswerIntent({ type: 'qualifying_classification_status', season: 2025, season_reference: reference(text, '2025'), event_reference: reference(text, 'Monaco'), status: 'dsq', status_reference: reference(text, 'Max') }, question)).toThrow();
    expect(() => parseAnswerIntent({ ...valid, season: 2024 }, question)).toThrow();
  });
});
