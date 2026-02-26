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
