import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicSemanticCandidateModel,
  buildSemanticCandidateCatalogProjection,
  buildSemanticCandidateProviderRequest,
  createSemanticCandidateModel,
  getConfiguredSemanticCandidateModelIdentity,
  hydrateSemanticCandidateProposals,
  OpenAICompatibleSemanticCandidateModel,
  SemanticCandidateProposalAdapter,
  SemanticCandidateProposalError,
  SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA,
  SEMANTIC_CANDIDATE_ANTHROPIC_SCHEMA_SHA256,
  SEMANTIC_CANDIDATE_CATALOG_PROJECTION,
  SEMANTIC_CANDIDATE_CATALOG_PROJECTION_SHA256,
  SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT,
  SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT,
  SEMANTIC_CANDIDATE_JSON_SCHEMA,
  SEMANTIC_CANDIDATE_PROVIDER_DIAGNOSTIC_CODES,
  SEMANTIC_CANDIDATE_SYSTEM_PROMPT,
  SemanticCandidateModel,
  translateSemanticCandidateQuestion
} from '../../src/f1ql/semantic-candidate-translator';
import {
  enumerateSemanticQueries,
  SEMANTIC_QUERY_MAX_CANDIDATES,
  SEMANTIC_QUERY_VERSION,
  SemanticEvidence,
  SemanticLiteralSpan,
  SemanticQuery
} from '../../src/f1ql/semantic-query';

