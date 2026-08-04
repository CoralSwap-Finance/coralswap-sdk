import { Network, Logger, Signer } from '@/types/common';
import { PollingStrategy } from '@/utils/polling';
import { RateLimiter } from '@/utils/rate-limiter';

/**
 * Contract addresses per network deployment.
 */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  factoryAddress: string;
  routerAddress: string;
  limitOrderAddress?: string;
  sorobanTimeout: number;
}

/**
 * SDK client configuration.
 */
export interface CoralSwapConfig {
  /** The Soroban network to connect to */
  network: Network;
  /** Optional custom RPC URL(s) to use. Can be a single string or an array of fallback URLs. */
  rpcUrl?: string | string[];
  /** Optional custom headers to include in all RPC requests (e.g. for authentication) */
  rpcHeaders?: Record<string, string>;
  /** Optional custom fetch options for the underlying RPC client */
  fetchOptions?: Record<string, unknown>;
  /** Optional secret key for signing transactions */
  secretKey?: string;
  /** Optional public key for the account */
  publicKey?: string;
  /** Optional logger for RPC request/response instrumentation. */
  logger?: Logger;
  /** External signer for wallet adapter pattern. Takes precedence over secretKey. */
  signer?: Signer;
  /** Default slippage tolerance in basis points (0-10000) */
  defaultSlippageBps?: number;
  /** Default transaction deadline in seconds from now */
  defaultDeadlineSec?: number;
  /** Maximum number of retry attempts for failed RPC calls */
  maxRetries?: number;
  /** Maximum delay between retry attempts */
  retryDelayMs?: number;
  /** Maximum delay in milliseconds between retry attempts */
  maxRetryDelayMs?: number;
  /**
   * Maximum total time in milliseconds allowed for a single RPC call,
   * including every retry attempt. Once the deadline is exceeded, retries
   * stop and a `DeadlineError` is thrown instead.
   *
   * The deadline is measured per call — each RPC call gets a fresh window
   * starting when the call begins.
   *
   * If omitted (the default), RPC calls retry up to `maxRetries` with no
   * overall time bound, identical to previous SDK versions.
   *
   * @example
   * ```ts
   * import { CoralSwapClient, Network } from '@coralswap/sdk';
   *
   * const client = new CoralSwapClient({
   *   network: Network.TESTNET,
   *   secretKey: 'S...',
   *   // Bound the total time spent on any single RPC call (including
   *   // retries) to 5 seconds.
   *   deadlineMs: 5000,
   * });
   *
   * // Retries stop and a DeadlineError is thrown once 5s elapse.
   * const healthy = await client.isHealthy();
   * ```
   */
  deadlineMs?: number;
  pollingStrategy?: PollingStrategy;
  pollingIntervalMs?: number;
  maxPollingAttempts?: number;
  pollingBackoffFactor?: number;
  maxPollingIntervalMs?: number;
  /**
   * Optional rate limiter to throttle outbound RPC requests.
   *
   * When provided, every RPC call made by `CoralSwapClient` will call
   * `rateLimiter.acquire()` before dispatching the request. This is useful
   * when targeting public Soroban RPC endpoints that enforce request-rate
   * limits.
   *
   * If omitted (the default), no throttling is applied and behaviour is
   * identical to previous SDK versions.
   *
   * @example
   * ```ts
   * import { CoralSwapClient, Network, RateLimiter } from '@coralswap/sdk';
   *
   * const client = new CoralSwapClient({
   *   network: Network.TESTNET,
   *   secretKey: 'S...',
   *   rateLimiter: new RateLimiter({ maxRequestsPerSecond: 5, maxBurst: 10 }),
   * });
   * ```
   */
  rateLimiter?: RateLimiter;
}

/** Network configuration for the Stellar testnet. */
export const TESTNET_NETWORK: NetworkConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  factoryAddress: "",
  routerAddress: "",
  sorobanTimeout: 30,
};

/** Network configuration for the Stellar mainnet. */
export const MAINNET_NETWORK: NetworkConfig = {
  rpcUrl: "https://soroban.stellar.org",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  factoryAddress: "",
  routerAddress: "",
  sorobanTimeout: 30,
};

/** Network configuration for the CoralSwap staging environment (runs on testnet RPC). */
export const STAGING_NETWORK: NetworkConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  factoryAddress: "",
  routerAddress: "",
  sorobanTimeout: 30,
};

/**
 * Known contract addresses for each network.
 */
export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  [Network.TESTNET]: TESTNET_NETWORK,
  [Network.MAINNET]: MAINNET_NETWORK,
  [Network.STAGING]: STAGING_NETWORK,
};

/**
 * Default SDK configuration values.
 */
export const DEFAULTS = {
  slippageBps: 50,
  deadlineSec: 1200,
  maxRetries: 3,
  retryDelayMs: 1000,
  maxRetryDelayMs: 30_000,
  pollingStrategy: PollingStrategy.LINEAR,
  pollingIntervalMs: 1000,
  maxPollingAttempts: 30,
  pollingBackoffFactor: 2,
  maxPollingIntervalMs: 10000,
  flashFeeFloorBps: 5,
  feeMinBps: 10,
  feeMaxBps: 100,
  baselineFeeBps: 30,
  timelockHours: 48,
  upgradeTimelockHours: 72,
  multiSigThreshold: 2,
  multiSigSigners: 3,
} as const;

/**
 * Standard default slippage tolerance expressed in basis points.
 *
 * This value is used when applications do not provide an explicit
 * `slippageBps` or `defaultSlippageBps` override.
 */
export const DEFAULT_SLIPPAGE = DEFAULTS.slippageBps;

/**
 * Precision constants for Soroban i128 math.
 */
export const PRECISION = {
  PRICE_SCALE: BigInt(1e14),
  BPS_DENOMINATOR: BigInt(10000),
  MIN_LIQUIDITY: BigInt(1000),
} as const;
