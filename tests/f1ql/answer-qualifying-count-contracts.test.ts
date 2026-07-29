import { describe, expect, it } from 'vitest';
import { estimateAnswerWork } from '../../src/f1ql/answer-bounds';
import { AnswerFormatError, formatAnswerRows } from '../../src/f1ql/answer-format';
import { deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { proveAnswerIntent } from '../../src/f1ql/answer-semantic-proof';
import { AnswerTemplateId, materializeAnswerTemplate } from '../../src/f1ql/answer-templates';
import { ANSWER_INTENT_JSON_SCHEMA, ANSWER_TRANSLATOR_SYSTEM_PROMPT } from '../../src/f1ql/answer-translator';
import { F1QLProgram } from '../../src/f1ql/ast';

const cases = [
  ['How many poles did Lando Norris take in 2025?', 'driver_season_qualifying_p1_count', { season: 2025, driver_id: 'lando-norris' }, 30, 1],
  ['How many career poles does Lewis Hamilton have?', 'driver_career_qualifying_p1_count', { driver_id: 'lewis-hamilton' }, 2280, 1],
  ['How many times did Lando Norris qualify in the top ten in 2025?', 'driver_season_qualifying_top_ten_count', { season: 2025, driver_id: 'lando-norris' }, 30, 1],
  ['Rank drivers by top-ten qualifying appearances in 2025.', 'season_qualifying_top_ten_ranking', { season: 2025 }, 30, 100]
] as const;

const inventory = {
  async inventoryMentions(question: string) {
    return ['Lando Norris', 'Lewis Hamilton'].filter(text => question.includes(text)).map(text => {
      const start = Array.from(question.slice(0, question.indexOf(text))).length;
      const id = text === 'Lando Norris' ? 'lando_norris' : 'lewis_hamilton';
      return { text, start, end: start + Array.from(text).length, candidates: [id], active_candidates: [id] };
    });
  }
};

const noEvents = {
  resolve: async () => ({ type: 'missing' as const }),
  resolveRound: async () => ({ type: 'missing' as const })
};

function approved(program: F1QLProgram) {
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved') throw new Error('expected approved fixture');
  return decision.capability;
}

function sentinels(sourceRows: number) {
  return {
    qualifying_source_rows: sourceRows,
    distinct_qualifying_keys: sourceRows,
    missing_qualifying_key_rows: 0,
    duplicate_qualifying_rows: 0,
    invalid_qualifying_position_rows: 0,
    duplicate_qualifying_position_rows: 0,
    source_presence_ok: true,
    source_key_integrity_ok: true,
    position_integrity_ok: true,
    source_integrity_ok: true
  };
}

describe('closed qualifying count answer contracts', () => {
  it.each(cases)('derives, independently proves, authorizes, and bounds %s', async (question, template, variables, units, requestedRows) => {
    const contract = createAnswerQuestionContract(question);
    expect(contract.metric_cues).toHaveLength(1);
    const intent = await deriveAnswerIntent(contract, inventory);
    expect(intent.type).toBe(template);
    const proof = await proveAnswerIntent(contract, intent, noEvents, inventory);
    expect(proof.template_id).toBe(template);
    expect(proof.program).toEqual(materializeAnswerTemplate(template, variables));
    expect(proof.mentions.filter(mention => mention.kind === 'driver')).toHaveLength('driver_id' in variables ? 1 : 0);
    const capability = approved(proof.program);
    expect(capability).toMatchObject({ source: 'qualifying_classification', filters: 'driver_id' in variables ? ['driver'] : [] });
    expect(estimateAnswerWork(proof.program, capability)).toEqual({ version: 'answer-work-v9', units, requested_rows: requestedRows });
  });

  it('keeps provider guidance and schema closed to the four exact intents', () => {
    const schema = JSON.stringify(ANSWER_INTENT_JSON_SCHEMA);
    for (const [question, type] of cases) {
      expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain(question);
      expect(schema).toContain(type);
    }
  });

  it('binds the seasonless career driver to the exact span and preserves ambiguity', async () => {
    const question = 'How many career poles does Lewis Hamilton have?';
    const contract = createAnswerQuestionContract(question);
    const intent = await deriveAnswerIntent(contract, inventory);
    const ambiguous = {
      inventoryMentions: async () => {
        const start = Array.from(question.slice(0, question.indexOf('Lewis Hamilton'))).length;
        return [{ text: 'Lewis Hamilton', start, end: start + 14, candidates: ['lewis-one', 'lewis-two'], active_candidates: ['lewis-one', 'lewis-two'] }];
      }
    };
    await expect(proveAnswerIntent(contract, intent, noEvents, ambiguous)).rejects.toMatchObject({ code: 'entity_ambiguous' });
    await expect(proveAnswerIntent(contract, { ...intent, driver_reference: { text: 'Lewis', start: 27, end: 32 } }, noEvents, inventory))
      .rejects.toThrow();
  });

  it.each([
    'How many pole positions did Lando Norris take in 2025?',
    'How many poles did Lando Norris take in 2024?',
    'How many poles did Norris take in 2025?',
    'How many career poles does Lewis Hamilton have in 2025?',
    'How many career poles does Lewis Hamilton have in 2026?',
    'How many times did Lando Norris reach the final qualifying segment in 2025?',
    'How many times did Lando Norris qualify in the top ten in 2025, including other sessions?',
    'Rank the top ten drivers by qualifying appearances in 2025.',
    'Rank drivers by top-ten qualifying appearances in 2024.',
    'Rank drivers by top-ten qualifying appearances in 2025?'
  ])('does not broaden wording: %s', async question => {
    const intent = await deriveAnswerIntent(createAnswerQuestionContract(question), inventory);
    expect(cases.map(item => item[1])).not.toContain(intent.type);
  });

  it('rejects root metric, scope, identity, and shape mutations in policy', () => {
    const programs = cases.map(([, template, variables]) => materializeAnswerTemplate(template, variables));
    for (const program of programs) {
      const root = program.root as unknown as Record<string, unknown>;
      for (const mutation of [
        { ...root, metric: 'other' },
        { ...root, extra: true },
        ...('season' in root ? [{ ...root, season: 2026 }] : []),
        ...('driver_id' in root ? [{ ...root, driver_id: 'Invalid Driver' }] : []),
        ...('seasons' in root ? [{ ...root, seasons: (root.seasons as number[]).slice(1) }] : [])
      ]) {
        expect(authorizeAnswerProgram({ version: 1, root: mutation } as unknown as F1QLProgram).type).toBe('rejected');
      }
    }
  });

  it('formats scalar counts only after every integrity sentinel and exact driver passes', () => {
    const program = materializeAnswerTemplate('driver_season_qualifying_p1_count', { season: 2025, driver_id: 'lando-norris' });
    const row = { metric_id: program.root.op === 'driver_season_qualifying_p1_count' ? program.root.metric : '', driver_id: 'lando-norris', qualifying_p1_count: 3, ...sentinels(6) };
    expect(formatAnswerRows(program, approved(program), [row]).answer.headline)
      .toBe('lando-norris has 3 recorded official qualifying P1 classifications in 2025.');
    for (const mutation of [
      { metric_id: 'other' }, { driver_id: 'other-driver' }, { qualifying_p1_count: -1 }, { qualifying_p1_count: 7 },
      { qualifying_source_rows: 0 }, { distinct_qualifying_keys: 5 }, { missing_qualifying_key_rows: 1 },
      { duplicate_qualifying_rows: 1 }, { invalid_qualifying_position_rows: 1 }, { duplicate_qualifying_position_rows: 1 }, { source_presence_ok: false },
      { source_key_integrity_ok: false }, { position_integrity_ok: false }, { source_integrity_ok: false }
    ]) expect(() => formatAnswerRows(program, approved(program), [{ ...row, ...mutation }])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(program, approved(program), [])).toThrow(AnswerFormatError);
    expect(() => formatAnswerRows(program, approved(program), [row, row])).toThrow(AnswerFormatError);
  });

  it('accepts ranking ties only in deterministic UTF-8 driver-id order and rejects row mutations', () => {
    const program = materializeAnswerTemplate('season_qualifying_top_ten_ranking', { season: 2025 });
    if (program.root.op !== 'season_qualifying_top_ten_ranking') throw new Error('fixture shape changed');
    const common = { metric_id: program.root.metric, ...sentinels(12) };
    const rows = [
      { ...common, driver_id: 'alpha', qualifying_top_ten_count: 5 },
      { ...common, driver_id: 'bravo', qualifying_top_ten_count: 5 },
      { ...common, driver_id: 'charlie', qualifying_top_ten_count: 3 }
    ];
    expect(formatAnswerRows(program, approved(program), rows).answer.headline)
      .toBe('Drivers ranked by recorded numeric top-ten positions in 2025.');
    for (const invalid of [
      [rows[1], rows[0], rows[2]],
      [rows[0], rows[2], rows[1]],
      [rows[0], { ...rows[1], driver_id: 'alpha' }, rows[2]],
      [rows[0], { ...rows[1], duplicate_qualifying_rows: 1 }, rows[2]]
    ]) expect(() => formatAnswerRows(program, approved(program), invalid)).toThrow(AnswerFormatError);
  });
});