const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const RACE_QUALIFYING = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const QUALIFYING_RANK = 'Show top 10 drivers by count of qualifying position in final 2025 qualifying classification.';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('semantic candidate translator foundation', () => {
  it('hydrates and admits proposals for every currently promoted topology', async () => {
    const cases = [
      { question: STANDINGS, entities: [] },
      { question: RACE_METADATA, entities: [] },
      { question: RACE_QUALIFYING, entities: [{ type: 'driver', span: span(RACE_QUALIFYING, 'Norris') }] },
      { question: QUALIFYING_RANK, entities: [] }
    ];
    for (const testCase of cases) {
      const evidence = candidateEvidence(testCase.question, testCase.entities);
      const provider = proposalSet(evidence.candidates);
      expect(hydrateSemanticCandidateProposals(provider, testCase.question).candidates).toEqual(evidence.candidates);
      await expect(translateSemanticCandidateQuestion(
        testCase.question,
        evidence,
        modelReturning(provider)
      )).resolves.toMatchObject({ type: 'admitted', query: evidence.candidates[0] });
    }
  });

  it('reconstructs literal season, round, limit, and filter values instead of accepting them', () => {
    const raceQuestion = 'List driver and finishing position for round 1 of the final 2025 race classification.';
    const raceEvidence = candidateEvidence(raceQuestion);
    const raceProposal = proposalSet(raceEvidence.candidates) as ProposalSet;
    const one = spanRef(span(raceQuestion, '1'));
    raceProposal.candidates[0].filters = [{
      operation: 'literal_filter',
      concept: { source_ref: 'event_classification', concept_ref: 'finishing_position' },
      operator: 'eq',
      value_span: one,
      evidence: [one]
    }];
    expect(hydrateSemanticCandidateProposals(raceProposal, raceQuestion).candidates[0]).toMatchObject({
      scopes: expect.arrayContaining([
        expect.objectContaining({ kind: 'season', value: 2025 }),
        expect.objectContaining({ kind: 'round', value: 1 })
      ]),
      filters: [expect.objectContaining({ kind: 'literal', value: 1 })]
    });

    const rankEvidence = candidateEvidence(QUALIFYING_RANK);
    expect(hydrateSemanticCandidateProposals(proposalSet(rankEvidence.candidates), QUALIFYING_RANK).candidates[0].limit)
      .toMatchObject({ value: 10, evidence: [span(QUALIFYING_RANK, 'top 10')] });
    const providerSchema = JSON.stringify(SEMANTIC_CANDIDATE_JSON_SCHEMA);
    expect(providerSchema).not.toMatch(/"(?:text|season|round|filter_value|limit_value)"\s*:/u);
    expect(providerSchema).toContain('"$ref":"#/$defs/concept_ref"');
    expect(providerSchema).toContain('"$ref":"#/$defs/evidence_ref"');
    expect(() => assertStrictProviderSchema(SEMANTIC_CANDIDATE_JSON_SCHEMA)).not.toThrow();
    expect(countProviderSchemaProperties(SEMANTIC_CANDIDATE_JSON_SCHEMA)).toBeLessThanOrEqual(100);
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('pair each concept_ref only with the source_ref that contains it');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('one source-qualified session scope for every referenced source');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('use null, never an empty array or object');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('For every candidate, exclude a concept phrase contained in a longer explicit source phrase');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('among overlapping phrases for the same concept retain the containing phrase, then use the earliest remaining occurrence');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('Each output evidence must copy the complete start and end offsets');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('never use an explicit source phrase for a single-source session scope');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('retain only globally longest phrases for each source-qualified concept, then use the earliest remaining concept phrase not contained in another selected phrase');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('use the earliest explicit source phrase for that source when present, otherwise reuse the earliest output evidence span');
    expect(SEMANTIC_CANDIDATE_SYSTEM_PROMPT).toContain('operation, temporal, season, round, limit, filter, and comparison evidence');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('For either exact unfiltered form "show the final YYYY standings points" or the current reviewed form "what were the final standings points in 2025?"');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('For the exact filtered shorthand "what were Charles Leclerc final standings points in 2024?"');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('For either exact pair shorthand "final 2025 standings points for Lando Norris and Oscar Piastri." or "final 2025 standings points for Oscar Piastri and Lando Norris."');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('zero to four specific driver entities; use eq for one driver and in for two to four');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('driver and finishing position from a final YYYY race classification at exactly one round or named event');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('one to four specific driver entities');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('driver and qualifying position from a final YYYY qualifying classification at exactly one round or named event');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('Do not extend either classification-selection rule to season-wide filtered selections or user-supplied limits');
    expect(SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT)
      .toContain('requests that name either race date or circuit identifier from final YYYY event metadata at exactly one round or named event');
    expect(SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT)
      .toContain('A circuit identifier is a raw identifier, not a circuit, venue, or Grand Prix name');
    expect(SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT)
      .toContain('Never generalize bare points or standings-points shorthand beyond the exact shorthand forms');
  });

  it('fails closed for malformed, extra, duplicate, and overflowing candidate sets', async () => {
    const evidence = candidateEvidence(STANDINGS);
    const valid = proposalSet(evidence.candidates) as ProposalSet;
    const invalidConceptPair = structuredClone(valid);
    invalidConceptPair.candidates[0].outputs[0].concept = {
      source_ref: 'driver_standings',
      concept_ref: 'finishing_position'
    };
    const invalid = [
      {},
      { ...valid, extra: true },
      { ...valid, candidates: [{ ...valid.candidates[0], extra: true }] },
      { ...valid, candidates: [valid.candidates[0], structuredClone(valid.candidates[0])] },
      { ...valid, candidates: Array.from({ length: 6 }, () => structuredClone(valid.candidates[0])) },
      invalidConceptPair
    ];
    for (const output of invalid) {
      await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, modelReturning(output))).resolves.toMatchObject({
        type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'schema_invalid'
      });
    }
  });

  it('canonicalizes only empty-array nullable fields before strict semantic validation', async () => {
    const evidence = candidateEvidence(STANDINGS);
    const emptyNullables = proposalSet(evidence.candidates) as ProposalSet;
    emptyNullables.candidates[0].comparison = [] as unknown as Record<string, unknown>;
    emptyNullables.candidates[0].limit = [] as unknown as { evidence: SpanRef[] };
    expect(hydrateSemanticCandidateProposals(emptyNullables, STANDINGS).candidates).toEqual(evidence.candidates);

    const nonempty = structuredClone(emptyNullables);
    nonempty.candidates[0].comparison = [{}] as unknown as Record<string, unknown>;
    await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, modelReturning(nonempty))).resolves.toMatchObject({
      type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'schema_invalid'
    });
  });

  it('rejects out-of-range, empty, and UTF-16-confused code-point spans', async () => {
    const question = `🏁 ${STANDINGS}`;
    const evidence = candidateEvidence(question);
    const valid = proposalSet(evidence.candidates) as ProposalSet;

    const outside = structuredClone(valid);
    outside.candidates[0].outputs[0].evidence[0] = { start: 0, end: 1_000 };
    await expect(translateSemanticCandidateQuestion(question, evidence, modelReturning(outside))).resolves.toMatchObject({
      type: 'provider_unavailable', diagnostic_code: 'schema_invalid'
    });

    const empty = structuredClone(valid);
    empty.candidates[0].outputs[0].evidence[0] = { start: 1, end: 1 };
    await expect(translateSemanticCandidateQuestion(question, evidence, modelReturning(empty))).resolves.toMatchObject({
      type: 'provider_unavailable', diagnostic_code: 'schema_invalid'
    });

    const utf16 = structuredClone(valid);
    const season = utf16.candidates[0].scopes.find(scope => scope.operation === 'season');
    if (!season) throw new Error('missing season proposal');
    season.evidence = season.evidence.map(reference => ({ start: reference.start + 1, end: reference.end + 1 }));
    await expect(translateSemanticCandidateQuestion(question, evidence, modelReturning(utf16))).resolves.toMatchObject({
      type: 'provider_unavailable', diagnostic_code: 'schema_invalid'
    });
  });

  it('rejects forbidden keys, query languages, physical topology, projection leakage, and canonical identity values', async () => {
    const evidence = candidateEvidence(STANDINGS);
    const valid = proposalSet(evidence.candidates) as ProposalSet;
    const forbidden = [
      { ...valid, sql: 'SELECT * FROM private_table' },
      { ...valid, candidates: [{ ...valid.candidates[0], physical_field: 'points' }] },
      { ...valid, candidates: [{ ...valid.candidates[0], join: 'race_event_metadata' }] },
      { ...valid, candidates: [{ ...valid.candidates[0], driver_id: 'max-verstappen' }] },
      { ...valid, candidates: [{ ...valid.candidates[0], canonicalId: 'max-verstappen' }] },
      { ...valid, candidates: [{ ...valid.candidates[0], catalogProjection: { names: ['private'] } }] },
      { ...valid, candidates: [{ ...valid.candidates[0], note: 'F1QL Core' }] }
    ];
    for (const output of forbidden) {
      await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, modelReturning(output))).resolves.toEqual({
        type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'forbidden_output'
      });
    }
  });

  it('sends strict schema requests with only the proposal contract and language catalog', async () => {
    let url = '';
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      url = String(input);
      request = JSON.parse(String(init?.body));
      return completedResponse(JSON.stringify({ version: 1, candidates: [] }), 'strict-model');
    }));
    const model = new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', 'private-key', 'strict-model');
    await model.complete('system', buildSemanticCandidateProviderRequest(`  ${STANDINGS}  `));
    expect(url).toBe('https://strict.example/v1/chat/completions');
    expect(request).toMatchObject({
      model: 'strict-model',
      max_tokens: 8_192,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'f1_semantic_candidate_proposals_v1',
          strict: true,
          schema: SEMANTIC_CANDIDATE_JSON_SCHEMA
        }
      }
    });
    const messages = request?.messages as Array<{ role: string; content: string }>;
    const providerInput = JSON.parse(messages[1].content);
    expect(providerInput).toEqual({
      question: STANDINGS,
      semantic_query_version: SEMANTIC_QUERY_VERSION,
      max_candidates: SEMANTIC_QUERY_MAX_CANDIDATES,
      catalog: SEMANTIC_CANDIDATE_CATALOG_PROJECTION
    });
    expect(JSON.stringify(providerInput)).not.toMatch(/"(?:entity_inventory|canonical_id|admission|physical_field|physical_type|relationships|integrity|grain|authority|coverage)"\s*:/iu);
    expect(request).not.toHaveProperty('tools');
  });

  it('sends native Anthropic structured-output requests with a compatible strict schema', async () => {
    let url = '';
    let headers = new Headers();
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ version: 1, candidates: [] }) }]
      }), { status: 200 });
    }));
    const model = new AnthropicSemanticCandidateModel(
      'https://api.anthropic.com/v1',
      'private-key',
      'claude-haiku-4-5-20251001'
    );
    await model.complete('system', buildSemanticCandidateProviderRequest(STANDINGS));

    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-api-key')).toBe('private-key');
    expect(headers.has('authorization')).toBe(false);
    expect(request).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      system: 'system',
      output_config: { format: { type: 'json_schema', schema: SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA } }
    });
    expect(request).not.toHaveProperty('response_format');
    const messages = request?.messages as Array<{ role: string; content: string }>;
    expect(JSON.parse(messages[0].content)).toEqual(buildSemanticCandidateProviderRequest(STANDINGS));
    const wireSchema = JSON.stringify(SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA);
    expect(() => assertStrictProviderSchema(SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA)).not.toThrow();
    expect(wireSchema).not.toMatch(/"(?:minimum|maximum|maxItems)":/u);
    expect(wireSchema).toContain('"minItems":1');
    expect(wireSchema).not.toContain('"minItems":3');
    expect(wireSchema).not.toContain('"type":"array","maxItems":0');
  });

  it('adapts orchestration proposals without forwarding identity inventory or deterministic evidence', async () => {
    const evidence = candidateEvidence(RACE_QUALIFYING, [{ type: 'driver', span: span(RACE_QUALIFYING, 'Norris') }]);
    const output = proposalSet(evidence.candidates);
    let providerRequest: unknown;
    const adapter = new SemanticCandidateProposalAdapter({
      complete: async (_systemPrompt, request) => {
        providerRequest = request;
        return JSON.stringify(output);
      }
    });
    const orchestrationRequest = {
      question: RACE_QUALIFYING,
      semantic_query_version: SEMANTIC_QUERY_VERSION,
      max_candidates: SEMANTIC_QUERY_MAX_CANDIDATES,
      entity_inventory: [{ type: 'driver', canonical_id: 'private-norris-id' }],
      evidence: { private: true },
      admission: { private: true }
    };

    await expect(adapter.propose(orchestrationRequest)).resolves.toEqual({
      version: SEMANTIC_QUERY_VERSION,
      candidates: evidence.candidates
    });
    expect(providerRequest).toEqual({
      question: RACE_QUALIFYING,
      semantic_query_version: SEMANTIC_QUERY_VERSION,
      max_candidates: SEMANTIC_QUERY_MAX_CANDIDATES,
      catalog: SEMANTIC_CANDIDATE_CATALOG_PROJECTION
    });
    expect(JSON.stringify(providerRequest)).not.toContain('private-norris-id');
    expect(Object.isFrozen(providerRequest)).toBe(true);
  });

  it('fails adapter provider errors with only a sanitized typed diagnostic', async () => {
    const adapter = new SemanticCandidateProposalAdapter({
      complete: async () => {throw new Error('private provider failure with credentials');}
    });
    let failure: unknown;
    try {
      await adapter.propose(buildSemanticCandidateProviderRequest(STANDINGS));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SemanticCandidateProposalError);
    expect(failure).toMatchObject({ code: 'transport', message: 'Semantic candidate proposal failed' });
    expect(String(failure)).not.toContain('credentials');
  });

  it('builds a deterministic deeply frozen language-only catalog projection', () => {
    const rebuilt = buildSemanticCandidateCatalogProjection();
    expect(rebuilt).toEqual(SEMANTIC_CANDIDATE_CATALOG_PROJECTION);
    expect(rebuilt.projection_sha256).toBe(SEMANTIC_CANDIDATE_CATALOG_PROJECTION_SHA256);
    expect(rebuilt.projection_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(rebuilt)).toBe(true);
    expect(Object.isFrozen(rebuilt.sources[0].concepts)).toBe(true);
    expect(new Set(rebuilt.sources.map(source => source.source_ref))).toEqual(new Set([
      'driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification'
    ]));
  });

  it('requires a dedicated strict provider and exposes only hashed model identity', () => {
    const base = {
      F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'openai-compatible',
      F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://strict.example/v1',
      F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY: 'private-key',
      F1QL_SEMANTIC_CANDIDATE_MODEL: 'vendor/strict-model',
      F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA: 'true'
    };
    const identity = getConfiguredSemanticCandidateModelIdentity(base);
    expect(identity).toMatchObject({
      provider: 'openai-compatible',
      endpoint_sha256: createHash('sha256').update('https://strict.example/v1').digest('hex'),
      model_sha256: createHash('sha256').update('vendor/strict-model').digest('hex'),
      request_config_sha256: '4353b4a0ad0728fab6f547a7e56fd9de338644f8f9b872ece028fef34a2b7acc'
    });
    expect(JSON.stringify(identity)).not.toContain('private-key');
    expect(JSON.stringify(identity)).not.toContain('strict.example');
    expect(JSON.stringify(identity)).not.toContain('vendor/strict-model');
    expect(createSemanticCandidateModel(base)).toBeInstanceOf(OpenAICompatibleSemanticCandidateModel);

    const anthropic = {
      ...base,
      F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'anthropic',
      F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://api.anthropic.com/v1',
      F1QL_SEMANTIC_CANDIDATE_MODEL: 'claude-haiku-4-5-20251001'
    };
    const anthropicIdentity = getConfiguredSemanticCandidateModelIdentity(anthropic);
    expect(anthropicIdentity).toMatchObject({
      provider: 'anthropic',
      endpoint_sha256: createHash('sha256').update('https://api.anthropic.com/v1').digest('hex'),
      model_sha256: createHash('sha256').update('claude-haiku-4-5-20251001').digest('hex'),
      schema_sha256: SEMANTIC_CANDIDATE_ANTHROPIC_SCHEMA_SHA256
    });
    expect(createSemanticCandidateModel(anthropic)).toBeInstanceOf(AnthropicSemanticCandidateModel);
    expect(() => createSemanticCandidateModel({
      ...anthropic,
      F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://proxy.example/v1'
    })).toThrow('must be https://api.anthropic.com/v1');

    expect(() => createSemanticCandidateModel({ ...base, F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'groq' })).toThrow('not supported');
    expect(() => createSemanticCandidateModel({ ...base, F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA: 'false' })).toThrow('not supported');
    expect(() => createSemanticCandidateModel({ ...base, F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY: '' })).toThrow('not supported');
    expect(() => createSemanticCandidateModel({ ...base, F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS: '0' })).toThrow('timeout');
  });

  it('rejects insecure or credential-bearing endpoints before fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const endpoint of [
      'http://strict.example/v1',
      'https://user:pass@strict.example/v1',
      'https://strict.example/v1?key=private',
      'https://strict.example/v1#private',
      'https://strict.example/v1?',
      'https://localhost/v1',
      'https://127.0.0.1/v1',
      'https://[::1]/v1',
      'https://provider.internal/v1',
      'https://strict.example:8443/v1'
    ]) {
      expect(() => new OpenAICompatibleSemanticCandidateModel(endpoint, 'key', 'model')).toThrow('HTTPS');
    }
    expect(() => new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', '', 'model')).toThrow('credentials');
    expect(() => new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', 'key', 'bad model')).toThrow('identity');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires exactly one completed non-refusal choice', async () => {
    const evidence = candidateEvidence(STANDINGS);
    const outputs = [
      {},
      { choices: [] },
      { choices: [{ finish_reason: 'stop', message: { content: '{}' } }, { finish_reason: 'stop', message: { content: '{}' } }] },
      { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
      { choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: null } }] }
    ];
    for (const output of outputs) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'model', ...output }), { status: 200 })));
      const model = new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', 'key', 'model');
      await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, model)).resolves.toEqual({
        type: 'provider_unavailable', reason: 'incomplete_response', diagnostic_code: 'incomplete'
      });
    }
  });

  it('requires one exact completed Anthropic text block and model identity', async () => {
    const evidence = candidateEvidence(STANDINGS);
    const outputs = [
      [{}, 'malformed'],
      [{ model: 'substituted-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }, 'malformed'],
      [{ model: 'model', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }, 'incomplete'],
      [{ model: 'model', stop_reason: 'end_turn', content: [] }, 'incomplete'],
      [{ model: 'model', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }, 'incomplete']
    ] as const;
    for (const [output, diagnosticCode] of outputs) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(output), { status: 200 })));
      const model = new AnthropicSemanticCandidateModel('https://api.anthropic.com/v1', 'key', 'model');
      await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, model)).resolves.toMatchObject({
        type: 'provider_unavailable',
        diagnostic_code: diagnosticCode
      });
    }
  });

  it('bounds provider bodies at 64 KiB and sanitizes HTTP diagnostics', async () => {
    const evidence = candidateEvidence(STANDINGS);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(65_537), { status: 200 })));
    const oversized = new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', 'key', 'model');
    await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, oversized)).resolves.toEqual({
      type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'oversize'
    });

    const statuses = [[401, 'auth'], [402, 'quota'], [429, 'rate_limit'], [400, 'client'], [503, 'server']] as const;
    for (const [status, diagnostic] of statuses) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('private provider body', { status })));
      const model = new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', 'key', 'model');
      await expect(translateSemanticCandidateQuestion(STANDINGS, evidence, model)).resolves.toMatchObject({
        type: 'provider_unavailable', diagnostic_code: diagnostic
      });
    }
  });

  it('distinguishes external cancellation from the closed provider-timeout diagnostic', async () => {
    const evidence = candidateEvidence(STANDINGS);
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      const providerSignal = init?.signal;
      if (!providerSignal) throw new Error('missing provider abort signal');
      const rejectAbort = () => reject(new DOMException('private timeout detail', 'AbortError'));
      if (providerSignal.aborted) {rejectAbort();}
      else {providerSignal.addEventListener('abort', rejectAbort, { once: true });}
    })));
    const model = new OpenAICompatibleSemanticCandidateModel('https://strict.example/v1', 'key', 'model', 5);
    const timedOut = translateSemanticCandidateQuestion(STANDINGS, evidence, model);
    await vi.advanceTimersByTimeAsync(5);
    await expect(timedOut).resolves.toEqual({
      type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'request_timeout'
    });
    expect(SEMANTIC_CANDIDATE_PROVIDER_DIAGNOSTIC_CODES).toContain('request_timeout');

    const aborted = AbortSignal.abort();
    await expect(translateSemanticCandidateQuestion(
      STANDINGS,
      evidence,
      { complete: async () => { throw new DOMException('aborted', 'AbortError'); } },
      aborted
    )).resolves.toEqual({
      type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'cancelled'
    });
    expect(SEMANTIC_CANDIDATE_PROVIDER_DIAGNOSTIC_CODES).toContain('cancelled');
  });

  it('has no route, database, executor, compiler, planner, or legacy translator dependency', () => {
    const entry = path.resolve(process.cwd(), 'src/f1ql/semantic-candidate-translator.ts');
    const reachable = reachableLocalModules(entry);
    const forbiddenBasenames = new Set([
      'executor.ts', 'compiler.ts', 'planned-compiler.ts', 'planned-pipeline.ts',
      'semantic-planner.ts', 'translator.ts', 'answer-execution.ts', 'answer-runtime.ts'
    ]);
    expect([...reachable].filter(file => forbiddenBasenames.has(path.basename(file)))).toEqual([]);
    for (const file of reachable) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/(?:from|require\s*\()\s*['"](?:pg|express|redis|\.\.\/api|\.\/executor|\.\/compiler|\.\/semantic-planner)['"]/u);
    }
  });
});

