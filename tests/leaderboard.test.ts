import { CoralSwapClient } from "../src/client";
import { LeaderboardModule } from "../src/modules/leaderboard";
import { Network } from "../src/types/common";
import { ValidationError } from "../src/errors";
import { SorobanRpc } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";
const PAIR_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAIR_B = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const USER_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USER_2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USER_3 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";

// ---------------------------------------------------------------------------
// Raw event builder helpers
// ---------------------------------------------------------------------------

function makeRawSwapEvent(opts: {
  contractId: string;
  sender: string;
  amountIn: bigint;
  ledger: number;
}): Record<string, unknown> {
  const makeAddr = (addr: string) => ({
    address: () => ({ toString: () => addr }),
  });

  const makeI128 = (n: bigint) => ({
    i128: () => ({
      hi: () => ({ toString: () => String(n >> 64n) }),
      lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
    }),
  });

  const makeSym = (s: string) => ({
    sym: () => ({ toString: () => s }),
  });

  const mapEntries = [
    { key: makeSym("sender"), val: makeAddr(opts.sender) },
    { key: makeSym("amount_in"), val: makeI128(opts.amountIn) },
    { key: makeSym("token_in"), val: makeAddr("TOKEN_X") },
    { key: makeSym("token_out"), val: makeAddr("TOKEN_Y") },
    { key: makeSym("amount_out"), val: makeI128(opts.amountIn) },
    { key: makeSym("fee_bps"), val: { u32: () => 30 } },
  ];

  return {
    topic: ["swap"],
    value: { map: () => mapEntries },
    contractId: opts.contractId,
    ledger: opts.ledger,
  };
}

function makeRawAddLiquidityEvent(opts: {
  contractId: string;
  provider: string;
  liquidity: bigint;
  ledger: number;
}): Record<string, unknown> {
  const makeAddr = (addr: string) => ({
    address: () => ({ toString: () => addr }),
  });

  const makeI128 = (n: bigint) => ({
    i128: () => ({
      hi: () => ({ toString: () => String(n >> 64n) }),
      lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
    }),
  });

  const makeSym = (s: string) => ({
    sym: () => ({ toString: () => s }),
  });

  const mapEntries = [
    { key: makeSym("provider"), val: makeAddr(opts.provider) },
    { key: makeSym("liquidity"), val: makeI128(opts.liquidity) },
    { key: makeSym("token_a"), val: makeAddr("TOKEN_X") },
    { key: makeSym("token_b"), val: makeAddr("TOKEN_Y") },
    { key: makeSym("amount_a"), val: makeI128(100n) },
    { key: makeSym("amount_b"), val: makeI128(200n) },
  ];

  return {
    topic: ["add_liquidity"],
    value: { map: () => mapEntries },
    contractId: opts.contractId,
    ledger: opts.ledger,
  };
}

