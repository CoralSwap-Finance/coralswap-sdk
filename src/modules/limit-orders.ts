/**
 * @module limit-orders
 *
 * Create, monitor, cancel, and query limit orders on CoralSwap.
 *
 * ## Order Lifecycle
 *
 * 1. **Place** – A user submits a `placeLimitOrder` with the desired token pair, amount,
 *    target price, and expiry. The order starts in the **open** state.
 * 2. **Monitor** – Poll `getLimitOrderStatus` or use `watchOrder` to receive live callbacks.
 * 3. **Fill** – When the market reaches the target price, the order transitions to
 *    **partial** (if only partly filled) and eventually **filled** (terminal).
 * 4. **Cancel** – The creator can cancel an **open** or **partial** order at any time
 *    via `cancelLimitOrder`. Unfilled tokens are refunded.
 * 5. **Expire** – If the expiry timestamp passes without a full fill, the order
 *    becomes **expired** (terminal).
 *
 * ## State machine
 *
 * ```
 *                ┌──────────┐
 *                │   open   │
 *                └────┬─────┘
 *                     │
 *          ┌──────────┼──────────┐
 *          │          │          │
 *          ▼          ▼          ▼
 *     ┌────────┐ ┌─────────┐ ┌─────────┐
 *     │partial │ │ filled  │ │expired  │
 *     └───┬────┘ └─────────┘ └─────────┘
 *         │
 *         ▼
 *     ┌──────────┐
 *     │cancelled │
 *     └──────────┘
 * ```
 *
 * @example
 * // Place a limit order and poll until filled
 * const sdk = new CoralSwapSDK({ ... });
 * const limit = sdk.modules.limitOrders;
 *
 * const { orderId } = await limit.placeLimitOrder({
 *   tokenIn: 'CA...',
 *   tokenOut: 'CB...',
 *   amountIn: 100_000_000n,
 *   targetPrice: 0.5,
 *   expiry: Math.floor(Date.now() / 1000) + 86400,
 *   pairAddress: 'CP...',
 * });
 *
 * const status = await limit.getLimitOrderStatus(orderId);
 * console.log(status.state); // "open"
 *
 * @example
 * // Watch an order with a polling callback
 * const unwatch = limit.watchOrder(orderId, (status) => {
 *   console.log(`Order ${orderId}: ${status.state} (${status.fillPercent}%)`);
 *   if (status.state === 'filled' || status.state === 'cancelled') {
 *     unwatch();
 *   }
 * });
 *
 * @example
 * // Cancel a partial order
 * const cancel = await limit.cancelLimitOrder(orderId);
 * console.log(`Refunded: ${cancel.refundedAmount}, Filled: ${cancel.filledAmount}`);
 */

import { CoralSwapSDKError } from "@/errors";
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  xdr,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import {
  OrderStatus,
  LimitOrderState,
  CancelResult,
  LimitOrderParams,
  LimitOrderDetails,
  PlaceLimitOrderResult,
} from '@/types/limit-orders';
import { withRetry, RetryOptions } from '@/utils/retry';
import { OrderNotFoundError, InvalidOperationError, ValidationError } from '@/errors';
import { validateAddress, validatePositiveAmount, validateDistinctTokens } from '@/utils/validation';

/**
 * Extract a string from an `xdr.ScVal`.
 *
 * Accepts `scvString`, `scvSymbol`, and `scvBytes` variants.
 *
 * @param val - The ScVal to decode. `undefined` triggers a `PARSING_ERROR`.
 * @returns The decoded UTF-8 string.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the value is missing or
 *   the tag is not a recognised string-like type.
 */
export function scValToString(val: xdr.ScVal | undefined): string {
  if (!val) throw new CoralSwapSDKError("PARSING_ERROR", "Missing field");
  const tag = val.switch().name;
  if (tag === 'scvString') return val.str().toString();
  if (tag === 'scvSymbol') return val.sym().toString();
  if (tag === 'scvBytes') return Buffer.from(val.bytes()).toString('utf8');
  throw new CoralSwapSDKError("PARSING_ERROR", `Expected string/symbol/bytes, got ${tag}`);
}

