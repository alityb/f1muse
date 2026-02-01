/**
 * LLM Concurrency Limiter
 * queue-based semaphore to prevent overwhelming anthropic api
 */

import { getConfig } from './config';
import { metrics } from '../observability/metrics';

export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  enqueueTime: number;
}

class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: QueuedRequest[] = [];
  private lastCallTime = 0;

  async acquire(): Promise<void> {
    const config = getConfig();

    // check if we can proceed immediately
    if (this.activeCount < config.maxConcurrency) {
      this.activeCount++;
      metrics.recordLLMWaitTime(0); // no wait
      await this.applyCorpusTestDelay();
      return;
    }

    // queue the request
    return new Promise<void>((resolve, reject) => {
      const request: QueuedRequest = {
        resolve,
        reject,
        enqueueTime: Date.now(),
      };

      this.queue.push(request);
      this.updateQueueMetrics();

      // set timeout for queue
      setTimeout(() => {
        const index = this.queue.indexOf(request);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.updateQueueMetrics();
          const waitTime = Date.now() - request.enqueueTime;
          metrics.recordLLMWaitTime(waitTime);
          reject(new LLMUnavailableError(
            `LLM queue timeout after ${config.queueTimeoutMs}ms`
          ));
        }
      }, config.queueTimeoutMs);
    });
  }

  private updateQueueMetrics(): void {
    metrics.setLLMQueueDepth(this.queue.length);
  }

  release(): void {
    this.activeCount--;

    // process next in queue if any
    if (this.queue.length > 0 && this.activeCount < getConfig().maxConcurrency) {
      const next = this.queue.shift();
      this.updateQueueMetrics();

      if (next) {
        const config = getConfig();
        const waitTime = Date.now() - next.enqueueTime;

        // record wait time
        metrics.recordLLMWaitTime(waitTime);

        // check if request has been waiting too long
        if (waitTime >= config.queueTimeoutMs) {
          next.reject(new LLMUnavailableError(
            `LLM queue timeout after ${waitTime}ms`
          ));
          return;
        }

        this.activeCount++;
        this.applyCorpusTestDelay().then(() => next.resolve());
      }
    }
  }

  private async applyCorpusTestDelay(): Promise<void> {
    const config = getConfig();
    if (!config.corpusTestMode) {
      return;
    }

    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;
    const requiredDelay = config.corpusTestDelayMs;

    if (timeSinceLastCall < requiredDelay) {
      const waitTime = requiredDelay - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
  }

  // for testing/observability
  getStats(): { active: number; queued: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
    };
  }
}

// singleton instance
let limiterInstance: ConcurrencyLimiter | null = null;

export function getLimiter(): ConcurrencyLimiter {
  if (!limiterInstance) {
    limiterInstance = new ConcurrencyLimiter();
  }
  return limiterInstance;
}

export function resetLimiter(): void {
  limiterInstance = null;
}

/**
 * wrap an async function with concurrency limiting
 */
export async function withConcurrencyLimit<T>(
  fn: () => Promise<T>
): Promise<T> {
  const limiter = getLimiter();
  await limiter.acquire();
  try {
    return await fn();
  } finally {
    limiter.release();
  }
}
