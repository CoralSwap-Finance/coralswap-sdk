/**
 * Comprehensive tests for PortfolioModule:
 *   getPortfolio()       — position snapshot with USD values
 *   getPortfolioValue()  — aggregate USD value + 24 h activity delta
 *   getPortfolioPnL()    — fee / IL / netPnL decomposition
 *
 * All RPC interactions and price feeds are mocked — no live network required.
 */
import { PortfolioModule } from "../src/modules/portfolio";

// ---------------------------------------------------------------------------
// Valid Stellar addresses (checksum-verified)
// ---------------------------------------------------------------------------

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
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";

// ---------------------------------------------------------------------------
// Raw-event helpers (mirrors the PortfolioModule internal decode pattern)
// ---------------------------------------------------------------------------

function makeI128(v: bigint) {
  const lo = v & BigInt("0xFFFFFFFFFFFFFFFF");
  const hi = v >> 64n;
  return {
    i128: () => ({
      lo: () => ({ toString: () => lo.toString() }),
      hi: () => ({ toString: () => hi.toString() }),
    }),
  };
}

function makeAddr(a: string) {
  return { address: () => ({ toString: () => a }) };
}

function makeScMap(fields: Record<string, unknown>) {
  return {
    map: () =>
      Object.entries(fields).map(([k, v]) => ({
        key: { sym: () => ({ toString: () => k }) },
        val: v,
      })),
  };
}

