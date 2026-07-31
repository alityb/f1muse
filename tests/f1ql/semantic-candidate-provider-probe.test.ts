import { describe, expect, it, vi } from 'vitest';
import { SemanticCandidateProposalError } from '../../src/f1ql/semantic-candidate-translator';
import { enumerateSemanticQueries } from '../../src/f1ql/semantic-query';
import { probeSemanticCandidateProvider } from '../../scripts/probe-semantic-candidate-provider';
import reviewedSnapshot from '../fixtures/compositional-regression.snapshot.json';
import { compositionalRegressionCorpusInput } from '../fixtures/compositional-regression-corpus';

const ENABLED_ENVIRONMENT: NodeJS.ProcessEnv = {
  F1QL_SEMANTIC_CANDIDATE_PROBE_ENABLED: 'true',
  F1QL_SEMANTIC_CANDIDATE_PROBE_TARGET: 'non-production',
  F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'anthropic',
  F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://api.anthropic.com/v1',
  F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY: 'test-key',
  F1QL_SEMANTIC_CANDIDATE_MODEL: 'claude-haiku-4-5-20251001',
  F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA: 'true',
  F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS: '30000'
};

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

  it('passes only a nonempty exact match for the reviewed first-case oracle', async () => {
    const propose = vi.fn(async request => {
      const evidence = enumerateSemanticQueries(request.question, []);
      if (evidence.type !== 'candidate_set') {throw new Error('missing test candidate set');}
      return { version: 2 as const, candidates: [...evidence.candidates] };
    });
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, { proposer: { propose } })).resolves.toEqual({
      status: 'passed',
      case_id: 'promoted-single-source-rows',
      provider: 'anthropic',
      candidate_count: 1,
      oracle_match: true
    });
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('fails closed on fixture drift, empty candidates, oracle drift, and typed provider failure', async () => {
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

    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => ({ version: 2, candidates: [] }) }
    })).resolves.toMatchObject({ status: 'failed', reason: 'empty_candidate_set', provider: 'anthropic' });

    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: {
        propose: async request => {
          const evidence = enumerateSemanticQueries(request.question, []);
          if (evidence.type !== 'candidate_set') {throw new Error('missing test candidate set');}
          const candidate = structuredClone(evidence.candidates[0]);
          candidate.outputs.pop();
          return { version: 2, candidates: [candidate] };
        }
      }
    })).resolves.toMatchObject({ status: 'failed', reason: 'oracle_mismatch', provider: 'anthropic' });

    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => {throw new SemanticCandidateProposalError('client');} }
    })).resolves.toEqual({
      status: 'failed', reason: 'provider_unavailable', case_id: 'promoted-single-source-rows',
      provider: 'anthropic', diagnostic_code: 'client'
    });
  });

  it('rejects provider identity drift before a request', async () => {
    const propose = vi.fn();
    for (const environment of [
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'openai-compatible' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://proxy.example/v1' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_MODEL: 'claude-sonnet-4-5' },
      { ...ENABLED_ENVIRONMENT, F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS: '10000' }
    ]) {
      await expect(probeSemanticCandidateProvider(environment, { proposer: { propose } })).resolves.toMatchObject({
        status: 'failed', reason: 'provider_not_configured'
      });
    }
    expect(propose).not.toHaveBeenCalled();
  });
});
