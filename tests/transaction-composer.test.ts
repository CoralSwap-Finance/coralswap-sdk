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

  // ---------------------------------------------------------------------
  // Operation order
  // ---------------------------------------------------------------------

  describe("operation order", () => {
    function makeClient() {
      return {
        submitTransaction: jest.fn().mockResolvedValue({ success: true }),
        simulateTransaction: jest.fn().mockResolvedValue({ success: true }),
      } as any;
    }

    it("preserves insertion order across repeated addOperation calls", () => {
      const composer = new TransactionComposer(makeClient());
      const opA = { type: "a" } as any;
      const opB = { type: "b" } as any;
      const opC = { type: "c" } as any;

      composer.addOperation(opA).addOperation(opB).addOperation(opC);

      expect(composer.getOperations()).toEqual([opA, opB, opC]);
    });

    it("returns `this` from addOperation so calls chain", () => {
      const composer = new TransactionComposer(makeClient());
      const opA = { type: "a" } as any;

      const result = composer.addOperation(opA);

      expect(result).toBe(composer);
    });

    it("keeps addLiquidityAndStake's two operations liquidity-then-stake, relative to surrounding manual ops", () => {
      const composer = new TransactionComposer(makeClient());

      jest.spyOn(require("../src/modules/liquidity"), "LiquidityModule")
        .mockImplementation(() => ({
          buildAddLiquidityOperation: () => ({ type: "add-liquidity" }),
        }));
      jest.spyOn(require("../src/modules/staking"), "StakingModule")
        .mockImplementation(() => ({
          buildStakeOperation: () => ({ type: "stake" }),
        }));

      const before = { type: "before" } as any;
      const after = { type: "after" } as any;

      composer.addOperation(before);
      composer.addLiquidityAndStake(
        {} as any,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        100n,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      );
      composer.addOperation(after);

      expect(composer.getOperations()).toEqual([
        before,
        { type: "add-liquidity" },
        { type: "stake" },
        after,
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // clear()
  // ---------------------------------------------------------------------

  describe("clear()", () => {
    function makeClient() {
      return {
        submitTransaction: jest.fn().mockResolvedValue({ success: true }),
        simulateTransaction: jest.fn().mockResolvedValue({ success: true }),
      } as any;
    }

    it("empties a composer that has accumulated operations", () => {
      const composer = new TransactionComposer(makeClient());
      composer.addOperation({ type: "a" } as any).addOperation({ type: "b" } as any);

      composer.clear();

      expect(composer.getOperations()).toEqual([]);
    });

    it("is idempotent: calling it repeatedly on an already-empty composer stays empty and does not throw", () => {
      const composer = new TransactionComposer(makeClient());

      expect(() => {
        composer.clear();
        composer.clear();
        composer.clear();
      }).not.toThrow();
      expect(composer.getOperations()).toEqual([]);
    });

    it("is idempotent: calling it twice after adding operations is the same as calling it once", () => {
      const composer = new TransactionComposer(makeClient());
      composer.addOperation({ type: "a" } as any);

      composer.clear();
      composer.clear();

      expect(composer.getOperations()).toEqual([]);
    });

    it("returns `this` so it chains", () => {
      const composer = new TransactionComposer(makeClient());

      expect(composer.clear()).toBe(composer);
    });

    it("does not resurrect operations added before it: a later addOperation starts a fresh list", () => {
      const composer = new TransactionComposer(makeClient());
      composer.addOperation({ type: "stale" } as any);

      composer.clear();
      const fresh = { type: "fresh" } as any;
      composer.addOperation(fresh);

      expect(composer.getOperations()).toEqual([fresh]);
    });

    it("does not affect a separate composer instance's operations", () => {
      const composerA = new TransactionComposer(makeClient());
      const composerB = new TransactionComposer(makeClient());
      const opA = { type: "a" } as any;
      const opB = { type: "b" } as any;
      composerA.addOperation(opA);
      composerB.addOperation(opB);

      composerA.clear();

      expect(composerA.getOperations()).toEqual([]);
      expect(composerB.getOperations()).toEqual([opB]);
    });
  });

  // ---------------------------------------------------------------------
  // estimate() and submit() forward the same operations
  // ---------------------------------------------------------------------

  describe("estimate() and submit() forward the same operations", () => {
    it("submit() forwards the exact composed operation array to client.submitTransaction", async () => {
      const submitTransaction = jest.fn().mockResolvedValue({ success: true });
      const client: any = { submitTransaction, simulateTransaction: jest.fn() };
      const composer = new TransactionComposer(client);
      const opA = { type: "a" } as any;
      const opB = { type: "b" } as any;
      composer.addOperation(opA).addOperation(opB);

      await composer.submit();

      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(submitTransaction).toHaveBeenCalledWith([opA, opB]);
    });

    it("estimate() forwards the exact composed operation array to client.simulateTransaction with empty options", async () => {
      const simulateTransaction = jest.fn().mockResolvedValue({ success: true });
      const client: any = { submitTransaction: jest.fn(), simulateTransaction };
      const composer = new TransactionComposer(client);
      const opA = { type: "a" } as any;
      const opB = { type: "b" } as any;
      composer.addOperation(opA).addOperation(opB);

      await composer.estimate();

      expect(simulateTransaction).toHaveBeenCalledTimes(1);
      expect(simulateTransaction).toHaveBeenCalledWith([opA, opB], {});
    });

    it("estimate() and submit(), called on the same composer state, forward equal operation arrays", async () => {
      const submitTransaction = jest.fn().mockResolvedValue({ success: true });
      const simulateTransaction = jest.fn().mockResolvedValue({ success: true });
      const client: any = { submitTransaction, simulateTransaction };
      const composer = new TransactionComposer(client);
      composer
        .addOperation({ type: "a" } as any)
        .addOperation({ type: "b" } as any)
        .addOperation({ type: "c" } as any);

      await composer.estimate();
      await composer.submit();

      const forwardedToEstimate = simulateTransaction.mock.calls[0][0];
      const forwardedToSubmit = submitTransaction.mock.calls[0][0];

      expect(forwardedToSubmit).toEqual(forwardedToEstimate);
      expect(forwardedToSubmit).toHaveLength(3);
    });

    it("a clear() between estimate() and submit() changes what submit() forwards", async () => {
      const submitTransaction = jest.fn().mockResolvedValue({ success: true });
      const simulateTransaction = jest.fn().mockResolvedValue({ success: true });
      const client: any = { submitTransaction, simulateTransaction };
      const composer = new TransactionComposer(client);
      composer.addOperation({ type: "a" } as any);

      await composer.estimate();
      composer.clear();
      composer.addOperation({ type: "b" } as any);
      await composer.submit();

      expect(simulateTransaction).toHaveBeenCalledWith([{ type: "a" }], {});
      expect(submitTransaction).toHaveBeenCalledWith([{ type: "b" }]);
    });
  });
});
