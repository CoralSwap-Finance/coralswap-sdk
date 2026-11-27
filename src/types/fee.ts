/**
 * Dynamic fee estimation for a pair.
 */
export interface FeeEstimate {
  /** Address of the pair */
  pairAddress: string;
  /** Current dynamic fee in basis points */
  currentFeeBps: number;
  /** Baseline fee in basis points */
  baselineFeeBps: number;
  /** Minimum fee in basis points */
  feeMin: number;
  /** Maximum fee in basis points */
  feeMax: number;
  /** Current volatility accumulator */
  volatility: bigint;
  /** EMA decay rate */
  emaDecayRate: number;
  /** Timestamp of the last fee update */
  lastUpdated: number;
  /** True if the fee estimate is considered stale */
  isStale: boolean;
}

/**
 * Fee parameter change proposal (timelocked).
 */
export interface FeeProposal {
  /** Hash of the proposed action */
  actionHash: string;
  /** Proposed minimum fee in basis points */
  feeMin: number;
  /** Proposed maximum fee in basis points */
  feeMax: number;
  /** Proposed EMA alpha parameter */
  emaAlpha: number;
  /** Timestamp when the proposal was created */
  createdAt: number;
  /** Timestamp when the proposal can be executed after */
  executeAfter: number;
  /** Array of signatures approving the proposal */
  signatures: string[];
  /** True if the proposal has been executed */
  executed: boolean;
}

/**
 * Fee history entry for analytics.
 */
export interface FeeHistoryEntry {
  /** Ledger sequence number */
  ledger: number;
  /** Timestamp of the entry */
  timestamp: number;
  /** Fee in basis points */
  feeBps: number;
  /** Volatility accumulator at the time */
  volatility: bigint;
}

/**
 * Per-token fee totals aggregated over a revenue scan window.
 *
 * Stroop-level totals are exact BigInt values; the display value is derived
 * with the token's own decimal precision.
 */
export interface FeeRevenueByToken {
  /** Address of the token contract the fees were paid in */
  token: string;
  /** Decimal precision of the token, used for the display conversion */
  decimals: number;
  /** Exact cumulative fee amount in the token's smallest (stroop-level) unit */
  feeStroops: bigint;
  /** Display fee total in whole token units (float, display only) */
  feeDisplay: number;
}

/**
 * One aggregated swap-fee entry produced by a fee revenue scan.
 *
 * `feeStroops` carries the exact BigInt fee; `feeXLM` is a display value
 * converted with the input token's own decimals (for XLM pairs, which use
 * 7 decimals, it is the amount in XLM — hence the legacy field name).
 */
export interface FeeRevenueEvent {
  /** Ledger sequence number where the swap settled */
  ledger: number;
  /** Unix timestamp (seconds) of the swap, approximated when unavailable */
  timestamp: number;
  /** Address of the token the fee was paid in */
  tokenIn: string;
  /** Decimal precision of `tokenIn` used for the display conversion */
  decimals: number;
  /** Fee charged for the swap, in basis points */
  feeBps: number;
  /** Exact fee amount in `tokenIn`'s smallest (stroop-level) unit */
  feeStroops: bigint;
  /** Display fee amount in whole `tokenIn` units (float, display only) */
  feeXLM: number;
}

/**
 * Aggregated fee revenue for a pair over a ledger window.
 *
 * All arithmetic is performed in BigInt on stroop-level values; float fields
 * are display-only conveniences.
 */
export interface PairFeeRevenue {
  /** Address of the pair contract */
  pairAddress: string;
  /** Exact cumulative fee across all scanned swaps, in stroop-level units (mixed tokens) */
  totalFeeStroops: bigint;
  /** Display total in token units (each event converted with its own token's decimals) */
  totalFeeXLM: number;
  /** Exact per-token fee totals with the decimals used for each display conversion */
  totalFeeByToken: FeeRevenueByToken[];
  /** Number of swap events aggregated */
  swapCount: number;
  /** Per-swap fee breakdown, ordered as returned by the ledger scan */
  history: FeeRevenueEvent[];
}

/**
 * LP yield metrics for an address in a pair over a ledger window.
 *
 * Share and value computations use BigInt-safe intermediate math; float
 * fields are display-only.
 */
export interface LPYieldResult {
  /** Address of the pair contract */
  pairAddress: string;
  /** Address of the LP token holder */
  lpAddress: string;
  /** Exact cumulative fee revenue in stroop-level units (mixed tokens) */
  totalFeeRevenueStroops: bigint;
  /** Display total fee revenue in token units (legacy name kept for compatibility) */
  totalFeeRevenueXLM: number;
  /** LP share of the pool's total supply, in percent (display only) */
  lpSharePercent: number;
  /** Display LP share of the window's fee revenue in token units */
  lpFeeShareXLM: number;
  /** Display implied value of the LP position in token units (per-side decimals applied) */
  lpValueXLM: number;
  /** Annualised yield in percent for the scanned window (display only) */
  aprPercent: number;
}
