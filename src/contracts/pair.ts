import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { FeeState, FlashLoanConfig } from "@/types/pool";
import { withRetry, RetryOptions } from "@/utils/retry";
import { Logger } from "@/types/common";

/**
 * Helper function to parse an XDR struct (ScMap) into a Record map.
 */
function parseScStruct(val: xdr.ScVal): Record<string, xdr.ScVal> {
  const map = val.map();
  if (!map) {
    throw new Error("Invalid XDR format: expected ScMap");
  }
  const result: Record<string, xdr.ScVal> = {};
  for (const entry of map) {
    const k = entry.key();
    const tag = k.switch().name;
    let keyStr = "";
    if (tag === "scvString") {
      keyStr = k.str().toString();
    } else if (tag === "scvSymbol") {
      keyStr = k.sym().toString();
    } else {
      continue;
    }
    result[keyStr] = entry.val();
  }
  return result;
}

/**
 * Helper function to convert ScVal to number (u32).
 */
function scValToU32(val: xdr.ScVal | undefined): number {
  if (!val) throw new Error("Missing field");
  if (val.switch().name !== "scvU32") {
    throw new Error(`Expected u32, got ${val.switch().name}`);
  }
  return Number(val.u32());
}

/**
 * Helper function to convert ScVal to bigint (i128).
 */
function scValToI128(val: xdr.ScVal | undefined): bigint {
  if (!val) throw new Error("Missing field");
  if (val.switch().name !== "scvI128") {
    throw new Error(`Expected i128, got ${val.switch().name}`);
  }
  const parts = val.i128();
  return BigInt(parts.lo().toString()) + (BigInt(parts.hi().toString()) << 64n);
}

/**
 * Helper function to convert ScVal to number (u64).
 */
