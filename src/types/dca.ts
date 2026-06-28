/**
 * TypeScript types for the CoralSwap DCAModule.
 *
 * Dollar-Cost Averaging (DCA) splits a large position into a series of
 * smaller, time-spaced swaps to reduce exposure to short-term volatility.
 * A schedule escrows the input token and executes one swap per interval
 * until all intervals are consumed or the schedule is cancelled.
 */

/**
 * Lifecycle status of a DCA schedule.
 */
export type DCAStatus = 'active' | 'completed' | 'cancelled';

/**
 * Parameters required to create a new DCA schedule.
 */
export interface DCAParams {
  /** Address of the token being spent each interval. */
  tokenIn: string;
  /** Address of the token being accumulated. */
  tokenOut: string;
  /** Amount of `tokenIn` swapped on every interval (smallest unit). */
  amountPerInterval: bigint;
  /**
   * Seconds between executions. Must be at least `3600` (one hour) so that
   * schedules cannot be used to grind the pool with sub-hour swaps.
   */
  intervalSeconds: number;
  /** Total number of intervals to execute. Must be at least `2`. */
  totalIntervals: number;
  /** Address of the pair the swaps route through. */
  pairAddress: string;
}

/**
 * Full on-chain state of a DCA schedule.
 */
export interface DCASchedule {
  /** Unique schedule identifier. */
  id: string;
  /** Stellar address that owns (and funded) the schedule. */
  owner: string;
  /** Address of the token being spent. */
  tokenIn: string;
  /** Address of the token being accumulated. */
  tokenOut: string;
  /** Amount of `tokenIn` swapped per interval. */
  amountPerInterval: bigint;
  /** Seconds between executions. */
  intervalSeconds: number;
  /** Total number of intervals the schedule will run for. */
  totalIntervals: number;
  /** Number of intervals already executed. */
  executedCount: number;
  /** Number of intervals still pending (`totalIntervals - executedCount`). */
  remainingCount: number;
  /** Unix timestamp (seconds) of the next scheduled execution. */
  nextExecutionAt: number;
  /** Current lifecycle status. */
  status: DCAStatus;
}

/**
 * Performance summary for a DCA schedule, comparing the realised DCA outcome
 * against a hypothetical single lump-sum swap of the same total size.
 */
export interface DCAPerformance {
  /** Schedule the performance figures relate to. */
  scheduleId: string;
  /** Total `tokenIn` spent so far (`amountPerInterval * executedCount`). */
  totalInvested: bigint;
  /** Total `tokenOut` received across all executed intervals. */
  totalReceived: bigint;
  /**
   * Amount of `tokenOut` a single lump-sum swap of `totalInvested` would
   * have produced, used as the comparison baseline.
   */
  lumpSumReceived: bigint;
  /**
   * Extra `tokenOut` gained (positive) or lost (negative) by averaging in
   * versus the lump-sum baseline: `totalReceived - lumpSumReceived`.
   */
  savings: bigint;
  /**
   * `savings` expressed in basis points of the lump-sum baseline.
   * `0` when the baseline is zero (nothing executed yet).
   */
  savingsBps: number;
}

/**
 * Result of cancelling a DCA schedule.
 */
export interface DCACancellation {
  /** Schedule that was cancelled. */
  scheduleId: string;
  /** Transaction hash of the cancellation. */
  txHash: string;
  /**
   * Amount of `tokenIn` refunded to the owner: the escrowed funds for every
   * interval that had not yet executed (`amountPerInterval * remainingCount`).
   */
  refundAmount: bigint;
}