type SpanRef = { start: number; end: number };
type ProposalScope = { operation: string; evidence: SpanRef[]; source_ref?: string; value?: string; entity_index?: number };
type ProposalCandidate = {
  outputs: Array<{ operation: string; concept: { source_ref: string; concept_ref: string }; evidence: SpanRef[]; function?: string }>;
  scopes: ProposalScope[];
  entities: Array<{ type: string; span: SpanRef }>;
  filters: Array<Record<string, unknown>>;
  group_by: Array<Record<string, unknown>>;
  comparison: Record<string, unknown> | null;
  order_by: Array<Record<string, unknown>>;
  limit: { evidence: SpanRef[] } | null;
};
type ProposalSet = { version: number; candidates: ProposalCandidate[] };

function candidateEvidence(question: string, entities: readonly unknown[] = []): Extract<SemanticEvidence, { type: 'candidate_set' }> {
  const evidence = enumerateSemanticQueries(question, entities);
  expect(evidence.type).toBe('candidate_set');
  return evidence as Extract<SemanticEvidence, { type: 'candidate_set' }>;
}

function proposalSet(queries: readonly SemanticQuery[]): ProposalSet {
  return {
    version: 1,
    candidates: queries.map(query => ({
      outputs: query.outputs.map(output => ({
        operation: output.kind === 'concept' ? 'select' : 'aggregate',
        ...('function' in output ? { function: output.function } : {}),
        concept: { source_ref: output.concept.source_id, concept_ref: output.concept.concept_id },
        evidence: output.evidence.map(spanRef)
      })),
      scopes: query.scopes.map(scope => ({
        operation: scope.kind,
        ...('source_id' in scope ? { source_ref: scope.source_id } : {}),
        ...((scope.kind === 'session' || scope.kind === 'temporal') ? { value: scope.value } : {}),
        ...('entity_index' in scope ? { entity_index: scope.entity_index } : {}),
        evidence: scope.evidence.map(spanRef)
      })),
      entities: query.entities.map(entity => ({ type: entity.type, span: spanRef(entity.span) })),
      filters: query.filters.map(filter => {
        if (filter.kind !== 'entity') throw new Error('test converter supports entity filters only');
        return {
          operation: 'entity_filter',
          concept: { source_ref: filter.concept.source_id, concept_ref: filter.concept.concept_id },
          operator: filter.operator,
          entity_indices: [...filter.entity_indices],
          evidence: filter.evidence.map(spanRef)
        };
      }),
      group_by: query.group_by.map(group => ({
        concept: { source_ref: group.concept.source_id, concept_ref: group.concept.concept_id },
        evidence: group.evidence.map(spanRef)
      })),
      comparison: query.comparison === undefined ? null : {
        operation: query.comparison.relation,
        evidence: query.comparison.evidence.map(spanRef)
      },
      order_by: query.order_by.map(order => ({
        output_index: order.output_index,
        direction: order.direction,
        evidence: order.evidence.map(spanRef)
      })),
      limit: query.limit === undefined ? null : { evidence: query.limit.evidence.map(spanRef) }
    }))
  };
}

