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
});
