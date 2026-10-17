/**
 * Represents the possible states of a limit order.
 *
 * **State machine:**
 * ```
 *                ┌──────────┐
 *                │   open   │
 *                └────┬─────┘
 *                     │
 *          ┌──────────┼──────────┐
 *          │          │          │
 *          ▼          ▼          ▼
 *     ┌────────┐ ┌─────────┐ ┌─────────┐
 *     │partial │ │ filled  │ │expired  │
 *     └───┬────┘ └─────────┘ └─────────┘
 *         │
 *         ▼
 *     ┌──────────┐
 *     │cancelled │
 *     └──────────┘
 * ```
 *
 * - **open**: Order is active with zero fills.
 * - **partial**: Order is active with some fills but not yet fully filled.
 * - **filled**: Order has been fully executed. Terminal state.
 * - **cancelled**: Order was cancelled by the creator. Terminal state.
 * - **expired**: Order reached its expiry timestamp without being fully filled. Terminal state.
 */
export type LimitOrderState = 'open' | 'partial' | 'filled' | 'cancelled' | 'expired';

/**
 * Snapshot of an order's status at a point in time.
 */
export interface OrderStatus {
  /** Current state of the order. */
  state: LimitOrderState;
  /** How much of the order has been filled (0–100). */
  fillPercent: number;
  /** Weighted-average execution price, if any fills exist. */
  executionPrice?: number;
  /** Unix timestamp (seconds) when the order was fully filled. */
  filledAt?: number;
}

/**
 * Result returned after successfully cancelling a limit order.
 */
export interface CancelResult {
  /** Amount refunded to the order creator (unfilled portion). */
  refundedAmount: bigint;
  /** Amount that was filled before cancellation. */
  filledAmount: bigint;
  /** Hash of the on-chain cancellation transaction. */
  refundTxHash: string;
}

/**
 * Parameters required to place a new limit order.
 */
export interface LimitOrderParams {
  /** Contract address of the token the caller wants to sell. */
  tokenIn: string;
  /** Contract address of the token the caller wants to buy. */
  tokenOut: string;
  /** Amount of `tokenIn` to sell (in smallest unit, e.g. stroops for Stellar assets). */
  amountIn: bigint;
  /**
   * Desired execution price (tokenOut per tokenIn). Must be positive and ≤ 1,000,000.
   * The order will only execute when the market price reaches this level or better.
   */
  targetPrice: number;
  /**
   * Unix timestamp (seconds) after which the order expires.
   * Must be **strictly greater than** `Math.floor(Date.now() / 1000)`.
   */
  expiry: number;
  /** Contract address of the trading pair. */
  pairAddress: string;
}

/**
 * Full details of a limit order retrieved from the chain.
 */
export interface LimitOrderDetails {
  /** Unique on-chain order identifier. */
  id: string;
  /** Current status snapshot. */
  status: OrderStatus;
  /** Total amount that has been filled so far (in smallest unit). */
  amountFilled: bigint;
  /** Amount still unfilled (in smallest unit). */
  amountRemaining: bigint;
  /** Unix timestamp (seconds) when the order was created. */
  createdAt: number;
}

/**
 * Result returned after successfully placing a limit order.
 */
export interface PlaceLimitOrderResult {
  /** On-chain order ID that can be used for subsequent status checks or cancellation. */
  orderId: string;
}
