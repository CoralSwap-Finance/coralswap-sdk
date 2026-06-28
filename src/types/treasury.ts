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
