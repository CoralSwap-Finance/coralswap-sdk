import { PortfolioModule } from "../src/modules/portfolio";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

// Real valid Stellar addresses for validation to pass
const OWNER     = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAIR_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_0   = "CDU36TRW256UCQ7KPXWJRL6TGTZS44FJRLJXOR7Z72GG2MOMS2GK2X2V";
const TOKEN_1   = "CCCBVHYMAUKQ3423ZXER6HNJRHJKETMVV5RK6IQZNSHEYU2NJBYODGV4";
const LP_TOKEN  = "CBCWYUYTYTERBE3SYUTRZLDGZ65CV66RNYUN3HOMHN3ZTK3M6ZGAYFFJ";

const makeMockClient = () => {
  const mockPair = {
    getReserves: jest.fn(),
    getTokens: jest.fn(),
    getLPTokenAddress: jest.fn(),
    getFeeState: jest.fn(),
  };

  const mockLpToken = {
    balance: jest.fn(),
    totalSupply: jest.fn(),
  };

  const mockFactory = {
    getAllPairs: jest.fn().mockResolvedValue([PAIR_ADDR]),
  };

  return {
    pair: jest.fn().mockReturnValue(mockPair),
    lpToken: jest.fn().mockReturnValue(mockLpToken),
    factory: mockFactory,
    simulateTransaction: jest.fn(),
    _mockPair: mockPair,
    _mockLpToken: mockLpToken,
  };
};

// Helper to convert ScVal to base64 XDR string
const toXdr = (scVal: xdr.ScVal): string => {
  return scVal.toXDR("base64");
};

