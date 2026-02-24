import { Contract, SorobanRpc, TransactionBuilder, xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';

/**
 * Type-safe client for the CoralSwap Router contract.
 *
 * Routes swaps through factory-registered pairs with deadline enforcement,
 * and orchestrates add/remove liquidity through optimal pair selection.
 */
export class RouterClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(
    contractAddress: string,
    rpcUrl: string,
    networkPassphrase: string,
  ) {
    this.contract = new Contract(contractAddress);
    this.server = new SorobanRpc.Server(rpcUrl);
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Build a swap_exact_in operation with deadline enforcement.
   */
  buildSwapExactIn(
    sender: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    amountOutMin: bigint,
    deadline: number,
  ): xdr.Operation {
    return this.contract.call(
      'swap_exact_in',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenIn), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenOut), { type: 'address' }),
      nativeToScVal(amountIn, { type: 'i128' }),
      nativeToScVal(amountOutMin, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
    );
  }

  /**
   * Build a swap_exact_out operation with deadline enforcement.
   */
  buildSwapExactOut(
    sender: string,
    tokenIn: string,
    tokenOut: string,
    amountOut: bigint,
    amountInMax: bigint,
    deadline: number,
  ): xdr.Operation {
    return this.contract.call(
      'swap_exact_out',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenIn), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenOut), { type: 'address' }),
      nativeToScVal(amountOut, { type: 'i128' }),
      nativeToScVal(amountInMax, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
    );
  }

  /**
   * Build a swap_exact_tokens_for_tokens operation for multi-hop routing.
   *
   * The full `path` vector (token addresses) is forwarded to the on-chain
   * router, which iterates through each consecutive pair autonomously.
   */
  buildSwapExactTokensForTokens(
    sender: string,
    path: string[],
    amountIn: bigint,
    amountOutMin: bigint,
    deadline: number,
  ): xdr.Operation {
    const pathVal = xdr.ScVal.scvVec(
      path.map((addr) => nativeToScVal(Address.fromString(addr), { type: 'address' })),
    );
    return this.contract.call(
      'swap_exact_tokens_for_tokens',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      pathVal,
      nativeToScVal(amountIn, { type: 'i128' }),
      nativeToScVal(amountOutMin, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
    );
  }

  /**
   * Build an add_liquidity operation via the router.
   */
  buildAddLiquidity(
    sender: string,
    tokenA: string,
    tokenB: string,
    amountADesired: bigint,
    amountBDesired: bigint,
    amountAMin: bigint,
    amountBMin: bigint,
    deadline: number,
  ): xdr.Operation {
    return this.contract.call(
      'add_liquidity',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenA), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenB), { type: 'address' }),
      nativeToScVal(amountADesired, { type: 'i128' }),
      nativeToScVal(amountBDesired, { type: 'i128' }),
      nativeToScVal(amountAMin, { type: 'i128' }),
      nativeToScVal(amountBMin, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
    );
  }

  /**
   * Build a remove_liquidity operation via the router.
   */
  buildRemoveLiquidity(
    sender: string,
    tokenA: string,
    tokenB: string,
    liquidity: bigint,
    amountAMin: bigint,
    amountBMin: bigint,
    deadline: number,
  ): xdr.Operation {
    return this.contract.call(
      'remove_liquidity',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenA), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenB), { type: 'address' }),
      nativeToScVal(liquidity, { type: 'i128' }),
      nativeToScVal(amountAMin, { type: 'i128' }),
      nativeToScVal(amountBMin, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
    );
  }

  /**
   * Query the current dynamic fee for a trading pair via the router.
   */
  async getDynamicFee(tokenA: string, tokenB: string): Promise<number> {
    const op = this.contract.call(
      'get_dynamic_fee',
      nativeToScVal(Address.fromString(tokenA), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenB), { type: 'address' }),
    );
    const result = await this.simulateRead(op);
    if (!result) return 30;
    return result.u32() ?? 30;
  }

  /**
   * Get a fee-aware quote for a swap via the router.
   */
  async quote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const op = this.contract.call(
      'quote',
      nativeToScVal(Address.fromString(tokenIn), { type: 'address' }),
      nativeToScVal(Address.fromString(tokenOut), { type: 'address' }),
      nativeToScVal(amountIn, { type: 'i128' }),
    );
    const result = await this.simulateRead(op);
    if (!result) throw new Error('Failed to get quote');
    return BigInt(result.i128().lo().toString()) + (BigInt(result.i128().hi().toString()) << 64n);
  }

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
