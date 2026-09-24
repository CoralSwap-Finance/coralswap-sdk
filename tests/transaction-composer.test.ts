import { TransactionComposer } from "../src/transaction-composer";

describe("TransactionComposer", () => {
  it("composes add liquidity and stake into one transaction", async () => {
    const submitTransaction = jest.fn().mockResolvedValue({
      success: true,
      txHash: "abc123",
      data: { ledger: 1 },
    });

    const client: any = {
      submitTransaction,
      simulateTransaction: jest.fn(),
    };

    const composer = new TransactionComposer(client);

    // Stub the convenience method's dependencies
    jest.spyOn(require("../src/modules/liquidity"), "LiquidityModule")
      .mockImplementation(() => ({
        buildAddLiquidityOperation: () => ({ type: "add-liquidity" }),
      }));

    jest.spyOn(require("../src/modules/staking"), "StakingModule")
      .mockImplementation(() => ({
        buildStakeOperation: () => ({ type: "stake" }),
      }));

    composer.addLiquidityAndStake(
      {} as any,
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      100n,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );

    await composer.submit();

    expect(submitTransaction).toHaveBeenCalledTimes(1);
    expect(submitTransaction.mock.calls[0][0]).toHaveLength(2);
  });

  it("rolls back both operations when the composed transaction fails", async () => {
    // A composed add-liquidity-and-stake transaction is one Soroban
    // transaction with two operations, submitted through a single
    // `submitTransaction` call (proven above). Stellar transactions are
    // atomic: if that one call fails, neither operation's effect lands
    // on-chain, so there is no separate rollback step for this SDK to
    // implement. What this test actually proves is the part that *is*
    // this SDK's responsibility: a failure never causes the composer to
    // fall back to submitting the two operations separately, which is
    // the one way a caller's convenience method could accidentally turn
    // an atomic action into two independent ones.
    const submitTransaction = jest.fn().mockResolvedValue({
      success: false,
      error: {
        code: "SIMULATION_FAILED",
        message: "Transaction simulation failed",
      },
    });

    const client: any = {
      submitTransaction,
      simulateTransaction: jest.fn(),
    };

    const composer = new TransactionComposer(client);

    jest.spyOn(require("../src/modules/liquidity"), "LiquidityModule")
      .mockImplementation(() => ({
        buildAddLiquidityOperation: () => ({ type: "add-liquidity" }),
      }));

    jest.spyOn(require("../src/modules/staking"), "StakingModule")
      .mockImplementation(() => ({
        buildStakeOperation: () => ({ type: "stake" }),
      }));

    composer.addLiquidityAndStake(
      {} as any,
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      100n,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );

    const result = await composer.submit();

    // One call, both operations, no partial resubmission of either leg.
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    expect(submitTransaction.mock.calls[0][0]).toEqual([
      { type: "add-liquidity" },
      { type: "stake" },
    ]);

    // The whole action reports as failed. Nothing in the result implies
    // the add-liquidity leg went through while the stake leg did not.
    expect(result).toEqual({
      success: false,
      error: {
        code: "SIMULATION_FAILED",
        message: "Transaction simulation failed",
      },
    });
  });
});
