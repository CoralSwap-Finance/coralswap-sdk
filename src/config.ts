import { Network, Logger, Signer } from './types/common';

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
  network: Network;
  rpcUrl?: string;
  secretKey?: string;
  publicKey?: string;
  /** Optional logger for RPC request/response instrumentation. */
  logger?: Logger;
  /** External signer for wallet adapter pattern. Takes precedence over secretKey. */
  signer?: Signer;
  defaultSlippageBps?: number;
  defaultDeadlineSec?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Known contract addresses for each network.
 */
export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  [Network.TESTNET]: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    factoryAddress: '',
    routerAddress: '',
    sorobanTimeout: 30,
  },
  [Network.MAINNET]: {
    rpcUrl: 'https://soroban.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    factoryAddress: '',
    routerAddress: '',
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
 * Precision constants for Soroban i128 math.
 */
export const PRECISION = {
  PRICE_SCALE: BigInt(1e14),
  BPS_DENOMINATOR: BigInt(10000),
  MIN_LIQUIDITY: BigInt(1000),
} as const;
