import { describe, expect, it, vi } from 'vitest';
import { SemanticCandidateProposalError } from '../../src/f1ql/semantic-candidate-translator';
import { enumerateSemanticQueries } from '../../src/f1ql/semantic-query';
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

  it('passes only a nonempty exact match for the reviewed first-case oracle', async () => {
    const propose = vi.fn(async request => {
      const evidence = enumerateSemanticQueries(request.question, []);
      if (evidence.type !== 'candidate_set') {throw new Error('missing test candidate set');}
      return { version: 2 as const, candidates: [...evidence.candidates] };
    });
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, { proposer: { propose } })).resolves.toEqual({
      status: 'passed',
      case_id: 'promoted-single-source-rows',
      provider: 'openai-compatible',
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
    })).resolves.toMatchObject({ status: 'failed', reason: 'empty_candidate_set', provider: 'openai-compatible' });

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
    })).resolves.toMatchObject({
      status: 'failed', reason: 'oracle_mismatch', provider: 'openai-compatible',
      mismatch_code: 'semantic_structure'
    });

    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => {throw new SemanticCandidateProposalError('client');} }
    })).resolves.toEqual({
      status: 'failed', reason: 'provider_unavailable', case_id: 'promoted-single-source-rows',
      provider: 'openai-compatible', diagnostic_code: 'client'
    });
  });

  it('classifies oracle drift without retaining candidate content', async () => {
    const evidence = enumerateSemanticQueries(
      (compositionalRegressionCorpusInput as { cases: Array<{ question: string }> }).cases[0].question,
      []
    );
    if (evidence.type !== 'candidate_set') {throw new Error('missing test candidate set');}

    const extraCandidate = structuredClone(evidence.candidates[0]);
    extraCandidate.outputs.pop();
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => ({ version: 2, candidates: [...evidence.candidates, extraCandidate] }) }
    })).resolves.toMatchObject({ reason: 'oracle_mismatch', mismatch_code: 'candidate_count' });

    const evidenceDrift = structuredClone(evidence.candidates[0]);
    evidenceDrift.outputs[0].evidence = structuredClone(evidenceDrift.outputs[1].evidence);
    const result = await probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => ({ version: 2, candidates: [evidenceDrift] }) }
    });
    expect(result).toMatchObject({
      reason: 'oracle_mismatch', mismatch_code: 'evidence_spans', evidence_code: 'outputs'
    });
    expect(JSON.stringify(result)).not.toContain('driver_standings');
    expect(JSON.stringify(result)).not.toContain('championship points');

    const scopeEvidenceDrift = structuredClone(evidence.candidates[0]);
    scopeEvidenceDrift.scopes[0].evidence = structuredClone(scopeEvidenceDrift.scopes[2].evidence);
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => ({ version: 2, candidates: [scopeEvidenceDrift] }) }
    })).resolves.toMatchObject({
      reason: 'oracle_mismatch', mismatch_code: 'evidence_spans', evidence_code: 'scopes'
    });

    const mixedEvidenceDrift = structuredClone(scopeEvidenceDrift);
    mixedEvidenceDrift.outputs[0].evidence = structuredClone(mixedEvidenceDrift.outputs[1].evidence);
    await expect(probeSemanticCandidateProvider(ENABLED_ENVIRONMENT, {
      proposer: { propose: async () => ({ version: 2, candidates: [mixedEvidenceDrift] }) }
    })).resolves.toMatchObject({
      reason: 'oracle_mismatch', mismatch_code: 'evidence_spans', evidence_code: 'mixed'
    });
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
