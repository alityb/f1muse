import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ANSWER_INTENT_DERIVATION_VERSION, AnswerIntentInventoryResolver, deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';

function inventory(...literals: string[]): AnswerIntentInventoryResolver {
  return {
    async inventoryMentions(question) {
      const points = Array.from(question);
      return literals.flatMap((literal, literalIndex) => {
        const needle = Array.from(literal);
        const mentions = [];
        for (let start = 0; start <= points.length - needle.length; start += 1) {
          if (needle.every((point, offset) => points[start + offset] === point)) {
            mentions.push({
              text: literal, start, end: start + needle.length,
              candidates: [`candidate-${literalIndex}`], active_candidates: [`active-${literalIndex}`]
            });
          }
        }
        return mentions;
      });
    }
  };
}

describe('provider-free answer intent derivation', () => {
  const templates = [
    ['Final 2025 standings points for Lando Norris.', inventory('Lando Norris'), 'final_standings_points'],
    ['Who was the final 2025 standings leader?', inventory(), 'final_standings_leader'],
    ['Show all 2025 Monaco race results.', inventory(), 'race_classification_all'],
    ['Where did Max Verstappen finish in the 2025 Monaco race?', inventory('Max Verstappen'), 'race_classification_driver'],
    ['Show DNFs in the 2025 Monaco race results.', inventory(), 'race_classification_status'],
    ['Show all 2025 Monaco qualifying results.', inventory(), 'qualifying_classification_all'],
    ['Where did Max Verstappen qualify in 2025 Monaco qualifying?', inventory('Max Verstappen'), 'qualifying_classification_driver'],
    ['Show DNSs in the 2025 Monaco qualifying results.', inventory(), 'qualifying_classification_status'],
    ['When was the 2025 Monaco race?', inventory(), 'race_date'],
    ['Who won the 2025 Australian Grand Prix?', inventory(), 'race_winner'],
    ['Show the podium for the 2025 Australian Grand Prix.', inventory(), 'race_podium'],
    ['Show the top five finishers at the 2025 Australian Grand Prix.', inventory(), 'race_top_n'],
    ['Who finished second at the 2025 Australian Grand Prix?', inventory(), 'race_exact_position'],
    ['Who took pole at the 2025 Australian Grand Prix?', inventory(), 'qualifying_pole'],
    ['Show the top five qualifiers at the 2025 Australian Grand Prix.', inventory(), 'qualifying_top_n'],
    ['Who qualified third at the 2025 Australian Grand Prix?', inventory(), 'qualifying_exact_position'],
    ['Show the latest recorded 2026 driver standings.', inventory(), 'current_standings'],
    ['Show Max Verstappen official 2025 season summary.', inventory('Max Verstappen'), 'driver_season_official_summary'],
    ['Give the official 2025 season summary for Max Verstappen.', inventory('Max Verstappen'), 'driver_season_official_summary'],
    ['Show Lando Norris official 2025 driver summary.', inventory('Lando Norris', 'driver'), 'driver_season_official_summary'],
    ['Give the official 2025 driver summary for Lando Norris.', inventory('Lando Norris', 'driver'), 'driver_season_official_summary'],
    ['Show Lewis Hamilton official career summary.', inventory('Lewis Hamilton'), 'driver_career_official_summary'],
    ['Give the official career summary for Lewis Hamilton.', inventory('Lewis Hamilton'), 'driver_career_official_summary']
    ,['Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?', inventory('Lando Norris', 'Oscar Piastri'), 'race_season_finishing_position_h2h']
    ,['In 2025, who finished ahead more often, Lando Norris or Oscar Piastri?', inventory('Lando Norris', 'Oscar Piastri'), 'race_season_finishing_position_h2h']
    ,['Who outqualified whom more often in 2025, Norris or Piastri?', inventory('Norris', 'Piastri'), 'qualifying_season_position_h2h']
    ,['In 2025, who outqualified whom more often, Lando Norris or Oscar Piastri?', inventory('Lando Norris', 'Oscar Piastri'), 'qualifying_season_position_h2h']
    ,['Who qualified ahead more often in 2025, Norris or Verstappen?', inventory('Norris', 'Verstappen'), 'qualifying_season_position_h2h']
    ,['In 2025, who qualified ahead more often, Lando Norris or Max Verstappen?', inventory('Lando Norris', 'Max Verstappen'), 'qualifying_season_position_h2h']
  ] as const;

  it.each(templates)('derives %s as %s', async (question, resolver, type) => {
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), resolver);
    expect(intent.type).toBe(type);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(ANSWER_INTENT_DERIVATION_VERSION).toBe('answer-intent-derivation-v8');
  });

  it.each([
    'Who finished ahead more often, Lando Norris or Oscar Piastri?',
    'Who finished ahead more often in 2026, Lando Norris or Oscar Piastri?',
    'Who finished ahead more often in 2025, Lando Norris?',
    'Who finished ahead more often in 2025, Lando Norris or Oscar Piastri or Max Verstappen?',
    'Who finished ahead more often in 2025, Lando Norris or Lando Norris?',
    'Who finished ahead more often in the 2025 Australian Grand Prix, Lando Norris or Oscar Piastri?',
    'Who finished ahead more often in race and qualifying in 2025, Lando Norris or Oscar Piastri?',
    'Which teammate finished ahead more often in 2025, Lando Norris or Oscar Piastri?',
    'Who was faster in 2025, Lando Norris or Oscar Piastri?',
    'Who finished ahead more often excluding DNFs in 2025, Lando Norris or Oscar Piastri?',
    'Compare who was better in 2025, Lando Norris or Oscar Piastri?'
  ])('does not broaden race H2H wording: %s', async question => {
    const names = ['Lando Norris', 'Oscar Piastri', 'Max Verstappen'].filter(name => question.includes(name));
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory(...names));
    expect(intent.type).toMatch(/unsupported|clarification/u);
  });

  it.each([
    'Who outqualified whom more often, Norris or Piastri?',
    'Who outqualified whom more often in 2026, Norris or Piastri?',
    'Who outqualified whom more often in 2025, Norris?',
    'Who outqualified whom more often in 2025, Norris or Piastri or Verstappen?',
    'Who outqualified whom more often in 2025, Norris or Norris?',
    'Who outqualified whom more often at Monaco in 2025, Norris or Piastri?',
    'Who finished ahead more often in qualifying in 2025, Norris or Piastri?',
    'Who outqualified whom more often in race and qualifying in 2025, Norris or Piastri?',
    'Which teammate outqualified whom more often in 2025, Norris or Piastri?',
    'Who had the faster qualifying lap in 2025, Norris or Piastri?',
    'Who outqualified whom more often excluding DNFs in 2025, Norris or Piastri?',
    'Compare who was better in qualifying in 2025, Norris or Piastri?'
  ])('does not broaden qualifying H2H wording: %s', async question => {
    const names = ['Norris', 'Piastri', 'Verstappen'].filter(name => question.includes(name));
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory(...names));
    expect(intent.type).toMatch(/unsupported|clarification/u);
  });

  it.each([
    'Show Max Verstappen 2025 season summary.',
    'Show Max Verstappen official 2026 season summary.',
    'Show Max Verstappen official 2025 season summary with wins and poles.',
    'Show Max Verstappen and Lando Norris official 2025 season summary.',
    'Show official 2025 season summary.'
  ])('does not broaden official season summaries: %s', async question => {
    const names = ['Max Verstappen', 'Lando Norris'].filter(name => question.includes(name));
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory(...names));
    expect(intent.type).toMatch(/unsupported|clarification/u);
  });

  it.each([
    'Show Lando Norris 2025 driver summary.',
    'Show Lando Norris official 2026 driver summary.',
    'Show Lando Norris official 2025 driver profile.',
    'Show Lando Norris official 2025 driver summary with wins and poles.',
    'Show Lando Norris and Oscar Piastri official 2025 driver summary.'
  ])('does not broaden profile replacement wording: %s', async question => {
    const names = ['Lando Norris', 'Oscar Piastri'].filter(name => question.includes(name));
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory(...names));
    expect(intent.type).toMatch(/unsupported|clarification/u);
  });

  it.each([
    'Show Lewis Hamilton career summary.',
    'Show Lewis Hamilton official 2024 career summary.',
    'Show Lewis Hamilton official career summary with wins and poles.',
    'Show Lewis Hamilton and Max Verstappen official career summary.',
    'Show official career summary.'
  ])('does not broaden official career summaries: %s', async question => {
    const names = ['Lewis Hamilton', 'Max Verstappen'].filter(name => question.includes(name));
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory(...names));
    expect(intent.type).toMatch(/unsupported|clarification/u);
  });

  it.each([
    'Show the latest recorded 2025 driver standings.',
    'Show the latest recorded 2027 driver standings.',
    'Show the latest recorded 2026 driver standings for Lando Norris.',
    'Show the latest recorded 2026 driver standings after the summer break.',
    'Show the latest recorded 2026 driver standings through last weekend.',
    'Show the latest recorded 2026 driver standings on July 1.'
  ])('does not broaden latest-recorded standings: %s', async question => {
    const resolver = question.includes('Lando') ? inventory('Lando Norris') : inventory();
    await expect(deriveAnswerIntent(createAnswerQuestionContract(question), resolver)).resolves.toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
  });

  it('binds result cardinality to the trusted cue', async () => {
    await expect(deriveAnswerIntent(createAnswerQuestionContract('Show the top five finishers at the 2025 Australian Grand Prix.'), inventory())).resolves.toMatchObject({
      type: 'race_top_n', position: 5, selection_reference: { text: 'top five finishers' }
    });
    await expect(deriveAnswerIntent(createAnswerQuestionContract('Who qualified third at the 2025 Australian Grand Prix?'), inventory())).resolves.toMatchObject({
      type: 'qualifying_exact_position', position: 3, selection_reference: { text: 'qualified third' }
    });
  });

  it.each([
    ['Show all 2025 Monaco race results.', 'Monaco'],
    ['Show all 2025 race results for round 2.', '2'],
    ['When was the race at the second round in 2025?', 'second']
  ])('uses the exact trusted event or round span: %s', async (question, text) => {
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory());
    expect(intent).toMatchObject({ event_reference: { text } });
  });

  it.each([
    ['', []],
    [' for Lando Norris', ['Lando Norris']],
    [' for Lando Norris and Oscar Piastri', ['Lando Norris', 'Oscar Piastri']],
    [' for Lando Norris, Oscar Piastri, Max Verstappen and Charles Leclerc', ['Lando Norris', 'Oscar Piastri', 'Max Verstappen', 'Charles Leclerc']]
  ] as const)('keeps 0/1/2/4 standings driver literals%s', async (suffix, names) => {
    const question = `Show final 2025 standings points${suffix}.`;
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory(...names));
    expect(intent).toMatchObject({ type: 'final_standings_points' });
    if (intent.type === 'final_standings_points') {
      expect(intent.driver_references.map(reference => reference.text)).toEqual(names);
    }
  });

  it('keeps repeated standings literals and strips every candidate identifier', async () => {
    const question = 'Final 2025 standings points for Max Verstappen and Max Verstappen.';
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory('Max Verstappen'));
    expect(intent.type).toBe('final_standings_points');
    if (intent.type === 'final_standings_points') {
      expect(intent.driver_references).toHaveLength(2);
      expect(intent.driver_references[0]).toEqual({ text: 'Max Verstappen', start: 32, end: 46 });
      expect(intent.driver_references[1]).toEqual({ text: 'Max Verstappen', start: 51, end: 65 });
    }
    expect(JSON.stringify(intent)).not.toMatch(/candidate|active|driver[_-]?id/i);
  });

  it.each([
    'Show all 2025 Monaco race results for Max Verstappen.',
    'Show complete race results for DNFs at 2025 Monaco.',
    'Show 2025 Monaco race results for round 2.',
    'Show DNFs and DNSs in the 2025 Monaco race results.',
    'Tell me about 2025 Monaco.',
    'Show final 2025 standings points for A, B, C, D and E.'
  ])('fails closed on conflicting or unknown selection: %s', async question => {
    const resolver = question.includes('Max') ? inventory('Max Verstappen')
      : question.includes('A, B') ? inventory('A', 'B', 'C', 'D', 'E') : inventory();
    await expect(deriveAnswerIntent(createAnswerQuestionContract(question), resolver)).resolves.toEqual({
      type: 'unsupported', reason: 'capability_unsupported'
    });
  });

  it.each(['classified', 'DNFs', 'DNSs', 'DSQs', 'not-classified', 'withdrawn'])('supports race status %s', async status => {
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(`Show ${status} drivers in the 2025 Monaco race results.`), inventory());
    expect(intent.type).toBe('race_classification_status');
  });

  it.each(['classified', 'DNFs', 'DNSs'])('supports qualifying status %s', async status => {
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(`Show ${status} drivers in the 2025 Monaco qualifying results.`), inventory());
    expect(intent.type).toBe('qualifying_classification_status');
  });

  it.each(['DSQs', 'not-classified', 'withdrawn'])('rejects qualifying status %s', async status => {
    await expect(deriveAnswerIntent(
      createAnswerQuestionContract(`Show ${status} drivers in the 2025 Monaco qualifying results.`), inventory()
    )).resolves.toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
  });

  it('preserves focused contract clarifications and rejections without inventory', async () => {
    const resolver = { inventoryMentions: vi.fn() };
    await expect(deriveAnswerIntent(createAnswerQuestionContract('Show the race results'), resolver)).resolves.toEqual({
      type: 'clarification', reason: 'season_missing'
    });
    await expect(deriveAnswerIntent(createAnswerQuestionContract('Show all 2025 Monaco race and qualifying results'), resolver)).resolves.toEqual({
      type: 'clarification', reason: 'session_ambiguous'
    });
    await expect(deriveAnswerIntent(createAnswerQuestionContract('Show 2025 sprint results'), resolver)).resolves.toEqual({
      type: 'unsupported', reason: 'sprint_source_unsupported'
    });
    expect(resolver.inventoryMentions).not.toHaveBeenCalled();
  });

  it('uses Unicode code-point offsets and permits emoji and Latin diacritics', async () => {
    const question = '🏁 Where did Sébastien Buemi finish in the 2025 São Paulo race?';
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory('Sébastien Buemi'));
    expect(intent).toMatchObject({
      type: 'race_classification_driver',
      season_reference: { text: '2025', start: 42, end: 46 },
      event_reference: { text: 'São Paulo', start: 47, end: 56 },
      driver_reference: { text: 'Sébastien Buemi', start: 12, end: 27 }
    });
  });

  it.each([
    'Where did Mаx Verstappen finish in the 2025 Monaco race?',
    'Where did Μax Verstappen finish in the 2025 Monaco race?'
  ])('rejects Cyrillic or Greek alphabetic content before inventory: %s', async question => {
    const resolver = { inventoryMentions: vi.fn() };
    await expect(deriveAnswerIntent(createAnswerQuestionContract(question), resolver)).resolves.toEqual({
      type: 'unsupported', reason: 'capability_unsupported'
    });
    expect(resolver.inventoryMentions).not.toHaveBeenCalled();
  });

  it('matches the reviewed homoglyph early-rejection reason', async () => {
    const reviewed = answerEvaluationManifest.find(item => item.id === 'unicode-homoglyph');
    expect(reviewed).toMatchObject({ expected: { action: 'abstain', reason: 'capability_unsupported' } });
    await expect(deriveAnswerIntent(
      createAnswerQuestionContract(reviewed?.question),
      { inventoryMentions: vi.fn() }
    )).resolves.toEqual({ type: 'unsupported', reason: 'capability_unsupported' });
  });

  it('has no provider, network, executor, or canonical-program imports', () => {
    const source = readFileSync(resolve(__dirname, '../../src/f1ql/answer-intent-derivation.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];?$/gmu)].map(match => match[1]);
    expect(imports).toEqual(['./answer-intent', './answer-question']);
    expect(source).not.toMatch(/provider|fetch\(|axios|executor|canonical|\.\/program|\.\/ast|\.\/core/iu);
  });
});