describe("PortfolioModule - getPortfolioValue", () => {
  it("calculates current and historical values and performance percentages correctly", async () => {
    const client = makeMockClient();
    const mod = new PortfolioModule(client as any, { stableAddresses: [TOKEN_0] });

    // Step 1: Metadata Query simulation (cold cache)
    const lpVal = nativeToScVal(Address.fromString(LP_TOKEN), { type: "address" });
    const t0Val = nativeToScVal(Address.fromString(TOKEN_0), { type: "address" });
    const t1Val = nativeToScVal(Address.fromString(TOKEN_1), { type: "address" });
    const metaSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(lpVal) },
          { xdr: toXdr(t0Val) },
          { xdr: toXdr(t1Val) },
        ],
      },
    };

    // Step 2: Current simulation values
    const currentReserves = xdr.ScVal.scvVec([
      nativeToScVal(1000n * 10000000n, { type: "i128" }), // reserve0 (1000 TOKEN_0)
      nativeToScVal(2000n * 10000000n, { type: "i128" }), // reserve1 (2000 TOKEN_1, price = 0.5 USD)
    ]);
    const currentBalance = nativeToScVal(100n, { type: "i128" }); // 10% share
    const currentTotalSupply = nativeToScVal(1000n, { type: "i128" });
    const currentSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(currentReserves) },
          { xdr: toXdr(currentBalance) },
          { xdr: toXdr(currentTotalSupply) },
        ],
      },
    };

    // Step 3: Historical simulation values
    const historicalReserves = xdr.ScVal.scvVec([
      nativeToScVal(800n * 10000000n, { type: "i128" }), // reserve0 (800 TOKEN_0)
      nativeToScVal(1600n * 10000000n, { type: "i128" }), // reserve1 (1600 TOKEN_1, price = 0.5 USD)
    ]);
    const historicalBalance = nativeToScVal(50n, { type: "i128" }); // 5% share
    const historicalTotalSupply = nativeToScVal(1000n, { type: "i128" });
    const historicalSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(historicalReserves) },
          { xdr: toXdr(historicalBalance) },
          { xdr: toXdr(historicalTotalSupply) },
        ],
      },
    };

    // Chain mocks: 1st metadata query, 2nd current valuation, 3rd historical valuation
    client.simulateTransaction
      .mockResolvedValueOnce(metaSimResult)
      .mockResolvedValueOnce(currentSimResult)
      .mockResolvedValueOnce(historicalSimResult);

    const val = await mod.getPortfolioValue(OWNER);

    // Current: pool value = 1000*1 + 2000*0.5 = 2000 USD. User owns 10% = 200 USD.
    // Historical: pool value = 800*1 + 1600*0.5 = 1600 USD. User owned 5% = 80 USD.
    // change24h = 200 - 80 = 120 USD.
    // change24hPercent = (120 / 80) * 100 = 150%.
    expect(val.totalUSD).toBeCloseTo(200, 2);
    expect(val.change24h).toBeCloseTo(120, 2);
    expect(val.change24hPercent).toBeCloseTo(150, 2);

    // Verify cache work: subsequent call should only trigger 2 simulation calls (current & historical)
    client.simulateTransaction.mockClear();
    client.simulateTransaction
      .mockResolvedValueOnce(currentSimResult)
      .mockResolvedValueOnce(historicalSimResult);

    const cachedVal = await mod.getPortfolioValue(OWNER);
    expect(cachedVal.totalUSD).toBeCloseTo(200, 2);
    expect(client.simulateTransaction).toHaveBeenCalledTimes(2); // Exactly 2 RPC calls when cached
  });

  it("returns zeros when address has no positions", async () => {
    const client = makeMockClient();
    const mod = new PortfolioModule(client as any, { stableAddresses: [TOKEN_0] });

    // Step 1: Metadata
    const lpVal = nativeToScVal(Address.fromString(LP_TOKEN), { type: "address" });
    const t0Val = nativeToScVal(Address.fromString(TOKEN_0), { type: "address" });
    const t1Val = nativeToScVal(Address.fromString(TOKEN_1), { type: "address" });
    const metaSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(lpVal) },
          { xdr: toXdr(t0Val) },
          { xdr: toXdr(t1Val) },
        ],
      },
    };

    // Step 2: Current (0 balance)
    const currentReserves = xdr.ScVal.scvVec([
      nativeToScVal(1000n * 10000000n, { type: "i128" }),
      nativeToScVal(2000n * 10000000n, { type: "i128" }),
    ]);
    const currentBalance = nativeToScVal(0n, { type: "i128" });
    const currentTotalSupply = nativeToScVal(1000n, { type: "i128" });
    const currentSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(currentReserves) },
          { xdr: toXdr(currentBalance) },
          { xdr: toXdr(currentTotalSupply) },
        ],
      },
    };

    // Step 3: Historical (0 balance)
    const historicalSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(currentReserves) },
          { xdr: toXdr(currentBalance) },
          { xdr: toXdr(currentTotalSupply) },
        ],
      },
    };

    client.simulateTransaction
      .mockResolvedValueOnce(metaSimResult)
      .mockResolvedValueOnce(currentSimResult)
      .mockResolvedValueOnce(historicalSimResult);

    const val = await mod.getPortfolioValue(OWNER);

    expect(val.totalUSD).toBe(0);
    expect(val.change24h).toBe(0);
    expect(val.change24hPercent).toBe(0);
  });

  it("handles missing prices without throwing", async () => {
    const client = makeMockClient();
    // stableAddresses is empty -> all prices are unavailable/missing
    const mod = new PortfolioModule(client as any, { stableAddresses: [] });

    const lpVal = nativeToScVal(Address.fromString(LP_TOKEN), { type: "address" });
    const t0Val = nativeToScVal(Address.fromString(TOKEN_0), { type: "address" });
    const t1Val = nativeToScVal(Address.fromString(TOKEN_1), { type: "address" });
    const metaSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(lpVal) },
          { xdr: toXdr(t0Val) },
          { xdr: toXdr(t1Val) },
        ],
      },
    };

    const currentReserves = xdr.ScVal.scvVec([
      nativeToScVal(1000n * 10000000n, { type: "i128" }),
      nativeToScVal(2000n * 10000000n, { type: "i128" }),
    ]);
    const currentBalance = nativeToScVal(100n, { type: "i128" });
    const currentTotalSupply = nativeToScVal(1000n, { type: "i128" });
    const currentSimResult = {
      success: true,
      raw: {
        results: [
          { xdr: toXdr(currentReserves) },
          { xdr: toXdr(currentBalance) },
          { xdr: toXdr(currentTotalSupply) },
        ],
      },
    };

    client.simulateTransaction
      .mockResolvedValueOnce(metaSimResult)
      .mockResolvedValueOnce(currentSimResult)
      .mockResolvedValueOnce(currentSimResult);

    const val = await mod.getPortfolioValue(OWNER);

    expect(val.totalUSD).toBe(0);
    expect(val.change24h).toBe(0);
    expect(val.change24hPercent).toBe(0);
  });
});
