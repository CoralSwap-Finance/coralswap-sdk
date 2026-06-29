import { PortfolioModule } from "../src/modules/portfolio";

// Real valid Stellar addresses for address validation
const OWNER =
  "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAIR_A =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const PAIR_B =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const TOKEN_0 =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_1 =
  "CBQHNAXSI55GX3BZPHDKBE4IMPBPJGZBDZIUMSOUAKVISQ3DTLAZQNSC";
const LP_TOKEN =
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WRTP5AP5WOJVRY3WNX";

// ---------------------------------------------------------------------------
// Helpers to build ScVal-like objects matching the raw event decode pattern
// ---------------------------------------------------------------------------

function makeI128(value: bigint) {
  const lo = value & BigInt("0xFFFFFFFFFFFFFFFF");
  const hi = value >> 64n;
  return {
    i128: () => ({
      lo: () => ({ toString: () => lo.toString() }),
      hi: () => ({ toString: () => hi.toString() }),
    }),
  };
}

function makeAddr(addr: string) {
  return {
    address: () => ({ toString: () => addr }),
  };
}

function makeScMap(fields: Record<string, unknown>) {
  const entries = Object.entries(fields).map(([k, v]) => ({
    key: { sym: () => ({ toString: () => k }) },
    val: v,
  }));
  return { map: () => entries };
}

