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
 * One swap's fee contribution, resolved against the input token's decimals.
 *
 * `feeAmount` is computed in BigInt stroops and never round-trips through
 * `Number`, so a fee smaller than one float ulp (or larger than 2^53) is
 * preserved exactly.
 */
export interface FeeRevenueEntry {
  /** Ledger the swap was emitted in */
  ledger: number;
  /** Unix seconds of the ledger close, or a ledger-time estimate when the event omits it */
  timestamp: number;
  /** Fee charged in basis points */
  feeBps: number;
  /** Input token the fee is denominated in */
  tokenIn: string;
  /** Decimals read from that token's on-chain metadata */
  decimals: number;
  /** Fee in the input token's smallest unit — exact BigInt stroops */
  feeAmount: bigint;
  /** `feeAmount` rendered in human units at `decimals` */
  feeFormatted: string;
  /** Float rendering of `feeAmount` at `decimals`; the legacy name is kept for compatibility and only equals XLM for a 7-decimal token */
  feeXLM: number;
}

/**
 * Fees aggregated for one input token within a single revenue query.
 *
 * A pair can collect fees in either side of the pool, so revenue is grouped
 * per token — stroops are only additive within one token.
 */
export interface FeeRevenueTokenTotal {
  /** Input token the fees are denominated in */
  token: string;
  /** Decimals read from that token's on-chain metadata */
  decimals: number;
  /** Swaps whose fees landed in this token */
  swapCount: number;
  /** Sum of `FeeRevenueEntry.feeAmount` for this token, exact BigInt stroops */
  totalFeeAmount: bigint;
  /** `totalFeeAmount` rendered in human units at `decimals` */
  totalFeeFormatted: string;
  /** Float rendering of `totalFeeAmount` at `decimals` (legacy `XLM` name) */
  totalFeeXLM: number;
}

/**
 * Fee revenue for a pair over a ledger window.
 */
export interface FeeRevenue {
  /** Pair the revenue was aggregated for */
  pairAddress: string;
  /** Swaps aggregated (after the `limit` cap) */
  swapCount: number;
  /** Raw stroop sum across every aggregated swap — prefer {@link FeeRevenue.byToken} when a pair collects fees in both tokens */
  totalFeeAmount: bigint;
  /** Float total at each swap's own token decimals (legacy `XLM` name) */
  totalFeeXLM: number;
  /** Per-input-token stroop totals */
  byToken: FeeRevenueTokenTotal[];
  /** Per-swap breakdown in scan order */
  history: FeeRevenueEntry[];
}
