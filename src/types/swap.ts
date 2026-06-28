import { TradeType } from "./common";
import type { DeviationResult } from "../modules/price-feed";
import type { PriceFeed } from "../modules/price-feed";

/**
 * Filter parameters for querying historical swap events.
 *
 * At least one of `pairAddress` or `userAddress` should be provided for
 * meaningful results. When both are given they are ANDed together.
 * Ledger range defaults to the last 1000 ledgers when omitted.
 */
export interface SwapHistoryFilter {
  /** Pair contract address to filter swaps by pool. */
  pairAddress?: string;
  /** Sender address to filter swaps by user. */
  userAddress?: string;
  /** Inclusive start ledger (defaults to currentLedger - 1000). */
  fromLedger?: number;
  /** Inclusive end ledger (defaults to currentLedger). */
  toLedger?: number;
  /** Maximum number of results to return (defaults to 200). */
  limit?: number;
}

/**
 * A historical swap event returned by getSwapHistory().
 *
 * Combines on-chain event data with the transaction and ledger context
 * in which the swap occurred.
 */
export interface SwapHistoryEvent {
  /** Transaction hash of the swap. */
  txHash: string;
  /** Amount of input token provided (in token's smallest unit). */
  amountIn: bigint;
  /** Amount of output token received (in token's smallest unit). */
  amountOut: bigint;
  /** Contract address of the input token. */
  tokenIn: string;
  /** Contract address of the output token. */
  tokenOut: string;
  /** Address of the account that initiated the swap. */
  sender: string;
  /** Pair contract address where the swap occurred. */
  pairAddress: string;
  /** Ledger sequence number in which the swap was confirmed. */
  ledger: number;
  /** Unix timestamp (seconds) of the ledger close. */
  timestamp: number;
  /** Fee charged for this swap in basis points. */
  feeBps: number;
}

/**
 * Result returned by simulateSwap() — a contract-backed dry-run quote.
 *
 * All values are computed from live on-chain reserve state, so the
 * returned `amountOut` matches what an actual swap would produce for
 * the same block.
 */
export interface SwapSimulationResult {
  /** Expected output amount in the output token's smallest unit. */
  amountOut: bigint;
  /** Price impact of the trade in basis points (1 bps = 0.01%). */
  priceImpactBps: number;
  /** Fee deducted from the input amount (in input token units). */
  feeAmount: bigint;
  /**
   * Execution price expressed as a Fraction: amountOut / amountIn.
   * Stored as { numerator, denominator } to avoid floating-point loss.
   */
  executionPrice: { numerator: bigint; denominator: bigint };
  /**
   * Optional warning attached when the trade has significant market impact.
   * Currently only `'HIGH_PRICE_IMPACT'` (priceImpactBps > 500).
   */
  warning?: 'HIGH_PRICE_IMPACT';
}

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
  slippageBps?: number;
  /** Optional deadline as Unix timestamp */
  deadline?: number;
  /** Optional recipient address */
  to?: string;
  /** Optional pre-fetched quote to execute against without re-fetching reserves */
  quote?: SwapQuote;
  /**
   * Optional price feed for pre-execution deviation check.
   *
   * When provided, `execute()` compares the realised execution price
   * against the oracle price and attaches a `DeviationResult` to the
   * returned `SwapResult`.
   */
  priceFeed?: PriceFeed;
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
  /**
   * Price deviation check result, populated when a `priceFeed` was
   * provided in the `SwapRequest`.
   *
   * Callers should inspect `isWithinBounds` before submitting a large
   * swap to avoid unfavourable execution.
   */
  deviation?: DeviationResult;
}

/**
 * RedStone oracle price feed payload.
 *
 * The payload is the raw bytes produced by the RedStone SDK's
 * `DataPackagesWrapper` and contains signed price data for one or more
 * feed symbols (e.g. "USDC", "XLM").
 */
export interface RedStonePayload {
  /** Raw payload bytes (hex-encoded or Uint8Array). */
  data: string | Uint8Array;
  /** Unix timestamp (ms) when the payload was signed by RedStone nodes. */
  timestampMs: number;
  /** Prices keyed by feed symbol, expressed as USD value × 10^8. */
  prices: Record<string, bigint>;
}

/**
 * Price guard configuration set by the admin.
 */
export interface PriceGuardConfig {
  /** Minimum swap size in USD (× 10^8) that triggers the guard. */
  minGuardedAmountUsd: bigint;
  /** Maximum allowed deviation between execution price and oracle price, in bps. */
  maxDeviationBps: number;
  /** Maximum age of a RedStone payload before it is considered stale, in ms. Default: 5 min. */
  maxPayloadAgeMs: number;
}

/**
 * Request parameters for a price-guarded swap.
 */
export interface SwapWithPriceGuardRequest extends SwapRequest {
  /**
   * Optional RedStone payload. Required when the swap size exceeds
   * `PriceGuardConfig.minGuardedAmountUsd`.
   */
  redstonePayload?: RedStonePayload;
}

export interface MultiHopSwapRequest {
  /** Ordered token addresses describing the route (minimum 3). */
  path: string[];
  /** Input amount (in tokenIn's smallest unit). */
  amount: bigint;
  /** Trade direction (EXACT_IN or EXACT_OUT). */
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
