import { StrKey } from "@stellar/stellar-sdk";
import { PortfolioModule } from "../src/modules/portfolio";

/** A genuinely valid, distinct Stellar contract address for index `n`. */
function contractAddress(n: number): string {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(n, 28);
  return StrKey.encodeContract(buf);
}

// Real valid Stellar addresses (StrKey checksums matter -- validateAddress
// is called on `owner`, and PositionsModule.getPosition validates each
// pair address too).
const OWNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAIR_PRICE_ONLY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const PAIR_POSITION = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
const PAIR_UNPRICED = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const TOKEN_STABLE = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_A = "CBQHNAXSI55GX3BZPHDKBE4IMPBPJGZBDZIUMSOUAKVISQ3DTLAZQNSC";
const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const TOKEN_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGA3U";
const LP_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHCV4";

const STROOP_BI = 10_000_000n;

interface PairSpec {
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  balance: bigint;
  totalSupply: bigint;
}

/**
 * Each pair gets its own LP token address so balance/totalSupply can be
 * stubbed independently per pair (the real client looks up an lpToken
 * client by address, so a shared address across pairs would make every
 * pair share the same balance).
 */
function makeMockClient(pairSpecs: Record<string, PairSpec>) {
  const pairMocks: Record<string, unknown> = {};
  const lpBalances = new Map<string, { balance: bigint; totalSupply: bigint }>();

  let lpCounter = 0;

  for (const [addr, spec] of Object.entries(pairSpecs)) {
    // Not StrKey-validated anywhere in this call path (only pairAddress and
    // owner are), so a distinct plain string per pair is enough here.
    const lpAddr = `${LP_TOKEN}-${lpCounter++}`;
    lpBalances.set(lpAddr, { balance: spec.balance, totalSupply: spec.totalSupply });

    pairMocks[addr] = {
      getReserves: jest.fn().mockResolvedValue({
        reserve0: spec.reserve0,
        reserve1: spec.reserve1,
      }),
      getTokens: jest.fn().mockResolvedValue({
        token0: spec.token0,
        token1: spec.token1,
      }),
      getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
      getLPTokenAddress: jest.fn().mockResolvedValue(lpAddr),
    };
  }

  const lpToken = jest.fn((lpAddr: string) => {
    const rec = lpBalances.get(lpAddr)!;
    return {
      balance: jest.fn().mockResolvedValue(rec.balance),
      totalSupply: jest.fn().mockResolvedValue(rec.totalSupply),
    };
  });

  return {
    pair: jest.fn((addr: string) => pairMocks[addr]),
    lpToken,
    factory: { getAllPairs: jest.fn().mockResolvedValue(Object.keys(pairSpecs)) },
  };
}

