import { Logger } from "@/types/common";
import { DEFAULTS } from "@/config";

/**
 * Options for the retry policy.
 */
export interface RetryOptions {
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
}

/**
 * Helper to execute an async function with exponential backoff retry.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @param logger - Optional logger for instrumentation
 * @param label - A label for logging purposes
 * @returns The result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  logger?: Logger,
  label: string = "RPC",
): Promise<T> {
  const { maxRetries, retryDelayMs, maxRetryDelayMs } = options;
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      // Determine if error is retryable (429, 503, or network timeout)
      const status = err?.response?.status;
      const isRetryable =
        status === 429 ||
        status === 503 ||
        err?.code === "ECONNABORTED" ||
        err?.code === "ETIMEDOUT" ||
        err?.message?.includes("timeout");

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter
      const backoff = Math.min(
        maxRetryDelayMs,
        retryDelayMs * Math.pow(2, attempt),
      );
      const jitter = backoff * 0.15 * (Math.random() * 2 - 1);
      const delay = Math.max(0, backoff + jitter);

      logger?.debug(`${label}: retrying after ${Math.round(delay)}ms`, {
        attempt: attempt + 1,
        maxRetries,
        error: err.message,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