function modelReturning(output: unknown): SemanticCandidateModel {
  return { complete: async () => JSON.stringify(output) };
}

function completedResponse(content: string, model = 'model'): Response {
  return new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 });
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}

function spanRef(value: Pick<SemanticLiteralSpan, 'start' | 'end'>): SpanRef {
  return { start: value.start, end: value.end };
}

function assertStrictProviderSchema(input: unknown): void {
  if (!isRecord(input) || input.type !== 'object' || !isRecord(input.$defs)) {
    throw new Error('provider schema root or definitions are invalid');
  }
  const definitions = input.$defs;
  const visited = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    if ('$ref' in value) {
      if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/$defs/') ||
          !(value.$ref.slice('#/$defs/'.length) in definitions)) {
        throw new Error('provider schema reference is invalid');
      }
      return;
    }
    if (value.type === 'object') {
      if (value.additionalProperties !== false || !isRecord(value.properties) || !Array.isArray(value.required) ||
          JSON.stringify([...value.required].sort()) !== JSON.stringify(Object.keys(value.properties).sort())) {
        throw new Error('provider schema object is not closed and fully required');
      }
      Object.values(value.properties).forEach(visit);
    }
    if (value.type === 'array') visit(value.items);
    if (Array.isArray(value.anyOf)) value.anyOf.forEach(visit);
    if (value === input) Object.values(definitions).forEach(visit);
  };
  visit(input);
}

function countProviderSchemaProperties(input: unknown): number {
  const visited = new Set<unknown>();
  const count = (value: unknown): number => {
    if (!isRecord(value) || visited.has(value)) return 0;
    visited.add(value);
    const properties = isRecord(value.properties) ? Object.values(value.properties) : [];
    const definitions = isRecord(value.$defs) ? Object.values(value.$defs) : [];
    const anyOf = Array.isArray(value.anyOf) ? value.anyOf : [];
    return properties.length + properties.reduce((total, child) => total + count(child), 0) +
      definitions.reduce((total, child) => total + count(child), 0) +
      anyOf.reduce((total, child) => total + count(child), 0) + count(value.items);
  };
  return count(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

function reachableLocalModules(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  const imports = [
    ...source.matchAll(/(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].map(match => match[1]).filter(specifier => specifier.startsWith('.'));
  for (const specifier of imports) {
    const base = path.resolve(path.dirname(entry), specifier);
    reachableLocalModules(path.extname(base) ? base : `${base}.ts`, seen);
  }
  return seen;
}
