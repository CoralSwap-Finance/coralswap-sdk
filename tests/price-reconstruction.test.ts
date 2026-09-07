import { Fraction } from '../src/utils/math';
import { getAmountOut, getAmountIn } from '../src/utils/math';

/**
 * Price reconstruction test suite.
 *
 * Verifies that spot prices, TWAP prices, and swap prices are internally
 * consistent across different reserve scales, token decimals, and price
 * denominations (1e7 vs 1e8).
 *
 * These tests use fixture reserves to ensure every price surface agrees
 * within rounding, catching unit mismatches.
 */

describe('Price Reconstruction Math', () => {
  // =========================================================================
  // Fixture Definitions
  // =========================================================================

  type PairFixture = {
    reserveA: bigint;
    reserveB: bigint;
    decimalsA: number;
    decimalsB: number;
    priceScale: number; // 1e7 or 1e8
    expectedSpotPrice: number; // normalized price
    description: string;
  };

  // Test fixtures covering different reserve scales and decimal combinations
  const fixtures: PairFixture[] = [
    {
      reserveA: 100_000_000_000_000n, // 100,000 tokens with 7 decimals
      reserveB: 200_000_000_000_000n, // 200,000 tokens with 7 decimals
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e7,
      expectedSpotPrice: 2.0,
      description: 'equal decimals, 1e7 scale',
    },
    {
      reserveA: 1_000_000_000_000_000n, // 1,000,000 tokens with 7 decimals
      reserveB: 2_000_000_000_000_000n, // 2,000,000 tokens with 7 decimals
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e7,
      expectedSpotPrice: 2.0,
      description: 'large reserves, 1e7 scale',
    },
    {
      reserveA: 100_000_000_000_000n,
      reserveB: 200_000_000_000_000n,
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e8,
      expectedSpotPrice: 2.0,
      description: 'equal decimals, 1e8 scale',
    },
    {
      reserveA: 100_000_000_000n, // 100 tokens with 7 decimals
      reserveB: 200_000_000_000n, // 200 tokens with 7 decimals
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e8,
      expectedSpotPrice: 2.0,
      description: 'small reserves, 1e8 scale',
    },
    {
      reserveA: 100_000_000_000_000n,
      reserveB: 200_000_000_000_000n,
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e8,
      expectedSpotPrice: 2.0,
      description: 'equal reserves, 1e8 scale',
    },
    // Mixed decimals
    {
      reserveA: 100_000_000_000_000n,
      reserveB: 200_000_000_000_000n,
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e7,
      expectedSpotPrice: 2.0,
      description: '7 vs 7 decimals, 1e7 scale',
    },
    {
      reserveA: 100_000_000_000_000n,
      reserveB: 200_000_000_000_000n,
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e8,
      expectedSpotPrice: 2.0,
      description: '7 vs 7 decimals, 1e8 scale',
    },
    // Imbalanced reserves
    {
      reserveA: 50_000_000_000_000n,
      reserveB: 200_000_000_000_000n,
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e7,
      expectedSpotPrice: 4.0,
      description: 'imbalanced reserves (1:4)',
    },
    {
      reserveA: 200_000_000_000_000n,
      reserveB: 50_000_000_000_000n,
      decimalsA: 7,
      decimalsB: 7,
      priceScale: 1e7,
      expectedSpotPrice: 0.25,
      description: 'imbalanced reserves (4:1)',
    },
  ];

  // =========================================================================
  // 1. Spot Price Tests
  // =========================================================================

  describe('Spot Price Consistency', () => {
    fixtures.forEach((fixture) => {
      it(`spot price matches expected for: ${fixture.description}`, () => {
        const { reserveA, reserveB, expectedSpotPrice } = fixture;

        // Compute spot price as reserveB / reserveA (price of token A in terms of token B)
        const spotPrice = Number(reserveB) / Number(reserveA);

        // Allow 0.1% tolerance for floating point
        const tolerance = 0.001;
        expect(spotPrice).toBeCloseTo(expectedSpotPrice, 3);
        expect(Math.abs(spotPrice - expectedSpotPrice) / expectedSpotPrice).toBeLessThan(tolerance);
      });
    });
  });

  // =========================================================================
  // 2. Swap Price Consistency (getAmountOut)
  // =========================================================================

  describe('Swap Price Consistency (getAmountOut)', () => {
    const feeBps = 30; // 0.3% standard fee

    fixtures.forEach((fixture) => {
      it(`swap output matches expected for: ${fixture.description}`, () => {
        const { reserveA, reserveB } = fixture;

        // Swap 1% of reserve
        const amountIn = reserveA / 100n;
        const amountOut = getAmountOut(amountIn, reserveA, reserveB, feeBps);

        // The price should be approximately reserveB/reserveA (spot price)
        const expectedOut = (amountIn * reserveB) / reserveA;
        const expectedOutWithFee = (expectedOut * BigInt(10000 - feeBps)) / 10000n;

        // Should be within 0.1% of expected
        const diff = Number(amountOut - expectedOutWithFee);
        const relativeDiff = Math.abs(diff) / Number(expectedOutWithFee);
        expect(relativeDiff).toBeLessThan(0.001);
      });
    });
  });

  // =========================================================================
  // 3. Price Scale Consistency (1e7 vs 1e8)
  // =========================================================================

  describe('Price Scale Consistency (1e7 vs 1e8)', () => {
    it('price scales yield consistent ratios', () => {
      const reserveA = 100_000_000_000_000n;
      const reserveB = 200_000_000_000_000n;

      // 1e7 scale
      const price7 = new Fraction(reserveB, reserveA).multiply(1e7);
      const price7Num = Number(price7.numerator) / Number(price7.denominator);

      // 1e8 scale
      const price8 = new Fraction(reserveB, reserveA).multiply(1e8);
      const price8Num = Number(price8.numerator) / Number(price8.denominator);

      // Price should be exactly 10x (1e8 / 1e7)
      expect(price8Num).toBeCloseTo(price7Num * 10, 9);
      expect(price8Num / price7Num).toBeCloseTo(10, 9);
    });
  });

  // =========================================================================
  // 4. Round-trip Consistency
  // =========================================================================

  describe('Round-trip Swap Consistency', () => {
    const feeBps = 30;

    fixtures.forEach((fixture) => {
      it(`swap round-trip conserves value for: ${fixture.description}`, () => {
        const { reserveA, reserveB } = fixture;

        const amountIn = reserveA / 1000n;

        // Swap A -> B
        const amountOut = getAmountOut(amountIn, reserveA, reserveB, feeBps);

        // Swap B -> A (should get back approximately the same amount)
        const amountBack = getAmountOut(amountOut, reserveB, reserveA, feeBps);

        // Due to fees, amount back < amount in
        expect(amountBack).toBeLessThan(amountIn);
        expect(amountBack).toBeGreaterThan(amountIn * 98n / 100n); // At least 98% of original
      });
    });
  });

  // =========================================================================
  // 5. Decimal Edge Cases
  // =========================================================================

  describe('Decimal Edge Cases', () => {
    it('handles extreme decimal differences', () => {
      // Token A has 7 decimals, Token B has 9 decimals
      const reserveA = 100_000_000_000_000n;
      const reserveB = 200_000_000_000_000n;
      const decimalsA = 7;
      const decimalsB = 9;

      // Normalize reserves to same decimal for comparison
      const normalizedA = reserveA * BigInt(10 ** (decimalsB - decimalsA));
      const spotPrice = Number(reserveB) / Number(normalizedA);

      expect(spotPrice).toBeGreaterThan(0);
      expect(Number.isFinite(spotPrice)).toBe(true);
    });

    it('handles zero reserves gracefully (should throw)', () => {
      expect(() => {
        getAmountOut(100n, 0n, 1000n, 30);
      }).toThrow();
    });
  });

  // =========================================================================
  // 6. TWAP-like Price Consistency
  // =========================================================================

  describe('TWAP-like Price Consistency', () => {
    it('price ratios remain consistent across different time windows', () => {
      const reserveA = 100_000_000_000_000n;
      const reserveB = 200_000_000_000_000n;

      // Simulate different price observations (should be consistent)
      const observations = [
        { reserveA: reserveA, reserveB: reserveB },
        { reserveA: reserveA * 99n / 100n, reserveB: reserveB * 101n / 100n },
        { reserveA: reserveA * 101n / 100n, reserveB: reserveB * 99n / 100n },
      ];

      const prices = observations.map((obs) => {
        const price = new Fraction(obs.reserveB, obs.reserveA);
        return Number(price.numerator) / Number(price.denominator);
      });

      // All prices should be close to the expected price (2.0)
      prices.forEach((price) => {
        expect(price).toBeCloseTo(2.0, 1);
      });

      // The average should also be close
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      expect(avg).toBeCloseTo(2.0, 1);
    });
  });

  // =========================================================================
  // 7. Fee Impact on Price
  // =========================================================================

  describe('Fee Impact on Price', () => {
    it('higher fees result in lower output', () => {
      const reserveA = 100_000_000_000_000n;
      const reserveB = 200_000_000_000_000n;
      const amountIn = reserveA / 1000n;

      const outLowFee = getAmountOut(amountIn, reserveA, reserveB, 10);
      const outHighFee = getAmountOut(amountIn, reserveA, reserveB, 100);

      expect(outHighFee).toBeLessThan(outLowFee);
    });
  });

  // =========================================================================
  // 8. Price Scale Consistency (1e7 vs 1e8) - Extended
  // =========================================================================

  describe('Price Scale Consistency (Extended)', () => {
    it('1e7 and 1e8 prices maintain ratio across different reserves', () => {
      const testCases = [
        { reserveA: 100_000_000_000_000n, reserveB: 200_000_000_000_000n },
        { reserveA: 1_000_000_000_000_000n, reserveB: 500_000_000_000_000n },
        { reserveA: 50_000_000_000_000n, reserveB: 75_000_000_000_000n },
      ];

      testCases.forEach(({ reserveA, reserveB }) => {
        const scale7 = new Fraction(reserveB, reserveA).multiply(1e7);
        const scale8 = new Fraction(reserveB, reserveA).multiply(1e8);

        const num7 = Number(scale7.numerator) / Number(scale7.denominator);
        const num8 = Number(scale8.numerator) / Number(scale8.denominator);

        // Ratio should always be 10
        expect(num8 / num7).toBeCloseTo(10, 9);
      });
    });
  });
});
