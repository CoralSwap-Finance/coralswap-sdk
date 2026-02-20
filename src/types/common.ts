/**
 * Supported Soroban networks for CoralSwap deployment.
 */
export enum Network {
  TESTNET = 'testnet',
  MAINNET = 'mainnet',
}

/**
 * Trade direction for swap operations.
 */
export enum TradeType {
  EXACT_IN = 'EXACT_IN',
  EXACT_OUT = 'EXACT_OUT',
}

/**
 * Contract identifiers within the CoralSwap protocol.
 */
export enum ContractType {
  FACTORY = 'factory',
  PAIR = 'pair',
  ROUTER = 'router',
  LP_TOKEN = 'lp_token',
  FLASH_RECEIVER = 'flash_receiver',
}

/**
 * Governance action types requiring multi-sig approval.
 */
export enum ActionType {
  PAUSE = 'pause',
  UNPAUSE = 'unpause',
  SET_FEE_PARAMS = 'set_fee_params',
  SET_FLASH_FEE = 'set_flash_fee',
  UPGRADE = 'upgrade',
  ROTATE_SIGNER = 'rotate_signer',
}

/**
 * Transaction submission status.
 */
export enum TxStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
}

/**
 * Result wrapper for all SDK operations.
 */
export interface Result<T> {
  success: boolean;
  data?: T;
  error?: CoralSwapError;
  txHash?: string;
}

/**
 * Structured error from SDK operations.
 */
export interface CoralSwapError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Logger interface for SDK request/response instrumentation.
 *
 * Implement this interface to receive debug, info, and error
 * logs from all RPC interactions within CoralSwapClient.
 * Defaults to undefined (no logging) for backward compatibility.
 */
export interface Logger {
  /** Debug-level log for routine RPC calls and polling. */
  debug(msg: string, data?: unknown): void;
  /** Info-level log for successful operations. */
  info(msg: string, data?: unknown): void;
  /** Error-level log for failed simulations, submissions, and exceptions. */
  error(msg: string, err?: unknown): void;
}
