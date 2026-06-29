import { ValidationError } from "../src/errors";
import { PortfolioModule } from "../src/modules/portfolio";

const OWNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAIR_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_0 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_1 = "CBQHNAXSI55GX3BZPHDKBE4IMPBPJGZBDZIUMSOUAKVISQ3DTLAZQNSC";
const LP_TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WRTP5AP5WOJVRY3WNT";

const makeMockClient = () => {
  const mockLpToken = {
    balance: jest.fn().mockResolvedValue(500n),
    totalSupply: jest.fn().mockResolvedValue(1000n),
  };

  const mockPair = {
    getReserves: jest.fn().mockResolvedValue({ reserve0: 2000n, reserve1: 4000n }),
    getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
    getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
    getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
  };

  return {
    pair: jest.fn().mockReturnValue(mockPair),
    lpToken: jest.fn().mockReturnValue(mockLpToken),
    factory: {
      getAllPairs: jest.fn().mockResolvedValue([PAIR_ADDR]),
    },
  };
};

describe("PortfolioModule", () => {
  it("values an LP position with supplied prices and decimals", async () => {
    const portfolio = new PortfolioModule(makeMockClient() as never);

    const position = await portfolio.getPosition(PAIR_ADDR, OWNER, {
      token0PriceUsd: 2,
      token1PriceUsd: 3,
      token0Decimals: 0,
      token1Decimals: 0,
    });

    expect(position.token0Amount).toBe(1000n);
    expect(position.token1Amount).toBe(2000n);
    expect(position.token0ValueUsd).toBe(2000);
    expect(position.token1ValueUsd).toBe(6000);
    expect(position.currentValueUsd).toBe(8000);
  });

  it("calculates PnL from current value, cost basis, hold value, and fees", () => {
    const portfolio = new PortfolioModule(makeMockClient() as never);

    const pnl = portfolio.calculatePositionPnL(
      {
        pairAddress: PAIR_ADDR,
        lpTokenAddress: LP_TOKEN,
        balance: 500n,
        totalSupply: 1000n,
        share: 0.5,
        token0Amount: 1000n,
        token1Amount: 2000n,
        token0: TOKEN_0,
        token1: TOKEN_1,
        reserve0: 2000n,
        reserve1: 4000n,
        feeBps: 30,
        token0PriceUsd: 2,
        token1PriceUsd: 3,
        token0AmountDecimal: 1000,
        token1AmountDecimal: 2000,
        token0ValueUsd: 2000,
        token1ValueUsd: 6000,
        currentValueUsd: 8000,
      },
      {
        token0Amount: 1000n,
        token1Amount: 1000n,
        token0PriceUsd: 1,
        token1PriceUsd: 2,
        token0Decimals: 0,
        token1Decimals: 0,
        feesEarnedUsd: 50,
      },
    );

    expect(pnl.costBasisUsd).toBe(3000);
    expect(pnl.holdValueUsd).toBe(5000);
    expect(pnl.unrealizedPnlUsd).toBe(5000);
    expect(pnl.totalPnlUsd).toBe(5050);
    expect(pnl.impermanentLossUsd).toBe(3000);
    expect(pnl.impermanentLossBps).toBe(6000);
    expect(pnl.totalReturnBps).toBeCloseTo(16833.3333, 4);
  });

  it("calculates standard constant-product impermanent loss from price movement", () => {
    const portfolio = new PortfolioModule(makeMockClient() as never);

    const il = portfolio.calculateImpermanentLoss({
      token0EntryPriceUsd: 1,
      token1EntryPriceUsd: 1,
      token0CurrentPriceUsd: 2,
      token1CurrentPriceUsd: 1,
    });

    expect(il.priceRatio).toBe(2);
    expect(il.impermanentLossRatio).toBeCloseTo(-0.057190958, 9);
    expect(il.impermanentLossBps).toBeCloseTo(-571.909584, 6);
  });

  it("rejects invalid valuation inputs", async () => {
    const portfolio = new PortfolioModule(makeMockClient() as never);

    await expect(
      portfolio.getPosition(PAIR_ADDR, OWNER, {
        token0PriceUsd: Number.NaN,
        token1PriceUsd: 1,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
