import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUntrustedAnswerIntentCandidate } from '../../src/f1ql/answer-intent';
import { ANSWER_INTENT_JSON_SCHEMA, ANSWER_TRANSLATOR_PROMPT_SHA256, ANSWER_TRANSLATOR_SCHEMA_SHA256, ANSWER_TRANSLATOR_SYSTEM_PROMPT, OpenAICompatibleAnswerIntentModel, createAnswerIntentModel, getConfiguredAnswerModelIdentity, translateAnswerQuestion } from '../../src/f1ql/answer-translator';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('answer-specific strict translator', () => {
  it('uses strict json_schema response format with closed required objects', async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"intent":{"type":"clarification","reason":"metric_ambiguous"}}' } }] }), { status: 200 });
    }));
    const model = new OpenAICompatibleAnswerIntentModel('https://api.groq.com/openai/v1', 'secret', 'strict-model');
    await model.complete('system', 'question');
    expect(request).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { strict: true, schema: ANSWER_INTENT_JSON_SCHEMA } }
    });
    expect(ANSWER_INTENT_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['intent'] });
    expect(Object.keys(ANSWER_INTENT_JSON_SCHEMA.properties)).toEqual(['intent']);
    for (const variant of ANSWER_INTENT_JSON_SCHEMA.properties.intent.anyOf) {
      expect(variant.additionalProperties).toBe(false);
      expect(new Set(variant.required)).toEqual(new Set(Object.keys(variant.properties)));
    }
    expect(JSON.stringify(ANSWER_INTENT_JSON_SCHEMA)).not.toMatch(/"(?:start|end)"/);
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(ANSWER_TRANSLATOR_PROMPT_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(ANSWER_TRANSLATOR_SCHEMA_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('{ "intent": <AnswerIntent> }');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('An explicit 4-digit year is never season_missing');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('final standings are supported');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('Session, event, driver, status, and all/single cardinality must follow literal wording');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('unique literal status cue selects the status-filter intent even with wording such as "show all classified drivers"');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('status_reference must copy the complete literal status phrase');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('DNF/DNFs/did not finish to dnf');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('DNS/DNSs/did not start to dns');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('server normalizes the candidate status enum and full status_reference');
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('one reference object per literal driver occurrence');
    expect((ANSWER_TRANSLATOR_SYSTEM_PROMPT.match(/\{"intent":/g) ?? [])).toHaveLength(17);
    expect((ANSWER_TRANSLATOR_SYSTEM_PROMPT.match(/"type":"(?:final_standings_leader|race_classification_all|qualifying_classification_driver)"/g) ?? [])).toHaveLength(3);
    const examples = ANSWER_TRANSLATOR_SYSTEM_PROMPT.split('\n').filter(line => line.startsWith('{"intent":')).map(line => JSON.parse(line) as { intent: unknown });
    expect(examples.map(example => parseUntrustedAnswerIntentCandidate(example.intent).type)).toEqual([
      'final_standings_leader', 'current_standings', 'driver_season_official_summary', 'driver_season_official_summary', 'driver_career_official_summary', 'race_season_finishing_position_h2h', 'race_classification_all', 'qualifying_classification_driver',
      'race_winner', 'race_podium', 'race_top_n', 'race_exact_position', 'qualifying_pole', 'qualifying_top_n', 'qualifying_exact_position',
      'clarification', 'unsupported'
    ]);
  });

  it('conforms statically to the documented Groq strict-schema subset', () => {
    const supportedKeywords = new Set(['type', 'additionalProperties', 'required', 'properties', 'anyOf', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'items']);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      for (const key of Object.keys(object)) {
        expect(supportedKeywords.has(key)).toBe(true);
      }
      expect(object).not.toHaveProperty('oneOf');
      expect(object).not.toHaveProperty('const');
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        if (object.properties) {
          expect(new Set(object.required as string[])).toEqual(new Set(Object.keys(object.properties as object)));
        }
      }
      for (const [key, child] of Object.entries(object)) {
        if (key === 'properties' && child && typeof child === 'object') {
          Object.values(child as Record<string, unknown>).forEach(visit);
        } else {
          visit(child);
        }
      }
    };
    visit(ANSWER_INTENT_JSON_SCHEMA);
  });

  it('returns only parsed AnswerIntent and fails closed for malformed or incomplete output', async () => {
    const question = 'Who was the 2025 standings leader?';
    const contract = createAnswerQuestionContract(question);
    const intent = { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025' } };
    const valid = JSON.stringify({ intent });
    await expect(translateAnswerQuestion(contract, { complete: async () => valid })).resolves.toEqual({
      type: 'intent_candidate', intent: { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025', start: 12, end: 16 } }
    });
    await expect(translateAnswerQuestion(contract, { complete: async () => '{bad' })).resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'malformed' });
    await expect(translateAnswerQuestion(contract, { complete: async () => JSON.stringify({ intent: { ...intent, season: 2024 } }) })).resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'schema_invalid' });
  });

  it('rejects missing, extra, wrong, and legacy bare wrappers', async () => {
    const question = 'Who was the 2025 standings leader?';
    const contract = createAnswerQuestionContract(question);
    const intent = { type: 'final_standings_leader', season: 2025, season_reference: { text: '2025' } };
    const invalid = [intent, {}, { intent, extra: true }, { answer: intent }, { intent: null }];
    for (const output of invalid) {
      await expect(translateAnswerQuestion(contract, { complete: async () => JSON.stringify(output) })).resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'schema_invalid' });
    }
  });

  it('classifies provider truncation as incomplete without retaining output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"type":' } }] }), { status: 200 })));
    const contract = createAnswerQuestionContract('Who was the 2025 standings leader?');
    const model = new OpenAICompatibleAnswerIntentModel('https://api.groq.com/openai/v1', 'secret', 'strict-model');
    await expect(translateAnswerQuestion(contract, model)).resolves.toEqual({ type: 'provider_unavailable', reason: 'incomplete_response', diagnostic_code: 'incomplete' });
  });

  it('cancels non-success provider bodies without reading or retaining them', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull() { throw new Error('body must not be read'); },
      cancel() { cancelled = true; }
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 500 })));
    const model = new OpenAICompatibleAnswerIntentModel('https://api.groq.com/openai/v1', 'secret', 'strict-model');
    await expect(model.complete('system', 'question')).rejects.toThrow('provider failed');
    expect(cancelled).toBe(true);
  });

  it('maps transport and HTTP failures to low-cardinality diagnostics without bodies', async () => {
    const contract = createAnswerQuestionContract('Who was the 2025 standings leader?');
    const statuses = [[401, 'auth'], [402, 'quota'], [429, 'rate_limit'], [400, 'client'], [503, 'server']] as const;
    for (const [status, diagnostic] of statuses) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('private provider body', { status })));
      const model = new OpenAICompatibleAnswerIntentModel('https://api.groq.com/openai/v1', 'secret', 'strict-model');
      await expect(translateAnswerQuestion(contract, model)).resolves.toMatchObject({ type: 'provider_unavailable', diagnostic_code: diagnostic });
    }
    await expect(translateAnswerQuestion(contract, { complete: async () => { throw new Error('private transport detail'); } })).resolves.toEqual({ type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'transport' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(65_537), { status: 200 })));
    const oversized = new OpenAICompatibleAnswerIntentModel('https://api.groq.com/openai/v1', 'secret', 'strict-model');
    await expect(translateAnswerQuestion(contract, oversized)).resolves.toEqual({ type: 'provider_unavailable', reason: 'provider_error', diagnostic_code: 'oversize' });
  });

  it('rejects unsupported providers and Groq models fail closed', () => {
    vi.stubEnv('F1QL_ANSWER_LLM_BASE_URL', 'https://api.groq.com/openai/v1');
    vi.stubEnv('F1QL_ANSWER_LLM_API_KEY', 'secret');
    vi.stubEnv('F1QL_ANSWER_MODEL', 'unsupported-model');
    vi.stubEnv('F1QL_ANSWER_LLM_PROVIDER', 'anthropic');
    expect(() => createAnswerIntentModel()).toThrow('not supported');
    vi.stubEnv('F1QL_ANSWER_LLM_PROVIDER', 'groq');
    expect(() => createAnswerIntentModel()).toThrow('not supported');
    vi.stubEnv('F1QL_ANSWER_MODEL', 'openai/gpt-oss-20b');
    expect(createAnswerIntentModel()).toBeInstanceOf(OpenAICompatibleAnswerIntentModel);
    expect(getConfiguredAnswerModelIdentity()).toEqual({
      provider: 'groq',
      model_id: 'openai/gpt-oss-20b',
      endpoint_sha256: createHash('sha256').update('https://api.groq.com/openai/v1').digest('hex'),
      reasoning_effort: 'disabled'
    });
  });

  it('includes only explicitly configured provider reasoning effort and keeps the none token cap', async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"intent":{"type":"clarification","reason":"metric_ambiguous"}}' } }] }), { status: 200 });
    }));
    vi.stubEnv('F1QL_ANSWER_LLM_PROVIDER', 'openai-compatible');
    vi.stubEnv('F1QL_ANSWER_LLM_BASE_URL', 'https://strict.example/v1');
    vi.stubEnv('F1QL_ANSWER_LLM_API_KEY', 'secret');
    vi.stubEnv('F1QL_ANSWER_MODEL', 'strict-model');
    vi.stubEnv('F1QL_ANSWER_MODEL_STRICT_JSON_SCHEMA', 'true');
    vi.stubEnv('F1QL_ANSWER_REASONING_EFFORT', 'none');
    expect(getConfiguredAnswerModelIdentity()).toEqual({
      provider: 'openai-compatible',
      model_id: 'strict-model',
      endpoint_sha256: createHash('sha256').update('https://strict.example/v1').digest('hex'),
      reasoning_effort: 'none'
    });
    await createAnswerIntentModel().complete('system', 'question');
    expect(request).toMatchObject({ reasoning_effort: 'none', max_tokens: 512 });

    vi.stubEnv('F1QL_ANSWER_REASONING_EFFORT', 'extreme');
    vi.stubEnv('F1QL_ANSWER_LLM_API_KEY', '');
    expect(() => createAnswerIntentModel()).toThrow('Invalid answer reasoning effort');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects HTTP Groq and declared-compatible endpoints before credential use', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => new OpenAICompatibleAnswerIntentModel('http://api.groq.com/openai/v1', 'secret', 'strict-model')).toThrow('HTTPS');

    vi.stubEnv('F1QL_ANSWER_LLM_PROVIDER', 'groq');
    vi.stubEnv('F1QL_ANSWER_LLM_BASE_URL', 'http://api.groq.com/openai/v1');
    vi.stubEnv('F1QL_ANSWER_LLM_API_KEY', 'secret');
    vi.stubEnv('F1QL_ANSWER_MODEL', 'openai/gpt-oss-20b');
    expect(() => createAnswerIntentModel()).toThrow('HTTPS');
    vi.stubEnv('F1QL_ANSWER_LLM_BASE_URL', 'https://strict.example/v1?credential=private');
    expect(() => createAnswerIntentModel()).toThrow('HTTPS');

    vi.stubEnv('F1QL_ANSWER_LLM_PROVIDER', 'openai-compatible');
    vi.stubEnv('F1QL_ANSWER_LLM_BASE_URL', 'http://strict.example/v1');
    vi.stubEnv('F1QL_ANSWER_MODEL_STRICT_JSON_SCHEMA', 'true');
    expect(() => createAnswerIntentModel()).toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
