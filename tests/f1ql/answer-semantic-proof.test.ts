import { describe, expect, it } from 'vitest';
import { AnswerDriverIdentityResolver, AnswerEventIdentityResolver, ANSWER_DRIVER_IDENTITY_MAX_ROWS, ANSWER_EVENT_IDENTITY_MAX_ROWS } from '../../src/identity/answer-identity-resolvers';
import { ANSWER_AMBIGUITY_MAX_OPTIONS, AnswerProofDriverResolver, AnswerProofEventResolver, AnswerSemanticProofError, proveAnswerIntent, stableSerialize, verifyAnswerSemanticProof } from '../../src/f1ql/answer-semantic-proof';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { F1QLLinkingError } from '../../src/f1ql/translation-linking';
import { hydrateAndParseAnswerIntent } from '../../src/f1ql/answer-intent';

const span = (question: string, text: string) => {
  const start = Array.from(question.slice(0, question.indexOf(text))).length;
  return { text, start, end: start + Array.from(text).length };
};
const events: AnswerProofEventResolver = {
  resolve: async (season, name) => name === 'Monaco' ? { type: 'resolved', season, round: 8 } : { type: 'missing' },
  resolveRound: async (season, round) => round === 8 ? { type: 'resolved', season, round } : { type: 'missing' }
};
const drivers: AnswerProofDriverResolver = {
  inventoryMentions: async question => {
    const mentions = ['Max', 'Lando Norris', 'Oscar Piastri', 'Lewis Hamilton'].filter(name => question.includes(name));
    return mentions.map(text => {
      const reference = span(question, text);
      const driver = text === 'Max' ? 'max_verstappen' : text === 'Lewis Hamilton' ? 'lewis_hamilton' : text === 'Oscar Piastri' ? 'oscar_piastri' : 'lando_norris';
      return { ...reference, candidates: [driver], active_candidates: [driver] };
    });
  }
};

