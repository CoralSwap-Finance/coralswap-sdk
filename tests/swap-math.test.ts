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
});
