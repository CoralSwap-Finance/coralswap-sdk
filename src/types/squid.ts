/**
 * Types for cross-chain swap execution via the Squid Router aggregator.
 *
 * A cross-chain swap has up to two legs:
 *  1. Bridge leg (skipped when `fromChain` is already Stellar) -- executed
 *     and tracked through the Squid API.
 *  2. Swap leg -- a CoralSwap `swap_exact_in` on Soroban that converts the
 *     bridged asset into the caller's desired output token.
 */

/** Parameters for requesting a cross-chain quote. */
export interface CrossChainQuoteParams {
  /** Source chain identifier (e.g. "ethereum", "arbitrum", or "stellar"). */
  fromChain: string;
  /** Source-chain asset identifier/address, as understood by Squid. */
  fromAsset: string;
  /** Destination CoralSwap token (Stellar contract address). */
  toAsset: string;
  /** Amount of `fromAsset` to send, denominated in its native smallest unit. */
  amount: bigint;
  /** Stellar destination address. Defaults to the client's public key. */
  toAddress?: string;
  /** Slippage tolerance in basis points for the swap leg. */
  slippageBps?: number;
}

/** A single human-readable step in a cross-chain route. */
export interface CrossChainRouteStep {
  type: 'bridge' | 'swap';
  chain: string;
  description: string;
}

/** Bridge call payload returned by Squid for the source-chain transaction. */
export interface SquidBridgeCalldata {
  target: string;
  data: string;
  value?: string;
}

/**
 * A quoted cross-chain route, ready to execute.
 *
 * `routeId` is Squid's identifier for this route/request. It is the key
 * used to look up the bridge's tracked status for idempotent resubmission,
 * so it must be stable across retries of the same logical swap.
 */
export interface CrossChainQuote {
  routeId: string;
  /** True when `fromChain` is Stellar and the bridge leg is bypassed entirely. */
  isStellarNative: boolean;
  fromChain: string;
  fromAsset: string;
  /**
   * Stellar contract address the bridge deposits into. Equal to `fromAsset`
   * when `isStellarNative` is true (no bridging occurs).
   */
  bridgedAsset: string;
  /** Desired final CoralSwap output token (Stellar contract address). */
  toAsset: string;
  /** Amount of `fromAsset` being sent (source-chain units, or Stellar units when native). */
  amountIn: bigint;
  /** Estimated amount of `bridgedAsset` landing on Stellar after bridge fees. */
  bridgedAmount: bigint;
  /** Estimated amount of `toAsset` received after the swap leg. */
  estimatedAmountOut: bigint;
  /** Minimum acceptable `toAsset` output for the swap leg (slippage guard). */
  amountOutMin: bigint;
  bridgeFee: bigint;
  swapFee: bigint;
  totalSlippageBps: number;
  estimatedTimeSeconds: number;
  steps: CrossChainRouteStep[];
  /** Deadline (unix seconds) enforced on the on-chain swap leg. */
  deadline: number;
  /** Squid-provided calldata for executing the bridge leg. Absent when Stellar-native. */
  bridgeCalldata?: SquidBridgeCalldata;
}

/** Result of a fully executed (or recovered) cross-chain swap. */
export interface CrossChainSwapResult {
  /** Source-chain bridge transaction hash. Absent for Stellar-native swaps. */
  bridgeTxHash?: string;
  /** Stellar transaction hash of the swap leg. */
  swapTxHash: string;
  ledger: number;
}

/** Normalized tracked status of a bridge transfer, as reported by Squid. */
export type SquidTrackedStatus = 'success' | 'ongoing' | 'failed' | 'not_found' | 'unknown';

export interface SquidRouteStatusResult {
  status: SquidTrackedStatus;
  /** The landed bridge transaction hash, when known. */
  bridgeTxHash?: string;
}

/** Construction options for {@link SquidModule}. */
export interface SquidModuleOptions {
  /** Base URL for the Squid API. Defaults to the public Squid v2 API. */
  apiBaseUrl?: string;
  /** Squid integrator ID, sent as a header on every request. */
  integratorId?: string;
  /** Squid API key, sent as a header on every request. */
  apiKey?: string;
  /** Override for the fetch implementation (primarily for testing). */
  fetchFn?: typeof fetch;
}
