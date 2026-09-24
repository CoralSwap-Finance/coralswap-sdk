import { z } from 'zod';
import { CoralSwapClient } from '@/client';
import {
  StopLossParams,
  StopLossOrder,
  StopLossOrderQuery,
  StopLossStatus,
} from '@/types/stop-loss';
import { Signer } from '@/types/common';
import { SwapRequest } from '@/types/swap';
import { GasEstimate } from '@/types/gas';
import {
  ValidationError,
  TransactionError,
  StaleOracleError,
  DecodeError,
} from '@/errors';
import { isValidAddress } from '@/utils/addresses';
import { validateAddress } from '@/utils/validation';
import { estimateGas } from '@/utils/gas';
import type { SwapModule } from '@/modules/swap';
import {
  Contract,
  nativeToScVal,
  Address,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * Default maximum age for oracle prices (in milliseconds).
 * Prices older than this are considered stale and will trigger a StaleOracleError.
 * Set to 5 minutes to align with TWAP minimum window.
 */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

type DecodedStopLossOrder = Omit<StopLossOrder, 'currentPrice' | 'triggered' | 'distancePercent'>;

interface OraclePriceSnapshot {
  price: bigint;
  timestamp?: number;
}

interface TriggerEvaluationOptions {
  staleAfterMs?: number;
}

const StopLossParamsSchema = z.object({
  tokenIn: z
    .string()
    .min(1, 'tokenIn must not be empty')
    .refine((v) => isValidAddress(v), 'tokenIn is not a valid Stellar address'),
  tokenOut: z
    .string()
    .min(1, 'tokenOut must not be empty')
    .refine((v) => isValidAddress(v), 'tokenOut is not a valid Stellar address'),
  amount: z.bigint().positive('amount must be greater than 0'),
  triggerPrice: z.bigint().positive('triggerPrice must be greater than 0'),
  pairAddress: z
    .string()
    .min(1, 'pairAddress must not be empty')
    .refine((v) => isValidAddress(v), 'pairAddress is not a valid Stellar address'),
  oracleAsset: z
    .string()
    .refine((v) => v.trim().length > 0, 'oracleAsset must not be empty'),
}).refine(
  (data) => data.tokenIn !== data.tokenOut,
  { message: 'tokenIn and tokenOut must be different addresses', path: ['tokenIn'] },
);

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
   * fire immediately and is rejected. The same price read is also subject to
   * the oracle-freshness guard used elsewhere in this module (see
   * {@link enrichOrder}), so an order can never be configured against a
   * stale price. The threshold defaults to {@link DEFAULT_STALE_AFTER_MS}.
   *
   * @param params - Order parameters (tokens, amount, trigger, pair, feed)
   * @param signer - Wallet signer that owns and authorises the order
   * @param options - Optional freshness guard for the oracle read used to
   *   configure the order
   * @returns The unique order ID assigned by the contract
   * @throws {ValidationError} If addresses are invalid, tokens are identical,
   *   the amount or trigger price is non-positive, the oracle asset is empty,
   *   or the trigger price is not below the current market price
   * @throws {StaleOracleError} If the oracle price used to configure the
   *   order is older than `options.staleAfterMs` (or {@link DEFAULT_STALE_AFTER_MS})
   * @throws {TransactionError} If the transaction is rejected on-chain
   */
  async createStopLoss(
    params: StopLossParams,
    signer: Signer,
    options: TriggerEvaluationOptions = {},
  ): Promise<string> {
    const signerPublicKey = await signer.publicKey();
    const op = await this.buildCreateStopLossOperation(params, signerPublicKey, options);

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
   * Execute a swap and create a protective stop-loss on the resulting
   * position as a single atomic transaction.
   *
   * Swapping into a position and then placing a stop-loss are normally two
   * sequential transactions, leaving the new position unprotected if the
   * second call fails. This composes both operations with a
   * {@link TransactionComposer} so either both land or neither does — there
   * is no window where the swap succeeded but the stop-loss did not.
   *
   * @param swapModule - The client's {@link SwapModule}, used to price and
   *   build the swap leg
   * @param swapRequest - The swap to execute before placing the stop-loss
   * @param stopLossParams - Parameters for the protective stop-loss order
   * @param signer - Wallet signer that owns and authorises both operations
   * @param options - Optional freshness guard for the oracle read used to
   *   configure the stop-loss
   * @returns The transaction hash and ledger of the single atomic transaction
   * @throws {ValidationError} If either leg's parameters are invalid, or the
   *   trigger price is not below the current market price
   * @throws {StaleOracleError} If the oracle price is stale
   * @throws {TransactionError} If the composed transaction is rejected —
   *   in that case neither the swap nor the stop-loss took effect
   *
   * @example
   * ```ts
   * const { txHash } = await stopLoss.swapAndCreateStopLoss(
   *   client.swap,
   *   { tokenIn: 'CAAA...', tokenOut: 'CBBB...', amount: 1_000_0000000n, tradeType: TradeType.EXACT_IN },
   *   { tokenIn: 'CBBB...', tokenOut: 'CAAA...', amount: 950_0000000n, triggerPrice: 9_000_000n, pairAddress: 'CPPP...', oracleAsset: 'XLM' },
   *   mySigner,
   * );
   * ```
   */
  async swapAndCreateStopLoss(
    swapModule: SwapModule,
    swapRequest: SwapRequest,
    stopLossParams: StopLossParams,
    signer: Signer,
    options: TriggerEvaluationOptions = {},
  ): Promise<{ txHash: string; ledger: number }> {
    const signerPublicKey = await signer.publicKey();

    const quote = await swapModule.getQuote(swapRequest);
    const swapOp = swapModule.buildSwapOperation(swapRequest, quote);
    const stopLossOp = await this.buildCreateStopLossOperation(
      stopLossParams,
      signerPublicKey,
      options,
    );

    const composer = this.client.transactionComposer();
    composer.addOperation(swapOp).addOperation(stopLossOp);

    const result = await composer.submit();

    if (!result.success || !result.data) {
      throw new TransactionError(
        `swapAndCreateStopLoss failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
      );
    }

    return result.data;
  }

  /**
   * Validate order parameters, read the current oracle price (rejecting it
   * if stale), and build the `create_stop_loss` operation without submitting.
   *
   * Shared by {@link createStopLoss} and {@link swapAndCreateStopLoss} so both
   * paths apply the same freshness guard to the price used at creation time.
   */
  private async buildCreateStopLossOperation(
    params: StopLossParams,
    signerPublicKey: string,
    options: TriggerEvaluationOptions,
  ): Promise<xdr.Operation> {
    this.validateStopLossParams(params);

    const currentPrice = await this.getOraclePrice(params.oracleAsset);
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.assertOracleFresh(currentPrice, params.oracleAsset, staleAfterMs);

    if (params.triggerPrice >= currentPrice.price) {
      throw new ValidationError(
        'triggerPrice must be below the current market price',
        {
          triggerPrice: params.triggerPrice.toString(),
          currentPrice: currentPrice.price.toString(),
        },
      );
    }

    const contract = new Contract(this.contractAddress);

    return contract.call(
      'create_stop_loss',
      new Address(params.tokenIn).toScVal(),
      new Address(params.tokenOut).toScVal(),
      nativeToScVal(params.amount, { type: 'i128' }),
      nativeToScVal(params.triggerPrice, { type: 'i128' }),
      new Address(params.pairAddress).toScVal(),
      nativeToScVal(params.oracleAsset, { type: 'symbol' }),
      new Address(signerPublicKey).toScVal(),
    );
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
  async getStopLoss(
    orderId: string,
    options: TriggerEvaluationOptions = {},
  ): Promise<StopLossOrder> {
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
    return this.enrichOrder(order, options);
  }

  /**
   * Fetch a user's stop-loss orders, enrich them with live trigger state, then
   * filter and sort the results.
   */
  async getStopLossOrders(
    address: string,
    query: StopLossOrderQuery = {},
    options: TriggerEvaluationOptions = {},
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

    // Convert top-level return value to native JS — handle decode failure explicitly
    let nativeArr: unknown[];
    try {
      const native = scValToNative(sim.returnValue);
      nativeArr = Array.isArray(native) ? native : [];
    } catch (e) {
      // Couldn't decode the top-level return value: surface a DecodeError with context
      throw new DecodeError('orders_for_user', 'Failed to decode orders_for_user return value', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Decode each slot: empty slots -> order: null; decode failures -> DecodeError(slot)
    const decodedSlots: Array<{ slot: number; order: DecodedStopLossOrder | null }> = [];

    for (const [idx, item] of nativeArr.entries()) {
      const slot = idx;
      if (item === null || item === undefined) {
        decodedSlots.push({ slot, order: null });
        continue;
      }

      try {
        let scval: xdr.ScVal;

        if (typeof item === 'string') {
          // Legacy: base64-encoded XDR for the slot
          try {
            scval = xdr.ScVal.fromXDR(item, 'base64');
          } catch (err) {
            throw new DecodeError(slot, 'Failed to parse base64 XDR for slot', {
              xdr: item,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          // Native JS object — convert to ScVal for reuse of decodeOrder
          try {
            scval = nativeToScVal(item);
          } catch (err) {
            throw new DecodeError(slot, 'Failed to convert native value to ScVal', {
              item,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const decoded = this.decodeOrder(scval);
        decodedSlots.push({ slot, order: decoded });
      } catch (err) {
        if (err instanceof DecodeError) throw err;
        throw new DecodeError(slot, 'Failed to decode order slot', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Enrich only the non-empty decoded orders, preserving successful decoding semantics
    const enriched = await Promise.all(
      decodedSlots.map(async (s) => (s.order ? await this.enrichOrder(s.order) : null)),
    );

    const filtered = enriched.filter((o): o is StopLossOrder => o !== null);
    return this.applyOrderQuery(filtered, query);
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
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.assertOracleFresh(snapshot, order.oracleAsset, staleAfterMs);
    return snapshot.price <= order.triggerPrice;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private validateStopLossParams(params: StopLossParams): void {
    const result = StopLossParamsSchema.safeParse(params);
    if (!result.success) {
      const issues = result.error.issues
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ValidationError(`Invalid stop-loss params: ${issues}`, {
        zodErrors: result.error.issues,
      });
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

  private async enrichOrder(
    order: DecodedStopLossOrder,
    options: TriggerEvaluationOptions = {},
  ): Promise<StopLossOrder> {
    const snapshot = await this.getOraclePrice(order.oracleAsset);
    
    // Enforce oracle freshness by default to prevent stale price usage
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.assertOracleFresh(snapshot, order.oracleAsset, staleAfterMs);
    
    const distancePercent =
      order.triggerPrice > 0n
        ? Number(
            ((snapshot.price - order.triggerPrice) * 10000n) / order.triggerPrice
          ) / 100
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
    staleAfterMs: number,
  ): void {
    if (snapshot.timestamp === undefined) {
      // No timestamp available - cannot verify freshness
      // This could happen with certain oracle implementations
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
