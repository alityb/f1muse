import { describe, expect, it } from 'vitest';
import { AnswerAdmissionController, AnswerAdmissionError, getAnswerRuntimeConfig } from '../../src/f1ql/answer-runtime';

describe('answer runtime configuration', () => {
  it('provides conservative bounded defaults', () => {
    expect(getAnswerRuntimeConfig({})).toEqual({
      maxConcurrency: 2,
      queueTimeoutMs: 2_000,
      requestTimeoutMs: 12_000,
      rateLimitMax: 10,
      rateLimitWindowMs: 900_000,
      statementTimeoutMs: 3_000,
      maxWorkUnits: 100,
      maxRows: 100,
      maxResponseBytes: 65_536
    });
  });

  it.each(['0', '-1', '1.5', 'nope', '17'] as const)('rejects invalid concurrency %s', value => {
    expect(() => getAnswerRuntimeConfig({ F1QL_ANSWER_MAX_CONCURRENCY: value })).toThrow('F1QL_ANSWER_MAX_CONCURRENCY');
  });

  it('rejects ineffective rate windows and statement deadlines beyond the request deadline', () => {
    expect(() => getAnswerRuntimeConfig({ F1QL_ANSWER_RATE_LIMIT_WINDOW_MS: '59999' })).toThrow('F1QL_ANSWER_RATE_LIMIT_WINDOW_MS');
    expect(() => getAnswerRuntimeConfig({
      F1QL_ANSWER_REQUEST_TIMEOUT_MS: '1000',
      F1QL_ANSWER_STATEMENT_TIMEOUT_MS: '1001'
    })).toThrow('must not exceed');
  });
});

describe('answer admission controller', () => {
  it('holds queued work until the active permit is released', async () => {
    const admission = new AnswerAdmissionController({ maxConcurrency: 1, queueTimeoutMs: 100 });
    const releaseFirst = await admission.acquire(new AbortController().signal);
    const second = admission.acquire(new AbortController().signal);
    expect(admission.stats()).toEqual({ active: 1, queued: 1 });

    releaseFirst();
    const releaseSecond = await second;
    expect(admission.stats()).toEqual({ active: 1, queued: 0 });
    releaseSecond();
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('removes cancelled queued work without consuming a permit', async () => {
    const admission = new AnswerAdmissionController({ maxConcurrency: 1, queueTimeoutMs: 100 });
    const release = await admission.acquire(new AbortController().signal);
    const controller = new AbortController();
    const queued = admission.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject<Partial<AnswerAdmissionError>>({ reason: 'request_cancelled' });
    expect(admission.stats()).toEqual({ active: 1, queued: 0 });
    release();
  });

  it('fails closed when the queue deadline expires', async () => {
    const admission = new AnswerAdmissionController({ maxConcurrency: 1, queueTimeoutMs: 5 });
    const release = await admission.acquire(new AbortController().signal);
    await expect(admission.acquire(new AbortController().signal)).rejects.toMatchObject<Partial<AnswerAdmissionError>>({ reason: 'answer_busy' });
    release();
  });
});
