import { SwapModule } from '../src/modules/swap';

/**
 * Test the V2 AMM swap math independently (no RPC calls).
 *
 * We instantiate SwapModule with a null client to test the pure
 * math functions getAmountOut and getAmountIn.
 */
describe('Swap Math', () => {
  let swap: SwapModule;

  beforeEach(() => {
    // Create with null client -- only testing pure math functions
    swap = new SwapModule(null as any);
  });

  describe('getAmountOut', () => {
    it('calculates correct output for standard swap', () => {
      const reserveIn = 1000000000n;
      const reserveOut = 1000000000n;
      const amountIn = 1000000n;
      const feeBps = 30;

      const out = swap.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
      expect(out).toBeGreaterThan(0n);
      expect(out).toBeLessThan(amountIn);
    });

    it('larger input yields larger output', () => {
      const reserveIn = 1000000000n;
      const reserveOut = 1000000000n;

      const out1 = swap.getAmountOut(1000000n, reserveIn, reserveOut, 30);
      const out2 = swap.getAmountOut(2000000n, reserveIn, reserveOut, 30);
      expect(out2).toBeGreaterThan(out1);
    });

    it('higher fee yields lower output', () => {
      const reserveIn = 1000000000n;
      const reserveOut = 1000000000n;
      const amountIn = 1000000n;

      const outLowFee = swap.getAmountOut(amountIn, reserveIn, reserveOut, 10);
      const outHighFee = swap.getAmountOut(amountIn, reserveIn, reserveOut, 100);
      expect(outLowFee).toBeGreaterThan(outHighFee);
    });

    it('throws on zero input', () => {
      expect(() =>
        swap.getAmountOut(0n, 1000n, 1000n, 30),
      ).toThrow('greater than zero');
    });

    it('throws on zero reserves', () => {
      expect(() =>
        swap.getAmountOut(100n, 0n, 1000n, 30),
      ).toThrow('Insufficient liquidity');
    });
  });

  describe('getAmountIn', () => {
    it('calculates correct input for desired output', () => {
      const reserveIn = 1000000000n;
      const reserveOut = 1000000000n;
      const amountOut = 1000000n;
      const feeBps = 30;

      const amountIn = swap.getAmountIn(amountOut, reserveIn, reserveOut, feeBps);
      expect(amountIn).toBeGreaterThan(amountOut);
    });

    it('throws when output exceeds reserve', () => {
      expect(() =>
        swap.getAmountIn(2000n, 1000n, 1000n, 30),
      ).toThrow('exceeds available reserve');
    });

    it('throws on zero output', () => {
      expect(() =>
        swap.getAmountIn(0n, 1000n, 1000n, 30),
      ).toThrow('greater than zero');
    });
  });

  describe('constant product invariant', () => {
    it('output preserves k (with fee)', () => {
      const reserveIn = 1000000000n;
      const reserveOut = 1000000000n;
      const amountIn = 10000000n;
      const feeBps = 30;

      const amountOut = swap.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);

      const kBefore = reserveIn * reserveOut;
      const newReserveIn = reserveIn + amountIn;
      const newReserveOut = reserveOut - amountOut;
      const kAfter = newReserveIn * newReserveOut;

      // k should increase or stay the same (never decrease)
      expect(kAfter).toBeGreaterThanOrEqual(kBefore);
    });
  });

  describe('edge cases', () => {
    // 1. Zero Input: getAmountOut(0) throws (acceptable per spec)
    it('getAmountOut throws on zero input', () => {
      expect(() =>
        swap.getAmountOut(0n, 1000n, 1000n, 30),
      ).toThrow();
    });

    // 2. Zero Reserves: Validation should fail
    it('getAmountOut throws on zero reserves', () => {
      expect(() =>
        swap.getAmountOut(100n, 0n, 0n, 30),
      ).toThrow('Insufficient liquidity');
    });

    // 3. Fee Extremes: feeBps = 0
    it('getAmountOut works with zero fee', () => {
      const out = swap.getAmountOut(1000n, 10000n, 10000n, 0);
      expect(out).toBeGreaterThan(0n);
    });

    // 3. Fee Extremes: feeBps = 10000 (all fees)
    it('getAmountOut returns 0 when fee is 10000 bps', () => {
      const out = swap.getAmountOut(1000n, 10000n, 10000n, 10000);
      expect(out).toBe(0n);
    });

    // 4. Max Values: Reserves near 2^63 - 1 (BigInt)
    it('getAmountOut handles max BigInt values', () => {
      const maxRes = BigInt(2 ** 63) - 1n;
      const out = swap.getAmountOut(1000n, maxRes, maxRes, 30);
      expect(out).toBeGreaterThanOrEqual(0n);
    });

    // 5. Invalid Path: getAmountIn where amountOut > reserveOut (should throw)
    it('getAmountIn throws when output exceeds reserve', () => {
      expect(() =>
        swap.getAmountIn(2000n, 1000n, 1000n, 30),
      ).toThrow();
    });

    // 6. Small Amounts: Swapping 1 stroop (smallest unit)
    it('getAmountOut handles smallest input amount (1 stroop)', () => {
      const out = swap.getAmountOut(1n, 1000000000n, 1000000000n, 30);
      // Should work but may return 0 due to rounding
      expect(out).toBeGreaterThanOrEqual(0n);
    });

    // Additional edge cases
    it('getAmountIn throws on zero reserves', () => {
      expect(() =>
        swap.getAmountIn(100n, 0n, 1000n, 30),
      ).toThrow('Insufficient liquidity');
    });

    it('getAmountIn handles zero fee', () => {
      const inAmount = swap.getAmountIn(1000n, 10000n, 10000n, 0);
      expect(inAmount).toBeGreaterThan(1000n);
    });

    // Zero output throws (acceptable per spec)
    it('getAmountIn throws on zero output', () => {
      expect(() =>
        swap.getAmountIn(0n, 1000n, 1000n, 30),
      ).toThrow();
    });
  });
});
