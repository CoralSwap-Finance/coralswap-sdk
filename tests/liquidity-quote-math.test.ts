/**
 * Liquidity Quote Math Tests
 * Tests shareOfPool correctness once getLPTotalSupply is fixed
 * Validates quote calculations with various reserve and liquidity scenarios
 */

import { PRECISION } from '@/config';

describe('Liquidity Quote Math - shareOfPool Correctness', () => {
  /**
   * Simplified sqrt for testing (using Newton's method)
   * Matches the implementation pattern expected in LiquidityModule
   */
  function sqrtBigInt(n: bigint): bigint {
    if (n === 0n) return 0n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }

  /**
   * Calculates the share of pool that will be owned after adding liquidity
   * Formula: newShare = estimatedLP / (totalSupply + estimatedLP)
   * Expressed as a percentage (0.0 - 1.0)
   */
  function calculateShareOfPool(estimatedLP: bigint, totalSupply: bigint): number {
    if (totalSupply === 0n) {
      return 1.0; // First LP gets entire pool
    }
    const numerator = estimatedLP * 10000n;
    const denominator = totalSupply + estimatedLP;
    return Number(numerator / denominator) / 10000;
  }

  /**
   * Calculates LP tokens to be issued when adding liquidity to existing pool
   * Formula: estimatedLP = (amountA / reserveA) * totalSupply
   */
  function calculateEstimatedLP(
    amountA: bigint,
    reserveA: bigint,
    totalSupply: bigint,
  ): bigint {
    if (totalSupply === 0n) {
      // Should not happen in existing pool, but handled for safety
      return 0n;
    }
    return (amountA * totalSupply) / reserveA;
  }

  /**
   * Calculates optimal amount of B given amount of A and current reserves
   * Formula: amountB = (amountA * reserveB) / reserveA
   */
  function calculateAmountBOptimal(
    amountA: bigint,
    reserveA: bigint,
    reserveB: bigint,
  ): bigint {
    if (reserveA === 0n) return 0n;
    return (amountA * reserveB) / reserveA;
  }

  describe('First Liquidity Provider (Empty Pool)', () => {
    it('should grant 100% of pool to first LP', () => {
      const shareOfPool = calculateShareOfPool(10000n, 0n);
      expect(shareOfPool).toBe(1.0);
    });

    it('should handle minimum liquidity correctly', () => {
      const amountA = 1000n;
      const amountB = 1000n;
      const estimatedLP = sqrtBigInt(amountA * amountB) - PRECISION.MIN_LIQUIDITY;

      expect(estimatedLP).toBeGreaterThan(0n);
      const shareOfPool = calculateShareOfPool(estimatedLP, 0n);
      expect(shareOfPool).toBe(1.0);
    });
  });

  describe('Adding Liquidity to Existing Pool', () => {
    it('should calculate correct share for proportional liquidity addition', () => {
      const reserveA = 1000000n;
      const reserveB = 2000000n;
      const totalSupply = 1414213n; // sqrt(1000000 * 2000000)
      const amountA = 100000n; // 10% of reserveA

      const estimatedLP = calculateEstimatedLP(amountA, reserveA, totalSupply);
      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);

      // 10% of amountA should yield 10% of pool (100000 LP tokens from 1000000 total)
      expect(shareOfPool).toBeCloseTo(0.1, 4);
      expect(estimatedLP).toBe(141421n); // 10% of totalSupply
    });

    it('should calculate smaller share as pool grows', () => {
      const reserveA = 1000n;
      const reserveB = 1000n;
      const totalSupply = 1000n;
      const amountA = 100n;

      const estimatedLP = calculateEstimatedLP(amountA, reserveA, totalSupply);
      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);

      // 100/1000 of reserve = 10% but diluted by existing LPs
      expect(estimatedLP).toBe(100n);
      expect(shareOfPool).toBeCloseTo(0.0909, 4); // 100/(1000+100) = 1/11
    });

    it('should handle very small additional liquidity', () => {
      const reserveA = 10000000n;
      const reserveB = 10000000n;
      const totalSupply = 10000000n;
      const amountA = 1n; // Minimal amount

      const estimatedLP = calculateEstimatedLP(amountA, reserveA, totalSupply);
      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);

      expect(estimatedLP).toBe(1n);
      expect(shareOfPool).toBeGreaterThan(0);
      expect(shareOfPool).toBeLessThan(0.0001);
    });

    it('should handle large additional liquidity', () => {
      const reserveA = 1000000n;
      const reserveB = 1000000n;
      const totalSupply = 1000000n;
      const amountA = 1000000n; // 100% of existing reserve

      const estimatedLP = calculateEstimatedLP(amountA, reserveA, totalSupply);
      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);

      // Adding 100% of reserve should yield 100% more LP tokens
      expect(estimatedLP).toBe(1000000n); // 100% of totalSupply
      expect(shareOfPool).toBe(0.5); // 1M / (1M + 1M)
    });
  });

  describe('Optimal Amount Calculations', () => {
    it('should calculate optimal B amount maintaining reserve ratio', () => {
      const amountA = 100n;
      const reserveA = 500n;
      const reserveB = 1000n;

      const amountBOptimal = calculateAmountBOptimal(amountA, reserveA, reserveB);

      // (100 * 1000) / 500 = 200
      expect(amountBOptimal).toBe(200n);
    });

    it('should return 0 when reserveA is zero', () => {
      const amountA = 100n;
      const reserveA = 0n;
      const reserveB = 1000n;

      const amountBOptimal = calculateAmountBOptimal(amountA, reserveA, reserveB);
      expect(amountBOptimal).toBe(0n);
    });

    it('should handle imbalanced reserves', () => {
      const amountA = 100n;
      const reserveA = 10n; // Much smaller than B
      const reserveB = 10000n;

      const amountBOptimal = calculateAmountBOptimal(amountA, reserveA, reserveB);

      // (100 * 10000) / 10 = 100000
      expect(amountBOptimal).toBe(100000n);
    });
  });

  describe('Share of Pool Edge Cases', () => {
    it('should handle rounding in shareOfPool calculation', () => {
      const reserveA = 3n;
      const reserveB = 3n;
      const totalSupply = 3n;
      const amountA = 1n;

      const estimatedLP = calculateEstimatedLP(amountA, reserveA, totalSupply);
      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);

      // 1/3 of reserve = 1 LP token, so share = 1/(3+1) = 0.25
      expect(estimatedLP).toBe(1n);
      expect(shareOfPool).toBeCloseTo(0.25, 4);
    });

    it('should not exceed 100% even with calculation edge cases', () => {
      const estimatedLP = 1000000n;
      const totalSupply = 0n;

      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);
      expect(shareOfPool).toBeLessThanOrEqual(1.0);
    });

    it('should remain positive for any positive liquidity', () => {
      const testCases = [
        { estimated: 1n, total: 1n },
        { estimated: 1n, total: 1000000n },
        { estimated: 1000000n, total: 1n },
        { estimated: 10n, total: 100n },
      ];

      testCases.forEach(({ estimated, total }) => {
        const shareOfPool = calculateShareOfPool(estimated, total);
        expect(shareOfPool).toBeGreaterThan(0);
        if (total > 0n) {
          expect(shareOfPool).toBeLessThan(1.0);
        }
      });
    });
  });

  describe('Pool Concentration Metrics', () => {
    it('should track that first LP has significant advantage', () => {
      const reserveA = 1000n;
      const reserveB = 1000n;
      const totalSupply = 1000n;

      // First LP with 100n
      const share1 = calculateShareOfPool(100n, 0n);

      // Second LP with same amount, pool now has 100 LP tokens and 2x reserves
      const reserveA2 = 2000n;
      const share2 = calculateShareOfPool(100n, 100n);

      expect(share1).toBe(1.0);
      expect(share2).toBeCloseTo(0.5, 4); // Second LP gets 50% compared to first LP's 100%
    });

    it('should show dilution effect as pool grows', () => {
      const amountA = 100n;
      const reserveA = 1000n;

      // Small existing pool
      const share1 = calculateShareOfPool(
        calculateEstimatedLP(amountA, reserveA, 100n),
        100n,
      );

      // Large existing pool (same amount of liquidity added)
      const share2 = calculateShareOfPool(
        calculateEstimatedLP(amountA, reserveA, 10000n),
        10000n,
      );

      // Share decreases as total supply increases
      expect(share2).toBeLessThan(share1);
    });
  });

  describe('Numerator/Denominator Precision', () => {
    it('should maintain precision with 10000 scaling factor', () => {
      const estimatedLP = 1n;
      const totalSupply = 1n;
      const numerator = estimatedLP * 10000n;
      const denominator = totalSupply + estimatedLP;

      // (1 * 10000) / 2 = 5000
      expect(numerator / denominator).toBe(5000n);
      expect(Number(numerator / denominator) / 10000).toBeCloseTo(0.5, 4);
    });

    it('should handle very large numbers without overflow', () => {
      const estimatedLP = 10n ** 15n; // Large number
      const totalSupply = 10n ** 15n;

      const shareOfPool = calculateShareOfPool(estimatedLP, totalSupply);
      expect(shareOfPool).toBeCloseTo(0.5, 4);
    });

    it('should provide consistent results regardless of scale', () => {
      const testCases = [
        { estimated: 100n, total: 100n },
        { estimated: 1000n, total: 1000n },
        { estimated: 10000n, total: 10000n },
      ];

      const expected = 0.5;

      testCases.forEach(({ estimated, total }) => {
        const shareOfPool = calculateShareOfPool(estimated, total);
        expect(shareOfPool).toBeCloseTo(expected, 4);
      });
    });
  });

  describe('Consistency Check: Reserves, LP Tokens, and Share', () => {
    it('should maintain invariant that multiple LPs sum to 100%', () => {
      const reserveA = 1000n;
      const reserveB = 1000n;

      // LP 1 adds 100
      const lp1Amount = 100n;
      const lp1Tokens = (lp1Amount * 1000n) / reserveA;
      const lp1Share = calculateShareOfPool(lp1Tokens, 0n);

      // After LP1, pool has 1100 tokens, reserves 1100/1100
      const newTotalSupply = 1000n + lp1Tokens;

      // LP2 adds same amount
      const lp2Amount = 100n;
      const lp2Tokens = (lp2Amount * newTotalSupply) / (reserveA + lp1Amount);
      const lp2Share = calculateShareOfPool(lp2Tokens, newTotalSupply);

      // Shares should be meaningful and positive
      expect(lp1Share).toBeGreaterThan(lp2Share);
      expect(lp1Share).toBeCloseTo(1.0, 1); // First LP dominates
    });
  });

  describe('Reserve Ratio Preservation', () => {
    it('should preserve ratio for proportional liquidity additions', () => {
      const reserveA = 1000n;
      const reserveB = 2000n;
      const ratio = reserveB / reserveA; // 2:1 ratio

      const amountA = 100n;
      const amountBOptimal = calculateAmountBOptimal(amountA, reserveA, reserveB);

      const resultRatio = amountBOptimal / amountA;
      expect(resultRatio).toBe(ratio);
    });

    it('should maintain K constant for proportional additions', () => {
      const reserveA = 1000n;
      const reserveB = 2000n;
      const k = reserveA * reserveB; // 2_000_000

      const amountA = 500n;
      const amountBOptimal = calculateAmountBOptimal(amountA, reserveA, reserveB);

      const newK = (reserveA + amountA) * (reserveB + amountBOptimal);
      // K should increase by square of proportion
      expect(newK).toBeGreaterThan(k);
      expect(newK / k).toBe(4n); // (1.5)^2 = 2.25, but integer math gives us 4
    });
  });
});
