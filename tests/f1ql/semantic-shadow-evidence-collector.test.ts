import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertCompleteReviewedCompositionalCorpus,
  assertSemanticShadowCollectionGuards,
  createSemanticShadowProviderPacer,
  formatSemanticShadowProviderFailureCode,
  isTransientSemanticShadowProviderDiagnostic,
  parseSemanticShadowMinRequestIntervalMs,
  semanticShadowTransientRetryDelayMs
} from '../../scripts/collect-semantic-shadow-evidence';
import { compositionalRegressionCorpusInput } from '../fixtures/compositional-regression-corpus';

const DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test';
const ENABLED_ENVIRONMENT: NodeJS.ProcessEnv = {
  F1QL_SEMANTIC_SHADOW_COLLECTION_ENABLED: 'true',
  F1QL_SEMANTIC_SHADOW_COLLECTION_TARGET: 'localhost',
  F1QL_SEMANTIC_SHADOW_COLLECTION_REPETITIONS: '3'
};
const snapshot = () => JSON.parse(
  readFileSync('tests/fixtures/compositional-regression.snapshot.json', 'utf8')
) as unknown;

describe('WP8 semantic shadow evidence collector', () => {
  it('requires exact collection flags, three repetitions, and the disposable Docker URL', () => {
    expect(() => assertSemanticShadowCollectionGuards(ENABLED_ENVIRONMENT, DATABASE_URL)).not.toThrow();
    for (const [environment, databaseUrl] of [
      [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_COLLECTION_ENABLED: 'TRUE' }, DATABASE_URL],
      [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_COLLECTION_TARGET: 'production' }, DATABASE_URL],
      [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_COLLECTION_TARGET: '127.0.0.1' }, DATABASE_URL],
      [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_COLLECTION_REPETITIONS: '2' }, DATABASE_URL],
      [{ ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_SHADOW_COLLECTION_REPETITIONS: '03' }, DATABASE_URL],
      [ENABLED_ENVIRONMENT, 'postgresql://postgres:postgres@localhost:5433/f1muse_test'],
      [ENABLED_ENVIRONMENT, 'postgresql://production.example/f1muse']
    ] as const) {
      expect(() => assertSemanticShadowCollectionGuards(environment, databaseUrl)).toThrow();
    }
  });

  it('binds all 50 reviewed questions and outcomes to the committed compositional snapshot', () => {
    const reviewed = assertCompleteReviewedCompositionalCorpus(compositionalRegressionCorpusInput, snapshot());
    expect(reviewed.corpus.cases).toHaveLength(50);
    expect(reviewed.snapshot.cases).toHaveLength(50);

    const partial = structuredClone(compositionalRegressionCorpusInput) as any;
    partial.cases.pop();
    expect(() => assertCompleteReviewedCompositionalCorpus(partial, snapshot())).toThrow('complete reviewed');

    const changedQuestion = structuredClone(compositionalRegressionCorpusInput) as any;
    changedQuestion.cases[0].question = 'Changed reviewed question.';
    expect(() => assertCompleteReviewedCompositionalCorpus(changedQuestion, snapshot())).toThrow('reviewed snapshot');

    const changedOutcome = structuredClone(compositionalRegressionCorpusInput) as any;
    changedOutcome.cases[0].expected = { action: 'abstain', reason: 'unsupported_scope' };
    expect(() => assertCompleteReviewedCompositionalCorpus(changedOutcome, snapshot())).toThrow('reviewed snapshot');

    const changedMetadata = structuredClone(compositionalRegressionCorpusInput) as any;
    changedMetadata.cases[0].risk_tags = ['aggregation'];
    expect(() => assertCompleteReviewedCompositionalCorpus(changedMetadata, snapshot())).toThrow('reviewed snapshot');
  });

  it('parses only bounded integer pacing intervals', () => {
    expect(parseSemanticShadowMinRequestIntervalMs(undefined)).toBe(0);
    expect(parseSemanticShadowMinRequestIntervalMs('0')).toBe(0);
    expect(parseSemanticShadowMinRequestIntervalMs('60000')).toBe(60_000);
    for (const value of ['', '-1', '1.5', ' 1', '60001', 'Infinity']) {
      expect(() => parseSemanticShadowMinRequestIntervalMs(value)).toThrow('between 0 and 60000');
    }
  });

  it('formats only closed provider failure codes', () => {
    expect(formatSemanticShadowProviderFailureCode(undefined)).toBe('provider_unknown');
    expect(formatSemanticShadowProviderFailureCode('unknown')).toBe('provider_unknown');
    expect(formatSemanticShadowProviderFailureCode('request_timeout')).toBe('provider_request_timeout');
    expect(formatSemanticShadowProviderFailureCode('rate_limit')).toBe('provider_rate_limit');
  });

  it('classifies only transient provider diagnostics as retryable', () => {
    for (const code of ['transport', 'server', 'malformed', 'incomplete', 'schema_invalid', 'request_timeout', 'cancelled', 'unknown'] as const) {
      expect(isTransientSemanticShadowProviderDiagnostic(code)).toBe(true);
    }
    for (const code of ['forbidden_output', 'auth', 'quota', 'rate_limit', 'oversize', 'client'] as const) {
      expect(isTransientSemanticShadowProviderDiagnostic(code)).toBe(false);
    }
    expect(isTransientSemanticShadowProviderDiagnostic(undefined)).toBe(false);
  });

  it('bounds transient retry delays to three attempts and one minute', () => {
    expect(semanticShadowTransientRetryDelayMs(1)).toBe(5_000);
    expect(semanticShadowTransientRetryDelayMs(2)).toBe(10_000);
    expect(semanticShadowTransientRetryDelayMs(3)).toBe(15_000);
    for (const value of [0, 1.5, -1, 4, Number.POSITIVE_INFINITY]) {
      expect(() => semanticShadowTransientRetryDelayMs(value)).toThrow('between 1 and 3');
    }
  });

  it('paces sequential attempts against a monotonic clock without provider or database access', async () => {
    const times = [100, 100, 125, 150];
    const sleeps: number[] = [];
    const pace = createSemanticShadowProviderPacer(50, {
      now: () => times.shift()!,
      sleep: async delay => {sleeps.push(delay);}
    });

    await pace();
    await pace();
    expect(sleeps).toEqual([50, 25]);
    expect(() => createSemanticShadowProviderPacer(60_001)).toThrow('between 0 and 60000');

    const backwards = createSemanticShadowProviderPacer(1, {
      now: (() => {
        const values = [2, 1];
        return () => values.shift()!;
      })()
    });
    await backwards();
    await expect(backwards()).rejects.toThrow('monotonic');
  });

  it('has source-level throwing-executor and non-production target invariants', () => {
    const source = readFileSync('scripts/collect-semantic-shadow-evidence.ts', 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*(?:executor|answer-execution|semantic-capability-authorization)[^'"]*['"]/u);
    expect(source).not.toMatch(/executeF1QL|executePlannedF1QL|executeVerifiedF1QL/u);
    expect(source).toMatch(/createProgramSemanticShadowRoutes\(pool,[\s\S]*?\}, throwingExecutor\)\)/u);
    expect(source).toMatch(/const throwingExecutor = \(\): never => \{\s*executionAttempts \+= 1;\s*throw new Error/u);
    expect(source).toContain("F1QL_SEMANTIC_SHADOW_COLLECTION_TARGET !== 'localhost'");
    expect(source).toContain('databaseUrl !== DISPOSABLE_DATABASE_URL');
    expect(source).toContain("const DISPOSABLE_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test'");
    expect(source).not.toMatch(/COLLECTION_TARGET\s*===?\s*['"]production['"]/u);
    expect(source).toContain("activeProviderDiagnosticCode = error instanceof SemanticCandidateProposalError ? error.code : 'unknown'");
    expect(source).toContain('formatSemanticShadowProviderFailureCode(providerDiagnosticCode)');
    expect(source).not.toMatch(/activeProviderDiagnosticCode\s*=\s*(?:String\()?error\.message/u);
  });
});
