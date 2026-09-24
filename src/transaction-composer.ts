import { xdr } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "./client";
import { LiquidityModule } from "./modules/liquidity";
import { StakingModule } from "./modules/staking";
import { AddLiquidityRequest } from "./types/liquidity";

export class TransactionComposer {
  private operations: xdr.Operation[] = [];

  constructor(private readonly client: CoralSwapClient) {}

  addOperation(operation: xdr.Operation): this {
    this.operations.push(operation);
    return this;
  }

  /**
   * Compose an add-liquidity operation and LP stake operation into
   * a single atomic transaction.
   *
   * @example
   * ```ts
   * await client
   *   .transactionComposer()
   *   .addLiquidityAndStake(
   *     liquidityRequest,
   *     lpTokenAddress,
   *     stakeAmount,
   *     publicKey,
   *   )
   *   .submit();
   * ```
   */
  addLiquidityAndStake(
    liquidityRequest: AddLiquidityRequest,
    lpTokenAddress: string,
    stakeAmount: bigint,
    publicKey: string,
  ): this {
    const liquidity = new LiquidityModule(this.client);
    const staking = new StakingModule(this.client);

    this.addOperation(
      liquidity.buildAddLiquidityOperation(liquidityRequest),
    );

    this.addOperation(
      staking.buildStakeOperation(
        lpTokenAddress,
        stakeAmount,
        publicKey,
      ),
    );

    return this;
  }
  clear(): this {
    this.operations = [];
    return this;
  }

  async submit() {
    return this.client.submitTransaction(this.operations);
  }

  async estimate() {
    return this.client.simulateTransaction(this.operations, {});
  }

  getOperations(): readonly xdr.Operation[] {
    return this.operations;
  }
}
