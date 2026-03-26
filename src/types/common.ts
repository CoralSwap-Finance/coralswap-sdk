import type { SorobanRpc, xdr } from '@stellar/stellar-sdk';

/**
 * Supported Soroban networks for CoralSwap deployment.
 */
export enum Network {
  TESTNET = "testnet",
  MAINNET = "mainnet",
  STAGING = "staging",
}

/**
 * Trade direction for swap operations.
 */
export enum TradeType {
  EXACT_IN = "EXACT_IN",
  EXACT_OUT = "EXACT_OUT",
}

/**
 * Contract identifiers within the CoralSwap protocol.
 */
export enum ContractType {
  FACTORY = "factory",
  PAIR = "pair",
  ROUTER = "router",
  LP_TOKEN = "lp_token",
  FLASH_RECEIVER = "flash_receiver",
}

/**
 * Governance action types requiring multi-sig approval.
 */
export enum ActionType {
  PAUSE = "pause",
  UNPAUSE = "unpause",
  SET_FEE_PARAMS = "set_fee_params",
  SET_FLASH_FEE = "set_flash_fee",
  UPGRADE = "upgrade",
  ROTATE_SIGNER = "rotate_signer",
}

/**
 * Transaction submission status.
 */
export enum TxStatus {
  PENDING = "pending",
  SUCCESS = "success",
  FAILED = "failed",
  TIMEOUT = "timeout",
}

/**
 * Result wrapper for all SDK operations.
 */
export interface Result<T> {
  /** True if the operation was successful */
  success: boolean;
  /** The returned payload if successful */
  data?: T;
  /** Error details if the operation failed */
  error?: CoralSwapError;
  /** Transaction hash if a transaction was submitted */
  txHash?: string;
}

/**
 * Structured error from SDK operations.
 */
export interface CoralSwapError {
  /** Unique error code identifier */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional diagnostic information */
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

/**
 * External signer interface for wallet adapter pattern.
 *
 * Implement this interface to integrate external wallets (e.g. Freighter,
 * Albedo) with CoralSwapClient instead of passing raw secret keys.
 */
export interface Signer {
  /** Return the public key of the signer. */
  publicKey(): Promise<string>;
  /** Sign a Stellar transaction and return the signed transaction. */
  signTransaction(xdr: string): Promise<string>;
}

/**
 * Options for controlling the simulation environment and behavior.
 *
 * Pass this as the second argument to the enhanced form of
 * {@link CoralSwapClient.simulateTransaction} to receive a rich
 * {@link SimulateTransactionResult} in return.
 *
 * @example
 * const result = await client.simulateTransaction([op], {
 *   source: 'G...',
 *   timeoutSec: 60,
 * });
 */
export interface SimulateTransactionOptions {
  /**
   * Override the source account public key for the simulated transaction.
   * Falls back to the configured signer's public key when omitted.
   */
  source?: string;
  /**
   * Transaction timeout in seconds.
   * Defaults to the network's `sorobanTimeout` value (30 s).
   */
  timeoutSec?: number;
  /**
   * Base fee in stroops for the transaction envelope.
   * Defaults to `"100"`. Does not affect simulation resource estimates.
   */
  fee?: string;
}

/**
 * A single decoded diagnostic event from a Soroban simulation response.
 *
 * The RPC returns events as an array of base64-encoded XDR strings.
 * This type exposes both the raw string (for serialisation) and the
 * decoded `xdr.DiagnosticEvent` object (for inspection).
 */
export interface SimulationDiagnosticEvent {
  /** Base64-encoded XDR string exactly as returned by the RPC. */
  xdr: string;
  /**
   * Decoded XDR `DiagnosticEvent` object.
   * `null` when XDR decoding fails (e.g. unsupported schema version).
   */
  decoded: xdr.DiagnosticEvent | null;
}

/**
 * Typed result returned by the enhanced form of
 * {@link CoralSwapClient.simulateTransaction}.
 *
 * All fields from the Soroban RPC simulation response are surfaced
 * in a strongly-typed structure. The `raw` field is always present
 * as an escape hatch for advanced use cases.
 *
 * @example
 * const result = await client.simulateTransaction([op], { source: 'G...' });
 * if (result.success) {
 *   console.log('Return value:', result.returnValue);
 *   console.log('Events:', result.events.length);
 *   console.log('Min fee:', result.minResourceFee);
 * } else {
 *   console.error('Simulation failed:', result.error);
 * }
 */
export interface SimulateTransactionResult {
  /** `true` when the RPC reports a successful simulation. */
  success: boolean;

  /**
   * Decoded return value from the contract invocation.
   * `null` when the simulation failed or the invocation produced no return value.
   */
  returnValue: xdr.ScVal | null;

  /**
   * Authorization entries required when assembling the real transaction.
   * Empty array when the simulation failed.
   */
  auth: xdr.SorobanAuthorizationEntry[];

  /**
   * Minimum resource fee in stroops as a string to avoid precision loss.
   * Empty string when the simulation failed.
   */
  minResourceFee: string;

  /**
   * Soroban resource cost estimate from the RPC.
   * `null` when the simulation failed.
   */
  cost: { cpuInsns: string; memBytes: string } | null;

  /**
   * Soroban transaction data needed for fee-bumping or assembling the real tx.
   * `null` when the simulation failed.
   */
  transactionData: xdr.SorobanTransactionData | null;

  /**
   * Latest ledger sequence number at the time of simulation.
   * Always populated regardless of success or failure.
   */
  latestLedger: number;

  /**
   * Diagnostic events emitted during the simulation, decoded from XDR.
   * Empty array when no events were emitted or when the simulation failed.
   */
  events: SimulationDiagnosticEvent[];

  /**
   * Error message from the RPC when `success` is `false`.
   * `null` when the simulation succeeded.
   */
  error: string | null;

  /**
   * Full, unmodified RPC response for advanced or escape-hatch use.
   */
  raw: SorobanRpc.Api.SimulateTransactionResponse;
}
