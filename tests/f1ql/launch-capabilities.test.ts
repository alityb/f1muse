import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectTemplate } from '../../src/execution/pipeline/select-template';
import { TemplateLoader } from '../../src/execution/template-loader';
import { LAUNCH_CAPABILITY_DISPOSITIONS, LEGACY_QUERY_KINDS, LEGACY_REMOVAL_ALLOWED } from '../../src/f1ql/launch-capabilities';
import type { QueryIntent } from '../../src/types/query-intent';
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
      ['current-standings', 'Show the latest recorded 2026 driver standings.', 'current_standings'],
      ['race-winner', 'Who won the 2025 Australian Grand Prix?', 'race_result_selection'],
      ['race-podium', 'Show the podium for the 2025 Australian Grand Prix.', 'race_result_selection'],
      ['race-top-five', 'Show the top five finishers at the 2025 Australian Grand Prix.', 'race_result_selection'],
      ['race-second', 'Who finished second at the 2025 Australian Grand Prix?', 'race_result_selection'],
      ['qualifying-pole', 'Who took pole at the 2025 Australian Grand Prix?', 'qualifying_result_selection'],
      ['qualifying-top-five', 'Show the top five qualifiers at the 2025 Australian Grand Prix.', 'qualifying_result_selection'],
      ['qualifying-third', 'Who qualified third at the 2025 Australian Grand Prix?', 'qualifying_result_selection']
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

  it('blocks legacy deletion until every reviewed prompt has a contracted implementation', () => {
    expect(LEGACY_REMOVAL_ALLOWED).toBe(false);
    expect(launchParityManifest.some(testCase => testCase.implementation === 'pending')).toBe(true);
    const loader = new TemplateLoader();
    for (const kind of LEGACY_QUERY_KINDS) {
      const template = selectTemplate({ kind, normalization: 'none' } as QueryIntent);
      expect(loader.load(template).trim()).not.toHaveLength(0);
    }
    const dynamicIntents = [
      { kind: 'season_driver_vs_driver', normalization: 'session_median_percent' },
      { kind: 'driver_head_to_head_count', normalization: 'none', filters: { exclude_dnfs: true } }
    ] as QueryIntent[];
    for (const intent of dynamicIntents) {
      expect(loader.load(selectTemplate(intent)).trim()).not.toHaveLength(0);
    }
  });

  it('contracts only result selections with deterministic proof and reviewed generated evidence', async () => {
    const contractedIds = ['qualifying-pole', 'qualifying-third', 'qualifying-top-five', 'race-podium', 'race-second', 'race-top-five', 'race-winner'];
    expect(launchParityManifest.filter(testCase => testCase.implementation === 'contracted').map(testCase => testCase.id).sort()).toEqual(contractedIds);
    const emitted = JSON.parse(readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', 'utf8')) as Array<{ id: string }>;
    const emittedIds = new Set(emitted.map(item => item.id));
    for (const parityCase of launchParityManifest.filter(testCase => testCase.implementation === 'contracted')) {
      const evaluation = answerEvaluationManifest.find(item => item.question === parityCase.question);
      expect(evaluation).toMatchObject({ answerable: true, expected: { action: 'answer', proof_outcome: 'passed' } });
      const contract = createAnswerQuestionContract(parityCase.question);
      const intent = await deriveAnswerIntent(contract, { inventoryMentions: async () => [] });
      expect(intent.type).not.toMatch(/clarification|unsupported/u);
      const proof = await proveAnswerIntent(contract, intent, {
        resolve: async (season, name) => name === 'Australian Grand Prix' ? { type: 'resolved', season, round: 1 } : { type: 'missing' },
        resolveRound: async (season, round) => ({ type: 'resolved', season, round })
      }, { inventoryMentions: async () => [] });
      expect(getF1QLProgramHash(proof.program)).toBe(getF1QLProgramHash(evaluation!.expected.acceptable_programs![0]));
      expect(authorizeAnswerProgram(proof.program).type).toBe('approved');
      expect(emittedIds.has(evaluation?.id ?? '')).toBe(true);
    }
    expect(LEGACY_REMOVAL_ALLOWED).toBe(false);
    expect(launchParityManifest.some(testCase => testCase.implementation === 'pending')).toBe(true);
  });

  it('retains only capabilities with an identified factual authority', () => {
    for (const disposition of Object.values(LAUNCH_CAPABILITY_DISPOSITIONS)) {
      if (disposition.decision !== 'retire') {
        expect(disposition.authorities).not.toContain('none');
      }
      expect(disposition.reason).not.toMatch(/legacy template|because supported/iu);
    }
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_season_summary.authorities).toEqual(expect.arrayContaining(['standings', 'race_classification', 'qualifying_classification']));
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_head_to_head_count.authorities).toEqual(expect.arrayContaining(['race_classification', 'qualifying_classification']));
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_multi_comparison.authorities).toEqual(['standings']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_matchup_lookup.authorities).toEqual(['race_classification', 'qualifying_classification']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.driver_career_wins_by_circuit.authorities).toEqual(['race_classification', 'event_metadata']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.race_results_summary.authorities).toEqual(['race_classification', 'event_metadata']);
    expect(LAUNCH_CAPABILITY_DISPOSITIONS.qualifying_results_summary.authorities).toEqual(['qualifying_classification', 'event_metadata']);
  });
});
