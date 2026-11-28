/**
 * Add liquidity request.
 */
export interface AddLiquidityRequest {
  /** Address of token A */
  tokenA: string;
  /** Address of token B */
  tokenB: string;
  /** Desired amount of token A to add */
  amountADesired: bigint;
  /** Desired amount of token B to add */
  amountBDesired: bigint;
  /**
   * Minimum amount of token A to add (slippage protection).
   *
   * When omitted, the minimum is derived from a fresh quote and
   * `slippageBps`. An explicit `0` is rejected unless `allowZeroMin` is set.
   */
  amountAMin?: bigint;
  /**
   * Minimum amount of token B to add (slippage protection).
   *
   * When omitted, the minimum is derived from a fresh quote and
   * `slippageBps`. An explicit `0` is rejected unless `allowZeroMin` is set.
   */
  amountBMin?: bigint;
  /**
   * Slippage tolerance in basis points (0-5000) used to derive missing
   * minimums. Defaults to the client's `defaultSlippageBps` or the SDK default.
   */
  slippageBps?: number;
  /** Opt in to sending an explicit zero minimum (unbounded slippage). */
  allowZeroMin?: boolean;
  /** Address receiving the LP tokens */
  to: string;
  /** Timestamp when the request expires */
  deadline?: number;
}

/**
 * Remove liquidity request.
 */
export interface RemoveLiquidityRequest {
  /** Address of token A */
  tokenA: string;
  /** Address of token B */
  tokenB: string;
  /** Amount of LP tokens to withdraw */
  liquidity: bigint;
  /**
   * Minimum amount of token A to receive. Derived from a removal quote and
   * `slippageBps` when omitted. An explicit `0` is rejected unless
   * `allowZeroMin` is set.
   */
  amountAMin?: bigint;
  /**
   * Minimum amount of token B to receive. Derived from a removal quote and
   * `slippageBps` when omitted. An explicit `0` is rejected unless
   * `allowZeroMin` is set.
   */
  amountBMin?: bigint;
  /**
   * Slippage tolerance in basis points (0-5000) used to derive missing
   * minimums. Defaults to the client's `defaultSlippageBps` or the SDK default.
   */
  slippageBps?: number;
  /** Opt in to sending an explicit zero minimum (unbounded slippage). */
  allowZeroMin?: boolean;
  /** Address receiving the withdrawn tokens */
  to: string;
  /** Timestamp when the request expires */
  deadline?: number;
}

/**
 * Liquidity operation result.
 */
export interface LiquidityResult {
  /** Transaction hash of the operation */
  txHash: string;
  /** Amount of token A added or removed */
  amountA: bigint;
  /** Amount of token B added or removed */
  amountB: bigint;
  /** Amount of LP tokens minted or burned */
  liquidity: bigint;
  /** Ledger sequence number */
  ledger: number;
}

/**
 * Quote for removing liquidity (expected amounts).
 */
export interface RemoveLiquidityQuote {
  /** Expected amount of token A to receive */
  amountA: bigint;
  /** Expected amount of token B to receive */
  amountB: bigint;
  /** Amount of LP tokens burned */
  liquidity: bigint;
}

/**
 * Quote for adding liquidity (optimal amounts).
 */
export interface AddLiquidityQuote {
  /** Optimal amount of token A */
  amountA: bigint;
  /** Optimal amount of token B */
  amountB: bigint;
  /** Estimated LP tokens to be minted */
  estimatedLPTokens: bigint;
  /** Estimated share of the pool as a float (0 to 1) */
  shareOfPool: number;
  /** Price of token A per token B (scaled) */
  priceAPerB: bigint;
  /** Price of token B per token A (scaled) */
  priceBPerA: bigint;
}
