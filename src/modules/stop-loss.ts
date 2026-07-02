import { CoralSwapClient } from '@/client';
import {
  StopLossParams,
  StopLossOrder,
  StopLossOrderQuery,
  StopLossStatus,
} from '@/types/stop-loss';
import { Signer } from '@/types/common';
import { GasEstimate } from '@/types/gas';
import {
  ValidationError,
  TransactionError,
  StaleOracleError,
} from '@/errors';
import {
  validateAddress,
  validatePositiveAmount,
  validateDistinctTokens,
} from '@/utils/validation';
import { estimateGas } from '@/utils/gas';
import {
  Contract,
  nativeToScVal,
  Address,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

type DecodedStopLossOrder = Omit<StopLossOrder, 'currentPrice' | 'triggered' | 'distancePercent'>;

interface OraclePriceSnapshot {
  price: bigint;
  timestamp?: number;
}

interface TriggerEvaluationOptions {
  staleAfterMs?: number;
}

/**
 * Stop-Loss module — automated stop-loss orders with RedStone trigger detection.
 *
 * Creates and inspects stop-loss orders that sell a position once the
 * RedStone-reported market price falls to or below a trigger price. Using an
 * external oracle (rather than the pool's spot price) makes the trigger
 * resistant to single-pool price manipulation.
 *
 * @example
 * const stopLoss = new StopLossModule(client, MANAGER_ADDRESS, REDSTONE_ORACLE);
 * const id = await stopLoss.createStopLoss(params, signer);
 */
export class StopLossModule {
  private readonly client: CoralSwapClient;
  private readonly contractAddress: string;
  private readonly oracleAddress: string;

  /**
   * @param client - Configured CoralSwap client
   * @param contractAddress - Address of the stop-loss manager contract
   * @param oracleAddress - Address of the RedStone price-feed oracle contract
   */
  constructor(
    client: CoralSwapClient,
    contractAddress: string,
    oracleAddress: string,
  ) {
    this.client = client;
    this.contractAddress = contractAddress;
    this.oracleAddress = oracleAddress;
  }

  // ---------------------------------------------------------------------------
  // Write operations (require signing)
  // ---------------------------------------------------------------------------

  /**
   * Create a stop-loss order.
   *
   * The current market price is read from the RedStone feed and the trigger
   * price is required to be strictly below it — a stop-loss above market would
   * fire immediately and is rejected.
   *
   * @param params - Order parameters (tokens, amount, trigger, pair, feed)
   * @param signer - Wallet signer that owns and authorises the order
   * @returns The unique order ID assigned by the contract
   * @throws {ValidationError} If addresses are invalid, tokens are identical,
   *   the amount or trigger price is non-positive, the oracle asset is empty,
   *   or the trigger price is not below the current market price
   * @throws {TransactionError} If the transaction is rejected on-chain
   */
  async createStopLoss(params: StopLossParams, signer: Signer): Promise<string> {
    this.validateStopLossParams(params);

    const currentPrice = await this.getOraclePrice(params.oracleAsset);
    if (params.triggerPrice >= currentPrice.price) {
      throw new ValidationError(
        'triggerPrice must be below the current market price',
        {
          triggerPrice: params.triggerPrice.toString(),
          currentPrice: currentPrice.price.toString(),
        },
      );
    }

    const signerPublicKey = await signer.publicKey();
    const contract = new Contract(this.contractAddress);

    const op = contract.call(
      'create_stop_loss',
      new Address(params.tokenIn).toScVal(),
      new Address(params.tokenOut).toScVal(),
      nativeToScVal(params.amount, { type: 'i128' }),
      nativeToScVal(params.triggerPrice, { type: 'i128' }),
      new Address(params.pairAddress).toScVal(),
      nativeToScVal(params.oracleAsset, { type: 'symbol' }),
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `createStopLoss failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
      );
    }

    return result.txHash!;
  }

  /**
   * Estimate the network fee for creating a stop-loss order without submitting.
   *
   * The operation validates the order and simulates the create transaction. When
   * a multi-hop path is provided, an extra view operation is included so route
   * pricing contributes to the fee estimate.
   */
  async estimateStopLossGas(
    params: StopLossParams,
    options?: { route?: string[] },
  ): Promise<GasEstimate> {
    this.validateStopLossParams(params);

    const contract = new Contract(this.contractAddress);
    const ops = [
      contract.call(
        'create_stop_loss',
        new Address(params.tokenIn).toScVal(),
        new Address(params.tokenOut).toScVal(),
        nativeToScVal(params.amount, { type: 'i128' }),
        nativeToScVal(params.triggerPrice, { type: 'i128' }),
        new Address(params.pairAddress).toScVal(),
        nativeToScVal(params.oracleAsset, { type: 'symbol' }),
        new Address(this.client.publicKey).toScVal(),
      ),
    ];

    if (options?.route && options.route.length > 2) {
      this.validateRoute(options.route);
      ops.push(
        contract.call(
          'quote_stop_loss_path',
          xdr.ScVal.scvVec(
            options.route.map((token) => new Address(token).toScVal()),
          ),
          nativeToScVal(params.amount, { type: 'i128' }),
        ),
      );
    }

    return estimateGas(
      (operations) => this.client.simulateTransaction(operations, {}),
      ops,
    );
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  /**
   * Fetch a stop-loss order and evaluate its trigger condition against the
   * latest RedStone price.
   *
   * @param orderId - Unique order identifier
   * @returns The order state plus the live `currentPrice` and `triggered` flag
   * @throws {ValidationError} If `orderId` is empty or no order exists
   */
  async getStopLoss(orderId: string): Promise<StopLossOrder> {
    if (!orderId || orderId.trim().length === 0) {
      throw new ValidationError('orderId must not be empty');
    }

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'get_order',
      nativeToScVal(orderId, { type: 'string' }),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      throw new ValidationError('Stop-loss order not found', { orderId });
    }

    const order = this.decodeOrder(sim.returnValue);
    return this.enrichOrder(order);
  }

  /**
   * Fetch a user's stop-loss orders, enrich them with live trigger state, then
   * filter and sort the results.
   */
  async getStopLossOrders(
    address: string,
    query: StopLossOrderQuery = {},
  ): Promise<StopLossOrder[]> {
    validateAddress(address, 'address');

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'orders_for_user',
      new Address(address).toScVal(),
    );

    const sim = await this.client.simulateTransaction([op], {});
    if (!sim.success || !sim.returnValue) {
      return [];
    }

    const native = scValToNative(sim.returnValue);
    const rawOrders = Array.isArray(native) ? native : [];
    const enriched = await Promise.all(
      rawOrders.map((item) =>
        this.enrichOrder(this.decodeOrder(nativeToScVal(item))),
      ),
    );

    return this.applyOrderQuery(enriched, query);
  }

  /**
   * Evaluate whether an order should currently trigger using the latest oracle
   * reading. Rejects stale oracle data when a staleness threshold is provided.
   */
  async isStopLossTriggered(
    order: Pick<StopLossOrder, 'triggerPrice' | 'oracleAsset'>,
    options: TriggerEvaluationOptions = {},
  ): Promise<boolean> {
    const snapshot = await this.getOraclePrice(order.oracleAsset);
    this.assertOracleFresh(snapshot, order.oracleAsset, options.staleAfterMs);
    return snapshot.price <= order.triggerPrice;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private validateStopLossParams(params: StopLossParams): void {
    validateAddress(params.tokenIn, 'tokenIn');
    validateAddress(params.tokenOut, 'tokenOut');
    validateAddress(params.pairAddress, 'pairAddress');
    validateDistinctTokens(params.tokenIn, params.tokenOut);
    validatePositiveAmount(params.amount, 'amount');
    validatePositiveAmount(params.triggerPrice, 'triggerPrice');

    if (!params.oracleAsset || params.oracleAsset.trim().length === 0) {
      throw new ValidationError('oracleAsset must not be empty');
    }
  }

  private validateRoute(route: string[]): void {
    if (route.length < 2) {
      throw new ValidationError('route must contain at least two tokens');
    }

    for (const [index, token] of route.entries()) {
      validateAddress(token, `route[${index}]`);
    }
  }

  private async enrichOrder(order: DecodedStopLossOrder): Promise<StopLossOrder> {
    const snapshot = await this.getOraclePrice(order.oracleAsset);
    const distancePercent =
      order.triggerPrice > 0n
        ? Number(
            ((snapshot.price - order.triggerPrice) * 100n) / order.triggerPrice
          )
        : 0;
    return {
      ...order,
      currentPrice: snapshot.price,
      triggered: snapshot.price <= order.triggerPrice,
      distancePercent,
    };
  }

  /**
   * Read the current price for an asset from the RedStone oracle contract.
   *
   * @param asset - RedStone feed identifier (asset symbol)
   * @returns Current price in the oracle's fixed-point scale
   * @throws {ValidationError} If the oracle returns no price for the asset
   */
  private async getOraclePrice(asset: string): Promise<OraclePriceSnapshot> {
    const oracle = new Contract(this.oracleAddress);
    const op = oracle.call(
      'get_price',
      nativeToScVal(asset, { type: 'symbol' }),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      throw new ValidationError(
        `RedStone oracle returned no price for asset ${asset}`,
        { asset },
      );
    }

    const native = scValToNative(sim.returnValue);
    if (
      native &&
      typeof native === 'object' &&
      'price' in (native as Record<string, unknown>)
    ) {
      const record = native as Record<string, unknown>;
      return {
        price: BigInt(String(record['price'] ?? '0')),
        timestamp:
          record['timestamp'] === undefined
            ? undefined
            : Number(record['timestamp']),
      };
    }

    return {
      price: BigInt(String(native)),
    };
  }

  private assertOracleFresh(
    snapshot: OraclePriceSnapshot,
    asset: string,
    staleAfterMs?: number,
  ): void {
    if (staleAfterMs === undefined || snapshot.timestamp === undefined) {
      return;
    }

    const ageMs = Date.now() - snapshot.timestamp;
    if (ageMs > staleAfterMs) {
      throw new StaleOracleError(asset, snapshot.timestamp, staleAfterMs);
    }
  }

  private applyOrderQuery(
    orders: StopLossOrder[],
    query: StopLossOrderQuery,
  ): StopLossOrder[] {
    const {
      statuses,
      triggered,
      sortBy = 'createdAt',
      sortDirection = 'desc',
    } = query;

    let filtered = orders;

    if (statuses && statuses.length > 0) {
      filtered = filtered.filter((order) => statuses.includes(order.status));
    }

    if (triggered !== undefined) {
      filtered = filtered.filter((order) => order.triggered === triggered);
    }

    const direction = sortDirection === 'asc' ? 1 : -1;
    filtered = [...filtered].sort((left, right) => {
      let leftValue: bigint | number;
      let rightValue: bigint | number;

      if (sortBy === 'triggerPrice') {
        leftValue = left.triggerPrice;
        rightValue = right.triggerPrice;
      } else if (sortBy === 'distancePercent') {
        leftValue = left.distancePercent;
        rightValue = right.distancePercent;
      } else {
        leftValue = BigInt(left.createdAt ?? 0);
        rightValue = BigInt(right.createdAt ?? 0);
      }

      if (leftValue === rightValue) return 0;
      return leftValue > rightValue ? direction : -direction;
    });

    return filtered;
  }

  private decodeOrder(val: xdr.ScVal): DecodedStopLossOrder {
    const native = scValToNative(val) as Record<string, unknown>;

    return {
      id: String(native['id'] ?? ''),
      owner: String(native['owner'] ?? ''),
      tokenIn: String(native['token_in'] ?? ''),
      tokenOut: String(native['token_out'] ?? ''),
      amount: BigInt(String(native['amount'] ?? '0')),
      triggerPrice: BigInt(String(native['trigger_price'] ?? '0')),
      createdAt:
        native['created_at'] === undefined
          ? undefined
          : Number(native['created_at']),
      oracleAsset: String(native['oracle_asset'] ?? ''),
      status: (native['status'] as StopLossStatus) ?? 'active',
    };
  }
}