function makeLiquidityEvent(
  provider: string,
  amountA: bigint,
  amountB: bigint,
  liquidity: bigint,
) {
  return {
    value: makeScMap({
      provider: makeAddr(provider),
      amount_a: makeI128(amountA),
      amount_b: makeI128(amountB),
      liquidity: makeI128(liquidity),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

interface MockClientOptions {
  lpBalance?: bigint;
  totalSupply?: bigint;
  reserve0?: bigint;
  reserve1?: bigint;
  addEvents?: ReturnType<typeof makeLiquidityEvent>[];
  removeEvents?: ReturnType<typeof makeLiquidityEvent>[];
  pairs?: string[];
  currentLedger?: number;
}

const makeMockClient = (opts: MockClientOptions = {}) => {
  const {
    lpBalance = 500n,
    totalSupply = 1_000n,
    reserve0 = 1_000_0000000n, // 1000 tokens (7 decimals)
    reserve1 = 2_000_0000000n, // 2000 tokens (7 decimals)
    addEvents = [],
    removeEvents = [],
    pairs = [PAIR_A],
    currentLedger = 5000,
  } = opts;

  const mockLpToken = {
    balance: jest.fn().mockResolvedValue(lpBalance),
    totalSupply: jest.fn().mockResolvedValue(totalSupply),
  };

  const mockPair = {
    getReserves: jest
      .fn()
      .mockResolvedValue({ reserve0, reserve1 }),
    getTokens: jest
      .fn()
      .mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
    getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
    getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
  };

  const mockServer = {
    getEvents: jest.fn().mockImplementation(
      (req: { filters: Array<{ topics: string[][] }> }) => {
        const topic = req.filters?.[0]?.topics?.[0]?.[0];
        const events =
          topic === "add_liquidity"
            ? addEvents
            : topic === "remove_liquidity"
            ? removeEvents
            : [];
        return Promise.resolve({ events });
      },
    ),
  };

  return {
    pair: jest.fn().mockReturnValue(mockPair),
    lpToken: jest.fn().mockReturnValue(mockLpToken),
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(pairs),
    },
    server: mockServer,
    getCurrentLedger: jest.fn().mockResolvedValue(currentLedger),
    _mockPair: mockPair,
    _mockLpToken: mockLpToken,
    _mockServer: mockServer,
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PortfolioModule.getPortfolioPnL", () => {
  describe("brand-new / empty positions", () => {
    it("returns zero PnL when address has no LP balance", async () => {
      const client = makeMockClient({ lpBalance: 0n });
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: { [TOKEN_0]: 1, [TOKEN_1]: 2 },
        startLedger: 0,
      });

      expect(result.totalPnLUSD).toBe(0);
      expect(result.totalPnLPercent).toBe(0);
      expect(result.byPosition).toHaveLength(0);
    });

    it("returns zero PnL when no pairs exist", async () => {
      const client = makeMockClient({ pairs: [] });
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, { startLedger: 0 });

      expect(result.totalPnLUSD).toBe(0);
      expect(result.byPosition).toHaveLength(0);
    });

    it("returns zero PnL when there are no events (brand-new position)", async () => {
      // LP balance > 0 but no historical events in window
      const client = makeMockClient({
        lpBalance: 500n,
        totalSupply: 1_000n,
        addEvents: [],
        removeEvents: [],
      });
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: { [TOKEN_0]: 1, [TOKEN_1]: 2 },
        startLedger: 0,
      });

      // entryValueUSD = 0 (no events), currentValueUSD > 0
      // netPnL = currentValueUSD - 0 (no cost basis found in window)
      expect(result.byPosition).toHaveLength(1);
      const pos = result.byPosition[0];
      expect(pos.entryValueUSD).toBe(0);
    });
  });

  describe("position with full deposit history", () => {
    it("correctly computes PnL for a simple deposit", async () => {
      // Deposited: 100 token0 + 200 token1
      const addEvent = makeLiquidityEvent(
        OWNER,
        100_0000000n, // 100 tokens
        200_0000000n, // 200 tokens
        500n,
      );

      // Pool: 1000 token0, 2000 token1, LP balance 500/1000
      const client = makeMockClient({
        lpBalance: 500n,
        totalSupply: 1_000n,
        reserve0: 1_000_0000000n,
        reserve1: 2_000_0000000n,
        addEvents: [addEvent],
      });
      const mod = new PortfolioModule(client as never);

      const prices = { [TOKEN_0]: 1.0, [TOKEN_1]: 0.5 };
      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: prices,
        startLedger: 0,
      });

      expect(result.byPosition).toHaveLength(1);
      const pos = result.byPosition[0];
      expect(pos.pairAddress).toBe(PAIR_A);

      // entryValueUSD = 100 * 1.0 + 200 * 0.5 = 100 + 100 = 200
      expect(pos.entryValueUSD).toBeCloseTo(200, 4);

      // currentValueUSD = (500/1000) * (1000*1.0 + 2000*0.5) = 0.5 * 2000 = 1000
      expect(pos.currentValueUSD).toBeCloseTo(1000, 4);

      // feeEarned = current - entry = 800 (LP position grew beyond cost basis)
      expect(pos.feeEarnedUSD).toBeCloseTo(800, 4);
      expect(pos.ilUSD).toBeCloseTo(0, 4);

      // netPnL = currentValue - entryValue = 800
      expect(pos.netPnLUSD).toBeCloseTo(800, 4);

      // Invariant: netPnL === feeEarned - IL
      expect(pos.netPnLUSD).toBeCloseTo(pos.feeEarnedUSD - pos.ilUSD, 6);
    });

    it("reports IL when LP position is worth less than cost basis", async () => {
      // Deposited 200 + 200 tokens into the pool
      const addEvent = makeLiquidityEvent(
        OWNER,
        200_0000000n,
        200_0000000n,
        500n,
      );

      // Current reserves skewed: price diverged (more token1 accumulated)
      const client = makeMockClient({
        lpBalance: 500n,
        totalSupply: 1_000n,
        reserve0: 100_0000000n,  // less token0
        reserve1: 400_0000000n,  // more token1
        addEvents: [addEvent],
      });
      const mod = new PortfolioModule(client as never);

      // Same price for both tokens
      const prices = { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 };
      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: prices,
        startLedger: 0,
      });

      const pos = result.byPosition[0];

      // entryValue = 200 + 200 = 400
      expect(pos.entryValueUSD).toBeCloseTo(400, 4);

      // currentValue = 0.5 * (100 + 400) = 250
      expect(pos.currentValueUSD).toBeCloseTo(250, 4);

      // IL is positive (LP underperformed vs holding)
      expect(pos.ilUSD).toBeCloseTo(150, 4);
      expect(pos.feeEarnedUSD).toBeCloseTo(0, 4);

      // netPnL = 250 - 400 = -150
      expect(pos.netPnLUSD).toBeCloseTo(-150, 4);

      // Invariant
      expect(pos.netPnLUSD).toBeCloseTo(pos.feeEarnedUSD - pos.ilUSD, 6);
    });

    it("works without prices (USD values are zero)", async () => {
      const addEvent = makeLiquidityEvent(OWNER, 100_0000000n, 200_0000000n, 500n);
      const client = makeMockClient({ addEvents: [addEvent] });
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, { startLedger: 0 });

      const pos = result.byPosition[0];
      expect(pos.entryValueUSD).toBe(0);
      expect(pos.currentValueUSD).toBe(0);
      expect(pos.netPnLUSD).toBe(0);
    });
  });

  describe("partial liquidity removals", () => {
    it("reduces cost basis proportionally on partial removal", async () => {
      // Deposited 200 + 200
      const addEvent = makeLiquidityEvent(
        OWNER,
        200_0000000n,
        200_0000000n,
        500n,
      );
      // Removed 50 + 50 (25% of position)
      const removeEvent = makeLiquidityEvent(
        OWNER,
        50_0000000n,
        50_0000000n,
        125n,
      );

      const client = makeMockClient({
        lpBalance: 375n,
        totalSupply: 875n,
        reserve0: 750_0000000n,
        reserve1: 750_0000000n,
        addEvents: [addEvent],
        removeEvents: [removeEvent],
      });
      const mod = new PortfolioModule(client as never);

      const prices = { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 };
      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: prices,
        startLedger: 0,
      });

      const pos = result.byPosition[0];

      // netDeposit = 200-50 = 150 for each token
      // entryValueUSD = 150 * 1 + 150 * 1 = 300
      expect(pos.entryValueUSD).toBeCloseTo(300, 4);

      // currentValueUSD = (375/875) * (750 + 750) = ~642.857
      expect(pos.currentValueUSD).toBeGreaterThan(600);
    });

    it("ignores remove events from other addresses", async () => {
      const OTHER =
        "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGEWDHDAEYXIDZEBC7MCJNC";

      const addEvent = makeLiquidityEvent(OWNER, 100_0000000n, 100_0000000n, 500n);
      // Remove by a different address — should NOT reduce OWNER's cost basis
      const removeByOther = makeLiquidityEvent(OTHER, 50_0000000n, 50_0000000n, 250n);

      const client = makeMockClient({
        addEvents: [addEvent],
        removeEvents: [removeByOther],
      });
      const mod = new PortfolioModule(client as never);

      const prices = { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 };
      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: prices,
        startLedger: 0,
      });

      const pos = result.byPosition[0];
      // netDeposit should still be 100+100 = 200
      expect(pos.entryValueUSD).toBeCloseTo(200, 4);
    });
  });

  describe("multiple add/remove events for same pool", () => {
    it("aggregates multiple add events correctly", async () => {
      const add1 = makeLiquidityEvent(OWNER, 100_0000000n, 100_0000000n, 250n);
      const add2 = makeLiquidityEvent(OWNER, 100_0000000n, 100_0000000n, 250n);

      const client = makeMockClient({
        lpBalance: 500n,
        totalSupply: 1_000n,
        reserve0: 1_000_0000000n,
        reserve1: 1_000_0000000n,
        addEvents: [add1, add2],
      });
      const mod = new PortfolioModule(client as never);

      const prices = { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 };
      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: prices,
        startLedger: 0,
      });

      const pos = result.byPosition[0];
      // Total deposited: 200 + 200 = 400
      expect(pos.entryValueUSD).toBeCloseTo(400, 4);
    });

    it("handles add then full remove (netDeposit → 0)", async () => {
      const addEvent = makeLiquidityEvent(OWNER, 100_0000000n, 100_0000000n, 500n);
      const removeEvent = makeLiquidityEvent(OWNER, 100_0000000n, 100_0000000n, 500n);

      // Balance went to 0 so this pair won't appear in activePairs — return empty
      const client = makeMockClient({
        lpBalance: 0n,
        totalSupply: 0n,
        addEvents: [addEvent],
        removeEvents: [removeEvent],
      });
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: { [TOKEN_0]: 1, [TOKEN_1]: 1 },
        startLedger: 0,
      });

      // Fully withdrawn → balance = 0 → filtered out
      expect(result.byPosition).toHaveLength(0);
      expect(result.totalPnLUSD).toBe(0);
    });
  });

  describe("multiple pairs", () => {
    it("sums PnL across multiple pairs", async () => {
      const addEventPairA = makeLiquidityEvent(OWNER, 100_0000000n, 100_0000000n, 500n);
      const addEventPairB = makeLiquidityEvent(OWNER, 50_0000000n, 50_0000000n, 500n);

      const mockLpToken = {
        balance: jest.fn().mockResolvedValue(500n),
        totalSupply: jest.fn().mockResolvedValue(1_000n),
      };

      const mockPairA = {
        getReserves: jest.fn().mockResolvedValue({ reserve0: 1_000_0000000n, reserve1: 1_000_0000000n }),
        getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
        getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
        getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
      };

      const mockPairB = {
        getReserves: jest.fn().mockResolvedValue({ reserve0: 500_0000000n, reserve1: 500_0000000n }),
        getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
        getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
        getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
      };

      const mockServer = {
        getEvents: jest.fn().mockImplementation(
          (req: { filters: Array<{ contractIds: string[]; topics: string[][] }> }) => {
            const contractId = req.filters?.[0]?.contractIds?.[0];
            const topic = req.filters?.[0]?.topics?.[0]?.[0];
            let events: ReturnType<typeof makeLiquidityEvent>[] = [];
            if (topic === "add_liquidity") {
              events = contractId === PAIR_A ? [addEventPairA] : [addEventPairB];
            }
            return Promise.resolve({ events });
          },
        ),
      };

      const client = {
        pair: jest.fn().mockImplementation((addr: string) =>
          addr === PAIR_A ? mockPairA : mockPairB,
        ),
        lpToken: jest.fn().mockReturnValue(mockLpToken),
        factory: { getAllPairs: jest.fn().mockResolvedValue([PAIR_A, PAIR_B]) },
        server: mockServer,
        getCurrentLedger: jest.fn().mockResolvedValue(5000),
      };

      const mod = new PortfolioModule(client as never);
      const prices = { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 };
      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: prices,
        startLedger: 0,
      });

      expect(result.byPosition).toHaveLength(2);
      expect(result.totalPnLUSD).toBeCloseTo(
        result.byPosition.reduce((s, p) => s + p.netPnLUSD, 0),
        6,
      );
    });
  });

  describe("aggregate totals", () => {
    it("totalPnLPercent is 0 when entryValueUSD is 0", async () => {
      const client = makeMockClient({ addEvents: [] }); // no events → entryValue = 0
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: { [TOKEN_0]: 1, [TOKEN_1]: 1 },
        startLedger: 0,
      });

      expect(result.totalPnLPercent).toBe(0);
    });

    it("uses factory to discover all pairs when none specified", async () => {
      const client = makeMockClient({ lpBalance: 0n });
      const mod = new PortfolioModule(client as never);

      await mod.getPortfolioPnL(OWNER, { startLedger: 0 });

      expect(client.factory.getAllPairs).toHaveBeenCalledTimes(1);
    });

    it("skips factory when pairAddresses provided", async () => {
      const client = makeMockClient({ lpBalance: 0n });
      const mod = new PortfolioModule(client as never);

      await mod.getPortfolioPnL(OWNER, {
        pairAddresses: [PAIR_A],
        startLedger: 0,
      });

      expect(client.factory.getAllPairs).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("returns [] when getEvents throws", async () => {
      const client = makeMockClient();
      (client._mockServer.getEvents as jest.Mock).mockRejectedValue(
        new Error("RPC failure"),
      );
      const mod = new PortfolioModule(client as never);

      const result = await mod.getPortfolioPnL(OWNER, {
        tokenPricesUSD: { [TOKEN_0]: 1, [TOKEN_1]: 1 },
        startLedger: 0,
      });

      // Events failed → entryValue = 0, currentValue from reserves
      expect(result.byPosition).toHaveLength(1);
      expect(result.byPosition[0].entryValueUSD).toBe(0);
    });

    it("resolves startLedger automatically when not provided", async () => {
      // Need balance > 0 so activePairs is non-empty and resolveStartLedger is called
      const client = makeMockClient({ currentLedger: 200_000, lpBalance: 500n });
      const mod = new PortfolioModule(client as never);

      await mod.getPortfolioPnL(OWNER);

      expect(client.getCurrentLedger).toHaveBeenCalledTimes(1);
    });
  });
});
