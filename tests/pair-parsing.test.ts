import { PairClient } from "../src/contracts/pair";
import { xdr, SorobanRpc } from "@stellar/stellar-sdk";

describe("PairClient Parsing", () => {
  const RPC_URL = "https://soroban-testnet.stellar.org";
  const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
  const PAIR_ADDRESS =
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";

  let client: PairClient;
  let mockSimulateTransaction: jest.SpyInstance;

  beforeEach(() => {
    client = new PairClient(PAIR_ADDRESS, RPC_URL, NETWORK_PASSPHRASE, {
      maxRetries: 1,
      retryDelayMs: 100,
      maxRetryDelayMs: 1000,
    });

    // Mock getAccount to avoid actual network calls
    (client as any).server.getAccount = jest.fn().mockResolvedValue({
      accountId: () =>
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    });

    mockSimulateTransaction = jest.spyOn(
      (client as any).server,
      "simulateTransaction",
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockSuccessfulSimulation(retval: xdr.ScVal) {
    mockSimulateTransaction.mockResolvedValue({
      result: {
        retval: retval,
      },
      latestLedger: 12345,
      events: [],
      restorePreamble: { minResourceFee: "100", transactionData: "" },
      transactionData: "",
      minResourceFee: "100",
      error: null,
      costs: { cpuInsns: "0", memBytes: "0" },
    } as unknown as SorobanRpc.Api.SimulateTransactionResponse);

    jest.spyOn(SorobanRpc.Api, "isSimulationSuccess").mockReturnValue(true);
  }

  const scvI128Hi = (lo: string, hi: string) =>
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        lo: xdr.Uint64.fromString(lo),
        hi: xdr.Int64.fromString(hi),
      }),
    );

  describe("getFeeState()", () => {
    it("correctly parses FeeState from XDR ScMap", async () => {
      const accurateFeeStateMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("price_last"),
          val: scvI128Hi("1000", "0"),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("vol_accumulator"),
          val: scvI128Hi("500", "0"),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("last_updated"),
          val: xdr.ScVal.scvU32(1625000000),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_current"),
          val: xdr.ScVal.scvU32(30),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_min"),
          val: xdr.ScVal.scvU32(10),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_max"),
          val: xdr.ScVal.scvU32(100),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("ema_alpha"),
          val: xdr.ScVal.scvU32(50),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_last_changed"),
          val: xdr.ScVal.scvU32(1624000000),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("ema_decay_rate"),
          val: xdr.ScVal.scvU32(5),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("baseline_fee"),
          val: xdr.ScVal.scvU32(30),
        }),
      ]);

      mockSuccessfulSimulation(accurateFeeStateMap);

      const state = await client.getFeeState();

      expect(state.priceLast).toBe(1000n);
      expect(state.volAccumulator).toBe(500n);
      expect(state.feeCurrent).toBe(30);
      expect(state.baselineFee).toBe(30);
    });

    it("parses high i128 values correctly", async () => {
      // (1 << 64) + 1
      const bigVal = (1n << 64n) + 1n;
      const bigValXdr = scvI128Hi("1", "1");

      const feeStateMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("price_last"),
          val: bigValXdr,
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("vol_accumulator"),
          val: scvI128Hi("0", "0"),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("last_updated"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_current"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_min"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_max"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("ema_alpha"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("fee_last_changed"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("ema_decay_rate"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("baseline_fee"),
          val: xdr.ScVal.scvU32(0),
        }),
      ]);

      mockSuccessfulSimulation(feeStateMap);

      const state = await client.getFeeState();
      expect(state.priceLast).toBe(bigVal);
    });
  });

  describe("getFlashLoanConfig()", () => {
    it("correctly parses FlashLoanConfig", async () => {
      const configMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("flash_fee_bps"),
          val: xdr.ScVal.scvU32(9),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("locked"),
          val: xdr.ScVal.scvBool(false),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("flash_fee_floor"),
          val: scvI128Hi("100", "0"),
        }),
      ]);

      mockSuccessfulSimulation(configMap);

      const config = await client.getFlashLoanConfig();

      expect(config.flashFeeBps).toBe(9);
      expect(config.locked).toBe(false);
      expect(config.flashFeeFloor).toBe(100n);
    });

    it("handles locked: true", async () => {
      const configMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("flash_fee_bps"),
          val: xdr.ScVal.scvU32(9),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("locked"),
          val: xdr.ScVal.scvBool(true),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("flash_fee_floor"),
          val: scvI128Hi("100", "0"),
        }),
      ]);

      mockSuccessfulSimulation(configMap);

      const config = await client.getFlashLoanConfig();
      expect(config.locked).toBe(true);
    });
  });

  describe("getCumulativePrices()", () => {
    it("correctly parses cumulative prices", async () => {
      const pricesMap = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("price0_cumulative_last"),
          val: scvI128Hi("123456789", "0"),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("price1_cumulative_last"),
          val: scvI128Hi("987654321", "0"),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("block_timestamp_last"),
          val: xdr.ScVal.scvU64(xdr.Uint64.fromString("1625000000")),
        }),
      ]);

      mockSuccessfulSimulation(pricesMap);

      const prices = await client.getCumulativePrices();

      expect(prices.price0CumulativeLast).toBe(123456789n);
      expect(prices.price1CumulativeLast).toBe(987654321n);
      expect(prices.blockTimestampLast).toBe(1625000000);
    });
  });
});