function scValToU64(val: xdr.ScVal | undefined): number {
  if (!val) throw new Error("Missing field");
  if (val.switch().name !== "scvU64") {
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
  private retryOptions: RetryOptions;
  private logger?: Logger;
  private sourceAccount?: string;
  readonly address: string;

  /**
   * Create a new PairClient for a specific pair contract.
   *
   * @param contractAddress - The Soroban contract address of the pair.
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
    sourceAccount?: string,
  ) {
    this.address = contractAddress;
    this.contract = new Contract(contractAddress);
    this.server = new SorobanRpc.Server(rpcUrl);
    this.networkPassphrase = networkPassphrase;
    this.retryOptions = retryOptions;
    this.logger = logger;
    this.sourceAccount = sourceAccount;
  }

  /**
   * Read current reserves from the pair contract.
   *
   * @returns The current token reserves as `{ reserve0, reserve1 }` in i128 BigInt.
   * @throws {Error} If the RPC call fails or returns an unexpected format.
   */
  async getReserves(): Promise<{ reserve0: bigint; reserve1: bigint }> {
    const op = this.contract.call("get_reserves");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read reserves");
    const vec = result.vec();
    if (!vec || vec.length < 2) throw new Error("Invalid reserves response");
    return {
      reserve0:
        BigInt(vec[0].i128().lo().toString()) +
        (BigInt(vec[0].i128().hi().toString()) << 64n),
      reserve1:
        BigInt(vec[1].i128().lo().toString()) +
        (BigInt(vec[1].i128().hi().toString()) << 64n),
    };
  }

  /**
   * Read the token addresses for this pair.
   *
   * @returns The canonical `{ token0, token1 }` addresses (token0 < token1 lexicographically).
   * @throws {Error} If the RPC call fails or returns an unexpected format.
   */
  async getTokens(): Promise<{ token0: string; token1: string }> {
    const op0 = this.contract.call("token_0");
    const op1 = this.contract.call("token_1");

    const [r0, r1] = await Promise.all([
      this.simulateRead(op0),
      this.simulateRead(op1),
    ]);

    if (!r0 || !r1) throw new Error("Failed to read token addresses");
    return {
      token0: Address.fromScVal(r0).toString(),
      token1: Address.fromScVal(r1).toString(),
    };
  }

  /**
   * Read the LP token address for this pair.
   *
   * @returns The Soroban contract address of the pair's LP token.
   * @throws {Error} If the RPC call fails.
   */
  async getLPTokenAddress(): Promise<string> {
    const op = this.contract.call("lp_token");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read LP token address");
    return Address.fromScVal(result).toString();
  }

  /**
   * Read the current dynamic fee in basis points.
   *
   * @returns The current fee in basis points (e.g. `30` = 0.3%).
   * @throws {Error} If the RPC call fails.
   */
  async getDynamicFee(): Promise<number> {
    const op = this.contract.call("get_dynamic_fee");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read dynamic fee");
    return result.u32() ?? 30;
  }

  /**
   * Read the full dynamic fee engine state.
   *
   * @returns The complete {@link FeeState} including EMA accumulators, min/max bounds,
   *   and the timestamp of the last fee update.
   * @throws {Error} If the RPC call fails or the response cannot be parsed.
   */
  async getFeeState(): Promise<FeeState> {
    const op = this.contract.call("get_fee_state");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read fee state");

    const struct = parseScStruct(result);

    return {
      priceLast: scValToI128(struct["price_last"]),
      volAccumulator: scValToI128(struct["vol_accumulator"]),
      lastUpdated: scValToU32(struct["last_updated"]),
      feeCurrent: scValToU32(struct["fee_current"]),
      feeMin: scValToU32(struct["fee_min"]),
      feeMax: scValToU32(struct["fee_max"]),
      emaAlpha: scValToU32(struct["ema_alpha"]),
      feeLastChanged: scValToU32(struct["fee_last_changed"]),
      emaDecayRate: scValToU32(struct["ema_decay_rate"]),
      baselineFee: scValToU32(struct["baseline_fee"]),
    };
  }

  /**
   * Read flash loan configuration.
   *
   * @returns The {@link FlashLoanConfig} for this pair, including fee bps, floor, and lock status.
   * @throws {Error} If the RPC call fails or the response cannot be parsed.
   */
  async getFlashLoanConfig(): Promise<FlashLoanConfig> {
    const op = this.contract.call("get_flash_config");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read flash loan config");

    const struct = parseScStruct(result);
    const lockedVal = struct["locked"];
    if (!lockedVal) throw new Error("Missing field locked");
    const locked =
      lockedVal.switch().name === "scvBool" ? lockedVal.b() : false;

    return {
      flashFeeBps: scValToU32(struct["flash_fee_bps"]),
      locked,
      flashFeeFloor: scValToI128(struct["flash_fee_floor"]),
    };
  }

  /**
   * Build a swap operation for this pair.
   *
   * @param sender - The address authorising and paying for the swap.
   * @param tokenIn - The address of the token being sold.
   * @param amountIn - The exact amount of `tokenIn` to sell (i128).
   * @param amountOutMin - The minimum acceptable output amount (slippage guard).
   * @returns An XDR operation ready to be included in a transaction.
   */
  buildSwap(
    sender: string,
    tokenIn: string,
    amountIn: bigint,
    amountOutMin: bigint,
  ): xdr.Operation {
    return this.contract.call(
      "swap",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(Address.fromString(tokenIn), { type: "address" }),
      nativeToScVal(amountIn, { type: "i128" }),
      nativeToScVal(amountOutMin, { type: "i128" }),
    );
  }

  /**
   * Build a deposit (add liquidity) operation.
   *
   * @param sender - The address providing liquidity and receiving LP tokens.
   * @param amountA - Desired amount of token A to deposit (i128).
   * @param amountB - Desired amount of token B to deposit (i128).
   * @param amountAMin - Minimum acceptable amount of token A (slippage guard).
   * @param amountBMin - Minimum acceptable amount of token B (slippage guard).
   * @returns An XDR operation ready to be included in a transaction.
   */
  buildDeposit(
    sender: string,
    amountA: bigint,
    amountB: bigint,
    amountAMin: bigint,
    amountBMin: bigint,
  ): xdr.Operation {
    return this.contract.call(
      "deposit",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(amountA, { type: "i128" }),
      nativeToScVal(amountB, { type: "i128" }),
      nativeToScVal(amountAMin, { type: "i128" }),
      nativeToScVal(amountBMin, { type: "i128" }),
    );
  }

  /**
   * Build a withdraw (remove liquidity) operation.
   *
   * @param sender - The address burning LP tokens and receiving underlying tokens.
   * @param liquidity - The amount of LP tokens to burn (i128).
   * @param amountAMin - Minimum acceptable amount of token A to receive (slippage guard).
   * @param amountBMin - Minimum acceptable amount of token B to receive (slippage guard).
   * @returns An XDR operation ready to be included in a transaction.
   */
  buildWithdraw(
    sender: string,
    liquidity: bigint,
    amountAMin: bigint,
    amountBMin: bigint,
  ): xdr.Operation {
    return this.contract.call(
      "withdraw",
      nativeToScVal(Address.fromString(sender), { type: "address" }),
      nativeToScVal(liquidity, { type: "i128" }),
      nativeToScVal(amountAMin, { type: "i128" }),
      nativeToScVal(amountBMin, { type: "i128" }),
    );
  }

  /**
   * Build a flash loan operation.
   *
   * @param borrower - The address initiating the flash loan (must be the tx source).
   * @param token - The address of the token to borrow.
   * @param amount - The amount to borrow (i128).
   * @param receiverAddress - The contract address that implements `on_flash_loan`.
   * @param data - Arbitrary callback data forwarded to the receiver contract.
   * @returns An XDR operation ready to be included in a transaction.
   */
  buildFlashLoan(
    borrower: string,
    token: string,
    amount: bigint,
    receiverAddress: string,
    data: Buffer,
  ): xdr.Operation {
    return this.contract.call(
      "flash_loan",
      nativeToScVal(Address.fromString(borrower), { type: "address" }),
      nativeToScVal(Address.fromString(token), { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(Address.fromString(receiverAddress), { type: "address" }),
      nativeToScVal(data, { type: "bytes" }),
    );
  }

  /**
   * Read the cumulative price oracle values (for TWAP).
   *
   * @returns The latest cumulative price accumulators and the block timestamp
   *   of the last swap, used to compute Time-Weighted Average Prices.
   * @throws {Error} If the RPC call fails or the response cannot be parsed.
   */
  async getCumulativePrices(): Promise<{
    price0CumulativeLast: bigint;
    price1CumulativeLast: bigint;
    blockTimestampLast: number;
  }> {
    const op = this.contract.call("get_cumulative_prices");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read cumulative prices");

    const struct = parseScStruct(result);

    return {
      price0CumulativeLast: scValToI128(struct["price0_cumulative_last"]),
      price1CumulativeLast: scValToI128(struct["price1_cumulative_last"]),
      blockTimestampLast: scValToU64(struct["block_timestamp_last"]),
    };
  }

  /**
   * Simulate a read-only contract call and return the return value.
   *
   * Uses a well-known zero-balance account as the source so no funds are required.
   *
   * @param op - The XDR operation to simulate.
   * @returns The `ScVal` return value, or `null` if simulation produced no result.
   * Simulate a read-only contract call.
   *
   * @param op - The contract operation to simulate.
   * @param sourceAccount - Optional account to use as the simulation source.
   *   Falls back to the account configured on this PairClient instance.
   * @throws {Error} If no source account is available.
   */
  private async simulateRead(op: xdr.Operation, sourceAccount?: string): Promise<xdr.ScVal | null> {
    const accountId = sourceAccount ?? this.sourceAccount;
    if (!accountId) {
      throw new Error(
        "simulateRead requires a sourceAccount. Provide one as an argument or configure it on the PairClient instance.",
      );
    }

    const account = await withRetry(
      () => this.server.getAccount(accountId),
      this.retryOptions,
      this.logger,
      "PairClient_getAccount",
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
      "PairClient_simulateTransaction",
    );
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}
