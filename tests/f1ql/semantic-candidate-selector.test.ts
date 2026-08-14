import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSemanticCandidateSelectionRequest,
  getConfiguredSemanticCandidateSelectionIdentity,
  SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS,
  SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_PROJECTION_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT,
  SEMANTIC_CANDIDATE_SELECTION_VERSION,
  SemanticCandidateSelectionAdapter,
  SemanticCandidateSelectionProviderRequest
} from '../../src/f1ql/semantic-candidate-selector';
import {
  OpenAICompatibleSemanticCandidateModel,
  SemanticCandidateModel,
  SemanticCandidateProposalError,
  SemanticCandidateStructuredOutputContract
} from '../../src/f1ql/semantic-candidate-translator';
import {
  computeSemanticQueryHash,
  enumerateSemanticQueries
} from '../../src/f1ql/semantic-query';

const QUESTION = 'List driver and championship points from final 2025 driver standings.';

afterEach(() => vi.unstubAllGlobals());

describe('server-enumerated semantic candidate selection', () => {
  it('lets the provider return only an opaque id and resolves it to the exact server-owned query', async () => {
    const evidence = uniqueEvidence();
    let observedRequest: SemanticCandidateSelectionProviderRequest | undefined;
    let observedContract: SemanticCandidateStructuredOutputContract | undefined;
    const model: SemanticCandidateModel = {
      complete: async (prompt, request, _signal, contract) => {
        expect(prompt).toBe(SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT);
        observedRequest = request as SemanticCandidateSelectionProviderRequest;
        observedContract = contract;
        return JSON.stringify({
          version: SEMANTIC_CANDIDATE_SELECTION_VERSION,
          candidate_id: observedRequest.candidates[0].candidate_id
        });
      }
    };

    const selected = await new SemanticCandidateSelectionAdapter(model)
      .propose(buildSemanticCandidateSelectionRequest(QUESTION, evidence));

    expect(selected.candidates).toEqual(evidence.candidates);
    expect(observedRequest).toEqual({
      version: SEMANTIC_CANDIDATE_SELECTION_VERSION,
      question: QUESTION,
      semantic_query_version: 2,
      candidate_set_hash: evidence.candidate_set_hash,
      candidates: [{
        candidate_id: computeSemanticQueryHash(evidence.candidates[0]),
        semantic_query: evidence.candidates[0]
      }]
    });
    expect(observedContract).toMatchObject({
      schema_name: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
      max_tokens: SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS,
      openai_schema: {
        additionalProperties: false,
        required: ['version', 'candidate_id'],
        properties: {
          candidate_id: { enum: [computeSemanticQueryHash(evidence.candidates[0])] }
        }
      }
    });
  });

  it('fails closed before provider access when choices are not bound to independent evidence', async () => {
    const evidence = uniqueEvidence();
    let calls = 0;
    const adapter = new SemanticCandidateSelectionAdapter({
      complete: async () => {calls += 1; return '{}';}
    });
    await expect(adapter.propose({
      ...buildSemanticCandidateSelectionRequest(QUESTION, evidence),
      candidate_set_hash: '0'.repeat(64)
    })).rejects.toEqual(expect.objectContaining({ code: 'schema_invalid' }));
    expect(calls).toBe(0);
  });

  it.each([
    { version: 2, candidate_id: '0'.repeat(64) },
    { version: 2, candidate_id: '0'.repeat(64), semantic_query: {} },
    { version: 1, candidate_id: '0'.repeat(64) },
    {},
    []
  ])('rejects every response that is not exactly one enumerated id: %j', async response => {
    const evidence = uniqueEvidence();
    const adapter = new SemanticCandidateSelectionAdapter({
      complete: async () => JSON.stringify(response)
    });
    await expect(adapter.propose(buildSemanticCandidateSelectionRequest(QUESTION, evidence)))
      .rejects.toEqual(expect.objectContaining<Partial<SemanticCandidateProposalError>>({ code: 'schema_invalid' }));
  });

  it('uses the tiny dynamic enum schema on the actual OpenAI-compatible wire', async () => {
    const evidence = uniqueEvidence();
    const candidateId = computeSemanticQueryHash(evidence.candidates[0]);
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: 'strict-model',
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ version: 2, candidate_id: candidateId }) }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const model = new OpenAICompatibleSemanticCandidateModel(
      'https://strict.example/v1', 'private-key', 'strict-model'
    );

    await expect(new SemanticCandidateSelectionAdapter(model)
      .propose(buildSemanticCandidateSelectionRequest(QUESTION, evidence)))
      .resolves.toMatchObject({ candidates: evidence.candidates });

    expect(body).toMatchObject({
      max_tokens: 128,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
          strict: true,
          schema: { properties: { candidate_id: { enum: [candidateId] } } }
        }
      }
    });
    expect(JSON.stringify(body)).not.toContain('private-key');
  });

  it('publishes a distinct provider identity for the authority-reduced contract', () => {
    const identity = getConfiguredSemanticCandidateSelectionIdentity({
      F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'openai-compatible',
      F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://strict.example/v1',
      F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY: 'private-key',
      F1QL_SEMANTIC_CANDIDATE_MODEL: 'strict-model',
      F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA: 'true',
      F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS: '300000'
    });
    expect(identity).toMatchObject({
      catalog_projection_sha256: SEMANTIC_CANDIDATE_SELECTION_PROJECTION_SHA256,
      prompt_sha256: SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256,
      schema_sha256: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256
    });
    expect(identity.request_config_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

function uniqueEvidence() {
  const evidence = enumerateSemanticQueries(QUESTION, []);
  if (evidence.type !== 'candidate_set' || evidence.candidates.length !== 1 || evidence.ambiguity_reason) {
    throw new Error('selector test requires one independently enumerated candidate');
  }
  return evidence;
}
