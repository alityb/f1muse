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
    ['When was the 2025 Monaco race?', inventory(), 'race_date']
  ] as const;

  it.each(templates)('derives %s as %s', async (question, resolver, type) => {
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), resolver);
    expect(intent.type).toBe(type);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(ANSWER_INTENT_DERIVATION_VERSION).toBe('answer-intent-derivation-v1');
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