/**
 * Extract a number from an `xdr.ScVal`.
 *
 * Accepts `scvU32`, `scvU64`, `scvI32`, and `scvI64`.
 *
 * @param val - The ScVal to decode. `undefined` triggers a `PARSING_ERROR`.
 * @returns The decoded number.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the value is missing or
 *   the ScVal type is not numeric.
 */
export function scValToNumber(val: xdr.ScVal | undefined): number {
  if (!val) throw new CoralSwapSDKError("PARSING_ERROR", "Missing field");
  const tag = val.switch().name;
  if (tag === 'scvU32') return Number(val.u32());
  if (tag === 'scvU64') return Number(val.u64().toBigInt());
  if (tag === 'scvI32') return val.i32();
  if (tag === 'scvI64') return Number(val.i64().toBigInt());
  throw new CoralSwapSDKError("PARSING_ERROR", `Expected number type, got ${tag}`);
}

/**
 * Extract an optional number from an `xdr.ScVal`.
 *
 * Returns `undefined` when the ScVal is missing or is `scvVoid`. Otherwise
 * delegates to {@link scValToNumber}.
 *
 * @param val - The ScVal to decode.
 * @returns The decoded number, or `undefined` for void / missing fields.
 */
export function scValToOptionalNumber(val: xdr.ScVal | undefined): number | undefined {
  if (!val) return undefined;
  if (val.switch().name === 'scvVoid') return undefined;
  return scValToNumber(val);
}

/**
 * Extract a `bigint` from an `xdr.ScVal`.
 *
 * Handles `scvI128` (two-part), `scvU64`, `scvI64`, `scvU32`, and `scvI32`.
 *
 * @param val - The ScVal to decode. `undefined` triggers a `PARSING_ERROR`.
 * @returns The decoded big integer.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the value is missing or
 *   the ScVal type is unsupported.
 */
export function scValToBigInt(val: xdr.ScVal | undefined): bigint {
  if (!val) throw new CoralSwapSDKError("PARSING_ERROR", "Missing field");
  const tag = val.switch().name;
  if (tag === 'scvI128') {
    const parts = val.i128();
    const lo = BigInt(parts.lo().toString());
    const hi = BigInt(parts.hi().toString());
    const loUnsigned = lo < 0n ? lo + (1n << 64n) : lo;
    return (hi << 64n) + loUnsigned;
  }
  if (tag === 'scvU64') return val.u64().toBigInt();
  if (tag === 'scvI64') return BigInt(val.i64().toBigInt());
  if (tag === 'scvU32') return BigInt(val.u32());
  if (tag === 'scvI32') return BigInt(val.i32());
  throw new CoralSwapSDKError("PARSING_ERROR", `Expected bigint type, got ${tag}`);
}

/**
 * Parse the ScVal result of a `cancel` contract call.
 *
 * Expects an `scvMap` with either snake_case or camelCase keys:
 * - `refunded_amount` / `refundedAmount`
 * - `filled_amount` / `filledAmount`
 *
 * @param result - The returned ScVal from the contract.
 * @returns Parsed refund and fill amounts.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the ScVal is not a map
 *   or required fields cannot be read.
 */
export function parseCancelResult(result: xdr.ScVal): { refundedAmount: bigint; filledAmount: bigint } {
  if (result.switch().name !== 'scvMap') {
    throw new CoralSwapSDKError("PARSING_ERROR", "Invalid cancel result: expected ScMap");
  }
  const map = result.map();
  if (!map) throw new CoralSwapSDKError("PARSING_ERROR", "Invalid cancel result: expected ScMap");

  const fields: Record<string, xdr.ScVal> = {};
  for (const entry of map) {
    const k = entry.key();
    const tag = k.switch().name;
    let keyStr = '';
    if (tag === 'scvString') keyStr = k.str().toString();
    else if (tag === 'scvSymbol') keyStr = k.sym().toString();
    else continue;
    fields[keyStr] = entry.val();
  }

  const refundedAmount = scValToBigInt(fields['refunded_amount'] ?? fields['refundedAmount']);
  const filledAmount = scValToBigInt(fields['filled_amount'] ?? fields['filledAmount']);

  return { refundedAmount, filledAmount };
}

