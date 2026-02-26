/**
 * On-chain pair pool state, read directly from Soroban storage.
 */
export interface PoolState {
  /** Address of the pair contract */
  address: string;
  /** Address of token 0 */
  token0: string;
  /** Address of token 1 */
  token1: string;
  /** Current reserve of token 0 */
  reserve0: bigint;
  /** Current reserve of token 1 */
  reserve1: bigint;
  /** Last K value (reserve0 * reserve1) at last invariant check */
  kLast: bigint;
  /** Address of the factory contract that deployed this pair */
  factory: string;
  /** Address of the LP token contract */
  lpToken: string;
  /** True if the pair is paused */
  paused: boolean;
  /** Protocol version format version */
  protocolVersion: number;
}

/**
 * Dynamic fee state attached to each pair.
 */
export interface FeeState {
  /** Last recorded price (scaled) */
  priceLast: bigint;
  /** Volatility accumulator value */
  volAccumulator: bigint;
  /** Timestamp of last update */
  lastUpdated: number;
  /** Current dynamic fee in basis points */
  feeCurrent: number;
  /** Minimum fee in basis points */
  feeMin: number;
  /** Maximum fee in basis points */
  feeMax: number;
  /** EMA alpha parameter */
  emaAlpha: number;
  /** Timestamp when the fee was last changed */
  feeLastChanged: number;
  /** EMA decay rate parameter */
  emaDecayRate: number;
  /** Baseline fee in basis points */
  baselineFee: number;
}

/**
 * Flash loan configuration for a pair.
 */
export interface FlashLoanConfig {
  /** Flash loan fee in basis points */
  flashFeeBps: number;
  /** True if flash loans are disabled for this pair */
  locked: boolean;
  /** Minimum absolute fee floor */
  flashFeeFloor: bigint;
}

/**
 * Combined pool info including reserves, fees, and flash config.
 */
export interface PoolInfo extends PoolState {
  /** Dynamic fee state */
  feeState: FeeState;
  /** Flash loan configuration */
  flashConfig: FlashLoanConfig;
}

/**
 * LP token position for a specific address.
 */
export interface LPPosition {
  /** Address of the pair contract */
  pairAddress: string;
  /** Address of the LP token contract */
  lpTokenAddress: string;
  /** LP token balance of the user */
  balance: bigint;
  /** Total supply of LP tokens */
  totalSupply: bigint;
  /** User's share of the pool as a float (0 to 1) */
  share: number;
  /** Implied amount of token 0 belonging to user */
  token0Amount: bigint;
  /** Implied amount of token 1 belonging to user */
  token1Amount: bigint;
}
