/**
 * Protocol-wide aggregate metrics returned by MonitoringModule.getProtocolMetrics().
 *
 * All USD values are expressed as bigint × 10^8 (i.e. the same scale used by
 * RedStone price feeds and throughout the rest of the SDK).
 */
export interface ProtocolMetrics {
  /**
   * Total Value Locked across all active pairs (USD × 10^8).
   *
   * Computed as the sum of both reserves of every pair, each converted
   * to USD using the RedStone price feed for that token.
   */
  tvlUSD: bigint;

  /**
   * Estimated 24-hour trading volume (USD × 10^8).
   *
   * Derived from swap events observed within the last 24 hours.
   * Returns 0n when no swap events are available.
   */
  volume24hUSD: bigint;

  /**
   * Number of pairs currently tracked by the factory.
   */
  activePools: number;

  /**
   * Estimated number of unique swap initiators in the last 24 hours.
   *
   * Returns 0 when event data is unavailable.
   */
  uniqueUsers24h: number;

  /**
   * Total number of swap transactions observed in the last 24 hours.
   *
   * Returns 0 when event data is unavailable.
   */
  totalSwaps24h: number;

  /**
   * Average swap size over the last 24 hours (USD × 10^8).
   *
   * Equals `volume24hUSD / totalSwaps24h`, or 0n when no swaps exist.
   */
  avgSwapSizeUSD: bigint;

  /**
   * Unix timestamp (seconds) when these metrics were fetched.
   */
  fetchedAt: number;
}

/**
 * Detailed metrics for a single liquidity pool.
 *
 * All USD values are expressed as bigint × 10^8.
 */
export interface PoolMetrics {
  /**
   * Pair contract address.
   */
  pairAddress: string;

  /**
   * Address of token 0 (canonical ordering, token0 < token1 lexicographically).
   */
  token0: string;

  /**
   * Address of token 1.
   */
  token1: string;

  /**
   * Current reserve of token 0 (in token0's smallest unit, 7 decimals).
   */
  reserve0: bigint;

  /**
   * Current reserve of token 1 (in token1's smallest unit, 7 decimals).
   */
  reserve1: bigint;

  /**
   * Total Value Locked for this specific pool (USD × 10^8).
   *
   * Sum of both reserves converted to USD via RedStone price feeds.
   */
  tvlUSD: bigint;

  /**
   * Current dynamic fee for this pair in basis points (e.g. 30 = 0.30 %).
   */
  feeBps: number;

  /**
   * Total LP token supply for this pair (i128 BigInt).
   */
  totalLPSupply: bigint;

  /**
   * Unix timestamp (seconds) when these metrics were fetched.
   */
  fetchedAt: number;
}

/**
 * A single cache entry used internally by MonitoringModule.
 *
 * @internal
 */
export interface MonitoringCacheEntry<T> {
  /** The cached value. */
  value: T;
  /** Absolute epoch-ms timestamp after which the entry is stale. */
  expiresAt: number;
}