function makeLiqEvent(
  provider: string,
  amountA: bigint,
  amountB: bigint,
  liquidity = 500n,
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
// Mock-client factory
// ---------------------------------------------------------------------------

interface MockOpts {
  lpBalance?: bigint;
  totalSupply?: bigint;
  reserve0?: bigint;
  reserve1?: bigint;
  addEvents?: ReturnType<typeof makeLiqEvent>[];
  removeEvents?: ReturnType<typeof makeLiqEvent>[];
  pairs?: string[];
  currentLedger?: number;
  token0?: string;
  token1?: string;
}

function makeMockClient(opts: MockOpts = {}) {
  const {
    lpBalance = 500n,
    totalSupply = 1_000n,
    reserve0 = 1_000_0000000n,
    reserve1 = 2_000_0000000n,
    addEvents = [],
    removeEvents = [],
    pairs = [PAIR_A],
    currentLedger = 5_000,
    token0 = TOKEN_0,
    token1 = TOKEN_1,
  } = opts;

  const mockLpToken = {
    balance: jest.fn().mockResolvedValue(lpBalance),
    totalSupply: jest.fn().mockResolvedValue(totalSupply),
  };

  const mockPair = {
    getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
    getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
    getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
    getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
  };

  const mockServer = {
    getEvents: jest
      .fn()
      .mockImplementation(
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
    factory: { getAllPairs: jest.fn().mockResolvedValue(pairs) },
    server: mockServer,
    getCurrentLedger: jest.fn().mockResolvedValue(currentLedger),
    _mockPair: mockPair,
    _mockLpToken: mockLpToken,
    _mockServer: mockServer,
  };
}

// ---------------------------------------------------------------------------
// getPortfolio
// ---------------------------------------------------------------------------

describe("PortfolioModule.getPortfolio", () => {
  it("TC-01: returns empty portfolio when address has no LP positions", async () => {
    const client = makeMockClient({ lpBalance: 0n });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolio(OWNER);

    expect(result.owner).toBe(OWNER);
    expect(result.totalValueUSD).toBe(0);
    expect(result.positions).toHaveLength(0);
  });

  it("TC-02: returns single position with correct USD valuation", async () => {
    // Pool: 1000 token0 @ $2 + 2000 token1 @ $1 = $4000 total
    // LP holds 50%: valueUSD = $2000
    const client = makeMockClient({
      lpBalance: 500n,
      totalSupply: 1_000n,
      reserve0: 1_000_0000000n, // 1000 tokens
      reserve1: 2_000_0000000n, // 2000 tokens
    });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolio(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 2.0, [TOKEN_1]: 1.0 },
    });

    expect(result.positions).toHaveLength(1);
    const pos = result.positions[0];
    expect(pos.pairAddress).toBe(PAIR_A);
    expect(pos.token0).toBe(TOKEN_0);
    expect(pos.token1).toBe(TOKEN_1);
    // 50% of (1000*2 + 2000*1) = 50% of 4000 = 2000
    expect(pos.valueUSD).toBeCloseTo(2000, 4);
    expect(result.totalValueUSD).toBeCloseTo(2000, 4);
  });

  it("TC-03: returns zero valueUSD when no price feed supplied", async () => {
    const client = makeMockClient();
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolio(OWNER); // no tokenPricesUSD

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].valueUSD).toBe(0);
    expect(result.totalValueUSD).toBe(0);
  });

  it("TC-04: returns zero valueUSD for pool with zero reserves", async () => {
    const client = makeMockClient({ reserve0: 0n, reserve1: 0n });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolio(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
    });

    expect(result.positions[0].valueUSD).toBe(0);
    expect(result.totalValueUSD).toBe(0);
  });

  it("TC-05: aggregates multiple positions correctly", async () => {
    // Two pairs, each worth $500 at 50% share
    const mockLpToken = {
      balance: jest.fn().mockResolvedValue(500n),
      totalSupply: jest.fn().mockResolvedValue(1_000n),
    };
    const makePairMock = (r0: bigint, r1: bigint) => ({
      getReserves: jest.fn().mockResolvedValue({ reserve0: r0, reserve1: r1 }),
      getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
      getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
      getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
    });

    const pairAMock = makePairMock(500_0000000n, 500_0000000n);
    const pairBMock = makePairMock(500_0000000n, 500_0000000n);

    const client = {
      pair: jest.fn().mockImplementation((addr: string) =>
        addr === PAIR_A ? pairAMock : pairBMock,
      ),
      lpToken: jest.fn().mockReturnValue(mockLpToken),
      factory: { getAllPairs: jest.fn().mockResolvedValue([PAIR_A, PAIR_B]) },
      server: { getEvents: jest.fn().mockResolvedValue({ events: [] }) },
      getCurrentLedger: jest.fn().mockResolvedValue(5_000),
    };

    const mod = new PortfolioModule(client as never);
    const result = await mod.getPortfolio(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
    });

    expect(result.positions).toHaveLength(2);
    // Each: 50% of (500+500) = 500; total = 1000
    expect(result.totalValueUSD).toBeCloseTo(1000, 4);
  });

  it("TC-06: uses factory to discover pairs when pairAddresses not specified", async () => {
    const client = makeMockClient({ lpBalance: 0n });
    const mod = new PortfolioModule(client as never);

    await mod.getPortfolio(OWNER);

    expect(client.factory.getAllPairs).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPortfolioValue
// ---------------------------------------------------------------------------

describe("PortfolioModule.getPortfolioValue", () => {
  it("TC-07: returns zeros for address with no active positions", async () => {
    const client = makeMockClient({ lpBalance: 0n });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioValue(OWNER, { startLedger24h: 0 });

    expect(result.totalValueUSD).toBe(0);
    expect(result.change24hUSD).toBe(0);
    expect(result.change24hPercent).toBe(0);
    expect(result.positions).toHaveLength(0);
  });

  it("TC-08: positive change24h when liquidity added in window", async () => {
    // LP added 100 token0 + 200 token1 in the last 24 h
    const addEv = makeLiqEvent(OWNER, 100_0000000n, 200_0000000n);
    const client = makeMockClient({ addEvents: [addEv] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioValue(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 0.5 },
      startLedger24h: 0,
    });

    // added = 100*1 + 200*0.5 = 200
    expect(result.positions[0].change24hUSD).toBeCloseTo(200, 4);
    expect(result.change24hUSD).toBeCloseTo(200, 4);
    expect(result.change24hUSD).toBeGreaterThan(0);
  });

  it("TC-09: negative change24h when liquidity removed in window", async () => {
    const removeEv = makeLiqEvent(OWNER, 50_0000000n, 100_0000000n);
    const client = makeMockClient({ removeEvents: [removeEv] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioValue(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger24h: 0,
    });

    // removed = 50 + 100 = 150 → change = -150
    expect(result.change24hUSD).toBeCloseTo(-150, 4);
    expect(result.change24hUSD).toBeLessThan(0);
  });

  it("TC-10: change24h is zero when no events in window", async () => {
    const client = makeMockClient(); // no events
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioValue(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger24h: 0,
    });

    expect(result.change24hUSD).toBe(0);
    expect(result.change24hPercent).toBe(0);
  });

  it("TC-11: batch efficiency — getCurrentLedger called exactly once", async () => {
    const mockLpToken = {
      balance: jest.fn().mockResolvedValue(500n),
      totalSupply: jest.fn().mockResolvedValue(1_000n),
    };
    const makePair = () => ({
      getReserves: jest.fn().mockResolvedValue({ reserve0: 1_000_0000000n, reserve1: 1_000_0000000n }),
      getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
      getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
      getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
    });

    const client = {
      pair: jest.fn().mockImplementation(() => makePair()),
      lpToken: jest.fn().mockReturnValue(mockLpToken),
      factory: { getAllPairs: jest.fn().mockResolvedValue([PAIR_A, PAIR_B]) },
      server: { getEvents: jest.fn().mockResolvedValue({ events: [] }) },
      getCurrentLedger: jest.fn().mockResolvedValue(20_000),
    };

    const mod = new PortfolioModule(client as never);
    await mod.getPortfolioValue(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
    });

    // All pairs share one getCurrentLedger call
    expect(client.getCurrentLedger).toHaveBeenCalledTimes(1);
  });

  it("TC-12: change24hPercent correctly derived from base and delta", async () => {
    // Current value $1000, added $200 in 24h → base = $800, change = 25%
    const addEv = makeLiqEvent(OWNER, 200_0000000n, 0n);
    const client = makeMockClient({
      reserve0: 1_000_0000000n,
      reserve1: 0n,
      addEvents: [addEv],
    });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioValue(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 2.0, [TOKEN_1]: 0 },
      startLedger24h: 0,
    });

    // totalValueUSD = (500/1000) * (1000 * 2 + 0) = 1000
    // change24h = 200 * 2 = 400
    // base = 1000 - 400 = 600
    // percent = 400/600 * 100 ≈ 66.67
    expect(result.change24hPercent).toBeCloseTo(
      (result.change24hUSD / (result.totalValueUSD - result.change24hUSD)) * 100,
      4,
    );
  });

  it("TC-13: ignores events from other addresses in 24h delta", async () => {
    const OTHER =
      "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGEWDHDAEYXIDZEBC7MCJNC";
    const addByOther = makeLiqEvent(OTHER, 100_0000000n, 100_0000000n);
    const client = makeMockClient({ addEvents: [addByOther] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioValue(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger24h: 0,
    });

    expect(result.change24hUSD).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPortfolioPnL
// ---------------------------------------------------------------------------

describe("PortfolioModule.getPortfolioPnL", () => {
  it("TC-14: entry value reconstructed from add events at current prices", async () => {
    // Add: 100 token0 + 200 token1
    // prices: token0=$1, token1=$0.5 → entryValueUSD = 100 + 100 = 200
    const addEv = makeLiqEvent(OWNER, 100_0000000n, 200_0000000n);
    const client = makeMockClient({ addEvents: [addEv] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 0.5 },
      startLedger: 0,
    });

    expect(result.byPosition).toHaveLength(1);
    // Manual: entryValueUSD = 100*1 + 200*0.5 = 200
    expect(result.byPosition[0].entryValueUSD).toBeCloseTo(200, 4);
  });

  it("TC-15: feeEarnedUSD positive when LP grew above cost basis (fees > IL)", async () => {
    // Deposited 100+100 at current prices = $200 entry
    // Current LP (50% share): 0.5 * (1000*1 + 1000*1) = $1000 > $200 → fees > IL
    const addEv = makeLiqEvent(OWNER, 100_0000000n, 100_0000000n);
    const client = makeMockClient({
      reserve0: 1_000_0000000n,
      reserve1: 1_000_0000000n,
      addEvents: [addEv],
    });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger: 0,
    });

    const pos = result.byPosition[0];
    expect(pos.feeEarnedUSD).toBeGreaterThan(0);
    expect(pos.ilUSD).toBe(0);
    expect(pos.netPnLUSD).toBeGreaterThan(0);
  });

  it("TC-16: ilUSD positive and feeEarnedUSD=0 when LP shrank below cost basis", async () => {
    // Deposited 200+200 = $400 entry (at $1 each)
    // Pool skewed to fewer token0: 0.5 * (100+400) = $250 < $400 → IL dominates
    const addEv = makeLiqEvent(OWNER, 200_0000000n, 200_0000000n);
    const client = makeMockClient({
      reserve0: 100_0000000n,
      reserve1: 400_0000000n,
      addEvents: [addEv],
    });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger: 0,
    });

    const pos = result.byPosition[0];
    expect(pos.ilUSD).toBeGreaterThan(0);
    expect(pos.feeEarnedUSD).toBe(0);
    expect(pos.netPnLUSD).toBeLessThan(0);
  });

  it("TC-17: invariant netPnLUSD === feeEarnedUSD − ilUSD holds", async () => {
    const addEv = makeLiqEvent(OWNER, 150_0000000n, 300_0000000n);
    const client = makeMockClient({ addEvents: [addEv] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 2.0, [TOKEN_1]: 1.0 },
      startLedger: 0,
    });

    const pos = result.byPosition[0];
    expect(pos.netPnLUSD).toBeCloseTo(pos.feeEarnedUSD - pos.ilUSD, 8);
  });

  it("TC-18: multiple add events for same pool are aggregated", async () => {
    const add1 = makeLiqEvent(OWNER, 100_0000000n, 100_0000000n);
    const add2 = makeLiqEvent(OWNER, 50_0000000n, 50_0000000n);
    const client = makeMockClient({
      reserve0: 1_000_0000000n,
      reserve1: 1_000_0000000n,
      addEvents: [add1, add2],
    });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger: 0,
    });

    // entryValueUSD = (100+50)*1 + (100+50)*1 = 300
    expect(result.byPosition[0].entryValueUSD).toBeCloseTo(300, 4);
  });

  it("TC-19: partial removal reduces cost basis proportionally", async () => {
    // Added 200+200, then removed 50+50 → net 150+150 at $1 each = $300
    const addEv = makeLiqEvent(OWNER, 200_0000000n, 200_0000000n);
    const removeEv = makeLiqEvent(OWNER, 50_0000000n, 50_0000000n);
    const client = makeMockClient({ addEvents: [addEv], removeEvents: [removeEv] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger: 0,
    });

    expect(result.byPosition[0].entryValueUSD).toBeCloseTo(300, 4);
  });

  it("TC-20: missing price feed returns zero USD values without error", async () => {
    const addEv = makeLiqEvent(OWNER, 100_0000000n, 100_0000000n);
    const client = makeMockClient({ addEvents: [addEv] });
    const mod = new PortfolioModule(client as never);

    // No tokenPricesUSD provided
    await expect(
      mod.getPortfolioPnL(OWNER, { startLedger: 0 }),
    ).resolves.not.toThrow();

    const result = await mod.getPortfolioPnL(OWNER, { startLedger: 0 });
    const pos = result.byPosition[0];
    expect(pos.entryValueUSD).toBe(0);
    expect(pos.currentValueUSD).toBe(0);
    expect(pos.netPnLUSD).toBe(0);
  });

  it("TC-21: zero PnL returned when address has no LP balance", async () => {
    const client = makeMockClient({ lpBalance: 0n });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, { startLedger: 0 });

    expect(result.totalPnLUSD).toBe(0);
    expect(result.byPosition).toHaveLength(0);
  });

  it("TC-22: totalPnLUSD is sum of per-position netPnLUSD", async () => {
    const addEv = makeLiqEvent(OWNER, 100_0000000n, 100_0000000n);
    const client = makeMockClient({ addEvents: [addEv] });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 1.0, [TOKEN_1]: 1.0 },
      startLedger: 0,
    });

    const expectedTotal = result.byPosition.reduce(
      (s, p) => s + p.netPnLUSD,
      0,
    );
    expect(result.totalPnLUSD).toBeCloseTo(expectedTotal, 8);
  });

  it("TC-23: manual verification — deposited $200, pool grew to $500 → netPnL=$300", async () => {
    // Deposited: 100 token0, price $2 → entryValueUSD = 100 * $2 = $200
    // Current pool: 500 token0 reserve, LP holds 50%
    // currentValueUSD = 0.5 * (500 * $2) = $500
    // netPnL = 500 - 200 = $300; feeEarned = $300; IL = $0
    const addEv = makeLiqEvent(OWNER, 100_0000000n, 0n);
    const client = makeMockClient({
      lpBalance: 500n,
      totalSupply: 1_000n,
      reserve0: 500_0000000n,
      reserve1: 0n,
      addEvents: [addEv],
    });
    const mod = new PortfolioModule(client as never);

    const result = await mod.getPortfolioPnL(OWNER, {
      tokenPricesUSD: { [TOKEN_0]: 2.0, [TOKEN_1]: 0 },
      startLedger: 0,
    });

    const pos = result.byPosition[0];
    expect(pos.entryValueUSD).toBeCloseTo(200, 4);
    expect(pos.currentValueUSD).toBeCloseTo(500, 4);
    expect(pos.feeEarnedUSD).toBeCloseTo(300, 4);
    expect(pos.ilUSD).toBeCloseTo(0, 4);
    expect(pos.netPnLUSD).toBeCloseTo(300, 4);
  });
});
