import { LiquidityModule } from '../src/modules/liquidity';
import { CoralSwapClient } from '../src/client';
import { PRECISION } from '../src/config';
import { ValidationError } from '../src/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock CoralSwapClient with overridable factory methods.
 *
 * By default `getPairAddress` returns `null` (simulating "first LP" scenario).
 * Pass overrides to configure reserves, tokens, and LP total supply.
 */
function createMockClient(overrides: {
  pairAddress?: string | null;
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
  totalSupply?: bigint;
} = {}): CoralSwapClient {
  const {
    pairAddress = null,
    reserve0 = 0n,
    reserve1 = 0n,
    token0 = 'TOKEN_A',
    token1 = 'TOKEN_B',
    totalSupply = 0n,
  } = overrides;

  return {
    getPairAddress: jest.fn().mockResolvedValue(pairAddress),
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
    }),
    lpToken: jest.fn().mockReturnValue({
      totalSupply: jest.fn().mockResolvedValue(totalSupply),
      balance: jest.fn().mockResolvedValue(0n),
    }),
  } as unknown as CoralSwapClient;
}

/**
 * Access the private `sqrt` method via type coercion.
 */
function sqrtOf(module: LiquidityModule, value: bigint): bigint {
  return (module as any).sqrt(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiquidityModule', () => {
  // -----------------------------------------------------------------------
  // sqrt() — Babylonian integer square root
  // -----------------------------------------------------------------------
  describe('sqrt()', () => {
    let module: LiquidityModule;

    beforeEach(() => {
      module = new LiquidityModule(createMockClient());
    });

    it('sqrt(0n) returns 0n', () => {
      expect(sqrtOf(module, 0n)).toBe(0n);
    });

    it('sqrt(1n) returns 1n', () => {
      expect(sqrtOf(module, 1n)).toBe(1n);
    });

    it('sqrt(4n) returns 2n', () => {
      expect(sqrtOf(module, 4n)).toBe(2n);
    });

    it('sqrt(9n) returns 3n', () => {
      expect(sqrtOf(module, 9n)).toBe(3n);
    });

    it('sqrt(16n) returns 4n', () => {
      expect(sqrtOf(module, 16n)).toBe(4n);
    });

    it('sqrt(25n) returns 5n', () => {
      expect(sqrtOf(module, 25n)).toBe(5n);
    });

    it('handles large perfect square: sqrt(10n ** 36n) returns 10n ** 18n', () => {
      expect(sqrtOf(module, 10n ** 36n)).toBe(10n ** 18n);
    });

    it('floors non-perfect square: sqrt(2n) returns 1n', () => {
      expect(sqrtOf(module, 2n)).toBe(1n);
    });

    it('floors non-perfect square: sqrt(3n) returns 1n', () => {
      expect(sqrtOf(module, 3n)).toBe(1n);
    });

    it('floors non-perfect square: sqrt(8n) returns 2n', () => {
      expect(sqrtOf(module, 8n)).toBe(2n);
    });

    it('floors non-perfect square: sqrt(10n) returns 3n', () => {
      expect(sqrtOf(module, 10n)).toBe(3n);
    });

    it('throws ValidationError for negative input', () => {
      expect(() => sqrtOf(module, -1n)).toThrow(ValidationError);
      expect(() => sqrtOf(module, -1n)).toThrow('Square root of negative number');
    });

    it('throws ValidationError for large negative input', () => {
      expect(() => sqrtOf(module, -(10n ** 18n))).toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // getAddLiquidityQuote()
  // -----------------------------------------------------------------------
  describe('getAddLiquidityQuote()', () => {
    const TOKEN_A = 'TOKEN_A';
    const TOKEN_B = 'TOKEN_B';
    const PAIR_ADDRESS = 'PAIR_CONTRACT';

    // -- First liquidity provider (no existing pair) ----------------------

    describe('first liquidity provider (no pair exists)', () => {
      it('returns desired amounts as-is for both tokens', async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);
        const amount = 1_000_000n;

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, amount);

        expect(quote.amountA).toBe(amount);
        expect(quote.amountB).toBe(amount);
      });

      it('returns sqrt(amountA * amountB) - MIN_LIQUIDITY as estimated LP tokens', async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);
        const amount = 1_000_000n;

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, amount);

        // For first LP: amountA == amountB == amount, so sqrt(amount * amount) == amount
        const expectedLP = amount - PRECISION.MIN_LIQUIDITY;
        expect(quote.estimatedLPTokens).toBe(expectedLP);
      });

      it('returns 100% share of pool', async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 1_000_000n);

        expect(quote.shareOfPool).toBe(1.0);
      });

      it('returns 1:1 price ratio', async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 1_000_000n);

        expect(quote.priceAPerB).toBe(PRECISION.PRICE_SCALE);
        expect(quote.priceBPerA).toBe(PRECISION.PRICE_SCALE);
      });
    });

    // -- Proportional deposit (existing pair with reserves) ---------------

    describe('proportional deposit (existing pair)', () => {
      it('calculates optimal amountB based on reserve ratio', async () => {
        // Pool has 1000 A : 2000 B (1:2 ratio)
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 1000n,
          reserve1: 2000n,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 100n);

        // amountB = (100 * 2000) / 1000 = 200
        expect(quote.amountB).toBe(200n);
        expect(quote.amountA).toBe(100n);
      });

      it('calculates LP tokens proportionally to total supply', async () => {
        const reserveA = 10_000n;
        const reserveB = 20_000n;
        const totalSupply = 5_000n;
        const amountA = 1_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, amountA);

        // estimatedLP = (amountA * totalSupply) / reserveA = (1000 * 5000) / 10000 = 500
        const expectedLP = (amountA * totalSupply) / reserveA;
        expect(quote.estimatedLPTokens).toBe(expectedLP);
      });

      it('computes correct fractional share of pool', async () => {
        const totalSupply = 10_000n;
        const reserveA = 100_000n;
        const reserveB = 200_000n;
        const amountA = 10_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, amountA);

        // estimatedLP = (10000 * 10000) / 100000 = 1000
        // share = 1000 * 10000 / (10000 + 1000) / 10000 = 10000000 / 11000 / 10000
        const estimatedLP = (amountA * totalSupply) / reserveA;
        const expectedShare =
          Number((estimatedLP * 10000n) / (totalSupply + estimatedLP)) / 10000;

        expect(quote.shareOfPool).toBe(expectedShare);
        expect(quote.shareOfPool).toBeGreaterThan(0);
        expect(quote.shareOfPool).toBeLessThan(1);
      });

      it('computes correct price ratios using PRICE_SCALE', async () => {
        const reserveA = 1_000_000n;
        const reserveB = 2_000_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 100n);

        // priceAPerB = (reserveB * PRICE_SCALE) / reserveA = 2 * PRICE_SCALE
        expect(quote.priceAPerB).toBe(
          (reserveB * PRECISION.PRICE_SCALE) / reserveA,
        );
        // priceBPerA = (reserveA * PRICE_SCALE) / reserveB = 0.5 * PRICE_SCALE
        expect(quote.priceBPerA).toBe(
          (reserveA * PRECISION.PRICE_SCALE) / reserveB,
        );
      });

      it('handles token ordering when tokenA is token1', async () => {
        // tokenA is actually token1 in the pair, so reserveA = reserve1
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 5000n,
          reserve1: 10000n,
          token0: TOKEN_B,  // tokenB is token0
          token1: TOKEN_A,  // tokenA is token1
          totalSupply: 2000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 1000n);

        // reserveA = reserve1 = 10000, reserveB = reserve0 = 5000
        // amountB = (1000 * 5000) / 10000 = 500
        expect(quote.amountB).toBe(500n);

        // estimatedLP = (1000 * 2000) / 10000 = 200
        expect(quote.estimatedLPTokens).toBe(200n);
      });
    });

    // -- Edge cases -------------------------------------------------------

    describe('edge cases', () => {
      it('equal reserves yield 1:1 deposit ratio', async () => {
        const reserve = 1_000_000n;
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserve,
          reserve1: reserve,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 500n);

        expect(quote.amountA).toBe(500n);
        expect(quote.amountB).toBe(500n);
      });

      it('small deposit into large pool yields small share', async () => {
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 10n ** 18n,
          reserve1: 10n ** 18n,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 10n ** 15n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 1000n);

        expect(quote.shareOfPool).toBeLessThan(0.001);
        expect(quote.estimatedLPTokens).toBeGreaterThan(0n);
      });
    });
  });
});
