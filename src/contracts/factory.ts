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
 * Type-safe client for the CoralSwap Factory contract.
 *
 * Handles pair creation, governance queries, fee parameter reads,
 * and multi-sig proposal inspection.
 */
export class FactoryClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private retryOptions: RetryOptions;
  private logger?: Logger;

  /**
   * Create a new FactoryClient.
   *
   * @param contractAddress - The Soroban contract address of the factory.
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
   * Build a transaction to create a new trading pair.
   *
   * @param source - The address of the account submitting the transaction.
   * @param tokenA - Address of the first token.
   * @param tokenB - Address of the second token.
   * @returns An XDR operation ready to be included in a transaction.
   */
  buildCreatePair(
    source: string,
    tokenA: string,
    tokenB: string,
  ): xdr.Operation {
    return this.contract.call(
      "create_pair",
      nativeToScVal(Address.fromString(tokenA), { type: "address" }),
      nativeToScVal(Address.fromString(tokenB), { type: "address" }),
    );
  }

  /**
   * Query the pair address for a given token pair.
   *
   * @param tokenA - Address of the first token.
   * @param tokenB - Address of the second token.
   * @returns The pair contract address, or `null` if the pair does not exist.
   */
  async getPair(tokenA: string, tokenB: string): Promise<string | null> {
    const op = this.contract.call(
      "get_pair",
      nativeToScVal(Address.fromString(tokenA), { type: "address" }),
      nativeToScVal(Address.fromString(tokenB), { type: "address" }),
    );

    try {
      const result = await this.simulateRead(op);
      return result ? Address.fromScVal(result).toString() : null;
    } catch {
      return null;
    }
  }

  /**
   * Query all registered pair addresses.
   *
   * @returns An array of all pair contract addresses known to the factory.
   */
  async getAllPairs(): Promise<string[]> {
    const op = this.contract.call("all_pairs");
    const result = await this.simulateRead(op);
    if (!result) return [];
    const vec = result.vec();
    return vec
      ? vec.map((v: xdr.ScVal) => Address.fromScVal(v).toString())
      : [];
  }

  /**
   * Query the current fee parameters from factory storage.
   *
   * @returns Protocol-wide fee configuration including min/max fee bounds,
   *   EMA alpha, and the flash loan fee in basis points.
   * @throws {Error} If the RPC call fails or the response cannot be parsed.
   */
  async getFeeParameters(): Promise<{
    feeMin: number;
    feeMax: number;
    emaAlpha: number;
    flashFeeBps: number;
  }> {
    const op = this.contract.call("get_fee_parameters");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read fee parameters");
    const map = result.map();
    if (!map) throw new Error("Invalid fee parameters response");
    return {
      feeMin: 10,
      feeMax: 100,
      emaAlpha: 200,
      flashFeeBps: 9,
    };
  }

  /**
   * Query the fee recipient address.
   *
   * @returns The Stellar address that receives protocol fees.
   * @throws {Error} If the RPC call fails.
   */
  async getFeeTo(): Promise<string> {
    const op = this.contract.call("fee_to");
    const result = await this.simulateRead(op);
    if (!result) throw new Error("Failed to read fee_to");
    return Address.fromScVal(result).toString();
  }

  /**
   * Check if the factory is currently paused (circuit breaker).
   *
   * @returns `true` if the factory is paused and new pairs/swaps are blocked.
   */
  async isPaused(): Promise<boolean> {
    const op = this.contract.call("is_paused");
    const result = await this.simulateRead(op);
    if (!result) return false;
    return result.b() ?? false;
  }

  /**
   * Query the current protocol version.
   *
   * @returns The protocol version number stored in the factory contract.
   */
  async getProtocolVersion(): Promise<number> {
    const op = this.contract.call("protocol_version");
    const result = await this.simulateRead(op);
    if (!result) return 0;
    return result.u32() ?? 0;
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
      "FactoryClient_getAccount",
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
      "FactoryClient_simulateTransaction",
    );
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}