describe("PortfolioModule", () => {
  describe("get() -- mixed-coverage isolation", () => {
    it("excludes a position with no price coverage instead of aborting, and still totals the rest", async () => {
      const client = makeMockClient({
        [PAIR_POSITION]: {
          token0: TOKEN_STABLE,
          token1: TOKEN_A,
          reserve0: 1_000_000_000n, // 100 tokens
          reserve1: 2_000_000_000n, // 200 tokens -> price(TOKEN_A) = 0.5
          balance: 1_000_000n,
          totalSupply: 1_000_000n, // owner owns 100% -> amounts == reserves
        },
        [PAIR_UNPRICED]: {
          token0: TOKEN_B,
          token1: TOKEN_C,
          reserve0: 500_000_000n,
          reserve1: 700_000_000n,
          balance: 1_000_000n,
          totalSupply: 1_000_000n,
        },
      });

      const portfolio = new PortfolioModule(client as never, {
        stableAddresses: [TOKEN_STABLE],
      });

      const result = await portfolio.getPortfolio(OWNER, {
        pairAddresses: [PAIR_POSITION, PAIR_UNPRICED],
      });

      // Only the priced position is valued.
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].pairAddress).toBe(PAIR_POSITION);
      // 100 (stable, price 1.0) + 200 * 0.5 = 200
      expect(result.positions[0].valueUSD).toBeCloseTo(200, 6);
      expect(result.totalValueUSD).toBeCloseTo(200, 6);

      // The unpriced pair is reported, not silently dropped and not
      // aborting the call.
      expect(result.unavailablePositions).toHaveLength(1);
      expect(result.unavailablePositions[0].pairAddress).toBe(PAIR_UNPRICED);
      expect(result.unavailablePositions[0].token0Amount).toBe(500_000_000n);
      expect(result.unavailablePositions[0].token1Amount).toBe(700_000_000n);
      expect(result.unavailablePositions[0].reason).toContain(TOKEN_B);
    });

    it("isolates a position whose value computation throws, without aborting the rest", async () => {
      const client = makeMockClient({
        [PAIR_POSITION]: {
          token0: TOKEN_STABLE,
          token1: TOKEN_A,
          reserve0: 1_000_000_000n,
          reserve1: 2_000_000_000n,
          balance: 1_000_000n,
          totalSupply: 1_000_000n,
        },
      });

      const portfolio = new PortfolioModule(client as never, {
        stableAddresses: [TOKEN_STABLE],
      });

      // Force a genuinely invalid scripted price (NaN) to exercise the
      // calculation-failure branch specifically -- distinct from "missing
      // price coverage" above, since here the token *has* a price map
      // entry, it's just unusable.
      jest.spyOn(portfolio as never, "buildPriceMapTracked" as never).mockResolvedValue({
        priceMap: new Map([
          [TOKEN_STABLE, 1.0],
          [TOKEN_A, NaN],
        ]),
        missingTokens: [],
      } as never);

      const result = await portfolio.getPortfolio(OWNER, {
        pairAddresses: [PAIR_POSITION],
      });

      expect(result.positions).toHaveLength(0);
      expect(result.totalValueUSD).toBe(0);
      expect(result.unavailablePositions).toHaveLength(1);
      expect(result.unavailablePositions[0].pairAddress).toBe(PAIR_POSITION);
      expect(result.unavailablePositions[0].reason).toContain(PAIR_POSITION);
    });
  });

  describe("get() -- BigInt precision", () => {
    it("preserves stroop-level precision for amounts beyond Number.MAX_SAFE_INTEGER", async () => {
      // 18 digits, far beyond 2^53 (~9.007e15) -- a naive Number(bigint)
      // conversion of this amount silently rounds.
      const amount = 123_456_789_012_345_678n;
      const price = 0.33;

      // Independent ground truth: split the amount into a safely-
      // representable whole-token part and a safely-representable
      // fractional (sub-stroop) remainder *before* any float conversion,
      // then apply the price to each part separately. This is a
      // deliberately different method from the implementation's own
      // scaled-BigInt-price approach, so it's a genuine cross-check rather
      // than restating the same algorithm.
      const whole = amount / STROOP_BI;
      const fracStroops = amount % STROOP_BI;
      const expectedValueUSD = Number(whole) * price + (Number(fracStroops) / 1e7) * price;

      const client = makeMockClient({
        // Price-only pair: clean small reserves give an exact 0.33 price
        // for TOKEN_A. Zero balance means it contributes no position of
        // its own -- purely a price reference.
        [PAIR_PRICE_ONLY]: {
          token0: TOKEN_A,
          token1: TOKEN_STABLE,
          reserve0: 100n,
          reserve1: 33n,
          balance: 0n,
          totalSupply: 1n,
        },
        // The actual (huge) position: reserve0 becomes token0Amount exactly
        // (balance == totalSupply), reserve1 = 0 isolates the calculation
        // to a single term.
        [PAIR_POSITION]: {
          token0: TOKEN_A,
          token1: TOKEN_STABLE,
          reserve0: amount,
          reserve1: 0n,
          balance: 1_000_000n,
          totalSupply: 1_000_000n,
        },
      });

      const portfolio = new PortfolioModule(client as never, {
        stableAddresses: [TOKEN_STABLE],
      });

      const result = await portfolio.getPortfolio(OWNER, {
        pairAddresses: [PAIR_PRICE_ONLY, PAIR_POSITION],
      });

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].token0Amount).toBe(amount);
      expect(result.positions[0].valueUSD).toBeCloseTo(expectedValueUSD, 2);
      expect(result.totalValueUSD).toBeCloseTo(expectedValueUSD, 2);
      expect(result.unavailablePositions).toHaveLength(0);
    });

    it("accumulates the total in BigInt rather than summing already-rounded per-position floats", async () => {
      // Many positions with a fractional-stroop-producing price; summing
      // pre-rounded floats can drift from the exact BigInt-accumulated
      // total as the position count grows.
      const price = 1 / 3; // repeating in binary and decimal
      const amountPerPosition = 10_000_000n; // exactly 1 token
      const positionCount = 25;

      const pairSpecs: Record<string, PairSpec> = {
        [PAIR_PRICE_ONLY]: {
          token0: TOKEN_A,
          token1: TOKEN_STABLE,
          reserve0: 3n,
          reserve1: 1n, // price(TOKEN_A) = 1/3
          balance: 0n,
          totalSupply: 1n,
        },
      };
      const pairAddresses = [PAIR_PRICE_ONLY];
      // Large offset so these generated addresses can't collide with any of
      // the small-integer-encoded fixture addresses used elsewhere in this
      // file or in sibling test files (contractAddress uses the same
      // "mostly-zero 32-byte buffer + trailing integer" construction those
      // were likely built with).
      for (let i = 0; i < positionCount; i++) {
        const addr = contractAddress(1_000_000 + i);
        pairSpecs[addr] = {
          token0: TOKEN_A,
          token1: TOKEN_STABLE,
          reserve0: amountPerPosition,
          reserve1: 0n,
          balance: 1n,
          totalSupply: 1n,
        };
        pairAddresses.push(addr);
      }

      const client = makeMockClient(pairSpecs);
      const portfolio = new PortfolioModule(client as never, {
        stableAddresses: [TOKEN_STABLE],
      });

      const result = await portfolio.getPortfolio(OWNER, { pairAddresses });

      expect(result.positions).toHaveLength(positionCount);
      expect(result.unavailablePositions).toHaveLength(0);

      const expectedTotal = positionCount * (Number(amountPerPosition) / 1e7) * price;
      expect(result.totalValueUSD).toBeCloseTo(expectedTotal, 6);
    });
  });

  describe("get() -- backward-compatible shape", () => {
    it("still returns an empty portfolio (no throw) when the owner has no positions", async () => {
      const client = makeMockClient({});
      const portfolio = new PortfolioModule(client as never);

      const result = await portfolio.getPortfolio(OWNER);

      expect(result.owner).toBe(OWNER);
      expect(result.positions).toEqual([]);
      expect(result.unavailablePositions).toEqual([]);
      expect(result.totalValueUSD).toBe(0);
    });
  });
});
