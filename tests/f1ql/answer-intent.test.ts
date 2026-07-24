import { describe, expect, it } from 'vitest';
import { parseAnswerIntent } from '../../src/f1ql/answer-intent';
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
