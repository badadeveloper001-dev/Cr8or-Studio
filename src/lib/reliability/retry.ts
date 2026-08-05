export type RetryOptions = {
  retries: number;
  minDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterRatio: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

const DEFAULT_OPTIONS: RetryOptions = {
  retries: 3,
  minDelayMs: 250,
  maxDelayMs: 3000,
  factor: 2,
  jitterRatio: 0.2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelayMs(base: number, maxDelayMs: number, jitterRatio: number): number {
  const jitter = base * jitterRatio * (Math.random() * 2 - 1);
  return Math.min(maxDelayMs, Math.max(0, Math.round(base + jitter)));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const config: RetryOptions = {
    ...DEFAULT_OPTIONS,
    ...(options ?? {}),
  };

  let delay = config.minDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt <= config.retries;
      const shouldRetry = config.shouldRetry ? config.shouldRetry(error, attempt) : true;

      if (!canRetry || !shouldRetry) {
        throw error;
      }

      await sleep(nextDelayMs(delay, config.maxDelayMs, config.jitterRatio));
      delay = Math.min(config.maxDelayMs, Math.round(delay * config.factor));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry operation failed.");
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
