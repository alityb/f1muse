import { describe, expect, it } from 'vitest';
import { fasterCandidateMatchesQuestion, inspectFasterQuestion } from '../../src/f1ql/faster-question';
import { parseF1QLProgramCandidate } from '../../src/f1ql/translation-schema';

describe('faster question semantics', () => {
  it('separates event mean, explicit window median, fastest lap, and classification wording', () => {
    expect(inspectFasterQuestion('Who was faster at Belgium 2022, Verstappen or Alonso?')).toEqual({
      type: 'event_mean', season: 2022, event_reference: 'Belgium'
    });
    expect(inspectFasterQuestion('Was Verstappen or Alonso quicker at Belgium 2022?')).toEqual({
      type: 'event_mean', season: 2022, event_reference: 'Belgium'
    });
    expect(inspectFasterQuestion('Who had the lower median over laps 3-10 at Belgium 2022, Verstappen or Alonso?')).toEqual({
      type: 'window_median', season: 2022, event_reference: 'Belgium', lap_start: 3, lap_end: 10
    });
    expect(inspectFasterQuestion('Who set the fastest lap at Belgium 2022?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Was Verstappen faster in the sprint at Belgium 2022 than Alonso?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Did Verstappen have a faster lap at Belgium 2022 than Alonso?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Was Verstappen faster on the final lap at Belgium 2022 than Alonso?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Was Verstappen faster than Alonso on the tenth lap at Belgium 2022?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Was Verstappen faster than Alonso on the 10th lap at Belgium 2022?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Was Verstappen faster than Alonso on lap ten at Belgium 2022?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Was Verstappen faster than Alonso on the sixtieth lap at Belgium 2022?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Who had lower average lap times on the tenth lap at Belgium 2022, Verstappen or Alonso?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('On lap number 10 at Belgium 2022, who was faster, Verstappen or Alonso?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Who was faster in quali at Belgium 2022, Verstappen or Alonso?')).toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
    expect(inspectFasterQuestion('Who finished ahead at Belgium 2022?')).toEqual({ type: 'classification', session: 'race', season: 2022, event_reference: 'Belgium' });
    expect(inspectFasterQuestion('Who qualified ahead at Belgium 2022?')).toEqual({ type: 'classification', session: 'qualifying', season: 2022, event_reference: 'Belgium' });
    expect(inspectFasterQuestion('Who was ahead in Q2 at Belgium 2022?')).toEqual({ type: 'classification', session: 'qualifying', season: 2022, event_reference: 'Belgium' });
  });

  it('clarifies missing scope and conflicting or incomplete statistics', () => {
    expect(inspectFasterQuestion('Who was faster at Belgium, Verstappen or Alonso?')).toMatchObject({ type: 'clarification', reason: 'season_missing' });
    expect(inspectFasterQuestion('Who was faster in 2022, Verstappen or Alonso?')).toMatchObject({ type: 'clarification', reason: 'event_ambiguous' });
    expect(inspectFasterQuestion('Who was faster over laps 3-10 at Belgium 2022?')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Compare Verstappen and Alonso lap times at Belgium 2022')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Compare Verstappen and Alonso pace at Belgium 2022')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Who had the lower average lap time at Belgium 2022, Verstappen or Alonso?')).toEqual({ type: 'event_mean', season: 2022, event_reference: 'Belgium' });
    expect(inspectFasterQuestion('Who had the lower average lap times at Belgium 2022, Verstappen or Alonso?')).toEqual({ type: 'event_mean', season: 2022, event_reference: 'Belgium' });
    expect(inspectFasterQuestion('Who had the lower median at Belgium 2022?')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Who was faster in the race results at Belgium 2022?')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Who was quickest at Belgium 2022?')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Who was better at Belgium 2022?')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('What were the average points at Belgium 2022?')).toEqual({ type: 'none' });
    expect(inspectFasterQuestion('What was the mean finishing position at Belgium 2022?')).toEqual({ type: 'classification', session: 'race', season: 2022, event_reference: 'Belgium' });
    expect(inspectFasterQuestion('What was the average speed at Belgium 2022?')).toEqual({ type: 'none' });
    expect(inspectFasterQuestion('Show the 2025 championship results')).toEqual({ type: 'none' });
    expect(inspectFasterQuestion('Who was faster at Belgium 2022, Verstappen or Alonso in the championship?')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
    expect(inspectFasterQuestion('Who was faster at Belgium or Monaco in 2022, Verstappen or Alonso?')).toMatchObject({ type: 'clarification', reason: 'event_ambiguous' });
    expect(inspectFasterQuestion('Who was faster at Belgium 2022, Verstappen, Alonso, or Hamilton?')).toMatchObject({ type: 'clarification', reason: 'entity_ambiguous' });
    expect(inspectFasterQuestion('Who was faster at Belgium 2022, Verstappen or Alonso or Hamilton?')).toMatchObject({ type: 'clarification', reason: 'entity_ambiguous' });
    expect(inspectFasterQuestion('Verstappen vs Alonso at Belgium 2022')).toMatchObject({ type: 'clarification', reason: 'metric_ambiguous' });
  });

  it('requires the candidate operation and every semantic value to be literal', () => {
    const question = 'Who was faster at Belgium 2022, Verstappen or Alonso?';
    const contract = inspectFasterQuestion(question);
    const valid = parseF1QLProgramCandidate({
      version: 1,
      root: {
        op: 'official_event_mean_compare',
        metric: 'official_non_deleted_non_pit_event_mean_v1',
        season: 2022,
        event_name: 'Belgium',
        driver_a_id: 'Verstappen',
        driver_b_id: 'Alonso'
      }
    });
    expect(fasterCandidateMatchesQuestion(contract, question, valid)).toBe(true);
    expect(fasterCandidateMatchesQuestion(contract, question, parseF1QLProgramCandidate({
      version: 1,
      root: { op: 'event_classification', season: 2022, event_name: 'Belgium', limit: 30 }
    }))).toBe(false);
    expect(fasterCandidateMatchesQuestion(contract, question, parseF1QLProgramCandidate({
      version: 1,
      root: { ...valid.root, season: 2021 }
    }))).toBe(false);
    expect(fasterCandidateMatchesQuestion(contract, question, parseF1QLProgramCandidate({
      version: 1,
      root: { ...valid.root, driver_b_id: 'Hamilton' }
    }))).toBe(false);
    expect(fasterCandidateMatchesQuestion(contract, 'Who was faster at Belgium 2022, Verstappen or Alonso after Hamilton retired?', parseF1QLProgramCandidate({
      version: 1,
      root: { ...valid.root, driver_b_id: 'Hamilton' }
    }))).toBe(false);
    const averageQuestion = 'Did Verstappen have a lower average lap time than Alonso at Belgium 2022?';
    expect(fasterCandidateMatchesQuestion(inspectFasterQuestion(averageQuestion), averageQuestion, valid)).toBe(true);
  });

  it('does not permit an official comparison for an unrelated question', () => {
    const candidate = parseF1QLProgramCandidate({
      version: 1,
      root: {
        op: 'official_event_mean_compare',
        metric: 'official_non_deleted_non_pit_event_mean_v1',
        season: 2022,
        event_name: 'Belgium',
        driver_a_id: 'Verstappen',
        driver_b_id: 'Alonso'
      }
    });
    expect(fasterCandidateMatchesQuestion(inspectFasterQuestion('Show the 2022 standings'), 'Show the 2022 standings', candidate)).toBe(false);
    expect(fasterCandidateMatchesQuestion(inspectFasterQuestion('Show the 2022 standings'), 'Show the 2022 standings', candidate)).toBe(false);
    const classification = parseF1QLProgramCandidate({ version: 1, root: { op: 'event_classification', season: 2022, event_name: 'Belgium', limit: 30 } });
    expect(fasterCandidateMatchesQuestion(inspectFasterQuestion('Who finished ahead at Belgium 2022?'), 'Who finished ahead at Belgium 2022?', classification)).toBe(true);
    expect(fasterCandidateMatchesQuestion(inspectFasterQuestion('Who qualified ahead at Belgium 2022?'), 'Who qualified ahead at Belgium 2022?', classification)).toBe(false);
    expect(fasterCandidateMatchesQuestion(inspectFasterQuestion('Who finished ahead at Belgium 2022?'), 'Who finished ahead at Belgium 2022?', parseF1QLProgramCandidate({
      version: 1, root: { op: 'event_classification', season: 2021, event_name: 'Monaco', limit: 30 }
    }))).toBe(false);
    expect(fasterCandidateMatchesQuestion(
      inspectFasterQuestion('Where did Max Verstappen finish?'),
      'Where did Max Verstappen finish?',
      parseF1QLProgramCandidate({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 30, filters: { driver_id: 'Max Chilton' } } })
    )).toBe(false);
    expect(fasterCandidateMatchesQuestion(
      inspectFasterQuestion('Where did Max finish?'),
      'Where did Max finish?',
      parseF1QLProgramCandidate({ version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 30, filters: { driver_id: 'Max Verstappen' } } })
    )).toBe(true);
  });

});
