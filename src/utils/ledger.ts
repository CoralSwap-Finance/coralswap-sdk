import { sleep } from './retry';

export interface WaitNextLedgerOptions {
  /** Max time to wait for the next ledger (ms). Default 30_000. */
  timeoutMs?: number;
  /** Interval between RPC polls (ms). Default 2_000. */
  pollIntervalMs?: number;
}

/**
 * Wait until the ledger number has incremented.
 *
 * Polls the provided getter until the returned ledger is greater than the
 * value at call time, then resolves with the new ledger number. Useful before
 * running checks or operations that depend on the next ledger close.
 *
 * @param getCurrentLedger - Function that returns the current ledger sequence (e.g. from Soroban RPC).
 * @param options - Optional timeout and poll interval.
 * @returns The new ledger sequence after it has incremented.
 * @throws Error if timeout is reached before the ledger increments.
 */
export async function waitNextLedger(
  getCurrentLedger: () => Promise<number>,
  options?: WaitNextLedgerOptions,
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;

  const initial = await getCurrentLedger();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    await sleep(pollIntervalMs);
    if (Date.now() >= deadline) {
      throw new Error(`waitNextLedger timed out after ${timeoutMs}ms`);
    }
    const current = await getCurrentLedger();
    if (current > initial) {
      return current;
    }
  }
}
