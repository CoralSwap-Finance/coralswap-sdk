/**
 * Balance of a single token held by the treasury.
 */
export interface TokenBalance {
  /** Soroban contract address of the token */
  address: string;
  /** Token symbol (e.g. "CORAL-LP" for LP tokens) */
  symbol: string;
  /** Raw token amount in the token's native precision (7 decimal places on Stellar) */
  amount: bigint;
  /** Estimated USD value, derived from on-chain spot prices. 0 if price unavailable. */
  valueUSD: number;
}

/**
 * Aggregate treasury balance across all held tokens.
 */
export interface TreasuryBalance {
  /** Sum of all token USD values */
  totalUSD: number;
  /** Per-token breakdown of treasury holdings */
  tokens: TokenBalance[];
}

/**
 * A single token's proportional share of the treasury.
 */
export interface Allocation {
  /** Soroban contract address of the token */
  token: string;
  /** Percentage of total treasury value (0–100). Percentages sum to 100 ±0.01. */
  percentage: number;
  /** USD value of this allocation */
  valueUSD: number;
  /** Raw token amount in native precision */
  amount: bigint;
}

/**
 * Treasury allocation breakdown across all held tokens.
 */
export interface TreasuryAllocation {
  /** Per-token percentage breakdown, sorted by percentage descending */
  allocations: Allocation[];
  /** Total treasury value in USD (sum of all allocation USD values) */
  totalValueUSD: number;
}

/**
 * Ledger range and granularity for a revenue query.
 * fromLedger and toLedger default to the last 30 days when omitted.
 */
export interface RevenuePeriod {
  /** Start of the query range (inclusive). Defaults to current − 30 days. */
  fromLedger?: number;
  /** End of the query range (inclusive). Defaults to current ledger. */
  toLedger?: number;
  /** Time bucket for trend analysis: '1h' | '1d' | '1w' */
  granularity: '1h' | '1d' | '1w';
}

/**
 * Revenue and volume figures for a single liquidity pool.
 */
export interface PoolRevenue {
  /** Soroban contract address of the pair */
  pairAddress: string;
  /** Total swap fee revenue collected in USD for the period */
  revenueUSD: number;
  /** Total swap volume in USD for the period */
  volumeUSD: number;
}

/**
 * Aggregated fee revenue across all pools for a time period.
 */
export interface RevenueData {
  /** Total protocol revenue in USD across all pools */
  totalUSD: number;
  /** Per-pool revenue breakdown, sorted by revenueUSD descending */
  byPool: PoolRevenue[];
  /**
   * Revenue trend derived from first-half vs second-half comparison:
   * 'rising' if second half > first half by >10%, 'falling' if <10%,
   * 'stable' otherwise.
   */
  trend: 'rising' | 'falling' | 'stable';
}
