import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { LAUNCH_CAPABILITY_DISPOSITIONS, LEGACY_QUERY_KINDS, LEGACY_REMOVAL_ALLOWED } from '../../src/f1ql/launch-capabilities';
import { launchParityManifest } from '../fixtures/f1ql-launch-parity-manifest';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { deriveAnswerIntent } from '../../src/f1ql/answer-intent-derivation';
import { proveAnswerIntent } from '../../src/f1ql/answer-semantic-proof';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { getF1QLProgramHash } from '../../src/f1ql/verified-programs';

describe('F1QL launch capability migration', () => {
  it('accounts exactly once for every executable legacy query kind', () => {
    expect(Object.keys(LAUNCH_CAPABILITY_DISPOSITIONS).sort()).toEqual([...LEGACY_QUERY_KINDS].sort());
    expect(LEGACY_QUERY_KINDS).toHaveLength(24);
    expect(new Set(launchParityManifest.map(testCase => testCase.id)).size).toBe(launchParityManifest.length);
    expect([...new Set(launchParityManifest.map(testCase => testCase.legacy_kind))].sort()).toEqual([...LEGACY_QUERY_KINDS].sort());
    const requiredCases = [
      ['season-summary', 'Show Max Verstappen official 2025 season summary.', 'driver_season_official_summary'],
      ['complete-final-standings', '2025 driver standings.', 'final_standings'],
      ['historical-complete-final-standings', '2023 driver standings.', 'final_standings'],
      ['career-summary', 'Show Lewis Hamilton official career summary.', 'driver_career_official_summary'],
      ['career-wins', 'At which circuits has Lewis Hamilton won races?', 'driver_career_wins_by_circuit'],
      ['profile-replacement', 'Show Lando Norris official 2025 driver summary.', 'driver_season_official_summary'],
      ['current-standings', 'Show the latest recorded 2026 driver standings.', 'current_standings'],
      ['multi-ranking-replacement', 'Rank Verstappen, Norris, and Piastri by final 2025 championship position.', 'official_multi_driver_ranking'],
      ['race-h2h', 'Who finished ahead more often in 2025, Lando Norris or Oscar Piastri?', 'classification_head_to_head'],
      ['matchup-replacement', 'Who outqualified whom more often in 2025, Norris or Piastri?', 'qualifying_season_position_h2h'],
      ['comprehensive-replacement', 'Compare the official 2025 results of Norris and Piastri.', 'official_driver_comparison'],
      ['qualifying-h2h-teammates', 'Who outqualified whom more often in 2025, Norris or Piastri?', 'qualifying_season_position_h2h'],
      ['qualifying-h2h-drivers', 'Who qualified ahead more often in 2025, Norris or Verstappen?', 'qualifying_season_position_h2h'],
      ['race-winner', 'Who won the 2025 Australian Grand Prix?', 'race_result_selection'],
      ['race-podium', 'Show the podium for the 2025 Australian Grand Prix.', 'race_result_selection'],
      ['race-top-five', 'Show the top five finishers at the 2025 Australian Grand Prix.', 'race_result_selection'],
      ['race-second', 'Who finished second at the 2025 Australian Grand Prix?', 'race_result_selection'],
      ['qualifying-pole', 'Who took pole at the 2025 Australian Grand Prix?', 'qualifying_result_selection'],
      ['qualifying-top-five', 'Show the top five qualifiers at the 2025 Australian Grand Prix.', 'qualifying_result_selection'],
      ['qualifying-third', 'Who qualified third at the 2025 Australian Grand Prix?', 'qualifying_result_selection']
      ,['season-poles', 'How many poles did Lando Norris take in 2025?', 'driver_season_poles']
      ,['career-poles', 'How many career poles does Lewis Hamilton have?', 'driver_career_poles']
      ,['season-q3', 'How many times did Lando Norris qualify in the top ten in 2025?', 'driver_season_top_ten_qualifying']
      ,['q3-ranking', 'Rank drivers by top-ten qualifying appearances in 2025.', 'season_top_ten_qualifying_ranking']
    ] as const;
    for (const [id, question, target] of requiredCases) {
      expect(launchParityManifest.find(testCase => testCase.id === id)).toMatchObject({ question, target, expected_decision: 'answer' });
    }
  });

  it('binds every reviewed prompt to its migration disposition', () => {
    for (const testCase of launchParityManifest) {
      const disposition = LAUNCH_CAPABILITY_DISPOSITIONS[testCase.legacy_kind];
      expect(disposition.targets).toContain(testCase.target);
      expect(testCase.question.trim().length).toBeGreaterThan(20);
      expect(testCase.expected_decision === 'abstain').toBe(disposition.decision === 'retire');
    }
  });

  it('physically removes the legacy architecture after every reviewed prompt is contracted', () => {
    expect(LEGACY_REMOVAL_ALLOWED).toBe(true);
    expect(launchParityManifest.some(testCase => testCase.implementation === 'pending')).toBe(false);

    for (const removedPath of [
      'src/api/nl-query.ts',
      'src/api/nl-query-production.ts',
      'src/api/routes/query.ts',
      'src/types/query-intent.ts',
      'src/execution/pipeline/select-template.ts',
      'src/execution/template-loader.ts',
      'templates'
    ]) {
      expect(existsSync(removedPath), removedPath).toBe(false);
    }

    const routeIndex = readFileSync('src/api/routes/index.ts', 'utf8');
    const answerRouter = readFileSync('src/api/routes/program-answer.ts', 'utf8');
    expect(routeIndex.match(/router\.use\('\/', createPublicAnswerRoutes\(answerPool\)\)/gu)).toHaveLength(1);
    expect(answerRouter.match(/createAnswerRoutes\('\/nl-query'/gu)).toHaveLength(1);

    const shadowRouter = readFileSync('src/api/routes/program-translate.ts', 'utf8');
    expect(shadowRouter).toContain('_executor?: () => never');
    expect(shadowRouter).not.toMatch(/_executor\s*\(/u);
    expect(shadowRouter).not.toMatch(/from ['"]\.\.\/\.\.\/f1ql\/executor['"]/u);
  });

  it('contracts only deterministic proof cases with reviewed generated evidence', async () => {
    const contractedIds = launchParityManifest.map(testCase => testCase.id).sort();
    expect(launchParityManifest.filter(testCase => testCase.implementation === 'contracted').map(testCase => testCase.id).sort()).toEqual(contractedIds);
    const emitted = JSON.parse(readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', 'utf8')) as Array<{ id: string }>;
    const emittedIds = new Set(emitted.map(item => item.id));
    for (const parityCase of launchParityManifest.filter(testCase => testCase.expected_decision === 'answer')) {
      const evaluation = answerEvaluationManifest.find(item => item.question === parityCase.question);
      expect(evaluation).toMatchObject({ answerable: true, expected: { action: 'answer', proof_outcome: 'passed' } });
      const contract = createAnswerQuestionContract(parityCase.question);
      const inventory = {
        inventoryMentions: async (question: string) => ['Max Verstappen', 'Lewis Hamilton', 'Lando Norris', 'Oscar Piastri', 'Norris', 'Piastri', 'Verstappen'].filter(name => question.includes(name) && !['Max Verstappen', 'Lando Norris', 'Oscar Piastri'].some(full => full !== name && full.endsWith(name) && question.includes(full))).map(name => ({
          text: name, start: Array.from(question.slice(0, question.indexOf(name))).length,
          end: Array.from(question.slice(0, question.indexOf(name))).length + Array.from(name).length,
          candidates: [name === 'Max Verstappen' || name === 'Verstappen' ? 'max_verstappen' : name === 'Lewis Hamilton' ? 'lewis_hamilton' : name === 'Oscar Piastri' || name === 'Piastri' ? 'oscar_piastri' : 'lando_norris'],
          active_candidates: [name === 'Max Verstappen' || name === 'Verstappen' ? 'max_verstappen' : name === 'Lewis Hamilton' ? 'lewis_hamilton' : name === 'Oscar Piastri' || name === 'Piastri' ? 'oscar_piastri' : 'lando_norris']
        }))
      };
      const intent = await deriveAnswerIntent(contract, inventory);
      expect(intent.type).not.toMatch(/clarification|unsupported/u);
      const proof = await proveAnswerIntent(contract, intent, {
        resolve: async (season, name) => name === 'Australian Grand Prix' ? { type: 'resolved', season, round: 1 } : name === 'Silverstone' ? { type: 'resolved', season, round: 12 } : { type: 'missing' },
        resolveRound: async (season, round) => ({ type: 'resolved', season, round })
      }, inventory);
      expect(getF1QLProgramHash(proof.program)).toBe(getF1QLProgramHash(evaluation!.expected.acceptable_programs![0]));
      expect(authorizeAnswerProgram(proof.program).type).toBe('approved');
      expect(emittedIds.has(evaluation?.id ?? '')).toBe(true);
    }
    const nonAnswerReasons: Readonly<Record<string, string>> = {
      'trend-retired': 'capability_unsupported', 'vector-retired': 'capability_unsupported',
      'teammate-career-replacement': 'session_ambiguous', 'season-pace-replacement': 'session_ambiguous',
      'teammate-gap-retired': 'pace_source_disabled', 'dual-gap-retired': 'pace_source_disabled',
      'track-fastest-retired': 'pace_source_disabled'
    };
    for (const parityCase of launchParityManifest.filter(testCase => testCase.expected_decision !== 'answer')) {
      const outcome = createAnswerQuestionContract(parityCase.question).outcome;
      expect(outcome).toMatchObject({
        type: parityCase.expected_decision === 'clarify' ? 'clarification_required' : 'rejected',
        reason: nonAnswerReasons[parityCase.id]
      });
    }
    expect(LEGACY_REMOVAL_ALLOWED).toBe(true);
    expect(launchParityManifest.some(testCase => testCase.implementation === 'pending')).toBe(false);
  });

  it('retains only capabilities with an identified factual authority', () => {
    for (const disposition of Object.values(LAUNCH_CAPABILITY_DISPOSITIONS)) {
      if (disposition.decision !== 'retire') {
        expect(disposition.authorities).not.toContain('none');
      }
      expect(disposition.reason).not.toMatch(/legacy template|because supported/iu);
    }
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_season_summary.authorities).toEqual(['standings']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_career_summary.authorities).toEqual(['standings']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_profile_summary.authorities).toEqual(['standings']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_head_to_head_count.authorities).toEqual(expect.arrayContaining(['race_classification', 'qualifying_classification']));
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_multi_comparison.authorities).toEqual(['standings']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_matchup_lookup.authorities).toEqual(['qualifying_classification']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_career_wins_by_circuit.authorities).toEqual(['race_classification', 'event_metadata']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.race_results_summary.authorities).toEqual(['race_classification', 'event_metadata']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.qualifying_results_summary.authorities).toEqual(['qualifying_classification', 'event_metadata']);
  });
});
