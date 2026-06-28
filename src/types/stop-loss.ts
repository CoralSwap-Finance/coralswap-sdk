/**
 * TypeScript types for the CoralSwap StopLossModule.
 *
 * A stop-loss order automatically sells a position when the market price
 * falls to or below a trigger price, capping downside risk. Trigger detection
 * relies on an external price feed (RedStone) rather than the pool's own spot
 * price, so manipulation of a single pool cannot spuriously fire the order.
 */

/**
 * Lifecycle status of a stop-loss order.
 */
export type StopLossStatus = 'active' | 'triggered' | 'executed' | 'cancelled';

/**
 * Parameters required to create a stop-loss order.
 */
export interface StopLossParams {
  /** Address of the token held / being sold when triggered. */
  tokenIn: string;
  /** Address of the token received on execution. */
  tokenOut: string;
  /** Amount of `tokenIn` to sell when the order triggers (smallest unit). */
  amount: bigint;
  /**
   * Price (in the oracle's fixed-point scale) at or below which the order
   * fires. Must be strictly below the current market price at creation time.
   */
  triggerPrice: bigint;
  /** Address of the pair the protective swap routes through. */
  pairAddress: string;
  /**
   * Identifier of the RedStone price feed used for trigger detection
   * (e.g. the asset symbol `'XLM'`).
   */
  oracleAsset: string;
}

/**
 * Full state of a stop-loss order, including a live oracle price reading.
 */
export interface StopLossOrder {
  /** Unique order identifier. */
  id: string;
  /** Stellar address that owns the order. */
  owner: string;
  /** Address of the token being sold. */
  tokenIn: string;
  /** Address of the token received. */
  tokenOut: string;
  /** Amount of `tokenIn` to sell on trigger. */
  amount: bigint;
  /** Price at or below which the order fires. */
  triggerPrice: bigint;
  /** Latest market price from the RedStone feed at query time. */
  currentPrice: bigint;
  /** RedStone feed identifier used for this order. */
  oracleAsset: string;
  /** Current lifecycle status reported by the contract. */
  status: StopLossStatus;
  /**
   * `true` when `currentPrice <= triggerPrice`, i.e. the stop-loss condition
   * is currently met and the order is eligible for execution.
   */
  triggered: boolean;
}
