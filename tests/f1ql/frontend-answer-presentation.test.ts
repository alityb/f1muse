import { describe, expect, it } from 'vitest';
import {
  formatColumnLabel,
  formatFactValue,
  formatHeadline,
  formatSubject
} from '../../frontend/lib/answer-presentation';

describe('public answer presentation', () => {
  it('presents canonical driver IDs and qualifying fields as familiar F1 labels', () => {
    expect(formatSubject('lando-norris')).toBe('Lando Norris');
    expect(formatColumnLabel('qualifying_position')).toBe('Position');
    expect(formatColumnLabel('best_time_ms')).toBe('Best lap');
    expect(formatColumnLabel('best_session')).toBe('Session');
    expect(formatColumnLabel('eliminated_in_round')).toBe('Eliminated');
    expect(formatColumnLabel('classification_status')).toBe('Status');
  });

  it('renders qualifying milliseconds as a lap clock and nulls as an em dash', () => {
    expect(formatFactValue('best_time_ms', '75096')).toBe('1:15.096');
    expect(formatFactValue('best_time_ms', '59999')).toBe('0:59.999');
    expect(formatFactValue('best_time_ms', null)).toBe('—');
  });

  it('humanizes canonical IDs in fact values and headlines without changing the API contract', () => {
    expect(formatFactValue('classification_status', 'not_classified')).toBe('Not Classified');
    expect(formatFactValue('finished_ahead_of', 'oscar-piastri')).toBe('Oscar Piastri');
    expect(formatHeadline('Official summary for lando-norris.', ['lando-norris'])).toBe('Official summary for Lando Norris.');
  });
});