describe('independent answer semantic proof', () => {
  it('materializes and immutably binds an exact server-owned canonical program', async () => {
    const question = 'Max in the 2025 Monaco race results';
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'race_classification_driver', season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Monaco'), driver_reference: span(question, 'Max')
    }, events, drivers);
    expect(proof.program.root).toMatchObject({ op: 'event_classification', season: 2025, round: 8, filters: { driver_id: 'max-verstappen' } });
    expect(proof).toMatchObject({ version: 'answer-semantic-proof-v15', template_id: 'race_classification_driver' });
    expect(proof.question_hash).toHaveLength(64);
    expect(proof.intent_hash).toHaveLength(64);
    expect(proof.template_registry_hash).toHaveLength(64);
    expect(proof.template_variables).toEqual({ season: 2025, round: 8, driver_id: 'max-verstappen' });
    expect(proof.program_hash).toHaveLength(64);
    expect(proof.proof_hash).toHaveLength(64);
    expect(verifyAnswerSemanticProof(proof)).toBe(proof);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.template_variables)).toBe(true);
    expect(Object.isFrozen(proof.program)).toBe(true);
  });

  it('rejects plain-object proof forgeries and mutation attempts', async () => {
    const question = 'Who led the 2025 standings?';
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025')
    }, events, drivers);
    expect(() => verifyAnswerSemanticProof({ ...proof })).toThrow(AnswerSemanticProofError);
    expect(() => { (proof.template_variables as { season: number }).season = 2024; }).toThrow();
    expect(() => { (proof.program.root as { limit: number }).limit = 2; }).toThrow();
    expect(verifyAnswerSemanticProof(proof)).toBe(proof);
  });

  it.each([
    ['Show all 2025 race results for the second round', 'the second round'],
    ['Show all 2025 race results for round two', 'round two']
  ])('proves and materializes the exact word round reference: %s', async (question, reference) => {
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'race_classification_all', season: 2025,
      season_reference: span(question, '2025'), event_reference: span(question, reference)
    }, {
      resolve: async () => ({ type: 'missing' }),
      resolveRound: async (season, round) => ({ type: 'resolved', season, round })
    }, drivers);
    expect(proof).toMatchObject({
      template_id: 'race_classification_all',
      template_variables: { season: 2025, round: 2 },
      program: { root: { op: 'event_classification', season: 2025, round: 2 } }
    });
  });

  it('hydrates, proves, and materializes all final standings points without a driver filter', async () => {
    const question = 'Show all final 2025 standings points.';
    const contract = createAnswerQuestionContract(question);
    const intent = hydrateAndParseAnswerIntent({
      type: 'final_standings_points', season: 2025,
      season_reference: { text: '2025' }, driver_references: []
    }, contract);
    const proof = await proveAnswerIntent(contract, intent, events, drivers);
    expect(proof).toMatchObject({
      version: 'answer-semantic-proof-v15',
      template_id: 'final_standings_points',
      template_variables: { season: 2025 },
      program: { root: { op: 'aggregate', input: { op: 'filter', where: { season: 2025 } } } }
    });
    expect(proof.program.root).not.toMatchObject({ input: { where: { driver_id: expect.anything() } } });
  });

  it('proves latest-recorded standings independently from final standings', async () => {
    const question = 'Show the latest recorded 2026 driver standings.';
    const contract = createAnswerQuestionContract(question);
    const proof = await proveAnswerIntent(contract, {
      type: 'current_standings', season: 2026, season_reference: span(question, '2026')
    }, events, drivers);
    expect(proof).toMatchObject({
      template_id: 'current_standings', template_variables: { season: 2026 },
      program: { root: { op: 'rank', by: 'championship_position', direction: 'asc', limit: 30 } }
    });
    await expect(proveAnswerIntent(contract, {
      type: 'final_standings_leader', season: 2026, season_reference: span(question, '2026')
    }, events, drivers)).rejects.toMatchObject({ reason: 'metric_mismatch' });
  });

  it('proves one standings-only official season summary', async () => {
    const question = 'Show Max official 2025 season summary.';
    const contract = createAnswerQuestionContract(question);
    const proof = await proveAnswerIntent(contract, {
      type: 'driver_season_official_summary', season: 2025,
      season_reference: span(question, '2025'), driver_reference: span(question, 'Max')
    }, events, drivers);
    expect(proof).toMatchObject({
      template_id: 'driver_season_official_summary',
      template_variables: { season: 2025, driver_id: 'max-verstappen' },
      program: { root: { op: 'aggregate', input: { where: { season: 2025, driver_id: 'max-verstappen' } } } }
    });
  });

  it('proves profile replacement wording only as the standings-only season summary', async () => {
    const question = 'Show Lando Norris official 2025 driver summary.';
    const collisionDrivers: AnswerProofDriverResolver = {
      inventoryMentions: async () => [
        { ...span(question, 'Lando Norris'), candidates: ['lando_norris'], active_candidates: ['lando_norris'] },
        { ...span(question, 'driver'), candidates: ['sample_driver'], active_candidates: ['sample_driver'] }
      ]
    };
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'driver_season_official_summary', season: 2025,
      season_reference: span(question, '2025'), driver_reference: span(question, 'Lando Norris')
    }, events, collisionDrivers);
    expect(proof).toMatchObject({
      template_id: 'driver_season_official_summary',
      template_variables: { season: 2025, driver_id: 'lando-norris' },
      program: { root: { op: 'aggregate', input: { where: { season: 2025, driver_id: 'lando-norris' } } } }
    });
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'driver_season_official_summary', season: 2025,
      season_reference: span(question, '2025'), driver_reference: span(question, 'driver')
    }, events, collisionDrivers)).rejects.toMatchObject({ reason: 'metric_mismatch' });
  });

  it('rejects broader profile wording for the season-summary intent', async () => {
    const question = 'Show Lando Norris official 2025 driver profile.';
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'driver_season_official_summary', season: 2025,
      season_reference: span(question, '2025'), driver_reference: span(question, 'Lando Norris')
    }, events, drivers)).rejects.toMatchObject({ reason: 'metric_mismatch' });
  });

  it('proves one final-standings-only official career summary', async () => {
    const question = 'Show Lewis Hamilton official career summary.';
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'driver_career_official_summary', driver_reference: span(question, 'Lewis Hamilton')
    }, events, drivers);
    expect(proof).toMatchObject({
      template_id: 'driver_career_official_summary',
      template_variables: { driver_id: 'lewis-hamilton' },
      program: { root: { op: 'aggregate', input: { where: { driver_id: 'lewis-hamilton' } } } }
    });
  });

  it('independently proves literal order and exact whole-question race H2H semantics', async () => {
    const question = 'Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?';
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'race_season_finishing_position_h2h', season: 2025, season_reference: span(question, '2025'),
      driver_references: [span(question, 'Lando Norris'), span(question, 'Oscar Piastri')]
    }, events, drivers);
    expect(proof).toMatchObject({
      template_id: 'race_season_finishing_position_h2h',
      template_variables: { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' },
      program: { root: { op: 'race_season_finishing_position_h2h', driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' } }
    });
    const broader = 'Compare who finished ahead more often in 2025, Lando Norris or Oscar Piastri?';
    await expect(proveAnswerIntent(createAnswerQuestionContract(broader), {
      type: 'race_season_finishing_position_h2h', season: 2025, season_reference: span(broader, '2025'),
      driver_references: [span(broader, 'Lando Norris'), span(broader, 'Oscar Piastri')]
    }, events, drivers)).rejects.toMatchObject({ reason: 'metric_mismatch' });
  });

  it('maps H2H IDs to intent spans when the resolver returns mentions in reverse order', async () => {
    const question = 'Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?';
    const reversedDrivers: AnswerProofDriverResolver = {
      inventoryMentions: async () => [
        { ...span(question, 'Oscar Piastri'), candidates: ['oscar_piastri'], active_candidates: ['oscar_piastri'] },
        { ...span(question, 'Lando Norris'), candidates: ['lando_norris'], active_candidates: ['lando_norris'] }
      ]
    };
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'race_season_finishing_position_h2h', season: 2025, season_reference: span(question, '2025'),
      driver_references: [span(question, 'Lando Norris'), span(question, 'Oscar Piastri')]
    }, events, reversedDrivers);
    expect(proof.template_variables).toEqual({ season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
    expect(proof.program.root).toMatchObject({ driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' });
  });

  it('independently proves qualifying H2H wording and maps IDs by exact spans', async () => {
    const question = 'In 2025, who outqualified whom more often, Lando Norris or Oscar Piastri?';
    const reversedDrivers: AnswerProofDriverResolver = {
      inventoryMentions: async () => [
        { ...span(question, 'Oscar Piastri'), candidates: ['oscar_piastri'], active_candidates: ['oscar_piastri'] },
        { ...span(question, 'Lando Norris'), candidates: ['lando_norris'], active_candidates: ['lando_norris'] }
      ]
    };
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'qualifying_season_position_h2h', season: 2025, season_reference: span(question, '2025'),
      driver_references: [span(question, 'Lando Norris'), span(question, 'Oscar Piastri')]
    }, events, reversedDrivers);
    expect(proof).toMatchObject({
      template_id: 'qualifying_season_position_h2h',
      template_variables: { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' },
      program: { root: { op: 'qualifying_season_position_h2h', metric: 'official_qualifying_position_shared_events_v1' } }
    });
    const broader = 'Compare who outqualified whom more often in 2025, Lando Norris or Oscar Piastri?';
    await expect(proveAnswerIntent(createAnswerQuestionContract(broader), {
      type: 'qualifying_season_position_h2h', season: 2025, season_reference: span(broader, '2025'),
      driver_references: [span(broader, 'Lando Norris'), span(broader, 'Oscar Piastri')]
    }, events, drivers)).rejects.toMatchObject({ reason: 'metric_mismatch' });
  });

  it('proves only the pinned comparison and binds roles by exact spans despite reversed resolver order', async () => {
    const question = 'Compare the official 2025 results of Norris and Piastri.';
    const reversedDrivers: AnswerProofDriverResolver = {
      inventoryMentions: async () => [
        { ...span(question, 'Piastri'), candidates: ['oscar_piastri'], active_candidates: ['oscar_piastri'] },
        { ...span(question, 'Norris'), candidates: ['lando_norris'], active_candidates: ['lando_norris'] }
      ]
    };
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'official_driver_results_comparison', season: 2025, season_reference: span(question, '2025'),
      driver_references: [span(question, 'Norris'), span(question, 'Piastri')]
    }, events, reversedDrivers);
    expect(proof).toMatchObject({
      template_id: 'official_driver_results_comparison',
      template_variables: { season: 2025, driver_a_id: 'lando-norris', driver_b_id: 'oscar-piastri' },
      program: { root: { op: 'official_driver_results_comparison', metric: 'official_driver_results_comparison_v1' } }
    });
    const broader = 'Compare the official 2025 results of Norris and Piastri?';
    await expect(proveAnswerIntent(createAnswerQuestionContract(broader), {
      type: 'official_driver_results_comparison', season: 2025, season_reference: span(broader, '2025'),
      driver_references: [span(broader, 'Norris'), span(broader, 'Piastri')]
    }, events, reversedDrivers)).rejects.toMatchObject({ reason: 'metric_mismatch' });
  });

  it.each([
    'Who was the final 2025 champion?',
    'Who was the final 2025 standings champion?',
    'Who was the 2025 championship champion?',
    'Who was the final 2025 driver champion?'
  ])('hydrates, proves, and materializes the official final leader: %s', async question => {
    const contract = createAnswerQuestionContract(question);
    const intent = hydrateAndParseAnswerIntent({
      type: 'final_standings_leader', season: 2025, season_reference: { text: '2025' }
    }, contract);
    const proof = await proveAnswerIntent(contract, intent, events, drivers);
    expect(proof).toMatchObject({
      template_id: 'final_standings_leader',
      template_variables: { season: 2025 },
      program: { root: { op: 'rank', by: 'championship_position', direction: 'asc', limit: 1 } }
    });
  });

  it('rejects an event champion as unsupported rather than mapping it to standings', async () => {
    const question = 'Who was the final 2025 Monaco champion?';
    const contract = createAnswerQuestionContract(question);
    const intent = hydrateAndParseAnswerIntent({
      type: 'final_standings_leader', season: 2025, season_reference: { text: '2025' }
    }, contract);
    await expect(proveAnswerIntent(contract, intent, events, drivers)).rejects.toMatchObject({ reason: 'template_mismatch' });
  });

  it.each([
    ['Who won the 2025 Australian Grand Prix?', 'race_winner', undefined, 'race_classification_position', [1]],
    ['Show the podium for the 2025 Australian Grand Prix.', 'race_podium', undefined, 'race_classification_position', [1, 2, 3]],
    ['Show the top five finishers at the 2025 Australian Grand Prix.', 'race_top_n', 5, 'race_classification_position', [1, 2, 3, 4, 5]],
    ['Who finished second at the 2025 Australian Grand Prix?', 'race_exact_position', 2, 'race_classification_position', [2]],
    ['Who took pole at the 2025 Australian Grand Prix?', 'qualifying_pole', undefined, 'qualifying_classification_position', [1]],
    ['Show the top five qualifiers at the 2025 Australian Grand Prix.', 'qualifying_top_n', 5, 'qualifying_classification_position', [1, 2, 3, 4, 5]],
    ['Who qualified third at the 2025 Australian Grand Prix?', 'qualifying_exact_position', 3, 'qualifying_classification_position', [3]]
  ] as const)('proves exact result selection for %s', async (question, type, position, template, positions) => {
    const contract = createAnswerQuestionContract(question);
    const selection = contract.result_cues[0];
    const intent = {
      type, season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Australian Grand Prix'),
      selection_reference: { text: selection.text, start: selection.start, end: selection.end },
      ...(position === undefined ? {} : { position })
    };
    const proof = await proveAnswerIntent(contract, intent, {
      resolve: async (season) => ({ type: 'resolved', season, round: 1 }),
      resolveRound: async (season, round) => ({ type: 'resolved', season, round })
    }, drivers);
    expect(proof).toMatchObject({ template_id: template, template_variables: { season: 2025, round: 1, positions } });
  });

  it('rejects a wrong-but-bounded result position', async () => {
    const question = 'Who finished second at the 2025 Australian Grand Prix?';
    const contract = createAnswerQuestionContract(question);
    await expect(proveAnswerIntent(contract, {
      type: 'race_exact_position', season: 2025, position: 3,
      season_reference: span(question, '2025'), event_reference: span(question, 'Australian Grand Prix'), selection_reference: span(question, 'finished second')
    }, { resolve: async season => ({ type: 'resolved', season, round: 1 }), resolveRound: async (season, round) => ({ type: 'resolved', season, round }) }, drivers))
      .rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
  });

  it.each([
    ['season', { type: 'final_standings_leader', season: 2024, season_reference: undefined }, 'season_mismatch'],
    ['session', { type: 'qualifying_classification_driver', season: 2025, season_reference: undefined, event_reference: undefined, driver_reference: undefined }, 'session_mismatch'],
    ['metric', { type: 'final_standings_points', season: 2025, season_reference: undefined, driver_references: [] }, 'metric_mismatch']
  ] as const)('rejects wrong-but-valid %s intent', async (_label, partial, reason) => {
    const question = _label === 'metric' ? 'Who was the 2025 standings leader?' : 'Max in the 2025 Monaco race results';
    const intent = { ...partial, season_reference: span(question, '2025') } as any;
    if ('event_reference' in partial) intent.event_reference = span(question, 'Monaco');
    if ('driver_reference' in partial) intent.driver_reference = span(question, 'Max');
    const proof = expect(proveAnswerIntent(createAnswerQuestionContract(question), intent, events, drivers)).rejects;
    if (_label === 'season') {
      await proof.toThrow();
    } else {
      await proof.toMatchObject({ reason });
    }
  });

  it('rejects dropped or invented status and all-driver cardinality', async () => {
    const question = 'Show all DNFs in the 2025 Monaco race results';
    const contract = createAnswerQuestionContract(question);
    await expect(proveAnswerIntent(contract, {
      type: 'race_classification_all', season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Monaco')
    }, events, drivers)).rejects.toBeInstanceOf(AnswerSemanticProofError);
    const plain = 'Show all 2025 Monaco race results';
    await expect(proveAnswerIntent(createAnswerQuestionContract(plain), {
      type: 'race_classification_status', season: 2025, season_reference: span(plain, '2025'), event_reference: span(plain, 'Monaco'), status: 'dnf', status_reference: span(plain, 'Show')
    }, events, drivers)).rejects.toMatchObject({ reason: 'status_mismatch' });
    await expect(proveAnswerIntent(createAnswerQuestionContract(plain), {
      type: 'race_classification_driver', season: 2025, season_reference: span(plain, '2025'), event_reference: span(plain, 'Monaco'), driver_reference: span(plain, 'Show')
    }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
  });

  it('materializes an exact classification-status filter from its literal status span', async () => {
    const question = 'Show all DNFs in the 2025 Monaco race results';
    const proof = await proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'race_classification_status', season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Monaco'), status: 'dnf', status_reference: span(question, 'DNFs')
    }, events, drivers);
    expect(proof.program.root).toMatchObject({ op: 'event_classification', filters: { classification_status: ['dnf'] } });
  });

  it('rejects a hydrated candidate when the contract has multiple status cues', async () => {
    const question = 'Show DNFs and DNSs in the 2025 Monaco race results';
    const contract = createAnswerQuestionContract(question);
    const intent = hydrateAndParseAnswerIntent({
      type: 'race_classification_status', season: 2025, status: 'dns',
      season_reference: { text: '2025' }, event_reference: { text: 'Monaco' }, status_reference: { text: 'DNSs' }
    }, contract);
    await expect(proveAnswerIntent(contract, intent, events, drivers)).rejects.toMatchObject({ reason: 'status_mismatch' });
  });

  it('never resolves deterministic ambiguity and verifies literal rounds exist', async () => {
    const question = 'Max in the 2025 Monaco race results';
    const ambiguousDrivers: AnswerProofDriverResolver = {
      inventoryMentions: async () => [{ text: 'Max', start: 0, end: 3, candidates: ['max-one', 'max-two'], active_candidates: ['max-one', 'max-two'] }]
    };
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'race_classification_driver', season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Monaco'), driver_reference: span(question, 'Max')
    }, events, ambiguousDrivers)).rejects.toBeInstanceOf(F1QLLinkingError);

    const roundQuestion = 'Show all 2025 race results for round 9';
    await expect(proveAnswerIntent(createAnswerQuestionContract(roundQuestion), {
      type: 'race_classification_all', season: 2025, season_reference: span(roundQuestion, '2025'), event_reference: span(roundQuestion, 'round 9')
    }, events, drivers)).rejects.toMatchObject({ code: 'source_coverage_missing' });
  });

  it('rejects multiple explicit events and the prior race-versus-qualifying ambiguity', async () => {
    const eventsQuestion = 'Show all 2025 Monaco and British race results';
    await expect(proveAnswerIntent(createAnswerQuestionContract(eventsQuestion), {
      type: 'race_classification_all', season: 2025, season_reference: span(eventsQuestion, '2025'), event_reference: span(eventsQuestion, 'Monaco')
    }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });

    const sessionQuestion = 'Show all 2025 Monaco race or qualifying results';
    await expect(proveAnswerIntent(createAnswerQuestionContract(sessionQuestion), {
      type: 'qualifying_classification_all', season: 2025, season_reference: span(sessionQuestion, '2025'), event_reference: span(sessionQuestion, 'Monaco')
    }, events, drivers)).rejects.toMatchObject({ reason: 'session_mismatch' });
  });

  it('rejects multiple word rounds and mixed event plus word round', async () => {
    const multiple = 'Show all 2025 race results for round two and the third round';
    await expect(proveAnswerIntent(createAnswerQuestionContract(multiple), {
      type: 'race_classification_all', season: 2025, season_reference: span(multiple, '2025'), event_reference: span(multiple, 'round two')
    }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });

    const mixed = 'Show all 2025 Monaco race results for round two';
    await expect(proveAnswerIntent(createAnswerQuestionContract(mixed), {
      type: 'race_classification_all', season: 2025, season_reference: span(mixed, '2025'), event_reference: span(mixed, 'round two')
    }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
  });

  it('requires the model driver references to exactly equal the independent inventory', async () => {
    const question = 'Max and Lando Norris points in the 2025 standings';
    const contract = createAnswerQuestionContract(question);
    const base = { type: 'final_standings_points' as const, season: 2025, season_reference: span(question, '2025') };
    await expect(proveAnswerIntent(contract, { ...base, driver_references: [span(question, 'Max')] }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
    await expect(proveAnswerIntent(contract, { ...base, driver_references: [] }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
    await expect(proveAnswerIntent(contract, { ...base, driver_references: [span(question, 'Max'), span(question, '2025')] }, events, drivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
    const proof = await proveAnswerIntent(contract, { ...base, driver_references: [span(question, 'Max'), span(question, 'Lando Norris')] }, events, drivers);
    expect(proof.program.root).toMatchObject({ input: { where: { driver_id: ['lando-norris', 'max-verstappen'] } } });
  });

  it('rejects repeated canonical driver identity after repeated-reference hydration', async () => {
    const question = 'Final 2025 standings points for Max Verstappen and Max Verstappen.';
    const contract = createAnswerQuestionContract(question);
    const intent = hydrateAndParseAnswerIntent({
      type: 'final_standings_points', season: 2025, season_reference: { text: '2025' },
      driver_references: [{ text: 'Max Verstappen' }, { text: 'Max Verstappen' }]
    }, contract);
    const repeatedDrivers: AnswerProofDriverResolver = {
      inventoryMentions: async () => intent.driver_references.map(reference => ({
        ...reference, candidates: ['max_verstappen'], active_candidates: ['max_verstappen']
      }))
    };
    await expect(proveAnswerIntent(contract, intent, events, repeatedDrivers)).rejects.toMatchObject({ reason: 'entity_cardinality_mismatch' });
  });

  it('requires participation and caps preserved ambiguity candidates', async () => {
    const question = 'Max in the 2025 Monaco race results';
    const inactive: AnswerProofDriverResolver = {
      inventoryMentions: async () => [{ text: 'Max', start: 0, end: 3, candidates: ['max-verstappen'], active_candidates: [] }]
    };
    const many = Array.from({ length: 10 }, (_, index) => `max-${index}`);
    const ambiguous: AnswerProofDriverResolver = {
      inventoryMentions: async () => [{ text: 'Max', start: 0, end: 3, candidates: many, active_candidates: many }]
    };
    const intent = { type: 'race_classification_driver' as const, season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Monaco'), driver_reference: span(question, 'Max') };
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), intent, events, inactive)).rejects.toMatchObject({ code: 'source_coverage_missing' });
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), intent, events, ambiguous)).rejects.toMatchObject({
      code: 'entity_ambiguous',
      options: many.slice(0, ANSWER_AMBIGUITY_MAX_OPTIONS),
      entityCandidates: [...many.slice(0, ANSWER_AMBIGUITY_MAX_OPTIONS).map(candidate => `driver:${candidate}`), 'event:2025:8'].sort()
    });
  });

  it('reparses unknown intent inputs and uses stable key-order hashing', async () => {
    const question = 'Who led the 2025 standings?';
    const malformed = { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 0, end: 4 } };
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), malformed, events, drivers)).rejects.toThrow();
    expect(stableSerialize({ z: 1, a: { y: 2, x: 3 } })).toBe(stableSerialize({ a: { x: 3, y: 2 }, z: 1 }));
    expect(stableSerialize({ '😀': 4, 'é': 3, 'ä': 2, z: 1 })).toBe('{"z":1,"ä":2,"é":3,"😀":4}');
  });

  it('clarifies status session deterministically and rejects it at proof without a source', async () => {
    const question = 'Show DNFs in 2025 at Monaco';
    const contract = createAnswerQuestionContract(question);
    expect(contract.outcome).toEqual({ type: 'clarification_required', reason: 'session_ambiguous' });
    await expect(proveAnswerIntent(contract, {
      type: 'race_classification_status', season: 2025, season_reference: span(question, '2025'), event_reference: span(question, 'Monaco'), status: 'dnf', status_reference: span(question, 'DNFs')
    }, events, drivers)).rejects.toMatchObject({ reason: 'session_mismatch' });
  });

  it.each(['Monaco', 'round 8'])('requires non-event templates to consume every material event or round cue: %s', async qualifier => {
    const question = `Who led the 2025 standings at ${qualifier}?`;
    await expect(proveAnswerIntent(createAnswerQuestionContract(question), {
      type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025')
    }, events, drivers)).rejects.toMatchObject({ reason: 'event_mismatch' });
  });

  it('inventories boundary-safe longest driver spans with candidates and season participation', async () => {
    const rows = [
      { driver_id: 'max-verstappen', identity: 'Max', participation_source: 'entrant' },
      { driver_id: 'max-other', identity: 'Max', participation_source: 'legacy_fallback' },
      { driver_id: 'maximum-driver', identity: 'Maximum', participation_source: 'entrant' },
      { driver_id: 'max-verstappen', identity: 'Max Verstappen', participation_source: 'entrant' },
      { driver_id: 'max-verstappen', identity: 'Verstappen', participation_source: 'entrant' }
    ];
    const database = { query: async () => ({ rows }) } as any;
    const question = '🏁 Maximum, Max Verstappen and Max.';
    const mentions = await new AnswerDriverIdentityResolver(database).inventoryMentions(question, 2025);
    expect(mentions).toEqual([
      { ...span(question, 'Maximum'), candidates: ['maximum-driver'], active_candidates: ['maximum-driver'] },
      { ...span(question, 'Max Verstappen'), candidates: ['max-verstappen'], active_candidates: ['max-verstappen'] },
      { text: 'Max', start: 30, end: 33, candidates: ['max-other', 'max-verstappen'], active_candidates: ['max-verstappen'] }
    ]);
  });

  it('bounds identity queries with deterministic ordering and sentinel overflow', async () => {
    const driverRows = Array.from({ length: ANSWER_DRIVER_IDENTITY_MAX_ROWS + 1 }, (_, index) => ({ driver_id: `driver-${index}`, identity: `Driver ${index}` }));
    const driverDatabase = { query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain('ORDER BY i.identity, i.driver_id, p.participation_source');
      expect(params[1]).toBe(ANSWER_DRIVER_IDENTITY_MAX_ROWS + 1);
      return { rows: driverRows };
    } } as any;
    await expect(new AnswerDriverIdentityResolver(driverDatabase).inventoryMentions('Driver 1', 2025)).rejects.toMatchObject({ code: 'driver_identity_overflow' });

    const eventDatabase = { query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain('ORDER BY round, identity');
      expect(params[1]).toBe(ANSWER_EVENT_IDENTITY_MAX_ROWS + 1);
      return { rows: Array.from({ length: ANSWER_EVENT_IDENTITY_MAX_ROWS + 1 }, (_, index) => ({ season: 2025, round: index + 1, identity: 'Monaco' })) };
    } } as any;
    await expect(new AnswerEventIdentityResolver(eventDatabase).resolve(2025, 'Monaco')).rejects.toMatchObject({ code: 'event_identity_overflow' });
  });
});
