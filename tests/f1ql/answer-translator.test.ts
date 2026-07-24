import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_INTENT_JSON_SCHEMA, ANSWER_TRANSLATOR_PROMPT_SHA256, ANSWER_TRANSLATOR_SCHEMA_SHA256, ANSWER_TRANSLATOR_SYSTEM_PROMPT, OpenAICompatibleAnswerIntentModel, createAnswerIntentModel, getConfiguredAnswerModelIdentity, translateAnswerQuestion } from '../../src/f1ql/answer-translator';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';

const span = (question: string, text: string) => {
  const start = Array.from(question.slice(0, question.indexOf(text))).length;
  return { text, start, end: start + Array.from(text).length };
};

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
    expect(ANSWER_TRANSLATOR_PROMPT_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(ANSWER_TRANSLATOR_SCHEMA_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(ANSWER_TRANSLATOR_SYSTEM_PROMPT).toContain('{ "intent": <AnswerIntent> }');
  });

  it('conforms statically to the documented Groq strict-schema subset', () => {
    const supportedKeywords = new Set(['type', 'additionalProperties', 'required', 'properties', 'anyOf', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'items']);
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
    const intent = { type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025') };
    const valid = JSON.stringify({ intent });
    await expect(translateAnswerQuestion(contract, { complete: async () => valid })).resolves.toMatchObject({ type: 'intent_candidate', intent: { type: 'final_standings_leader' } });
    await expect(translateAnswerQuestion(contract, { complete: async () => '{bad' })).resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'malformed' });
    await expect(translateAnswerQuestion(contract, { complete: async () => JSON.stringify({ intent: { ...intent, season: 2024 } }) })).resolves.toEqual({ type: 'provider_unavailable', reason: 'invalid_response', diagnostic_code: 'schema_invalid' });
  });

  it('rejects missing, extra, wrong, and legacy bare wrappers', async () => {
    const question = 'Who was the 2025 standings leader?';
    const contract = createAnswerQuestionContract(question);
    const intent = { type: 'final_standings_leader', season: 2025, season_reference: span(question, '2025') };
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
    expect(getConfiguredAnswerModelIdentity()).toEqual({ provider: 'groq', model_id: 'openai/gpt-oss-20b' });
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

    vi.stubEnv('F1QL_ANSWER_LLM_PROVIDER', 'openai-compatible');
    vi.stubEnv('F1QL_ANSWER_LLM_BASE_URL', 'http://strict.example/v1');
    vi.stubEnv('F1QL_ANSWER_MODEL_STRICT_JSON_SCHEMA', 'true');
    expect(() => createAnswerIntentModel()).toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
