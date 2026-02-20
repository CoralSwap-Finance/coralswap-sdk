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
