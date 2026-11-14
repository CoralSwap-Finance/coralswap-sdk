import {
  Contract,
  rpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { DecodeError, SimulationError } from "@/errors";
import { withRetry, RetryOptions } from "@/utils/retry";
import { decodeI128 } from "@/utils/scval";
import { validateAddress } from "@/utils/validation";
import { Logger } from "@/types/common";

/** Maximum valid fee in basis points (100% = 10,000 bps). */
const MAX_FEE_BPS = 10_000;

/**
 * Extract the ScVal arm name across both plain-property and accessor-method shapes.
 */
function getScValTypeName(val: xdr.ScVal): string {
  const candidate = val as unknown as {
    type?: unknown;
    switch?: () => { name?: string } | string;
  };
  if (typeof candidate.type === "string" && candidate.type.length > 0) {
    return candidate.type;
  }
  if (typeof candidate.switch === "function") {
    const sw = candidate.switch();
    if (typeof sw === "string") return sw;
    if (sw && typeof sw.name === "string") return sw.name;
  }
  return typeof val;
}

/**
 * Strictly decode a dynamic fee basis-point `u32` from a Soroban `ScVal`.
 * Fails closed with {@link DecodeError} on non-`scvU32` or out-of-range values.
 */
function decodeDynamicFeeBps(
  val: xdr.ScVal,
  tokenA: string,
  tokenB: string,
): number {
  const typeName = getScValTypeName(val);
  let rawFee: unknown;

  if (typeName === "scvU32") {
    const candidate = val as unknown as { u32?: number | (() => number) };
    rawFee =
      typeof candidate.u32 === "function" ? candidate.u32() : candidate.u32;
  } else {
    throw new DecodeError(
      "get_dynamic_fee",
      `Expected scvU32 return value from get_dynamic_fee, got ${typeName}`,
      { tokenA, tokenB, actualType: typeName },
    );
  }

  if (
    typeof rawFee !== "number" ||
    !Number.isInteger(rawFee) ||
    rawFee < 0 ||
    rawFee > MAX_FEE_BPS
  ) {
    throw new DecodeError(
      "get_dynamic_fee",
      `Invalid dynamic fee basis points decoded from get_dynamic_fee: ${String(rawFee)}`,
      { tokenA, tokenB, feeBps: rawFee },
    );
  }

  return rawFee;
}

/**
 * Type-safe client for the CoralSwap Router contract.
 *
 * Routes swaps through factory-registered pairs with deadline enforcement,
 * and orchestrates add/remove liquidity through optimal pair selection.
 */
export class RouterClient {
  private contract: Contract;
  private server: rpc.Server;
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
    server: rpc.Server,
    networkPassphrase: string,
    retryOptions: RetryOptions,
    logger?: Logger,
  ) {
    this.contract = new Contract(contractAddress);
    this.server = server;
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
   * @param amountOutMin - Minimum acceptable output amount (slippage guard). Must be > 0.
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
   * @throws {Error} If `amountOutMin` is not greater than zero.
   */
  buildSwapExactIn(
    sender: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    amountOutMin: bigint,
    deadline: number,
  ): xdr.Operation {
    this.assertSlippageBound(amountOutMin, "amountOutMin");
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
   * @param amountInMax - Maximum amount of `tokenIn` willing to spend (slippage guard). Must be > 0.
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
   * @throws {Error} If `amountInMax` is not greater than zero.
   */
  buildSwapExactOut(
    sender: string,
    tokenIn: string,
    tokenOut: string,
    amountOut: bigint,
    amountInMax: bigint,
    deadline: number,
  ): xdr.Operation {
    this.assertSlippageBound(amountInMax, "amountInMax");
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
   * @param amountOutMin - Minimum acceptable amount of the last token in `path` (slippage guard). Must be > 0.
   * @param deadline - Unix timestamp after which the transaction reverts.
   * @returns An XDR operation ready to be included in a transaction.
   * @throws {Error} If `amountOutMin` is not greater than zero.
   */
  buildSwapExactTokensForTokens(
    sender: string,
    path: string[],
    amountIn: bigint,
    amountOutMin: bigint,
    deadline: number,
  ): xdr.Operation {
    this.assertSlippageBound(amountOutMin, "amountOutMin");
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
   * Fails closed without any silent fallback fee if simulation fails, produces
   * no return value, or returns a non-`u32` / out-of-range value.
   *
   * @param tokenA - Address of the first token.
   * @param tokenB - Address of the second token.
   * @returns The current fee in basis points (e.g. `30` = 0.3%).
   * @throws {ValidationError} If `tokenA` or `tokenB` is not a valid Stellar address.
   * @throws {SimulationError} If the read simulation fails or returns no result.
   * @throws {DecodeError} If the simulated return value is not a valid `u32` fee in `[0, 10000]`.
   */
  async getDynamicFee(tokenA: string, tokenB: string): Promise<number> {
    validateAddress(tokenA, "tokenA");
    validateAddress(tokenB, "tokenB");

    const op = this.contract.call(
      "get_dynamic_fee",
      nativeToScVal(Address.fromString(tokenA), { type: "address" }),
      nativeToScVal(Address.fromString(tokenB), { type: "address" }),
    );
    const result = await this.simulateReadOrThrow(op, "get_dynamic_fee", {
      tokenA,
      tokenB,
    });
    return decodeDynamicFeeBps(result, tokenA, tokenB);
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
    return decodeI128(result);
  }

  /**
   * Assert that a swap slippage bound is explicit and strictly positive.
   *
   * The router rejects `0` and negative bounds because they would silently
   * allow full/unbounded slippage. Every swap path must use a positive bound.
   */
  private assertSlippageBound(value: bigint, label: string): void {
    if (value <= 0n) {
      throw new Error(
        `${label} must be > 0; refusing to swap with unbounded slippage`,
      );
    }
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
    const sim = await this.executeReadSimulation(op);
    if (rpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }

  /**
   * Simulate a read-only contract call and fail closed with a typed
   * {@link SimulationError} if simulation fails or returns no `retval`.
   */
  private async simulateReadOrThrow(
    op: xdr.Operation,
    method: string,
    details: Record<string, unknown>,
  ): Promise<xdr.ScVal> {
    // Honour instance-level simulateRead test stubs if overridden on `this`.
    if (this.simulateRead !== RouterClient.prototype.simulateRead) {
      const overridden = await this.simulateRead(op);
      if (!overridden) {
        throw new SimulationError(
          `RouterClient.${method} simulation returned no result`,
          { method, reason: "missing_retval", ...details },
        );
      }
      return overridden;
    }

    const sim = await this.executeReadSimulation(op);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const errorDetail =
        "error" in sim && typeof sim.error === "string" && sim.error.length > 0
          ? sim.error
          : "Simulation failed";
      throw new SimulationError(
        `RouterClient.${method} simulation failed: ${errorDetail}`,
        { method, simulationError: errorDetail, ...details },
      );
    }
    if (!sim.result || !sim.result.retval) {
      throw new SimulationError(
        `RouterClient.${method} simulation returned no result`,
        { method, reason: "missing_retval", ...details },
      );
    }
    return sim.result.retval;
  }

  /**
   * Execute the underlying zero-balance read simulation against Soroban RPC.
   */
  private async executeReadSimulation(
    op: xdr.Operation,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
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

    return withRetry(
      () => this.server.simulateTransaction(tx),
      this.retryOptions,
      this.logger,
      "RouterClient_simulateTransaction",
    );
  }
}
