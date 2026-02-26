import { TradeType } from "./common";

/**
 * Swap request parameters.
 *
 * If `path` is provided with 3+ tokens, the swap is routed through
 * intermediate pairs (multi-hop). For a direct swap (A -> B) omit
 * `path` or pass `[tokenIn, tokenOut]`.
 */
export interface SwapRequest {
  /** The address of the input token */
  tokenIn: string;
  /** The address of the output token */
  tokenOut: string;
  /** The amount to swap */
  amount: bigint;
  /** Trade direction (exact in or exact out) */
  tradeType: TradeType;
  /** Optional explicit routing path. Tokens are Soroban contract addresses. */
  path?: string[];
  /** Optional slippage tolerance in basis points */
  slippageBps?: number;
  /** Optional deadline as Unix timestamp */
  deadline?: number;
  /** Optional recipient address */
  to?: string;
}

/**
 * Per-hop calculation result used internally during multi-hop routing.
 */
export interface HopResult {
  /** The address of the input token for this hop */
  tokenIn: string;
  /** The address of the output token for this hop */
  tokenOut: string;
  /** The input amount for this hop */
  amountIn: bigint;
  /** The output amount for this hop */
  amountOut: bigint;
  /** Fee charged on this hop in basis points. */
  feeBps: number;
  /** Fee amount deducted on this hop (in tokenIn units). */
  feeAmount: bigint;
  /** Price impact for this hop in basis points. */
  priceImpactBps: number;
}

/**
 * Swap quote returned before execution.
 */
export interface SwapQuote {
  /** The address of the input token */
  tokenIn: string;
  /** The address of the output token */
  tokenOut: string;
  /** The calculated input amount */
  amountIn: bigint;
  /** The calculated output amount */
  amountOut: bigint;
  /** Minimum output amount factoring in slippage */
  amountOutMin: bigint;
  /** Price impact of the trade in basis points */
  priceImpactBps: number;
  /** Total fee in basis points */
  feeBps: number;
  /** Total fee amount deducted */
  feeAmount: bigint;
  /** Routing path used for the quote */
  path: string[];
  /** Expiration timestamp for the quote */
  deadline: number;
}

/**
 * Swap execution result.
 */
export interface SwapResult {
  /** Transaction hash of the swap execution */
  txHash: string;
  /** Actual input amount */
  amountIn: bigint;
  /** Actual output amount */
  amountOut: bigint;
  /** Fee paid in input tokens */
  feePaid: bigint;
  /** Ledger sequence number */
  ledger: number;
  /** Unix timestamp of the transaction */
  timestamp: number;
}

/**
 * Request parameters for a multi-hop swap.
 *
 * Unlike SwapRequest, `path` is required and must contain 3+ token addresses
 * describing the routing path (e.g. [tokenA, tokenB, tokenC]).
 */
export interface MultiHopSwapRequest {
  /** Ordered token addresses describing the route (minimum 3). */
  path: string[];
  /** Input amount (in tokenIn's smallest unit). */
  amount: bigint;
  /** Trade direction — only EXACT_IN is supported for multi-hop. */
  tradeType: TradeType;
  /** Slippage tolerance in basis points. */
  slippageBps?: number;
  /** Deadline as Unix timestamp. */
  deadline?: number;
  /** Recipient address (defaults to sender). */
  to?: string;
}

/**
 * Multi-hop swap quote with per-hop breakdown.
 *
 * Extends the standard SwapQuote with an ordered `hops` array containing
 * the calculation result for each consecutive pair in the route.
 */
export interface MultiHopSwapQuote extends SwapQuote {
  /** Per-hop breakdown in path order. */
  hops: HopResult[];
}
