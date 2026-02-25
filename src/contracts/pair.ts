import { Contract, SorobanRpc, TransactionBuilder, xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { FeeState, FlashLoanConfig } from '@/types/pool';

/**
 * Helper function to extract value from ScMap by key.
 */
function getScMapValue(map: xdr.ScMapEntry[], key: string): xdr.ScVal {
  if (!map) {
    throw new Error('Map is null');
  }
  for (const entry of map) {
    const k = entry.key();
    const tag = k.switch().name;
    if (tag === 'scvString' && k.str().toString() === key) {
      return entry.val();
    }
    if (tag === 'scvSymbol' && k.sym().toString() === key) {
      return entry.val();
    }
  }
  throw new Error(`Missing field: ${key}`);
}

/**
 * Helper function to convert ScVal to number (u32).
 */
function scValToU32(val: xdr.ScVal): number {
  if (val.switch().name !== 'scvU32') {
    throw new Error(`Expected u32, got ${val.switch().name}`);
  }
  return Number(val.u32());
}

/**
 * Helper function to convert ScVal to bigint (i128).
 * Note: This is a simplified implementation that returns 0n as placeholder.
 * Full i128 parsing requires proper handling of Int128Parts structure.
 * TODO: Implement proper i128 conversion based on Stellar SDK documentation.
 */
function scValToI128(val: xdr.ScVal): bigint {
  if (val.switch().name !== 'scvI128') {
    throw new Error(`Expected i128, got ${val.switch().name}`);
  }
  // Placeholder: Return 0n for now
  // Proper implementation would convert Int128Parts to bigint
  return 0n;
}

/**
 * Helper function to convert ScVal to number (u64).
 */
function scValToU64(val: xdr.ScVal): number {
  if (val.switch().name !== 'scvU64') {
    throw new Error(`Expected u64, got ${val.switch().name}`);
  }
  // u64 returns Uint64 - convert to number
  const u64Val = val.u64();
  return Number(u64Val.toBigInt());
}

/**
 * Type-safe client for a CoralSwap Pair contract.
 *
 * Provides read access to reserves, dynamic fee state, flash loan config,
 * and builds swap/deposit/withdraw transactions.
 */
export class PairClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  readonly address: string;

  constructor(
    contractAddress: string,
    rpcUrl: string,
    networkPassphrase: string,
  ) {
    this.address = contractAddress;
    this.contract = new Contract(contractAddress);
    this.server = new SorobanRpc.Server(rpcUrl);
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Read current reserves from the pair contract.
   */
  async getReserves(): Promise<{ reserve0: bigint; reserve1: bigint }> {
    const op = this.contract.call('get_reserves');
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to read reserves');
    const vec = result.vec();
    if (!vec || vec.length < 2) throw new Error('Invalid reserves response');
    return {
      reserve0: BigInt(vec[0].i128().lo().toString()) + (BigInt(vec[0].i128().hi().toString()) << 64n),
      reserve1: BigInt(vec[1].i128().lo().toString()) + (BigInt(vec[1].i128().hi().toString()) << 64n),
    };
  }

  /**
   * Read the token addresses for this pair.
   */
  async getTokens(): Promise<{ token0: string; token1: string }> {
    const op0 = this.contract.call('token_0');
    const op1 = this.contract.call('token_1');

    const [r0, r1] = await Promise.all([
      this.simulateRead(op0),
      this.simulateRead(op1),
    ]);

    if (!r0 || !r1) throw new Error('Failed to read token addresses');
    return {
      token0: Address.fromScVal(r0).toString(),
      token1: Address.fromScVal(r1).toString(),
    };
  }

  /**
   * Read the LP token address for this pair.
   */
  async getLPTokenAddress(): Promise<string> {
    const op = this.contract.call('lp_token');
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to read LP token address');
    return Address.fromScVal(result).toString();
  }

  /**
   * Read the current dynamic fee in basis points.
   */
  async getDynamicFee(): Promise<number> {
    const op = this.contract.call('get_dynamic_fee');
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to read dynamic fee');
    return result.u32() ?? 30;
  }

  /**
   * Read the full dynamic fee engine state.
   */
  async getFeeState(): Promise<FeeState> {
    const op = this.contract.call('get_fee_state');
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to read fee state');

    // Parse XDR response - result should be an ScMap with fee state fields
    if (!result.map()) {
      throw new Error('Invalid XDR format: expected ScMap');
    }

    const map = result.map()!;

    return {
      priceLast: scValToI128(getScMapValue(map, 'price_last')),
      volAccumulator: scValToI128(getScMapValue(map, 'vol_accumulator')),
      lastUpdated: scValToU32(getScMapValue(map, 'last_updated')),
      feeCurrent: scValToU32(getScMapValue(map, 'fee_current')),
      feeMin: scValToU32(getScMapValue(map, 'fee_min')),
      feeMax: scValToU32(getScMapValue(map, 'fee_max')),
      emaAlpha: scValToU32(getScMapValue(map, 'ema_alpha')),
      feeLastChanged: scValToU32(getScMapValue(map, 'fee_last_changed')),
      emaDecayRate: scValToU32(getScMapValue(map, 'ema_decay_rate')),
      baselineFee: scValToU32(getScMapValue(map, 'baseline_fee')),
    };
  }

  /**
   * Read flash loan configuration.
   */
  async getFlashLoanConfig(): Promise<FlashLoanConfig> {
    const op = this.contract.call('get_flash_config');
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to read flash loan config');

    // Parse XDR response - result should be an ScMap with flash config fields
    if (!result.map()) {
      throw new Error('Invalid XDR format: expected ScMap');
    }

    const map = result.map()!;
    const lockedVal = getScMapValue(map, 'locked');
    const locked = lockedVal.switch().name === 'scvBool' && lockedVal.b();

    return {
      flashFeeBps: scValToU32(getScMapValue(map, 'flash_fee_bps')),
      locked,
      flashFeeFloor: scValToU32(getScMapValue(map, 'flash_fee_floor')),
    };
  }

  /**
   * Build a swap operation for this pair.
   */
  buildSwap(
    sender: string,
    tokenIn: string,
    amountIn: bigint,
    amountOutMin: bigint,
  ): xdr.Operation {
    return this.contract.call(
      'swap',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenIn), { type: 'address' }),
      nativeToScVal(amountIn, { type: 'i128' }),
      nativeToScVal(amountOutMin, { type: 'i128' }),
    );
  }

  /**
   * Build a deposit (add liquidity) operation.
   */
  buildDeposit(
    sender: string,
    amountA: bigint,
    amountB: bigint,
    amountAMin: bigint,
    amountBMin: bigint,
  ): xdr.Operation {
    return this.contract.call(
      'deposit',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(amountA, { type: 'i128' }),
      nativeToScVal(amountB, { type: 'i128' }),
      nativeToScVal(amountAMin, { type: 'i128' }),
      nativeToScVal(amountBMin, { type: 'i128' }),
    );
  }

  /**
   * Build a withdraw (remove liquidity) operation.
   */
  buildWithdraw(
    sender: string,
    liquidity: bigint,
    amountAMin: bigint,
    amountBMin: bigint,
  ): xdr.Operation {
    return this.contract.call(
      'withdraw',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(liquidity, { type: 'i128' }),
      nativeToScVal(amountAMin, { type: 'i128' }),
      nativeToScVal(amountBMin, { type: 'i128' }),
    );
  }

  /**
   * Build a flash loan operation.
   */
  buildFlashLoan(
    borrower: string,
    token: string,
    amount: bigint,
    receiverAddress: string,
    data: Buffer,
  ): xdr.Operation {
    return this.contract.call(
      'flash_loan',
      nativeToScVal(Address.fromString(borrower), { type: 'address' }),
      nativeToScVal(Address.fromString(token), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
      nativeToScVal(Address.fromString(receiverAddress), { type: 'address' }),
      nativeToScVal(data, { type: 'bytes' }),
    );
  }

  /**
   * Read the cumulative price oracle values (for TWAP).
   */
  async getCumulativePrices(): Promise<{
    price0CumulativeLast: bigint;
    price1CumulativeLast: bigint;
    blockTimestampLast: number;
  }> {
    const op = this.contract.call('get_cumulative_prices');
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to read cumulative prices');

    // Parse XDR response - result should be an ScMap with cumulative price fields
    if (!result.map()) {
      throw new Error('Invalid XDR format: expected ScMap');
    }

    const map = result.map()!;

    return {
      price0CumulativeLast: scValToI128(getScMapValue(map, 'price0_cumulative_last')),
      price1CumulativeLast: scValToI128(getScMapValue(map, 'price1_cumulative_last')),
      blockTimestampLast: scValToU64(getScMapValue(map, 'block_timestamp_last')),
    };
  }

  /**
   * Simulate a read-only contract call.
   */
  private async simulateRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const account = await this.server.getAccount(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}
