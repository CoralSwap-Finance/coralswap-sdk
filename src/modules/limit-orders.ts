import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  xdr,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import { OrderStatus, LimitOrderState } from '@/types/limit-orders';
import { withRetry, RetryOptions } from '@/utils/retry';
export function scValToString(val: xdr.ScVal | undefined): string {
  if (!val) throw new Error("Missing field");
  const tag = val.switch().name;
  if (tag === 'scvString') return val.str().toString();
  if (tag === 'scvSymbol') return val.sym().toString();
  if (tag === 'scvBytes') return Buffer.from(val.bytes()).toString('utf8');
  throw new Error(`Expected string/symbol/bytes, got ${tag}`);
}

export function scValToNumber(val: xdr.ScVal | undefined): number {
  if (!val) throw new Error("Missing field");
  const tag = val.switch().name;
  if (tag === 'scvU32') return Number(val.u32());
  if (tag === 'scvU64') return Number(val.u64().toBigInt());
  if (tag === 'scvI32') return val.i32();
  if (tag === 'scvI64') return Number(val.i64().toBigInt());
  throw new Error(`Expected number type, got ${tag}`);
}

export function scValToOptionalNumber(val: xdr.ScVal | undefined): number | undefined {
  if (!val) return undefined;
  if (val.switch().name === 'scvVoid') return undefined;
  return scValToNumber(val);
}

export function parseOrderStatus(result: xdr.ScVal): OrderStatus {
  const map = result.map();
  if (!map) throw new Error("Invalid order status: expected ScMap");

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
    throw new Error(`Invalid order state: ${stateStr}`);
  }

  const fillPercent = scValToNumber(fields['fill_percent'] ?? fields['fillPercent']);
  if (fillPercent < 0 || fillPercent > 100) {
    throw new Error(`Invalid fillPercent: ${fillPercent}`);
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
    this.client = client;
    const address = contractAddress ?? client.networkConfig.limitOrderAddress;
    if (!address) {
      throw new Error(
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
    if (!orderId || typeof orderId !== 'string') {
      throw new Error('orderId must be a non-empty string');
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
      throw new Error(`Failed to read order status: simulation did not succeed`);
    }

    return parseOrderStatus(sim.result.retval);
  }

  watchOrder(
    orderId: string,
    callback: (status: OrderStatus) => void,
    intervalMs?: number,
  ): () => void {
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
}
