import { sleep } from './retry';

/**
 * Nominal Stellar ledger close interval, in seconds.
 *
 * Stellar/Soroban validators target a new ledger roughly every 5 seconds. This
 * is the single source of truth for the "ledgers <-> wall-clock" assumption so
 * that modules do not each hard-code their own copy of the constant.
 */
export const LEDGER_CLOSE_INTERVAL_SECONDS = 5;

/**
 * A reference point mapping a ledger sequence to a known close time, e.g. the
 * RPC chain head from `getLatestLedger()` or a recent event's
 * `{ ledger, ledgerClosedAt }` pair.
 */
export interface LedgerHead {
  /** Ledger sequence number of the reference point. */
  ledger: number;
  /** Close time of `ledger`, in Unix seconds. */
  closeTime: number;
}

/**
 * Approximate the wall-clock close time of a ledger from a known reference head.
 *
 * The estimate assumes a fixed {@link LEDGER_CLOSE_INTERVAL_SECONDS} between
 * ledgers and linearly extrapolates from `head`:
 *
 * ```
 * approxTime = head.closeTime + (ledger - head.ledger) * LEDGER_CLOSE_INTERVAL_SECONDS
 * ```
 *
 * @remarks
 * This is an **approximation**. Real ledger close times drift because validators
 * do not close ledgers on an exact 5-second cadence (network load, consensus
 * timing, and downtime all shift it). Error accumulates linearly with the
 * distance between `ledger` and `head.ledger`, so prefer an on-chain
 * `ledgerClosedAt` when one is available and reserve this helper for ledgers
 * whose real close time is unknown. The result is not suitable for
 * consensus-critical or precise accounting use.
 *
 * @param ledger - Ledger sequence to estimate the close time for.
 * @param head - Reference `{ ledger, closeTime }` snapshot to extrapolate from.
 * @returns Approximate close time of `ledger`, in Unix seconds.
 */
export function ledgerToApproxTime(ledger: number, head: LedgerHead): number {
  return head.closeTime + (ledger - head.ledger) * LEDGER_CLOSE_INTERVAL_SECONDS;
}

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
