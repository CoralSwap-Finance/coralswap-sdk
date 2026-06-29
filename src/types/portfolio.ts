/**
 * A single LP position within a portfolio, valued in USD.
 */
export interface PortfolioPosition {
  /** Pair contract address */
  pairAddress: string;
  /** LP token contract address */
  lpTokenAddress: string;
  /** Token 0 address in the pair */
  token0: string;
  /** Token 1 address in the pair */
  token1: string;
  /** LP token balance held by the owner */
  lpBalance: bigint;
  /** Implied token 0 amount belonging to the owner */
  token0Amount: bigint;
  /** Implied token 1 amount belonging to the owner */
  token1Amount: bigint;
  /** Estimated USD value of this position */
  valueUSD: number;
}

/**
 * Aggregated portfolio view for an address across CoralSwap pools.
 */
export interface Portfolio {
  /** The queried owner address */
  owner: string;
  /** Non-zero LP positions */
  positions: PortfolioPosition[];
  /** Sum of position USD values */
  totalValueUSD: number;
}

/**
 * Snapshot of portfolio state at a point in time (entry cost basis).
 */
export interface PortfolioEntrySnapshot {
  /** Owner address */
  owner: string;
  /** Total USD value at capture time */
  totalValueUSD: number;
  /** Per-pair position breakdown at capture time */
  positions: Array<{
    pairAddress: string;
    token0Amount: bigint;
    token1Amount: bigint;
    valueUSD: number;
  }>;
  /** Unix timestamp (seconds) when the snapshot was taken */
  capturedAt: number;
}

/**
 * Profit and loss relative to an entry snapshot.
 */
export interface PortfolioPnL {
  /** USD value at entry (from snapshot) */
  entryValueUSD: number;
  /** Current USD value */
  currentValueUSD: number;
  /** Absolute PnL in USD (current − entry) */
  pnlUSD: number;
  /** Percentage PnL relative to entry */
  pnlPercent: number;
}

/**
 * Options for portfolio queries.
 */
export interface GetPortfolioOptions {
  /** Specific pair addresses to include; defaults to all factory pairs */
  pairAddresses?: string[];
}