/**
 * Parse the ScVal result of a `status` contract call.
 *
 * Expects an `scvMap` with these keys (snake_case or camelCase):
 * - `state` → string
 * - `fill_percent` / `fillPercent` → number (validated 0–100)
 * - `execution_price` / `executionPrice` → optional number
 * - `filled_at` / `filledAt` → optional number
 *
 * @param result - The returned ScVal from the contract.
 * @returns A parsed {@link OrderStatus} object.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the state string is
 *   unrecognised, `fillPercent` is outside 0–100, or the ScVal is not a map.
 */
export function parseOrderStatus(result: xdr.ScVal): OrderStatus {
  const map = result.map();
  if (!map) throw new CoralSwapSDKError("PARSING_ERROR", "Invalid order status: expected ScMap");

  const fields: Record<string, xdr.ScVal> = {};
  for (const entry of map) {
    const k = entry.key();
    const tag = k.switch().name;
    let keyStr = '';
    if (tag === 'scvString') keyStr = k.str().toString();
    else if (tag === 'scvSymbol') keyStr = k.sym().toString();
    else continue;
    fields[keyStr] = entry.val();
  }

  const stateStr = scValToString(fields['state']).toLowerCase();
  if (!['open', 'partial', 'filled', 'cancelled', 'expired'].includes(stateStr)) {
    throw new CoralSwapSDKError("PARSING_ERROR", `Invalid order state: ${stateStr}`);
  }

  const fillPercent = scValToNumber(fields['fill_percent'] ?? fields['fillPercent']);
  if (fillPercent < 0 || fillPercent > 100) {
    throw new CoralSwapSDKError("PARSING_ERROR", `Invalid fillPercent: ${fillPercent}`);
  }

  const executionPrice = scValToOptionalNumber(fields['execution_price'] ?? fields['executionPrice']);
  const filledAt = scValToOptionalNumber(fields['filled_at'] ?? fields['filledAt']);

  return {
    state: stateStr as LimitOrderState,
    fillPercent,
    executionPrice,
    filledAt,
  };
}

/**
 * Extract an array of strings from an `scvVec`.
 *
 * Each element is decoded via {@link scValToString}. An empty vector yields an empty array.
 *
 * @param val - The ScVal to decode. `undefined` triggers `PARSING_ERROR`.
 * @returns Array of decoded strings.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the value is missing or
 *   not an `scvVec`.
 */
export function scValToStringVec(val: xdr.ScVal | undefined): string[] {
  if (!val) throw new CoralSwapSDKError("PARSING_ERROR", "Missing field");
  if (val.switch().name !== 'scvVec') throw new CoralSwapSDKError("PARSING_ERROR", "Expected Vec");
  const vec = val.vec();
  if (!vec) return [];
  return vec.map((v) => scValToString(v));
}

/**
 * Parse the ScVal result of a `get_order` contract call.
 *
 * Extracts the full order details including state, fill information, timestamps,
 * and amounts. Keys may be snake_case or camelCase.
 *
 * @param result - The returned ScVal from the `get_order` contract call.
 * @returns A parsed {@link LimitOrderDetails} object.
 * @throws {@link CoralSwapSDKError} with code `PARSING_ERROR` if the result is not a map,
 *   the state is unrecognised, or `fillPercent` is outside 0–100.
 */
export function parseOrderDetails(result: xdr.ScVal): LimitOrderDetails {
  const map = result.map();
  if (!map) throw new CoralSwapSDKError("PARSING_ERROR", "Invalid order details: expected ScMap");

  const fields: Record<string, xdr.ScVal> = {};
  for (const entry of map) {
    const k = entry.key();
    const tag = k.switch().name;
    let keyStr = '';
    if (tag === 'scvString') keyStr = k.str().toString();
    else if (tag === 'scvSymbol') keyStr = k.sym().toString();
    else continue;
    fields[keyStr] = entry.val();
  }

  const id = scValToString(fields['id']);

  const stateStr = scValToString(fields['state']).toLowerCase();
  if (!['open', 'partial', 'filled', 'cancelled', 'expired'].includes(stateStr)) {
    throw new CoralSwapSDKError("PARSING_ERROR", `Invalid order state: ${stateStr}`);
  }

  const fillPercent = scValToNumber(fields['fill_percent'] ?? fields['fillPercent']);
  if (fillPercent < 0 || fillPercent > 100) {
    throw new CoralSwapSDKError("PARSING_ERROR", `Invalid fillPercent: ${fillPercent}`);
  }

  const executionPrice = scValToOptionalNumber(fields['execution_price'] ?? fields['executionPrice']);
  const filledAt = scValToOptionalNumber(fields['filled_at'] ?? fields['filledAt']);
  const amountFilled = scValToBigInt(fields['amount_filled'] ?? fields['amountFilled']);
  const amountRemaining = scValToBigInt(fields['amount_remaining'] ?? fields['amountRemaining']);
  const createdAt = scValToNumber(fields['created_at'] ?? fields['createdAt']);

  return {
    id,
    status: {
      state: stateStr as LimitOrderState,
      fillPercent,
      executionPrice,
      filledAt,
    },
    amountFilled,
    amountRemaining,
    createdAt,
  };
}

