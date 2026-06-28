import { PositionsModule } from "../src/modules/positions";

// Real valid Stellar addresses for validation to pass
const OWNER     = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAIR_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_0   = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_1   = "CBQHNAXSI55GX3BZPHDKBE4IMPBPJGZBDZIUMSOUAKVISQ3DTLAZQNSC";
const LP_TOKEN  = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WRTP5AP5WOJVRY3WNT";

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

  const mockFactory = {
    getAllPairs: jest.fn().mockResolvedValue([PAIR_ADDR]),
  };

  return {
    pair: jest.fn().mockReturnValue(mockPair),
    lpToken: jest.fn().mockReturnValue(mockLpToken),
    factory: mockFactory,
    _mockPair: mockPair,
    _mockLpToken: mockLpToken,
  };
};

describe("PositionsModule", () => {
  describe("getPosition", () => {
    it("returns correct share and token amounts", async () => {
      const client = makeMockClient();
      const mod = new PositionsModule(client as never);

      const pos = await mod.getPosition(PAIR_ADDR, OWNER);

      expect(pos.share).toBeCloseTo(0.5, 4);
      expect(pos.token0Amount).toBe(1000n);
      expect(pos.token1Amount).toBe(2000n);
      expect(pos.token0).toBe(TOKEN_0);
      expect(pos.token1).toBe(TOKEN_1);
      expect(pos.feeBps).toBe(30);
      expect(pos.pairAddress).toBe(PAIR_ADDR);
      expect(pos.lpTokenAddress).toBe(LP_TOKEN);
    });

    it("returns zero amounts when totalSupply is zero", async () => {
      const client = makeMockClient();
      client._mockLpToken.totalSupply.mockResolvedValue(0n);
      client._mockLpToken.balance.mockResolvedValue(0n);
      const mod = new PositionsModule(client as never);

      const pos = await mod.getPosition(PAIR_ADDR, OWNER);

      expect(pos.share).toBe(0);
      expect(pos.token0Amount).toBe(0n);
      expect(pos.token1Amount).toBe(0n);
    });

    it("defaults feeBps to 0 when getFeeState fails", async () => {
      const client = makeMockClient();
      client._mockPair.getFeeState.mockRejectedValue(new Error("not found"));
      const mod = new PositionsModule(client as never);

      const pos = await mod.getPosition(PAIR_ADDR, OWNER);

      expect(pos.feeBps).toBe(0);
    });

    it("caches the LP token address on repeated calls", async () => {
      const client = makeMockClient();
      const mod = new PositionsModule(client as never);

      await mod.getPosition(PAIR_ADDR, OWNER);
      await mod.getPosition(PAIR_ADDR, OWNER);

      expect(client._mockPair.getLPTokenAddress).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPositions", () => {
    it("filters out zero-balance positions by default", async () => {
      const client = makeMockClient();
      client._mockLpToken.balance.mockResolvedValue(0n);
      const mod = new PositionsModule(client as never);

      const summary = await mod.getPositions(OWNER);

      expect(summary.positions).toHaveLength(0);
      expect(summary.totalPools).toBe(0);
    });

    it("includes zero-balance positions when includeEmpty is true", async () => {
      const client = makeMockClient();
      client._mockLpToken.balance.mockResolvedValue(0n);
      const mod = new PositionsModule(client as never);

      const summary = await mod.getPositions(OWNER, { includeEmpty: true });

      expect(summary.positions).toHaveLength(1);
    });

    it("returns correct summary when owner has a position", async () => {
      const client = makeMockClient();
      const mod = new PositionsModule(client as never);

      const summary = await mod.getPositions(OWNER);

      expect(summary.owner).toBe(OWNER);
      expect(summary.totalPools).toBe(1);
      expect(summary.positions[0].pairAddress).toBe(PAIR_ADDR);
    });

    it("queries only specified pairs when pairAddresses is given", async () => {
      const client = makeMockClient();
      const mod = new PositionsModule(client as never);

      await mod.getPositions(OWNER, { pairAddresses: [PAIR_ADDR] });

      expect(client.factory.getAllPairs).not.toHaveBeenCalled();
    });

    it("returns empty summary when no pairs exist", async () => {
      const client = makeMockClient();
      client.factory.getAllPairs.mockResolvedValue([]);
      const mod = new PositionsModule(client as never);

      const summary = await mod.getPositions(OWNER);

      expect(summary.positions).toHaveLength(0);
      expect(summary.totalPools).toBe(0);
    });
  });

  describe("hasPosition", () => {
    it("returns true when balance is non-zero", async () => {
      const client = makeMockClient();
      const mod = new PositionsModule(client as never);

      expect(await mod.hasPosition(PAIR_ADDR, OWNER)).toBe(true);
    });

    it("returns false when balance is zero", async () => {
      const client = makeMockClient();
      client._mockLpToken.balance.mockResolvedValue(0n);
      const mod = new PositionsModule(client as never);

      expect(await mod.hasPosition(PAIR_ADDR, OWNER)).toBe(false);
    });
  });
});