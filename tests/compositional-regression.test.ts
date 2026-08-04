import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH,
  emitCompositionalRegressionSnapshot
} from '../scripts/snapshot-compositional-regression';
import { compositionalRegressionCorpusInput } from './fixtures/compositional-regression-corpus';
import { answerEvaluationManifest } from './fixtures/f1ql-answer-evaluation-manifest';
import {
  parseCompositionalRegressionCorpus,
  parseCompositionalRegressionSnapshot,
  runCompositionalRegressionCorpus
} from './support/compositional-regression';

describe('Phase 11 compositional regression corpus', () => {
  it('matches the snapshot emitted by the real evidence-to-proof runner', async () => {
    const snapshotSource = readFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, 'utf8');
    const snapshot = parseCompositionalRegressionSnapshot(JSON.parse(snapshotSource));
    const actual = await runCompositionalRegressionCorpus(compositionalRegressionCorpusInput);

    expect(actual).toEqual(snapshot);
    expect(await emitCompositionalRegressionSnapshot()).toBe(snapshotSource);
  });

  it('is exactly accounted, serializable, frozen, and repeatable', async () => {
    const first = await runCompositionalRegressionCorpus(compositionalRegressionCorpusInput);
    const second = await runCompositionalRegressionCorpus(compositionalRegressionCorpusInput);

    expect(first).toEqual(second);
    expect(parseCompositionalRegressionSnapshot(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.cases)).toBe(true);
    expect(first.coverage).toMatchObject({
      cases_total: 22,
      action_counts: { answer: 10, clarify: 5, abstain: 7 },
      topology_counts: {
        single_source_rows: 5,
        single_source_aggregate: 1,
        row_dimension_join: 2,
        scalar_aggregate_compose: 2
      },
      ambiguity_reason_counts: { temporal_ambiguous: 0 }
    });
    expect(first.cases.filter(item => item.split === 'public_holdout').map(item => item.plan_family)).toEqual([
      'single_source',
      'safe_dimension_join',
      'aggregate_locality'
    ]);
  });

  it('fails closed on malformed corpus, snapshot, and coverage drift', async () => {
    const corpus = structuredClone(compositionalRegressionCorpusInput) as any;
    corpus.cases[0].sql = 'SELECT 1';
    expect(() => parseCompositionalRegressionCorpus(corpus)).toThrow();

    const malformedResolver = structuredClone(compositionalRegressionCorpusInput) as any;
    malformedResolver.cases.find((item: any) => item.id === 'promoted-aggregate-locality')
      .resolver.driver_mentions[0].active_candidates = ['not-enumerated'];
    expect(() => parseCompositionalRegressionCorpus(malformedResolver)).toThrow();

    const wrongCoverage = structuredClone(compositionalRegressionCorpusInput) as any;
    wrongCoverage.expected_coverage.cases_total = 23;
    await expect(runCompositionalRegressionCorpus(wrongCoverage)).rejects.toThrow('coverage mismatch');

    const snapshot = JSON.parse(readFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, 'utf8'));
    snapshot.execution = true;
    expect(() => parseCompositionalRegressionSnapshot(snapshot)).toThrow();

    const partialAnswer = JSON.parse(readFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, 'utf8'));
    partialAnswer.cases[0].proof = null;
    expect(() => parseCompositionalRegressionSnapshot(partialAnswer)).toThrow();

    const contradictoryReason = JSON.parse(readFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, 'utf8'));
    const clarification = contradictoryReason.cases.find((item: any) => item.action === 'clarify');
    clarification.admission.reason = 'unsupported_scope';
    expect(() => parseCompositionalRegressionSnapshot(contradictoryReason)).toThrow();

    const contradictorySources = JSON.parse(readFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, 'utf8'));
    contradictorySources.cases[0].resolution.source_ids = ['event_classification'];
    expect(() => parseCompositionalRegressionSnapshot(contradictorySources)).toThrow();

    const contradictoryEntity = JSON.parse(readFileSync(COMPOSITIONAL_REGRESSION_SNAPSHOT_PATH, 'utf8'));
    const resolved = contradictoryEntity.cases.find((item: any) => item.resolution?.entities.length > 0);
    resolved.resolution.entities[0].selected_id = 'not-a-candidate';
    expect(() => parseCompositionalRegressionSnapshot(contradictoryEntity)).toThrow();
  });

  it('preserves the existing 110-case exact-template evaluation as a separate suite', async () => {
    const compositional = await runCompositionalRegressionCorpus(compositionalRegressionCorpusInput);
    expect(answerEvaluationManifest).toHaveLength(110);
    expect(compositional.cases).toHaveLength(22);
    const legacyIds = new Set(answerEvaluationManifest.map(item => item.id));
    expect(compositional.cases.every(item => !legacyIds.has(item.id))).toBe(true);
    expect(JSON.stringify(compositional)).not.toContain('template_id');
  });

  it('does not directly import or invoke route, provider, database, or execution paths', () => {
    const runnerSource = readFileSync('tests/support/compositional-regression.ts', 'utf8');
    expect(runnerSource).not.toMatch(/from\s+['"][^'"]*(?:api|routes?|providers?|executor|database)[^'"]*['"]/iu);
    expect(runnerSource).not.toMatch(/from\s+['"](?:pg|express|redis|@anthropic-ai\/sdk)(?:\/[^'"]*)?['"]/u);
    expect(runnerSource).not.toMatch(/executeF1QL|executePlannedF1QL|new\s+Pool\s*\(|\.query\s*\(/u);
  });
});
