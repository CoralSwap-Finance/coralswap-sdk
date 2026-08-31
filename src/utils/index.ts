export {
  toSorobanAmount,
  parseTokenAmount,
  fromSorobanAmount,
  formatAmount,
  formatLargeNumber,
  toBps,
  applyBps,
  percentDiff,
  safeMul,
  safeDiv,
  minBigInt,
  maxBigInt,
} from "./amounts";

export {
  isValidPublicKey,
  isValidContractId,
  isValidAddress,
  isNativeToken,
  getNativeAssetContractAddress,
  resolveTokenIdentifier,
  sortTokens,
  truncateAddress,
  toScAddress,
  getPairAddress,
} from './addresses';

export {
  isSimulationSuccess,
  getSimulationReturnValue,
  getResourceEstimate,
  exceedsBudget,
  decodeDiagnosticEvents,
  buildSimulationResult,
} from "./simulation";

export type { SimulationResult, SimulationResourceEstimate } from './simulation';

export {
  decodeI128,
  decodeI32,
  decodeI64,
  decodeU32,
  decodeU64,
  decodeBool,
  decodeAddress,
  decodeString,
  getMapValue,
  mapValue,
} from "./scval";

export {
  withRetry,
  isRetryable,
  sleep,
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
  CircuitBreaker,
  CircuitOpenError,
  getCircuitBreaker,
  resetCircuitBreakers,
} from "./retry";

export { Fraction, Percent, Rounding } from './math';

export {
  validateAddress,
  validatePositiveAmount,
  validateNonNegativeAmount,
  validateSlippage,
  validateDistinctTokens,
  isValidPath,
} from './validation';

export {
  batchRequest,
  batchRequestOrThrow,
  batchCall,
  batchCallSequential,
  DEFAULT_BATCH_CONCURRENCY,
} from './batch-request';
export type { BatchRequestOptions, BatchResult } from './batch-request';

export { parseChangelog } from './changelog';
export { RateLimiter } from './rate-limiter';
export type { RateLimiterOptions } from './rate-limiter';
export { estimateGas } from './gas';
export type { SimulateFn } from './gas';

export { waitNextLedger } from './ledger';
export type { WaitNextLedgerOptions } from './ledger';

export {
  EventParser,
  EVENT_TOPICS,
  decodeEvents,
  decodeEventsFromXdr,
} from './events';
export type { DecodeEventsOptions } from './events';

export { EventCursor, TypedEventCursor, decodeEventTopic, MIN_START_LEDGER } from './event-cursor';
export type { EventCursorOptions, TypedEventScanParams } from './event-cursor';
export { ConnectionPool } from './connection-pool';

export {
  getVotingPower,
  getVotingPowerAtLedger,
  setVotingPowerQueryProvider,
} from './voting-power';
export type { VotingPower, VotingPowerQueryProvider, VotingPowerQueryResult } from './voting-power';

export { checkCompatibility } from './migration';
export type { BreakingChange, CompatibilityReport } from './migration';
export { suppressDeprecationWarnings, deprecated } from './deprecation-warnings';

/**
 * Idempotent-resubmission helpers for state-changing on-chain calls.
 *
 * `submitTransaction()` (and similar) can fail with a retryable error
 * (timeout, connection reset, RPC 503) that says nothing about whether the
 * transaction actually landed. Before rebuilding and resubmitting on such a
 * failure, use `getTransactionStatus()` to check the real on-chain outcome
 * and `shouldRetrySubmission()` to decide whether it's safe to retry.
 *
 * @example
 * const result = await client.submitTransaction([op]);
 * if (!result.success && result.txHash) {
 *   const status = await getTransactionStatus(client.server, result.txHash);
 *   const { shouldRetry } = shouldRetrySubmission(status);
 *   if (!shouldRetry && status.status === 'SUCCESS') {
 *     // Already landed -- use status.ledger / status.result, don't resubmit.
 *   }
 * }
 */
export {
  getTransactionStatus,
  shouldRetrySubmission,
} from './idempotent-resubmission';
export type { TransactionStatus, RetryDecision } from './idempotent-resubmission';
