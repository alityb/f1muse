export interface AnswerRuntimeConfig {
  maxConcurrency: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  statementTimeoutMs: number;
  maxWorkUnits: number;
  maxRows: number;
  maxResponseBytes: number;
}

const DEFAULTS: AnswerRuntimeConfig = {
  maxConcurrency: 2,
  queueTimeoutMs: 2_000,
  requestTimeoutMs: 12_000,
  rateLimitMax: 10,
  rateLimitWindowMs: 15 * 60_000,
  statementTimeoutMs: 3_000,
  maxWorkUnits: 100,
  maxRows: 100,
  maxResponseBytes: 64 * 1024
};

const MAXIMUMS: AnswerRuntimeConfig = {
  maxConcurrency: 16,
  queueTimeoutMs: 10_000,
  requestTimeoutMs: 14_000,
  rateLimitMax: 100,
  rateLimitWindowMs: 60 * 60_000,
  statementTimeoutMs: 10_000,
  maxWorkUnits: 10_000,
  maxRows: 1_000,
  maxResponseBytes: 1024 * 1024
};

const ENV_KEYS: Record<keyof AnswerRuntimeConfig, string> = {
  maxConcurrency: 'F1QL_ANSWER_MAX_CONCURRENCY',
  queueTimeoutMs: 'F1QL_ANSWER_QUEUE_TIMEOUT_MS',
  requestTimeoutMs: 'F1QL_ANSWER_REQUEST_TIMEOUT_MS',
  rateLimitMax: 'F1QL_ANSWER_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'F1QL_ANSWER_RATE_LIMIT_WINDOW_MS',
  statementTimeoutMs: 'F1QL_ANSWER_STATEMENT_TIMEOUT_MS',
  maxWorkUnits: 'F1QL_ANSWER_MAX_WORK_UNITS',
  maxRows: 'F1QL_ANSWER_MAX_ROWS',
  maxResponseBytes: 'F1QL_ANSWER_MAX_RESPONSE_BYTES'
};

export function getAnswerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AnswerRuntimeConfig {
  const config = Object.fromEntries(
    (Object.keys(DEFAULTS) as Array<keyof AnswerRuntimeConfig>).map(key => [
      key,
      parseBoundedInteger(env[ENV_KEYS[key]], ENV_KEYS[key], DEFAULTS[key], minimumFor(key), MAXIMUMS[key])
    ])
  ) as unknown as AnswerRuntimeConfig;
  if (config.statementTimeoutMs > config.requestTimeoutMs) {
    throw new Error('F1QL_ANSWER_STATEMENT_TIMEOUT_MS must not exceed F1QL_ANSWER_REQUEST_TIMEOUT_MS');
  }
  return config;
}

function minimumFor(key: keyof AnswerRuntimeConfig): number {
  return key === 'rateLimitWindowMs' ? 60_000 : 1;
}

function parseBoundedInteger(raw: string | undefined, name: string, defaultValue: number, minimum: number, maximum: number): number {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export type AnswerAdmissionFailure = 'answer_busy' | 'request_cancelled';

export class AnswerAdmissionError extends Error {
  constructor(readonly reason: AnswerAdmissionFailure) {
    super(reason);
    this.name = 'AnswerAdmissionError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: AnswerAdmissionError) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort: () => void;
}

export class AnswerAdmissionController {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly config: Pick<AnswerRuntimeConfig, 'maxConcurrency' | 'queueTimeoutMs'>) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new AnswerAdmissionError('request_cancelled'));
    }
    if (this.active < this.config.maxConcurrency) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const waiter = {} as Waiter;
      const removeAndReject = (reason: AnswerAdmissionFailure) => {
        const index = this.queue.indexOf(waiter);
        if (index === -1) {
          return;
        }
        this.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        signal.removeEventListener('abort', waiter.onAbort);
        reject(new AnswerAdmissionError(reason));
      };
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.signal = signal;
      waiter.onAbort = () => removeAndReject('request_cancelled');
      waiter.timer = setTimeout(() => removeAndReject('answer_busy'), this.config.queueTimeoutMs);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active--;
      this.admitNext();
    };
  }

  private admitNext(): void {
    while (this.queue.length > 0 && this.active < this.config.maxConcurrency) {
      const waiter = this.queue.shift();
      if (!waiter) {
        return;
      }
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new AnswerAdmissionError('request_cancelled'));
        continue;
      }
      this.active++;
      waiter.resolve(this.releaseOnce());
    }
  }
}