/**
 * High-level interface for CoralSwap limit orders.
 *
 * Provides methods to place, query, monitor, and cancel limit orders on the
 * CoralSwap decentralised exchange.
 *
 * Instances are **not** created directly — access via
 * `coralSwapSdk.modules.limitOrders`.
 *
 * @example
 * const sdk = new CoralSwapSDK({ ... });
 * const limit = sdk.modules.limitOrders;
 * const { orderId } = await limit.placeLimitOrder({ ... });
 */
export class LimitOrderModule {
  private client: CoralSwapClient;
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private retryOptions: RetryOptions;

  /**
   * @internal
   * @param client - Initialised CoralSwap client.
   * @param contractAddress - Optional override for the limit-order contract address.
   *   When omitted, `client.networkConfig.limitOrderAddress` is used.
   * @throws {@link ValidationError} if `client` is invalid.
   * @throws {@link CoralSwapSDKError} with code `VALIDATION_ERROR` if no contract address
   *   is available from either the parameter or the network config.
   */
  constructor(
    client: CoralSwapClient,
    contractAddress?: string,
  ) {
    if (!client || typeof client !== 'object') {
      throw new ValidationError('client must be a valid CoralSwapClient instance');
    }
    if (contractAddress !== undefined) {
      validateAddress(contractAddress, 'contractAddress');
    }
    this.client = client;
    const address = contractAddress ?? client.networkConfig.limitOrderAddress;
    if (!address) {
      throw new CoralSwapSDKError(
        "VALIDATION_ERROR",
        'Limit order contract address is required. Provide one in the constructor or configure limitOrderAddress in the network config.',
      );
    }
    this.contract = new Contract(address);
    this.server = client.server;
    this.networkPassphrase = client.networkConfig.networkPassphrase;
    this.retryOptions = {
      maxRetries: client.config.maxRetries ?? 3,
      retryDelayMs: client.config.retryDelayMs ?? 1000,
      maxRetryDelayMs: client.config.maxRetryDelayMs ?? 30000,
    };
  }

  /**
   * Retrieve the current status of a limit order.
   *
   * Simulates a `status` call against the on-chain contract. Use this for a
   * one-shot check or pair with {@link watchOrder} for polling.
   *
   * @param orderId - The on-chain order ID returned by {@link placeLimitOrder}.
   * @returns The order's current {@link OrderStatus}.
   * @throws {@link ValidationError} if `orderId` is empty or not a string.
   * @throws {@link CoralSwapSDKError} with code `SIMULATION_ERROR` if the simulation fails.
   *
   * @example
   * const status = await limit.getLimitOrderStatus(orderId);
   * if (status.state === 'filled') {
   *   console.log(`Filled at ${status.executionPrice}`);
   * }
   */
  async getLimitOrderStatus(orderId: string): Promise<OrderStatus> {
    if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw new ValidationError('orderId must be a non-empty string', { orderId });
    }

    const op = this.contract.call(
      'status',
      nativeToScVal(orderId, { type: 'string' }),
    );

