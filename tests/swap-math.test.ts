import { SwapModule } from '../src/modules/swap';
import {
  ValidationError,
  InsufficientLiquidityError,
  CoralSwapSDKError,
} from '../src/errors';

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

    it('throws ValidationError on zero input', () => {
      expect(() =>
        swap.getAmountOut(0n, 1000n, 1000n, 30),
      ).toThrow(ValidationError);
    });

    it('throws InsufficientLiquidityError on zero reserves', () => {
      expect(() =>
        swap.getAmountOut(100n, 0n, 1000n, 30),
      ).toThrow(InsufficientLiquidityError);
    });

    it('thrown errors are instances of CoralSwapSDKError', () => {
      expect(() =>
        swap.getAmountOut(0n, 1000n, 1000n, 30),
      ).toThrow(CoralSwapSDKError);
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

    it('throws InsufficientLiquidityError when output exceeds reserve', () => {
      expect(() =>
        swap.getAmountIn(2000n, 1000n, 1000n, 30),
      ).toThrow(InsufficientLiquidityError);
    });

    it('throws ValidationError on zero output', () => {
      expect(() =>
        swap.getAmountIn(0n, 1000n, 1000n, 30),
      ).toThrow(ValidationError);
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

  describe('Edge Cases', () => {
    const RESERVE = 1_000_000_000n;
    const FEE_30 = 30;

    // getAmountOut

    it('should return 0n for a 1-stroop input against very large equal reserves', () => {
      const largeReserve = 1_000_000_000_000n;
      const out = swap.getAmountOut(1n, largeReserve, largeReserve, FEE_30);
      expect(out).toBe(0n);
    });

    it('should throw when reserveOut is zero', () => {
      expect(() =>
        swap.getAmountOut(1_000n, RESERVE, 0n, FEE_30),
      ).toThrow('Insufficient liquidity');
    });

    it('should return 0n when feeBps equals 10000 (100% fee)', () => {
      const out = swap.getAmountOut(1_000_000n, RESERVE, RESERVE, 10000);
      expect(out).toBe(0n);
    });

    it('should match the no-fee constant-product formula exactly when feeBps is 0', () => {
      const amountIn = 10_000_000n;
      // feeBps=0 reduces to: out = (amountIn * reserveOut) / (reserveIn + amountIn)
      const expected = (amountIn * RESERVE) / (RESERVE + amountIn);
      const actual = swap.getAmountOut(amountIn, RESERVE, RESERVE, 0);
      expect(actual).toBe(expected);
    });

    it('should return a positive value with reserves near the i128 ceiling (2^63 - 1)', () => {
      const MAX_I63 = 9_223_372_036_854_775_807n;
      const amountIn = 1_000_000n;
      const out = swap.getAmountOut(amountIn, MAX_I63, MAX_I63, FEE_30);
      expect(out).toBeGreaterThan(0n);
      expect(out).toBeLessThanOrEqual(amountIn);
    });

    it('should yield less output for a highly imbalanced pool (reserveOut << reserveIn)', () => {
      const amountIn = 1_000_000n;
      const balancedOut = swap.getAmountOut(amountIn, RESERVE, RESERVE, FEE_30);
      const skewedOut = swap.getAmountOut(amountIn, RESERVE * 10n, RESERVE / 10n, FEE_30);
      expect(skewedOut).toBeLessThan(balancedOut);
    });

    it('should treat a negative amountIn as insufficient input and throw', () => {
      expect(() =>
        swap.getAmountOut(-1n, RESERVE, RESERVE, FEE_30),
      ).toThrow('Insufficient input');
    });

    // getAmountIn

    it('should throw when reserveOut is zero (getAmountIn)', () => {
      expect(() =>
        swap.getAmountIn(100n, RESERVE, 0n, FEE_30),
      ).toThrow('Insufficient liquidity');
    });

    it('should throw when reserveIn is zero (getAmountIn)', () => {
      expect(() =>
        swap.getAmountIn(100n, 0n, RESERVE, FEE_30),
      ).toThrow('Insufficient liquidity');
    });

    it('should compute a positive required input for a 1-stroop desired output', () => {
      const requiredIn = swap.getAmountIn(1n, RESERVE, RESERVE, FEE_30);
      expect(requiredIn).toBeGreaterThan(0n);
    });

    it('should treat a negative amountOut as insufficient output and throw (getAmountIn)', () => {
      expect(() =>
        swap.getAmountIn(-1n, RESERVE, RESERVE, FEE_30),
      ).toThrow('Insufficient output');
    });

    // Cross-function invariants

    it('roundtrip: getAmountOut(getAmountIn(y)) should return at least y', () => {
      const desiredOut = 1_000_000n;
      const requiredIn = swap.getAmountIn(desiredOut, RESERVE, RESERVE, FEE_30);
      const actualOut = swap.getAmountOut(requiredIn, RESERVE, RESERVE, FEE_30);
      expect(actualOut).toBeGreaterThanOrEqual(desiredOut);
    });

    it('should preserve constant-product invariant (k never decreases) across multiple fee levels', () => {
      const amountIn = 50_000_000n;
      const reserveIn = 500_000_000n;
      const reserveOut = 800_000_000n;
      const kBefore = reserveIn * reserveOut;

      for (const feeBps of [0, 10, 30, 100]) {
        const amountOut = swap.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
        const kAfter = (reserveIn + amountIn) * (reserveOut - amountOut);
        expect(kAfter).toBeGreaterThanOrEqual(kBefore);
      }
    });
  });
});
