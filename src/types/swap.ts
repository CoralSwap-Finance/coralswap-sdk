import { TradeType } from './common';

/**
 * Swap request parameters.
 *
 * If `path` is provided with 3+ tokens, the swap is routed through
 * intermediate pairs (multi-hop). For a direct swap (A -> B) omit
 * `path` or pass `[tokenIn, tokenOut]`.
 */
export interface SwapRequest {
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  tradeType: TradeType;
  /** Optional explicit routing path. Tokens are Soroban contract addresses. */
  path?: string[];
  slippageBps?: number;
  deadline?: number;
  to?: string;
}

/**
 * Per-hop calculation result used internally during multi-hop routing.
 */
export interface HopResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
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
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  amountOutMin: bigint;
  priceImpactBps: number;
  feeBps: number;
  feeAmount: bigint;
  path: string[];
  deadline: number;
}

/**
 * Swap execution result.
 */
export interface SwapResult {
  txHash: string;
  amountIn: bigint;
  amountOut: bigint;
  feePaid: bigint;
  ledger: number;
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
