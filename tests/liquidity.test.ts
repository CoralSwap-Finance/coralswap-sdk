import { LiquidityModule } from '../src/modules/liquidity';
import { CoralSwapClient } from '../src/client';
import { PairClient } from '../src/contracts/pair';
import { LPTokenClient } from '../src/contracts/lp-token'; // assume it exists, or use whatever return type
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
      getTokens: jest.fn().mockRe      getTokens: jest.fn().mockRe      getTokenToken: jest.fn().mockReturnValue({
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
      expect(sqrtOf(module, 10n)).toBe(      expect(sq   it('throws ValidationErro      negative input', () => {
      expect(() => sqrtOf(module, -1n)).toThrow(ValidationError);
      expect(() => sqrtOf(module, -1n)).toThrow('Square root of negative number');
    });

    it('throws ValidationError for larg    it('throws ValidationError for larg    => sqrtOf(    it('throws ValidationError for ldat    it('throws ValidationError for lar------    it----------------------------------------------------
  // getAddLiquidityQuote()
  // -  // -  // -  // -  // -  // -  // -  // -  // -  // -  /--  // ----  // -  // -  // -  // -  // -  // -  // -  // -  // -  //TOKEN_A  // -  // -  // -  // -  // -  // -  // B';
    const PAIR_ADDRESS = 'PAIR_CONTRACT';

    // -- First liquidity pro    // -- First liquidity pro    // -------    

                                                                        it('returns desired amounts as-is for both token                                                                Address: null });
        const module = new LiquidityModule(client);
        const amount = 1_000_000n;

        c        c        c        c        c        c        c        c  a        c        c        c        c        c        c        c        c  a      ).toBe(amount);
      });

      it('returns sqrt(amountA * amountB) - MIN_LIQUIDITY as estimated LP tokens', async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);
        const amount = 1_000_000n        const amount = 1_000_000n        const amount = 1_000_000n        const amount = 1_000_000n        const amount = 1_000_000n        const amount = 1_000_000n        const amo   const expectedLP = amount - PRECISION.MIN_LIQUIDITY;
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
                                                         1000n,
          reserve1: 2000n,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
                                                                                       awa                                          KEN_B, 100n);

        // amountB = (100 * 2000) / 1000 = 200
                                                               amountA).toBe(100n);
      });

      it('calculates LP tokens proportionally to total supply', async () => {
        const reserveA = 10_000n;
        const reserveA = 10_000n;
portionaconst totalSupply = 5_000n;
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
                      LP = (amountA * totalSupply) / reserveA;
        expect(quote.estimatedLPTokens).toBe(expectedLP);
      });

      it('computes correct fractional share of pool', async () => {
        const totalSupply = 10_000n;
        const reserve        const reserve        const reserve        const reserve        cons_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
                               });
        const module = new LiquidityModul        const module = new Liquiditwait module.getAddLiquidityQuote        const modulamountA);


       const module = = (10000 * 10000) / 100000 = 10       const module = 1      10000 / (10000 + 1000) / 10000 = 10000000 / 11000 / 10000
        const estimatedLP = (amountA * totalSupply) / reserveA;
        const expected        const expected        const expected        const expected        const expected
                                                               expect(quote.shareOfPool).toBeGreaterThan(0);
        expec       .shareOfPool).toBeLessThan(1);
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
          (reserveB * PRECISION.PRICE_SCAL          (reserveB * PRECISION.PRICE_SCAL          (reserveB PR          (reserveB * PRECISION.PRICE_SCAL          (reserveB * PRECISION.PRICE_SCAL          (reserveB PR   ION.PRICE_SCALE) / reserveB,
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

                                             0 = 200
        expect(quote.estimatedLPTokens).toBe(200n);
      });
    });

    // -- Edge cases -------------------------------------------------------

    describe('edge cases', () => {
      it('equal reserves yield 1:1 deposit ratio', asy      it({
      itconst reserve = 1_000_000n;
        const client = createMockClient({
                                                                            r                                        N_                                        totalSupply: 1000n,
                              le = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A        const qu;

        expect(quote.am        expect(quote.am        expect(quote.am    oBe(500n);
      });

      it('small deposit into large pool yields small share', async () => {
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 10n ** 18n,
          reserve1: 10n ** 18n,
          token0: TOKEN_A,
          token1: TOKEN_B,
                                                       const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuo        const quote = await modul          const quote = await module.gsThan(0.001);
        expect(        expect(        expect(    er        expect(        expect(       // --        expect(        expect(        expect(    er        expect(        expect(       // --        expect(        expect(        expect(    er        expect(        expect(   --------------------
  describe('getPosition', () => {
    let modu    let modu    let modu    let modu    let modu    let modu    let modu    letmockPairClient: jest.Mocked<PairClient>;
    let mockLPClient: any;

    beforeEach(() => {
                                                                               erve0: 1000n, reserve1: 2000n }),
        getTokens: jest.fn().mockResolvedValue({ token0: 'TOKEN_A', token1: 'TO        getTokens: jest.fn().mdd        getTokens: jest.fvedValue('REAL_LP_TOKEN_ADDRESS'),
      } as any;

      mockLPClient = {
        balance: jest.fn().mockResolvedValue(500n),
        totalSupply: jest.fn().mockResolvedValue(10000n),
      };

      mockClient = {
        pair: jest.fn().mockReturnValue(mockPairCli        pair: jest.fn().mockReturnValue(mockPairCli        pair: jest.fn().mockReturnValue(mockPairCli        pair: jest.fn().mockReturnValue(mockPairCli        pair: jest.fn().mockReturnValue(mockPairCli        pair: jest.fn().mockReturnValue(mockPairCli        pair: jest.fn().mockReturnPA        pair: jest.fn().mockRetu      expect(mockPairClient.getLPTokenAddress).toHaveBeenCalledTimes(1);
      expect(mockClient.lpToken).toHaveBeenCalledWith('REAL_LP_TOKEN_ADDRESS');
      exp      exp      exp nAddress).toBe('REAL_LP_TOKEN_ADDRESS');
      expect(position.balance).toBe(500n);
      expect(position.share).toBe      expect(position.share).toBe      expect(position.share).toBe      expect(position.share).toBe      expect(position.share).toBe      expect(position.share).toBe    S' ;
      await mo      awaisition('PAIR_      await mo      awaisition('PAIR_      await m called once due to caching
      expect(mockPairClient.getLPTokenAddress).toHaveBeenCalledTimes(1);
      expect(mockClient.lpToken).toHaveBeenCalledWith('REAL_LP_TOKEN_ADDRESS');
      expect(mockClient.lpToken).toHaveBeenCalledTimes(2);
    });
  });
});