    const source = this.client.publicKey;
    const account = await withRetry(
      () => this.server.getAccount(source),
      this.retryOptions,
      undefined,
      'LimitOrderModule_getAccount',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      undefined,
      'LimitOrderModule_simulate',
    );

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new CoralSwapSDKError("SIMULATION_ERROR", `Failed to read order status: simulation did not succeed`);
    }

    return parseOrderStatus(sim.result.retval);
  }

  /**
   * Poll an order's status at a regular interval and invoke a callback.
   *
   * Errors during polling are silently caught — the callback is only invoked
   * on successful fetches. The returned unsubscribe function stops the polling
   * loop and clears the timer.
   *
   * @param orderId - The on-chain order ID to watch.
   * @param callback - Function called on every successful poll with the latest
   *   {@link OrderStatus}. Callback errors are **not** caught.
   * @param intervalMs - Polling interval in milliseconds (default `5000`). Must be
   *   a positive finite number.
   * @returns An unsubscribe function that stops polling. Idempotent.
   * @throws {@link ValidationError} if `orderId` is empty, `callback` is not a
   *   function, or `intervalMs` is invalid.
   *
   * @example
   * const unwatch = limit.watchOrder(orderId, (status) => {
   *   console.log(status.state, status.fillPercent);
   *   if (status.state === 'filled' || status.state === 'cancelled') {
   *     unwatch();
   *   }
   * }, 2000);
   *
   * // Later:
   * unwatch();
   */
  watchOrder(
    orderId: string,
    callback: (status: OrderStatus) => void,
    intervalMs?: number,
  ): () => void {
    if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw new ValidationError('orderId must be a non-empty string', { orderId });
    }
    if (typeof callback !== 'function') {
      throw new ValidationError('callback must be a function');
    }
    if (intervalMs !== undefined && (typeof intervalMs !== 'number' || isNaN(intervalMs) || !isFinite(intervalMs) || intervalMs <= 0)) {
      throw new ValidationError('intervalMs must be a positive number', { intervalMs });
    }
    const interval = intervalMs ?? 5000;
    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const status = await this.getLimitOrderStatus(orderId);
        if (!active) return;
        callback(status);
      } catch {
      }
    };

    poll();

    const timer = setInterval(poll, interval);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }

  /**
   * Cancel an open or partially filled limit order.
   *
   * The unfilled portion is refunded to the order creator. Cancelling an already
   * filled, cancelled, or expired order throws.
   *
   * @param orderId - The on-chain order ID to cancel.
   * @param signer - Optional Stellar address that will sign the cancellation.
   *   Defaults to `client.publicKey`.
   * @returns A {@link CancelResult} with refund and fill amounts plus the
   *   transaction hash.
   * @throws {@link ValidationError} if `orderId` is empty or `signer` is malformed.
   * @throws {@link OrderNotFoundError} if the order is already cancelled.
   * @throws {@link InvalidOperationError} if the order is filled or expired.
   * @throws {@link CoralSwapSDKError} with code `SIMULATION_ERROR` if simulation fails.
   * @throws {@link CoralSwapSDKError} with code `TRANSACTION_ERROR` if submission fails.
   *
   * @example
   * try {
   *   const result = await limit.cancelLimitOrder(orderId);
   *   console.log(`Refunded ${result.refundedAmount}, tx: ${result.refundTxHash}`);
   * } catch (err) {
   *   if (err instanceof InvalidOperationError) {
   *     console.log('Order cannot be cancelled in its current state');
   *   }
   * }
   */
  async cancelLimitOrder(orderId: string, signer?: string): Promise<CancelResult> {
    if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw new ValidationError('orderId must be a non-empty string', { orderId });
    }
    if (signer !== undefined) {
      validateAddress(signer, 'signer');
    }

    const status = await this.getLimitOrderStatus(orderId);

    if (status.state === 'cancelled') {
      throw new OrderNotFoundError(orderId);
    }

    if (status.state === 'filled') {
      throw new InvalidOperationError(`Order ${orderId} is already filled`);
    }

    if (status.state === 'expired') {
      throw new InvalidOperationError(`Order ${orderId} has expired`);
    }

    const cancelSigner = signer ?? this.client.publicKey;

    const op = this.contract.call(
      'cancel',
      nativeToScVal(orderId, { type: 'string' }),
      nativeToScVal(cancelSigner, { type: 'address' }),
    );

    const source = this.client.publicKey;
    const account = await withRetry(
      () => this.server.getAccount(source),
      this.retryOptions,
      undefined,
      'LimitOrderModule_cancel_getAccount',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      undefined,
      'LimitOrderModule_cancel_simulate',
    );

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new CoralSwapSDKError(
        "SIMULATION_ERROR",
        `Failed to cancel order ${orderId}: simulation did not succeed`,
      );
    }

    const { refundedAmount, filledAmount } = parseCancelResult(sim.result.retval);

    const submitResult = await this.client.submitTransaction([op]);

    if (!submitResult.success || !submitResult.data) {
      throw new CoralSwapSDKError(
        "TRANSACTION_ERROR",
        `Failed to cancel order ${orderId}: ${submitResult.error?.message ?? 'Unknown error'}`,
      );
    }

    return {
      refundedAmount,
      filledAmount,
      refundTxHash: submitResult.data.txHash,
    };
  }

  /**
   * Place a new limit order.
   *
   * Submits a `create_order` transaction after validating all parameters.
   * The order starts in the **open** state and will be matched when the market
   * reaches `targetPrice`.
   *
   * @param params - {@link LimitOrderParams} describing the order.
   * @param signer - Optional Stellar address that will sign the order.
   *   Defaults to `client.publicKey`.
   * @returns A {@link PlaceLimitOrderResult} containing the new order ID.
   * @throws {@link ValidationError} if any parameter is invalid (bad address,
   *   non-positive amount, same token in/out, out-of-range target price,
   *   past expiry, mismatched pair address, etc.).
   * @throws {@link CoralSwapSDKError} with code `SIMULATION_ERROR` if simulation fails.
   * @throws {@link CoralSwapSDKError} with code `TRANSACTION_ERROR` if submission fails.
   *
   * @example
   * const { orderId } = await limit.placeLimitOrder({
   *   tokenIn: 'CAXFG3HY6H...',
   *   tokenOut: 'CBOB7D2F5...',
   *   amountIn: 500_000_000n,
   *   targetPrice: 1.25,
   *   expiry: Math.floor(Date.now() / 1000) + 3600 * 24,
   *   pairAddress: 'CP5KJ7A2E...',
   * });
   * console.log('Placed order:', orderId);
   */
  async placeLimitOrder(params: LimitOrderParams, signer?: string): Promise<PlaceLimitOrderResult> {
    if (!params || typeof params !== 'object') {
      throw new ValidationError('params must be a valid object');
    }
    if (typeof params.targetPrice !== 'number' || isNaN(params.targetPrice) || !isFinite(params.targetPrice) || params.targetPrice <= 0) {
      throw new ValidationError('targetPrice must be positive', { targetPrice: params.targetPrice });
    }
    if (params.targetPrice > 1_000_000) {
      throw new ValidationError('targetPrice exceeds maximum allowed range (1,000,000)', {
        targetPrice: params.targetPrice,
      });
    }
    if (typeof params.expiry !== 'number' || isNaN(params.expiry) || !isFinite(params.expiry) || params.expiry <= Math.floor(Date.now() / 1000)) {
      throw new ValidationError('expiry must be a Unix timestamp in the future', {
        expiry: params.expiry,
      });
    }

    validateAddress(params.tokenIn, 'tokenIn');
    validateAddress(params.tokenOut, 'tokenOut');
    validateDistinctTokens(params.tokenIn, params.tokenOut);
    validateAddress(params.pairAddress, 'pairAddress');
    validatePositiveAmount(params.amountIn, 'amountIn');

    if (signer !== undefined) {
      validateAddress(signer, 'signer');
    }

    if (typeof this.client.getPairAddress === 'function') {
      const onChainPair = await this.client.getPairAddress(params.tokenIn, params.tokenOut);
      if (!onChainPair || onChainPair !== params.pairAddress) {
        throw new ValidationError(
          `Pair address ${params.pairAddress} does not exist on-chain or does not match tokens ${params.tokenIn} and ${params.tokenOut}`,
          { pairAddress: params.pairAddress, tokenIn: params.tokenIn, tokenOut: params.tokenOut, onChainPair },
        );
      }
    }

    const orderSigner = signer ?? this.client.publicKey;

    const op = this.contract.call(
      'create_order',
      nativeToScVal(params.tokenIn, { type: 'address' }),
      nativeToScVal(params.tokenOut, { type: 'address' }),
      nativeToScVal(params.amountIn, { type: 'i128' }),
      xdr.ScVal.scvString(String(params.targetPrice)),
      nativeToScVal(params.expiry, { type: 'u64' }),
      nativeToScVal(params.pairAddress, { type: 'address' }),
      nativeToScVal(orderSigner, { type: 'address' }),
    );

    const source = this.client.publicKey;
    const account = await withRetry(
      () => this.server.getAccount(source),
      this.retryOptions,
      undefined,
      'LimitOrderModule_place_getAccount',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      undefined,
      'LimitOrderModule_place_simulate',
    );

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new CoralSwapSDKError("SIMULATION_ERROR", 'Failed to place limit order: simulation did not succeed');
    }

    const orderId = scValToString(sim.result.retval);

    const submitResult = await this.client.submitTransaction([op]);

    if (!submitResult.success || !submitResult.data) {
      throw new CoralSwapSDKError(
        "TRANSACTION_ERROR",
        `Failed to place limit order: ${submitResult.error?.message ?? 'Unknown error'}`,
      );
    }

    return { orderId };
  }

  /**
   * Retrieve full details of a limit order.
   *
   * Includes the order ID, current status, fill amounts, and creation timestamp.
   *
   * @param orderId - The on-chain order ID.
   * @returns Full {@link LimitOrderDetails} for the order.
   * @throws {@link ValidationError} if `orderId` is empty or not a string.
   * @throws {@link CoralSwapSDKError} with code `SIMULATION_ERROR` if the
   *   simulation fails.
   *
   * @example
   * const details = await limit.getLimitOrder(orderId);
   * console.log(`Created: ${new Date(details.createdAt * 1000).toISOString()}`);
   * console.log(`Filled: ${details.amountFilled} / Remaining: ${details.amountRemaining}`);
   */
  async getLimitOrder(orderId: string): Promise<LimitOrderDetails> {
    if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
      throw new ValidationError('orderId must be a non-empty string', { orderId });
    }

    const op = this.contract.call(
      'get_order',
      nativeToScVal(orderId, { type: 'string' }),
    );

    const source = this.client.publicKey;
    const account = await withRetry(
      () => this.server.getAccount(source),
      this.retryOptions,
      undefined,
      'LimitOrderModule_getOrder_getAccount',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      undefined,
      'LimitOrderModule_getOrder_simulate',
    );

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new CoralSwapSDKError("SIMULATION_ERROR", `Failed to read order ${orderId}: simulation did not succeed`);
    }

    return parseOrderDetails(sim.result.retval);
  }

  /**
   * List all open and partially filled orders for a user address.
   *
   * Fetches order IDs from `orders_for_user`, then resolves each to full
   * {@link LimitOrderDetails}. Only orders in **open** or **partial** state
   * are returned — filled, cancelled, and expired orders are excluded.
   *
   * @param address - Stellar address to query.
   * @returns Array of active {@link LimitOrderDetails}.
   * @throws {@link ValidationError} if `address` is malformed.
   * @throws {@link CoralSwapSDKError} with code `SIMULATION_ERROR` if the
   *   simulation fails for the user query or any sub-order fetch.
   *
   * @example
   * const openOrders = await limit.getOpenOrders('GA...');
   * for (const order of openOrders) {
   *   console.log(`Order ${order.id}: ${order.status.state} ${order.status.fillPercent}%`);
   * }
   */
  async getOpenOrders(address: string): Promise<LimitOrderDetails[]> {
    validateAddress(address, 'address');

    const op = this.contract.call(
      'orders_for_user',
      nativeToScVal(address, { type: 'address' }),
    );

    const source = this.client.publicKey;
    const account = await withRetry(
      () => this.server.getAccount(source),
      this.retryOptions,
      undefined,
      'LimitOrderModule_openOrders_getAccount',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      undefined,
      'LimitOrderModule_openOrders_simulate',
    );

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      throw new CoralSwapSDKError("SIMULATION_ERROR", `Failed to fetch orders for ${address}: simulation did not succeed`);
    }

    const orderIds = scValToStringVec(sim.result.retval);

    const orders = await Promise.all(
      orderIds.map((id) => this.getLimitOrder(id)),
    );

    return orders.filter(
      (o) => o.status.state === 'open' || o.status.state === 'partial',
    );
  }
}
