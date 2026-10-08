import {
  isRetryable,
  sleep,
  getCircuitBreaker,
  DEFAULT_RETRY_CONFIG,
  DeadlineError,
} from "@/utils/retry";
import type { RetryOptions } from "@/utils/retry";
import { Logger } from "@/types/common";

/**
 * Wraps a state-changing submission (stake/unstake) so that a retryable
 * failure (timeout, 503, etc.) never causes a blind resubmission of an
 * operation that actually landed on-chain.
 *
 * Reuses the existing retry/backoff/circuit-breaker infra from retry.ts,
 * adding an on-chain landed-check between attempts.
 *
 * @param submit - Executes the state-changing call, returns its tx hash.
 * @param checkLanded - Called after a retryable failure. Returns a tx hash
 *   (or synthetic marker) if the prior attempt is confirmed to have landed,
 *   or null if it did not.
 */
export async function idempotentResubmit(
  submit: () => Promise<string>,
  checkLanded: () => Promise<string | null>,
  options: RetryOptions,
  logger?: Logger,
  label: string = "idempotent-resubmit",
): Promise<string> {
  const baseDelayMs = options.baseDelayMs ?? options.retryDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier;
  const maxDelayMs = options.maxDelayMs ?? options.maxRetryDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs;
  const maxRetries = options.maxRetries;

  const breaker = getCircuitBreaker(label, options.circuitBreaker);
  breaker.beforeRequest();

  let lastError: unknown;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (typeof options.deadlineMs === "number" && Date.now() >= options.deadlineMs) {
        throw new DeadlineError(options.deadlineMs);
      }
      try {
        const txHash = await submit();
        breaker.onSuccess();
        return txHash;
      } catch (err: unknown) {
        lastError = err;
        if (!isRetryable(err) || attempt === maxRetries) throw err;

        // Don't blindly resubmit — check real state first.
        const landedTxHash = await checkLanded();
        if (landedTxHash) {
          breaker.onSuccess();
          return landedTxHash;
        }

        const rawBackoff = baseDelayMs * Math.pow(backoffMultiplier, attempt);
        const delay = Math.min(maxDelayMs, rawBackoff);

        logger?.debug(`${label}: retrying after ${Math.round(delay)}ms (landed=false)`, {
          attempt: attempt + 1,
          maxRetries,
          error: (err as Error).message,
        });

        await sleep(delay);
      }
    }
  } catch (err) {
    breaker.onFailure();
    throw err;
  }

  breaker.onFailure();
  throw lastError;
}
