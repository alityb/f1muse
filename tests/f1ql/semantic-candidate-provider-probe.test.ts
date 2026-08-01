import { describe, expect, it, vi } from 'vitest';
import {
  probeSemanticCandidateProvider,
  type SemanticCandidateProviderProbeResult
} from '../../scripts/probe-semantic-candidate-provider';
import reviewedSnapshot from '../fixtures/compositional-regression.snapshot.json';
import { compositionalRegressionCorpusInput } from '../fixtures/compositional-regression-corpus';

const ENABLED_ENVIRONMENT: NodeJS.ProcessEnv = {
  F1QL_SEMANTIC_CANDIDATE_PROBE_ENABLED: 'true',
  F1QL_SEMANTIC_CANDIDATE_PROBE_TARGET: 'non-production',
  F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'openai-compatible',
  F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://api.fireworks.ai/inference/v1',
  F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY: 'test-key',
  F1QL_SEMANTIC_CANDIDATE_MODEL: 'accounts/fireworks/models/deepseek-v4-flash',
  F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA: 'true',
  F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS: '30000'
};

const acceptProbeResult = (_result: SemanticCandidateProviderProbeResult): void => undefined;
if (false) {
  // @ts-expect-error evidence locations exist only on evidence-span mismatches
  acceptProbeResult({ status: 'passed', case_id: 'case', provider: 'openai-compatible', candidate_count: 1, oracle_match: true, evidence_code: 'outputs' });
  // @ts-expect-error evidence locations exist only on evidence-span mismatches
  acceptProbeResult({ status: 'failed', reason: 'guard_refused', evidence_code: 'outputs' });
}

describe('semantic candidate provider probe', () => {
  it('refuses before provider construction unless both probe guards are exact', async () => {
    const propose = vi.fn();
    for (const environment of [
      {},
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_PROBE_ENABLED: 'false' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_PROBE_TARGET: 'production' }
    ]) {
      await expect(probeSemanticCandidateProvider(environment, { proposer: { propose } })).resolves.toEqual({
        status: 'failed', reason: 'guard_refused'
      });
    }
    expect(propose).not.toHaveBeenCalled();
  });

  it('refuses the retired V4 Flash identity before a request', async () => {
    const propose = vi.fn();
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, { proposer: { propose } })).resolves.toEqual({
      status: 'failed', reason: 'provider_identity_retired', case_id: 'promoted-single-source-rows'
    });
    expect(propose).not.toHaveBeenCalled();
  });

  it('fails closed on fixture drift before checking the retired identity', async () => {
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      corpusInput: {}, proposer: { propose: vi.fn() }
    })).resolves.toEqual({ status: 'failed', reason: 'reviewed_fixture_invalid' });

    const driftedCorpus = structuredClone(compositionalRegressionCorpusInput) as {
      cases: Array<{ question: string }>;
    };
    driftedCorpus.cases[1].question = `${driftedCorpus.cases[1].question} drift`;
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      corpusInput: driftedCorpus, proposer: { propose: vi.fn() }
    })).resolves.toEqual({ status: 'failed', reason: 'reviewed_fixture_invalid' });

    const driftedSnapshot = structuredClone(reviewedSnapshot) as unknown as { cases: unknown[] };
    driftedSnapshot.cases[1] = {};
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      snapshotInput: driftedSnapshot, proposer: { propose: vi.fn() }
    })).resolves.toEqual({ status: 'failed', reason: 'reviewed_fixture_invalid' });

    const sparseCorpus = structuredClone(compositionalRegressionCorpusInput) as {
      cases: Array<{ resolver: { driver_mentions: unknown[] } }>;
    };
    sparseCorpus.cases[0].resolver.driver_mentions = Array(1);
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      corpusInput: sparseCorpus, proposer: { propose: vi.fn() }
    })).resolves.toEqual({ status: 'failed', reason: 'reviewed_fixture_invalid' });

    const symbolCorpus = structuredClone(compositionalRegressionCorpusInput) as {
      cases: Array<{ resolver: { driver_mentions: unknown[] } }>;
    };
    Object.defineProperty(symbolCorpus.cases[0].resolver.driver_mentions, Symbol('drift'), { value: true });
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      corpusInput: symbolCorpus, proposer: { propose: vi.fn() }
    })).resolves.toEqual({ status: 'failed', reason: 'reviewed_fixture_invalid' });
  });

  it('rejects provider identity drift before a request', async () => {
    const propose = vi.fn();
    for (const environment of [
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'anthropic' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://proxy.example/v1' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_MODEL: 'accounts/fireworks/models/deepseek-v4-pro' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS: '10000' }
    ]) {
      await expect(probeSemanticCandidateProvider(environment, { proposer: { propose } })).resolves.toMatchObject({
        status: 'failed', reason: 'provider_not_configured'
      });
    }
    expect(propose).not.toHaveBeenCalled();
  });
});
