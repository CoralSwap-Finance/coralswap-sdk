import { PairClient } from './pair';

/**
 * Reserve snapshot for a pair, as returned by {@link PairClient.getReserves}.
 */
export interface PairReserves {
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * Options for {@link verifyReserveConservation}.
 */
export interface ReserveConservationOptions {
  /**
   * How much the constant-product invariant `k = reserve0 * reserve1` is
   * allowed to decrease across the callback, expressed in basis points of
   * `kBefore`. Defaults to the pair's own `flashFeeBps` (from
   * {@link PairClient.getFlashLoanConfig}): a correctly-repaid flash loan
   * that skims its fee out to `feeReceiver` (rather than adding it back to
   * the pool's own reserves) is expected to leave `k` roughly flat, so the
   * fee rate itself is a reasonable ceiling on legitimate drift. Pass an
   * explicit value to override -- e.g. a smaller tolerance if your pool
   * design adds fees back to reserves instead of skimming them out.
   */
  toleranceBps?: number;
}

/**
 * Result of a {@link verifyReserveConservation} check.
 */
export interface ReserveConservationResult {
  /** `true` if `kAfter` is within the acceptable tolerance of `kBefore`. */
  ok: boolean;
  /** The fee-receiver address this check was evaluated against. */
  feeReceiver: string;
  reservesBefore: PairReserves;
  reservesAfter: PairReserves;
  /** `reservesBefore.reserve0 * reservesBefore.reserve1`. */
  kBefore: bigint;
  /** `reservesAfter.reserve0 * reservesAfter.reserve1`. */
  kAfter: bigint;
  /** The tolerance actually applied, in basis points of `kBefore`. */
  toleranceBps: number;
  /** The lowest `kAfter` value that still passes (`kBefore` minus tolerance). */
  minAcceptableK: bigint;
  /** Present only when `ok` is `false`; a human-readable explanation. */
  reason?: string;
}

/**
 * Post-hook guard for flash-loan consumers: verifies a pair's constant-product
 * invariant (`k = reserve0 * reserve1`) has not degraded beyond an acceptable,
 * fee-aware tolerance across a borrower callback.
 *
 * Snapshots reserves immediately before invoking `borrowerCallback`, runs it,
 * then snapshots reserves again and compares `k` before vs. after. This
 * function -- not the caller -- controls the timing of both snapshots, so
 * there's no window for the caller to accidentally snapshot "before" state
 * too early/late relative to when the callback actually runs.
 *
 * A legitimate flash loan that skims its fee out to a separate `feeReceiver`
 * (rather than compounding it back into the pool's own reserves) is expected
 * to leave `k` roughly flat rather than growing, so the default tolerance is
 * the pair's own configured `flashFeeBps` -- see
 * {@link ReserveConservationOptions.toleranceBps}.
 *
 * @param pair - The pair to guard.
 * @param feeReceiver - Address the flash-loan fee is expected to have been
 *   paid to. Not independently balance-checked (that would require knowing
 *   which token was borrowed, which this helper doesn't take as input) --
 *   it's threaded through to the result/reason for traceability, and to
 *   anchor the tolerance's justification ("k may drop by up to the fee rate
 *   because that fee legitimately left the pool for this address").
 * @param borrowerCallback - The operation to guard (e.g. submitting the
 *   borrower's callback transaction, awaiting its confirmation, and/or
 *   submitting repayment) -- whatever your flow needs to happen between the
 *   two reserve snapshots.
 * @param options - See {@link ReserveConservationOptions}.
 * @returns A {@link ReserveConservationResult} describing whether the
 *   invariant held, and by how much it moved either way.
 *
 * @example
 * ```ts
 * const result = await verifyReserveConservation(
 *   pair,
 *   treasuryAddress,
 *   async () => {
 *     await submitBorrowerCallbackAndRepayment();
 *   },
 * );
 * if (!result.ok) {
 *   throw new Error(result.reason);
 * }
 * ```
 */
export async function verifyReserveConservation(
  pair: PairClient,
  feeReceiver: string,
  borrowerCallback: () => Promise<void>,
  options: ReserveConservationOptions = {},
): Promise<ReserveConservationResult> {
  const reservesBefore = await pair.getReserves();
  const kBefore = reservesBefore.reserve0 * reservesBefore.reserve1;

  await borrowerCallback();

  const reservesAfter = await pair.getReserves();
  const kAfter = reservesAfter.reserve0 * reservesAfter.reserve1;

  let toleranceBps = options.toleranceBps;
  if (toleranceBps === undefined) {
    const { flashFeeBps } = await pair.getFlashLoanConfig();
    toleranceBps = flashFeeBps;
  }

  const toleranceAmount = (kBefore * BigInt(toleranceBps)) / 10_000n;
  const minAcceptableK = toleranceAmount < kBefore ? kBefore - toleranceAmount : 0n;

  const ok = kAfter >= minAcceptableK;

  return {
    ok,
    feeReceiver,
    reservesBefore,
    reservesAfter,
    kBefore,
    kAfter,
    toleranceBps,
    minAcceptableK,
    reason: ok
      ? undefined
      : `Reserve invariant (k) degraded beyond tolerance: k went from ${kBefore} to ${kAfter} ` +
        `(minimum acceptable ${minAcceptableK} at ${toleranceBps} bps tolerance). ` +
        `Verify the flash-loan fee was correctly paid to feeReceiver ${feeReceiver}.`,
  };
}
