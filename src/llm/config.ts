/**
 * LLM Configuration
 * centralized config for all llm-related behavior
 */

export interface LLMConfig {
  // concurrency control
  maxConcurrency: number;
  queueTimeoutMs: number;

  // retry behavior
  maxRetries: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;

  // corpus test mode
  corpusTestMode: boolean;
  corpusTestDelayMs: number;

  // request timeout
  requestTimeoutMs: number;
}

function parseIntEnv(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) {
    return defaultValue;
  }
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) {
    return defaultValue;
  }
  return val.toLowerCase() === 'true' || val === '1';
}

export function getLLMConfig(): LLMConfig {
  const corpusTestMode = parseBoolEnv('CORPUS_TEST_MODE', false);

  return {
    // concurrency: forced to 1 in corpus test mode
    maxConcurrency: corpusTestMode ? 1 : parseIntEnv('LLM_MAX_CONCURRENCY', 2),
    queueTimeoutMs: parseIntEnv('LLM_QUEUE_TIMEOUT_MS', 30000),

    // retries: disabled in corpus test mode
    maxRetries: corpusTestMode ? 0 : parseIntEnv('LLM_MAX_RETRIES', 3),
    initialRetryDelayMs: parseIntEnv('LLM_INITIAL_RETRY_DELAY_MS', 500),
    maxRetryDelayMs: parseIntEnv('LLM_MAX_RETRY_DELAY_MS', 5000),

    // corpus test mode adds delay between calls
    corpusTestMode,
    corpusTestDelayMs: parseIntEnv('CORPUS_TEST_DELAY_MS', 400),

    // request timeout
    requestTimeoutMs: parseIntEnv('LLM_REQUEST_TIMEOUT_MS', 10000),
  };
}

// singleton config instance
let configInstance: LLMConfig | null = null;

export function getConfig(): LLMConfig {
  if (!configInstance) {
    configInstance = getLLMConfig();
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}
