import { Network, Logger, Signer } from '@/types/common';
import { PollingStrategy } from '@/utils/polling';

/**
 * Contract addresses per network deployment.
 */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  factoryAddress: string;
  routerAddress: string;
  sorobanTimeout: number;
}

/**
 * SDK client configuration.
 */
export interface CoralSwapConfig {
  /** The Soroban network to connect to */
  network: Network;
  /** Optional custom RPC URL to use */
  rpcUrl?: string;
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
  /** Delay in milliseconds between retry attempts */
  retryDelayMs?: number;
  /** Maximum delay in milliseconds between retry attempts */
  maxRetryDelayMs?: number;
  /** Initial delay for exponential backoff (alias for retryDelayMs) */
  baseDelayMs?: number;
  /** Maximum delay for exponential backoff (alias for maxRetryDelayMs) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier?: number;
  pollingStrategy?: PollingStrategy;
  pollingIntervalMs?: number;
  maxPollingAttempts?: number;
  pollingBackoffFactor?: number;
  maxPollingIntervalMs?: number;
}

/**
 * Known contract addresses for each network.
 */
export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  [Network.TESTNET]: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    factoryAddress: "",
    routerAddress: "",
    sorobanTimeout: 30,
  },
  [Network.MAINNET]: {
    rpcUrl: "https://soroban.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    factoryAddress: "",
    routerAddress: "",
    sorobanTimeout: 30,
  },
};

/**
 * Default SDK configuration values.
 */
export const DEFAULTS = {
  slippageBps: 50,
  deadlineSec: 1200,
  maxRetries: 3,
  retryDelayMs: 1000,
  maxRetryDelayMs: 10000,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
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
