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
  /** Minimum amount of token A to add (slippage protection) */
  amountAMin: bigint;
  /** Minimum amount of token B to add (slippage protection) */
  amountBMin: bigint;
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
  /** Minimum amount of token A to receive */
  amountAMin: bigint;
  /** Minimum amount of token B to receive */
  amountBMin: bigint;
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
