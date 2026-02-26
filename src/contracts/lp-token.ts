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
 * Type-safe client for CoralSwap LP Token contracts (SEP-41 compliant).
 *
 * Each trading pair deploys a separate LP token contract. This client
 * provides read access to balances, allowances, and metadata.
 */
export class LPTokenClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private retryOptions: RetryOptions;
  private logger?: Logger;
  readonly address: string;

  constructor(
    contractAddress: string,
    rpcUrl: string,
    networkPassphrase: string,
    retryOptions: RetryOptions,
    logger?: Logger,
  ) {
    this.address = contractAddress;
    this.contract = new Contract(contractAddress);
    this.server = new SorobanRpc.Server(rpcUrl);
    this.networkPassphrase = networkPassphrase;
    this.retryOptions = retryOptions;
    this.logger = logger;
  }

  /**
   * Query the LP token balance for an address.
   */
  async balance(owner: string): Promise<bigint> {
    const op = this.contract.call(
      "balance",
      nativeToScVal(Address.fromString(owner), { type: "address" }),
    );
    const result = await this.simulateRead(op);
    if (!result) return 0n;
    return (
      BigInt(result.i128().lo().toString()) +
      (BigInt(result.i128().hi().toString()) << 64n)
    );
  }

  /**
   * Query the total supply of LP tokens.
   */
  async totalSupply(): Promise<bigint> {
    const op = this.contract.call("total_supply");
    const result = await this.simulateRead(op);
    if (!result) return 0n;
    return (
      BigInt(result.i128().lo().toString()) +
      (BigInt(result.i128().hi().toString()) << 64n)
    );
  }

  /**
   * Query the allowance for a spender on an owner's balance.
   */
  async allowance(owner: string, spender: string): Promise<bigint> {
    const op = this.contract.call(
      "allowance",
      nativeToScVal(Address.fromString(owner), { type: "address" }),
      nativeToScVal(Address.fromString(spender), { type: "address" }),
    );
    const result = await this.simulateRead(op);
    if (!result) return 0n;
    return (
      BigInt(result.i128().lo().toString()) +
      (BigInt(result.i128().hi().toString()) << 64n)
    );
  }

  /**
   * Build an approve operation for LP token spending.
   */
  buildApprove(
    owner: string,
    spender: string,
    amount: bigint,
    expirationLedger: number,
  ): xdr.Operation {
    return this.contract.call(
      "approve",
      nativeToScVal(Address.fromString(owner), { type: "address" }),
      nativeToScVal(Address.fromString(spender), { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(expirationLedger, { type: "u32" }),
    );
  }

  /**
   * Build a transfer operation for LP tokens.
   */
  buildTransfer(from: string, to: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      "transfer",
      nativeToScVal(Address.fromString(from), { type: "address" }),
      nativeToScVal(Address.fromString(to), { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    );
  }

  /**
   * Query token metadata (name, symbol, decimals).
   */
  async metadata(): Promise<{
    name: string;
    symbol: string;
    decimals: number;
  }> {
    const [nameOp, symbolOp, decimalsOp] = [
      this.contract.call("name"),
      this.contract.call("symbol"),
      this.contract.call("decimals"),
    ];

    const [nameResult, symbolResult, decimalsResult] = await Promise.all([
      this.simulateRead(nameOp),
      this.simulateRead(symbolOp),
      this.simulateRead(decimalsOp),
    ]);

    return {
      name: nameResult?.str().toString() ?? "CoralSwap LP",
      symbol: symbolResult?.str().toString() ?? "CORAL-LP",
      decimals: decimalsResult?.u32() ?? 7,
    };
  }

  private async simulateRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const account = await withRetry(
      () =>
        this.server.getAccount(
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        ),
      this.retryOptions,
      this.logger,
      "LPTokenClient_getAccount",
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
      "LPTokenClient_simulateTransaction",
    );
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}
