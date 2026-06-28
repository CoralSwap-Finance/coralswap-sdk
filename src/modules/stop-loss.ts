import { CoralSwapClient } from '@/client';
import {
  StopLossParams,
  StopLossOrder,
  StopLossStatus,
} from '@/types/stop-loss';
import { Signer } from '@/types/common';
import { ValidationError, TransactionError } from '@/errors';
import {
  validateAddress,
  validatePositiveAmount,
  validateDistinctTokens,
} from '@/utils/validation';
import {
  Contract,
  nativeToScVal,
  Address,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

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
    validateAddress(params.tokenIn, 'tokenIn');
    validateAddress(params.tokenOut, 'tokenOut');
    validateAddress(params.pairAddress, 'pairAddress');
    validateDistinctTokens(params.tokenIn, params.tokenOut);
    validatePositiveAmount(params.amount, 'amount');
    validatePositiveAmount(params.triggerPrice, 'triggerPrice');

    if (!params.oracleAsset || params.oracleAsset.trim().length === 0) {
      throw new ValidationError('oracleAsset must not be empty');
    }

    // A stop-loss only makes sense below the current price; otherwise it would
    // trigger on creation.
    const currentPrice = await this.getOraclePrice(params.oracleAsset);
    if (params.triggerPrice >= currentPrice) {
      throw new ValidationError(
        'triggerPrice must be below the current market price',
        {
          triggerPrice: params.triggerPrice.toString(),
          currentPrice: currentPrice.toString(),
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

    // The contract returns the order ID; the txHash is a stable reference when
    // the return value cannot be extracted from the polling result.
    return result.txHash!;
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

    // Re-read the live price from RedStone to decide whether the order is
    // currently eligible to execute.
    const currentPrice = await this.getOraclePrice(order.oracleAsset);
    const triggered = currentPrice <= order.triggerPrice;

    return { ...order, currentPrice, triggered };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the current price for an asset from the RedStone oracle contract.
   *
   * @param asset - RedStone feed identifier (asset symbol)
   * @returns Current price in the oracle's fixed-point scale
   * @throws {ValidationError} If the oracle returns no price for the asset
   */
  private async getOraclePrice(asset: string): Promise<bigint> {
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

    return BigInt(String(scValToNative(sim.returnValue)));
  }

  private decodeOrder(val: xdr.ScVal): Omit<StopLossOrder, 'currentPrice' | 'triggered'> {
    const native = scValToNative(val) as Record<string, unknown>;

    return {
      id: String(native['id'] ?? ''),
      owner: String(native['owner'] ?? ''),
      tokenIn: String(native['token_in'] ?? ''),
      tokenOut: String(native['token_out'] ?? ''),
      amount: BigInt(String(native['amount'] ?? '0')),
      triggerPrice: BigInt(String(native['trigger_price'] ?? '0')),
      oracleAsset: String(native['oracle_asset'] ?? ''),
      status: (native['status'] as StopLossStatus) ?? 'active',
    };
  }
}
