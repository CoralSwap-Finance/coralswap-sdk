import { CoralSwapSDKError, mapContractError } from "./errors";
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
export function scValToString(val: xdr.ScVal | undefined): string {
  if (!val) throw new CoralSwapSDKError("Missing field");
  const tag = val.switch().name;
  if (tag === 'scvString') return val.str().toString();
  if (tag === 'scvSymbol') return val.sym().toString();
  if (tag === 'scvBytes') return Buffer.from(val.bytes()).toString('utf8');
  throw new CoralSwapSDKError(`Expected string/symbol/bytes, got ${tag}`);
}

export function scValToNumber(val: xdr.ScVal | undefined): number {
  if (!val) throw new CoralSwapSDKError("Missing field");
  const tag = val.switch().name;
  if (tag === 'scvU32') return Number(val.u32());
  if (tag === 'scvU64') return Number(val.u64().toBigInt());
  if (tag === 'scvI32') return val.i32();
  if (tag === 'scvI64') return Number(val.i64().toBigInt());
  throw new CoralSwapSDKError(`Expected number type, got ${tag}`);
}

export function scValToOptionalNumber(val: xdr.ScVal | undefined): number | undefined {
  if (!val) return undefined;
  if (val.switch().name === 'scvVoid') return undefined;
  return scValToNumber(val);
}

export function scValToBigInt(val: xdr.ScVal | undefined): bigint {
  if (!val) throw new CoralSwapSDKError("Missing field");
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
  throw new CoralSwapSDKError(`Expected bigint type, got ${tag}`);
}

export function parseCancelResult(result: xdr.ScVal): { refundedAmount: bigint; filledAmount: bigint } {
  if (result.switch().name !== 'scvMap') {
    throw new CoralSwapSDKError("Invalid cancel result: expected ScMap");
  }
  const map = result.map();
  if (!map) throw new CoralSwapSDKError("Invalid cancel result: expected ScMap");

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

export function parseOrderStatus(result: xdr.ScVal): OrderStatus {
  const map = result.map();
  if (!map) throw new CoralSwapSDKError("Invalid order status: expected ScMap");

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
    throw new CoralSwapSDKError(`Invalid order state: ${stateStr}`);
  }

  const fillPercent = scValToNumber(fields['fill_percent'] ?? fields['fillPercent']);
  if (fillPercent < 0 || fillPercent > 100) {
    throw new CoralSwapSDKError(`Invalid fillPercent: ${fillPercent}`);
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

export function scValToStringVec(val: xdr.ScVal | undefined): string[] {
  if (!val) throw new CoralSwapSDKError("Missing field");
  if (val.switch().name !== 'scvVec') throw new CoralSwapSDKError("Expected Vec");
  const vec = val.vec();
  if (!vec) return [];
  return vec.map((v) => scValToString(v));
}

export function parseOrderDetails(result: xdr.ScVal): LimitOrderDetails {
  const map = result.map();
  if (!map) throw new CoralSwapSDKError("Invalid order details: expected ScMap");

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
    throw new CoralSwapSDKError(`Invalid order state: ${stateStr}`);
  }

  const fillPercent = scValToNumber(fields['fill_percent'] ?? fields['fillPercent']);
  if (fillPercent < 0 || fillPercent > 100) {
    throw new CoralSwapSDKError(`Invalid fillPercent: ${fillPercent}`);
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

export class LimitOrderModule {
  private client: CoralSwapClient;
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private retryOptions: RetryOptions;

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
      throw new CoralSwapSDKError(`Failed to read order status: simulation did not succeed`);
    }

    return parseOrderStatus(sim.result.retval);
  }

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
        `Failed to cancel order ${orderId}: simulation did not succeed`,
      );
    }

    const { refundedAmount, filledAmount } = parseCancelResult(sim.result.retval);

    const submitResult = await this.client.submitTransaction([op]);

    if (!submitResult.success || !submitResult.data) {
      throw new CoralSwapSDKError(
        `Failed to cancel order ${orderId}: ${submitResult.error?.message ?? 'Unknown error'}`,
      );
    }

    return {
      refundedAmount,
      filledAmount,
      refundTxHash: submitResult.data.txHash,
    };
  }

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
      throw new CoralSwapSDKError('Failed to place limit order: simulation did not succeed');
    }

    const orderId = scValToString(sim.result.retval);

    const submitResult = await this.client.submitTransaction([op]);

    if (!submitResult.success || !submitResult.data) {
      throw new CoralSwapSDKError(
        `Failed to place limit order: ${submitResult.error?.message ?? 'Unknown error'}`,
      );
    }

    return { orderId };
  }

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
      throw new CoralSwapSDKError(`Failed to read order ${orderId}: simulation did not succeed`);
    }

    return parseOrderDetails(sim.result.retval);
  }

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
      throw new CoralSwapSDKError(`Failed to fetch orders for ${address}: simulation did not succeed`);
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
