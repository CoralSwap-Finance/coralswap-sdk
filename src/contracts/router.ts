import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { withRetry, RetryOptions } from "@/utils/retry";
import { Logger } from "@/types/common";

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
  private retryOptions: RetryOptions;
  private logger?: Logger;

  /**
   * Create a new RouterClient.
   *
   * @param contractAddress - The Soroban contract address of the router.
   * @param rpcUrl - The Soroban RPC endpoint URL.
   * @param networkPassphrase - The Stellar network passphrase.
   * @param retryOptions - Retry policy for RPC calls.
   * @param logger - Optional logger for debug/error output.
   */
  constructor(
    contractAddress: string,
    rpcUrl: string,
    networkPassphrase: string,
    retryOptions: RetryOptions,
    logger?: Logger,
  ) {
    this.contract = new Contract(contractAddress);
    this.server = new SorobanRpc.Server(rpcUrl);
    this.networkPassphrase = networkPassphrase;
    this.retryOptions = retryOptions;
    this.logger = logger;
  }

  /**
   * Build a swap_exact_in operation with deadline enforcement.
   *
   * @param sender - The address authorising the swap and receiving `tokenOut`.
   * @param tokenIn - Address of the token being sold.
   * @param tokenOut - Address of the token being bought.
   * @param amountIn - Exact amount of `tokenIn` to sell (i128).
   * @param amountOutMin - Minimum acceptable output amount (slippage guard).
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
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
      "swap_exact_in",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(Address.fromString(tokenIn), { type: "address" }),
      nativeToScVal(Address.fromString(tokenOut), { type: "address" }),
      nativeToScVal(amountIn, { type: "i128" }),
      nativeToScVal(amountOutMin, { type: "i128" }),
      nativeToScVal(deadline, { type: "u64" }),
    );
  }

  /**
   * Build a swap_exact_out operation with deadline enforcement.
   *
   * @param sender - The address authorising the swap and receiving `tokenOut`.
   * @param tokenIn - Address of the token being sold.
   * @param tokenOut - Address of the token being bought.
   * @param amountOut - Exact amount of `tokenOut` to receive (i128).
   * @param amountInMax - Maximum amount of `tokenIn` willing to spend (slippage guard).
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
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
      "swap_exact_out",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(Address.fromString(tokenIn), { type: "address" }),
      nativeToScVal(Address.fromString(tokenOut), { type: "address" }),
      nativeToScVal(amountOut, { type: "i128" }),
      nativeToScVal(amountInMax, { type: "i128" }),
      nativeToScVal(deadline, { type: "u64" }),
    );
  }

  /**
   * Build a swap_exact_tokens_for_tokens operation for multi-hop routing.
   *
   * The full `path` vector (token addresses) is forwarded to the on-chain
   * router, which iterates through each consecutive pair autonomously.
   *
   * @param sender - The address authorising the swap and receiving the final output token.
   * @param path - Ordered array of token addresses defining the route (min 2 tokens).
   * @param amountIn - Exact amount of the first token in `path` to sell (i128).
   * @param amountOutMin - Minimum acceptable amount of the last token in `path` (slippage guard).
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
   */
  buildSwapExactTokensForTokens(
    sender: string,
    path: string[],
    amountIn: bigint,
    amountOutMin: bigint,
    deadline: number,
  ): xdr.Operation {
    const pathVal = xdr.ScVal.scvVec(
      path.map((addr) =>
        nativeToScVal(Address.fromString(addr), { type: "address" }),
      ),
    );
    return this.contract.call(
      "swap_exact_tokens_for_tokens",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      pathVal,
      nativeToScVal(amountIn, { type: "i128" }),
      nativeToScVal(amountOutMin, { type: "i128" }),
      nativeToScVal(deadline, { type: "u64" }),
    );
  }

  /**
   * Build an add_liquidity operation via the router.
   *
   * @param sender - The address providing liquidity and receiving LP tokens.
   * @param tokenA - Address of the first token.
   * @param tokenB - Address of the second token.
   * @param amountADesired - Desired amount of token A to deposit (i128).
   * @param amountBDesired - Desired amount of token B to deposit (i128).
   * @param amountAMin - Minimum acceptable amount of token A (slippage guard).
   * @param amountBMin - Minimum acceptable amount of token B (slippage guard).
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
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
      "add_liquidity",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(Address.fromString(tokenA), { type: "address" }),
      nativeToScVal(Address.fromString(tokenB), { type: "address" }),
      nativeToScVal(amountADesired, { type: "i128" }),
      nativeToScVal(amountBDesired, { type: "i128" }),
      nativeToScVal(amountAMin, { type: "i128" }),
      nativeToScVal(amountBMin, { type: "i128" }),
      nativeToScVal(deadline, { type: "u64" }),
    );
  }

  /**
   * Build a remove_liquidity operation via the router.
   *
   * @param sender - The address burning LP tokens and receiving underlying tokens.
   * @param tokenA - Address of the first token.
   * @param tokenB - Address of the second token.
   * @param liquidity - Amount of LP tokens to burn (i128).
   * @param amountAMin - Minimum acceptable amount of token A to receive (slippage guard).
   * @param amountBMin - Minimum acceptable amount of token B to receive (slippage guard).
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
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
      "remove_liquidity",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(Address.fromString(tokenA), { type: "address" }),
      nativeToScVal(Address.fromString(tokenB), { type: "address" }),
      nativeToScVal(liquidity, { type: "i128" }),
      nativeToScVal(amountAMin, { type: "i128" }),
      nativeToScVal(amountBMin, { type: "i128" }),
      nativeToScVal(deadline, { type: "u64" }),
    );
  }

  /**
   * Query the current dynamic fee for a trading pair via the router.
   *
   * @param tokenA - Address of the first token.
   * @param tokenB - Address of the second token.
   * @returns The current fee in basis points (e.g. `30` = 0.3%).
   */
  async getDynamicFee(tokenA: string, tokenB: string): Promise<number> {
    const op = this.contract.call(
      "get_dynamic_fee",
      nativeToScVal(Address.fromString(tokenA), { type: "address" }),
      nativeToScVal(Address.fromString(tokenB), { type: "address" }),
    );
    const result = await this.simulateRead(op);
    if (!result) return 30;
    return result.u32() ?? 30;
  }

  /**
   * Get a fee-aware quote for a swap via the router.
   *
   * @param tokenIn - Address of the token being sold.
   * @param tokenOut - Address of the token being bought.
   * @param amountIn - Amount of `tokenIn` to sell (i128).
   * @returns The expected output amount of `tokenOut` (i128).
   * @throws {Error} If the RPC call fails or the pair does not exist.
   */
  async quote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const op = this.contract.call(
      "quote",
      nativeToScVal(Address.fromString(tokenIn), { type: "address" }),
      nativeToScVal(Address.fromString(tokenOut), { type: "address" }),
      nativeToScVal(amountIn, { type: "i128" }),
    );
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to get quote");
    return (
      BigInt(result.i128().lo().toString()) +
      (BigInt(result.i128().hi().toString()) << 64n)
    );
  }

  /**
   * Simulate a read-only contract call and return the return value.
   *
   * Uses a well-known zero-balance account as the source so no funds are required.
   *
   * @param op - The XDR operation to simulate.
   * @returns The `ScVal` return value, or `null` if simulation produced no result.
   */
  private async simulateRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const account = await withRetry(
      () =>
        this.server.getAccount(
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        ),
      this.retryOptions,
      this.logger,
      "RouterClient_getAccount",
    );
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      this.logger,
      "RouterClient_simulateTransaction",
    );
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}
