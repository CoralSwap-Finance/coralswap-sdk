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
