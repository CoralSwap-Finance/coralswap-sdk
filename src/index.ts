/**
 * @coralswap/sdk -- TypeScript SDK for CoralSwap Protocol
 *
 * Contract-first AMM SDK for Stellar/Soroban.
 * Interacts directly with on-chain Soroban contracts without
 * intermediary APIs, using auto-generated contract bindings.
 *
 * @example
 * ```ts
 * import { CoralSwapClient, Network, TradeType } from '@coralswap/sdk';
 *
 * const client = new CoralSwapClient({
 *   network: Network.TESTNET,
 *   secretKey: 'S...',
 * });
 *
 * const swap = client.swap();
 * const quote = await swap.getQuote({
 *   tokenIn: 'CDLZ...',
 *   tokenOut: 'CBQH...',
 *   amount: 1000000n,
 *   tradeType: TradeType.EXACT_IN,
 * });
 * ```
 *
 * @packageDocumentation
 */

// Core client
export { CoralSwapClient, KeypairSigner } from './client';

// Configuration
export {
  CoralSwapConfig,
  NetworkConfig,
  NETWORK_CONFIGS,
  DEFAULTS,
  PRECISION,
} from './config';

// Type exports
export * from './types';
export type { Logger } from './types/common';

// Contract clients
export {
  FactoryClient,
  PairClient,
  RouterClient,
  LPTokenClient,
  encodeFlashLoanData,
  decodeFlashLoanData,
  calculateRepayment,
  validateFeeFloor,
} from './contracts';

// Feature modules
export {
  SwapModule,
  LiquidityModule,
  FlashLoanModule,
  FeeModule,
  OracleModule,
  TokenListModule,
} from './modules';
export type { TWAPObservation, TWAPResult } from './modules';

// Utilities
export {
  toSorobanAmount,
  fromSorobanAmount,
  formatAmount,
  toBps,
  applyBps,
  percentDiff,
  safeMul,
  safeDiv,
  minBigInt,
  maxBigInt,
  isValidPublicKey,
  isValidContractId,
  isValidAddress,
  sortTokens,
  truncateAddress,
  toScAddress,
  isSimulationSuccess,
  getSimulationReturnValue,
  getResourceEstimate,
  exceedsBudget,
  withRetry,
  isRetryable,
  sleep,
  validateAddress,
  validatePositiveAmount,
  validateNonNegativeAmount,
  validateSlippage,
  validateDistinctTokens,
} from './utils';

export type {
  RetryConfig,
  SimulationResult,
  SimulationResourceEstimate,
} from './utils';

// Errors
export {
  CoralSwapSDKError,
  NetworkError,
  RpcError,
  SimulationError,
  TransactionError,
  DeadlineError,
  SlippageError,
  InsufficientLiquidityError,
  PairNotFoundError,
  ValidationError,
  FlashLoanError,
  CircuitBreakerError,
  SignerError,
  mapError,
} from './errors';