function makeEventsResponse(
  events: Record<string, unknown>[],
): SorobanRpc.Api.GetEventsResponse {
  return {
    events: events as unknown as SorobanRpc.Api.EventResponse[],
    latestLedger: 2000,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("LeaderboardModule.getLeaderboard()", () => {
  let client: CoralSwapClient;
  let leaderboard: LeaderboardModule;
import { LeaderboardModule } from "../src/modules/leaderboard";
import { SwapModule } from "../src/modules/swap";
import { CoralSwapClient } from "../src/client";
import { Network } from "../src/types/common";

const STABLE_ADDR = "CUSDC000000000000000000000000000000000000000000000000000000";
const TOKEN_A     = "CTOKENA00000000000000000000000000000000000000000000000000";
const TOKEN_B     = "CTOKENB00000000000000000000000000000000000000000000000000";
const PAIR_1      = "CPAIR00000000000000000000000000000000000000000000000000001";
const PAIR_2      = "CPAIR00000000000000000000000000000000000000000000000000002";

describe("LeaderboardModule.getTopTraders()", () => {
  let client: CoralSwapClient;
  let leaderboard: LeaderboardModule;
  let getSwapHistorySpy: jest.SpyInstance;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    leaderboard = new LeaderboardModule(client);

    // Default current ledger: 50000
    jest.spyOn(client, "getCurrentLedger").mockResolvedValue(50000);
      secretKey: "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU",
    });

    leaderboard = new LeaderboardModule(client, { stableAddresses: [STABLE_ADDR] });

    // Mock getCurrentLedger to return a fixed ledger sequence
    jest.spyOn(client, "getCurrentLedger").mockResolvedValue(100000);

    // Mock factory getter
    jest.spyOn(client, "factory", "get").mockReturnValue({
      getAllPairs: jest.fn().mockResolvedValue([PAIR_1, PAIR_2]),
    } as any);

    // Mock pair.getTokens and pair.getReserves
    jest.spyOn(client, "pair").mockImplementation((pairAddr: string): any => {
      if (pairAddr === PAIR_1) {
        return {
          getTokens: jest.fn().mockResolvedValue({ token0: STABLE_ADDR, token1: TOKEN_A }),
          getReserves: jest.fn().mockResolvedValue({ reserve0: 1000000n, reserve1: 1000000n }), // 1:1 price
        };
      }
      if (pairAddr === PAIR_2) {
        return {
          getTokens: jest.fn().mockResolvedValue({ token0: STABLE_ADDR, token1: TOKEN_B }),
          getReserves: jest.fn().mockResolvedValue({ reserve0: 2000000n, reserve1: 1000000n }), // 2 USD per TOKEN_B
        };
      }
      return {
        getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_A, token1: TOKEN_B }),
        getReserves: jest.fn().mockResolvedValue({ reserve0: 1000000n, reserve1: 1000000n }),
      };
    });

    // Mock lpToken metadata
    jest.spyOn(client, "lpToken").mockImplementation((tokenAddr: string): any => {
      return {
        metadata: jest.fn().mockResolvedValue({
          name: "Token",
          symbol: "TKN",
          decimals: 7,
        }),
      };
    });

    // Spy on SwapModule's getSwapHistory
    getSwapHistorySpy = jest.spyOn(SwapModule.prototype, "getSwapHistory");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
  describe("Validation & Options Check", () => {
    it("throws ValidationError for invalid type", async () => {
      await expect(
        leaderboard.getLeaderboard("invalid-type" as any),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for invalid period", async () => {
      await expect(
        leaderboard.getLeaderboard("trader", { period: "invalid-period" as any }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for invalid pairAddress", async () => {
      await expect(
        leaderboard.getLeaderboard("trader", { period: "24h", pairAddress: "invalid-addr" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("Trader Leaderboard", () => {
    it("returns correctly sorted and ranked trader entries", async () => {
      // 50000 is current ledger.
      // 24h period is 17280 ledgers.
      // Current range is [32720, 50000].
      // Previous range is [15440, 32720].
      const events = [
        // Current period swaps
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1000n, ledger: 40000 }),
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_2, amountIn: 5000n, ledger: 41000 }),
        makeRawSwapEvent({ contractId: PAIR_B, sender: USER_1, amountIn: 2000n, ledger: 42000 }),
        // Previous period swaps for USER_1 (to calculate change24h)
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1500n, ledger: 20000 }),
      ];

      jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("trader", { period: "24h" });

      expect(result).toHaveLength(2);

      // USER_2 has 5000n current volume, prev volume is 0
      expect(result[0].address).toBe(USER_2);
      expect(result[0].metricValue).toBe(5000n);
      expect(result[0].rank).toBe(1);
      expect(result[0].change24h).toBe(100);

      // USER_1 has 3000n current volume, prev volume is 1500n -> +100% change
      expect(result[1].address).toBe(USER_1);
      expect(result[1].metricValue).toBe(3000n);
      expect(result[1].rank).toBe(2);
      expect(result[1].change24h).toBe(100);
    });

    it("filters by pairAddress option", async () => {
      const events = [
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1000n, ledger: 40000 }),
        makeRawSwapEvent({ contractId: PAIR_B, sender: USER_2, amountIn: 5000n, ledger: 41000 }),
      ];

      const spy = jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("trader", {
        period: "24h",
        pairAddress: PAIR_A,
      });

      // Verification that pairAddress is passed to getEvents query filter
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [
            expect.objectContaining({
              contractIds: [PAIR_A],
            }),
          ],
        }),
      );

      // Only USER_1 (Pair A swap) should be aggregated
      expect(result).toHaveLength(1);
      expect(result[0].address).toBe(USER_1);
      expect(result[0].metricValue).toBe(1000n);
    });

    it("respects limit option", async () => {
      const events = [
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1000n, ledger: 40000 }),
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_2, amountIn: 5000n, ledger: 41000 }),
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_3, amountIn: 3000n, ledger: 42000 }),
      ];

      jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("trader", {
        period: "24h",
        limit: 2,
      });

      expect(result).toHaveLength(2);
      expect(result[0].address).toBe(USER_2); // rank 1
      expect(result[1].address).toBe(USER_3); // rank 2
    });
  });

  describe("LP Leaderboard", () => {
    it("returns correctly sorted and ranked LP entries", async () => {
      // 50000 is current ledger.
      // 24h period is 17280 ledgers.
      // Current range is [32720, 50000].
      // Previous range is [15440, 32720].
      const events = [
        // Current period liquidity additions
        makeRawAddLiquidityEvent({ contractId: PAIR_A, provider: USER_1, liquidity: 1000n, ledger: 40000 }),
        makeRawAddLiquidityEvent({ contractId: PAIR_A, provider: USER_2, liquidity: 5000n, ledger: 41000 }),
        makeRawAddLiquidityEvent({ contractId: PAIR_B, provider: USER_1, liquidity: 2000n, ledger: 42000 }),
        // Previous period liquidity additions for USER_1 (to calculate change24h)
        makeRawAddLiquidityEvent({ contractId: PAIR_A, provider: USER_1, liquidity: 4000n, ledger: 20000 }),
      ];

      jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("lp", { period: "24h" });

      expect(result).toHaveLength(2);

      // USER_2 has 5000n current yield, prev yield is 0
      expect(result[0].address).toBe(USER_2);
      expect(result[0].metricValue).toBe(5000n);
      expect(result[0].rank).toBe(1);
      expect(result[0].change24h).toBe(100);

      // USER_1 has 3000n current yield, prev yield is 4000n -> -25% change
      expect(result[1].address).toBe(USER_1);
      expect(result[1].metricValue).toBe(3000n);
      expect(result[1].rank).toBe(2);
      expect(result[1].change24h).toBe(-25);
    });
  it("returns empty array if no swap events found", async () => {
    getSwapHistorySpy.mockResolvedValue([]);
    const result = await leaderboard.getTopTraders();
    expect(result).toEqual([]);
  });

  it("ranks traders by totalVolumeUSD descending", async () => {
    getSwapHistorySpy.mockResolvedValue([
      // Trader 1 (USER_1) - 100 tokens of STABLE_ADDR (100 USD)
      {
        txHash: "tx1",
        amountIn: 1000000000n, // 100 tokens (7 decimals)
        amountOut: 900000000n,
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_A,
        sender: "USER_1",
        pairAddress: PAIR_1,
        ledger: 99000,
        timestamp: 1234567,
        feeBps: 30,
      },
      // Trader 2 (USER_2) - 300 tokens of STABLE_ADDR (300 USD)
      {
        txHash: "tx2",
        amountIn: 3000000000n, // 300 tokens (7 decimals)
        amountOut: 2800000000n,
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_A,
        sender: "USER_2",
        pairAddress: PAIR_1,
        ledger: 99100,
        timestamp: 1234580,
        feeBps: 30,
      },
    ]);

    const result = await leaderboard.getTopTraders();
    expect(result).toHaveLength(2);
    expect(result[0].address).toBe("USER_2");
    expect(result[0].totalVolumeUSD).toBeCloseTo(300);
    expect(result[1].address).toBe("USER_1");
    expect(result[1].totalVolumeUSD).toBeCloseTo(100);
  });

  it("accurately calculates tradeCount, avgTradeSize and favoritePool", async () => {
    getSwapHistorySpy.mockResolvedValue([
      {
        txHash: "tx1",
        amountIn: 1000000000n, // 100 USD
        amountOut: 900000000n,
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_A,
        sender: "USER_1",
        pairAddress: PAIR_1,
        ledger: 99000,
        timestamp: 1234567,
        feeBps: 30,
      },
      {
        txHash: "tx2",
        amountIn: 2000000000n, // 200 USD
        amountOut: 1800000000n,
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_A,
        sender: "USER_1",
        pairAddress: PAIR_1,
        ledger: 99100,
        timestamp: 1234580,
        feeBps: 30,
      },
      {
        txHash: "tx3",
        amountIn: 5000000000n, // 500 USD
        amountOut: 4500000000n,
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_B,
        sender: "USER_1",
        pairAddress: PAIR_2,
        ledger: 99200,
        timestamp: 1234600,
        feeBps: 30,
      },
    ]);

    const result = await leaderboard.getTopTraders();
    expect(result).toHaveLength(1);
    const u1 = result[0];
    expect(u1.address).toBe("USER_1");
    expect(u1.tradeCount).toBe(3);
    expect(u1.totalVolumeUSD).toBeCloseTo(800);
    expect(u1.avgTradeSize).toBeCloseTo(800 / 3);
    expect(u1.favoritePool).toBe(PAIR_1); // PAIR_1 used twice, PAIR_2 once
  });

  it("calculates winRate correctly where output value > input value", async () => {
    getSwapHistorySpy.mockResolvedValue([
      // Win: input 100 stable, output value 105 (say, output token price is 1.0, output amount is 105)
      // Since TOKEN_A price is 1.0 (reserves 1:1), 105 tokens of TOKEN_A is 105 USD.
      {
        txHash: "tx1",
        amountIn: 1000000000n, // 100 USD input
        amountOut: 1050000000n, // 105 USD output
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_A,
        sender: "USER_1",
        pairAddress: PAIR_1,
        ledger: 99000,
        timestamp: 1234567,
        feeBps: 30,
      },
      // Loss: input 100 stable, output value 95
      {
        txHash: "tx2",
        amountIn: 1000000000n, // 100 USD input
        amountOut: 950000000n, // 95 USD output
        tokenIn: STABLE_ADDR,
        tokenOut: TOKEN_A,
        sender: "USER_1",
        pairAddress: PAIR_1,
        ledger: 99100,
        timestamp: 1234580,
        feeBps: 30,
      },
    ]);

    const result = await leaderboard.getTopTraders();
    expect(result).toHaveLength(1);
    expect(result[0].winRate).toBe(50); // 1 win out of 2 trades
  });

  it("respects the limit option", async () => {
    getSwapHistorySpy.mockResolvedValue([
      { txHash: "tx1", amountIn: 1000000000n, amountOut: 900000000n, tokenIn: STABLE_ADDR, tokenOut: TOKEN_A, sender: "USER_1", pairAddress: PAIR_1, ledger: 99000, timestamp: 1234567, feeBps: 30 },
      { txHash: "tx2", amountIn: 2000000000n, amountOut: 1800000000n, tokenIn: STABLE_ADDR, tokenOut: TOKEN_A, sender: "USER_2", pairAddress: PAIR_1, ledger: 99100, timestamp: 1234580, feeBps: 30 },
      { txHash: "tx3", amountIn: 3000000000n, amountOut: 2700000000n, tokenIn: STABLE_ADDR, tokenOut: TOKEN_A, sender: "USER_3", pairAddress: PAIR_1, ledger: 99200, timestamp: 1234590, feeBps: 30 },
    ]);

    const result = await leaderboard.getTopTraders({ limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].address).toBe("USER_3"); // 300 USD
    expect(result[1].address).toBe("USER_2"); // 200 USD
  });
});
