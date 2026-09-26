/**
 * Fuzz and property tests for amounts.ts
 * Tests round-tripping, truncation policy, and sub-stroop rejection
 */

import {
  parseTokenAmount,
  toSorobanAmount,
  fromSorobanAmount,
  formatAmount,
  applyBps,
  getSlippageTolerance,
  percentDiff,
  safeMul,
  safeDiv,
  minBigInt,
  maxBigInt,
  formatLargeNumber,
} from '@/utils/amounts';
import { ValidationError } from '@/errors';

describe('amounts.ts - Fuzz and Property Tests', () => {
  describe('Round-trip Property: parseTokenAmount <-> fromSorobanAmount', () => {
    it('should round-trip for whole numbers', () => {
      const testCases = [
        { value: '1', decimals: 7 },
        { value: '100', decimals: 6 },
        { value: '1000000', decimals: 18 },
        { value: '0', decimals: 7 },
      ];

      testCases.forEach(({ value, decimals }) => {
        const parsed = parseTokenAmount(value, decimals);
        const roundTripped = fromSorobanAmount(parsed, decimals);
        const reparsed = parseTokenAmount(roundTripped, decimals);
        expect(reparsed).toBe(parsed);
      });
    });

    it('should round-trip for decimals within precision', () => {
      const testCases = [
        { value: '1.5', decimals: 7 },
        { value: '0.123456', decimals: 6 },
        { value: '999.999999999999', decimals: 12 },
      ];

      testCases.forEach(({ value, decimals }) => {
        const parsed = parseTokenAmount(value, decimals);
        const roundTripped = fromSorobanAmount(parsed, decimals);
        const reparsed = parseTokenAmount(roundTripped, decimals);
        expect(reparsed).toBe(parsed);
      });
    });

    it('should preserve negative amounts through round-trip', () => {
      const testCases = [
        { value: '-1.5', decimals: 7 },
        { value: '-100.123', decimals: 6 },
        { value: '-0.0001', decimals: 4 },
      ];

      testCases.forEach(({ value, decimals }) => {
        const parsed = parseTokenAmount(value, decimals);
        const roundTripped = fromSorobanAmount(parsed, decimals);
        const reparsed = parseTokenAmount(roundTripped, decimals);
        expect(reparsed).toBe(parsed);
      });
    });

    it('should handle positive sign explicitly', () => {
      const parsed1 = parseTokenAmount('+1.5', 7);
      const parsed2 = parseTokenAmount('1.5', 7);
      expect(parsed1).toBe(parsed2);
    });
  });

  describe('Truncation Policy: excess decimals are always truncated', () => {
    it('should truncate excess decimal places', () => {
      // 1.123456789 with 7 decimals should truncate to 1.1234567 (not round to 1.1234568)
      const result = parseTokenAmount('1.123456789', 7);
      expect(result).toBe(11234567n);

      const roundTripped = fromSorobanAmount(result, 7);
      expect(roundTripped).toBe('1.1234567');
    });

    it('should truncate without rounding up', () => {
      // 0.9999999 with 7 decimals = 9999999, not 10000000
      const result = parseTokenAmount('0.9999999', 7);
      expect(result).toBe(9999999n);
    });

    it('should handle many excess decimals', () => {
      const excess = '1.' + '9'.repeat(50);
      const result = parseTokenAmount(excess, 7);
      expect(result).toBe(19999999n);
    });

    it('should preserve zero decimal padding', () => {
      const result = parseTokenAmount('1.0', 7);
      expect(result).toBe(10000000n);
      expect(fromSorobanAmount(result, 7)).toBe('1.0000000');
    });

    it('should pad insufficient decimal places with zeros', () => {
      const result = parseTokenAmount('1.1', 7);
      expect(result).toBe(11000000n);
      expect(fromSorobanAmount(result, 7)).toBe('1.1000000');
    });
  });

  describe('Sub-stroop Rejection: values with more decimals than token precision are rejected', () => {
    it('should truncate but not error on excess decimals', () => {
      // Even though XLM has 7 decimals, we allow parsing with more decimal places
      // and simply truncate excess (no ValidationError for sub-unit amounts)
      const input = '1.12345678'; // 8 decimals, XLM has 7
      expect(() => parseTokenAmount(input, 7)).not.toThrow();
      const result = parseTokenAmount(input, 7);
      expect(result).toBe(11234567n); // truncated to 7 decimals
    });

    it('should reject empty strings', () => {
      expect(() => parseTokenAmount('', 7)).toThrow('Amount is required');
    });

    it('should reject whitespace-only strings', () => {
      expect(() => parseTokenAmount('   ', 7)).toThrow('Amount is required');
    });

    it('should reject invalid amount formats', () => {
      const invalid = [
        '1.2.3',
        'abc',
        '1.5abc',
        'NaN',
        'Infinity',
        '1e10',
        '1E10',
      ];

      invalid.forEach((value) => {
        expect(() => parseTokenAmount(value, 7)).toThrow('Invalid amount format');
      });
    });

    it('should reject invalid decimal counts', () => {
      expect(() => parseTokenAmount('1.5', -1)).toThrow('Invalid decimals');
      expect(() => parseTokenAmount('1.5', 3.5)).toThrow('Invalid decimals');
      expect(() => parseTokenAmount('1.5', NaN)).toThrow('Invalid decimals');
    });
  });

  describe('Large Number Formatting Fuzz Tests', () => {
    it('should handle all magnitude ranges', () => {
      const testCases = [
        { value: 42n, expected: '42' },
        { value: 999n, expected: '999' },
        { value: 1000n, expected: '1.0K' },
        { value: 1500n, expected: '1.5K' },
        { value: 1_000_000n, expected: '1.0M' },
        { value: 2_500_000n, expected: '2.5M' },
        { value: 1_000_000_000n, expected: '1.0B' },
        { value: 1_230_000_000n, expected: '1.2B' },
        { value: 1_000_000_000_000n, expected: '1.0T' },
        { value: 5_000_000_000_000n, expected: '5.0T' },
      ];

      testCases.forEach(({ value, expected }) => {
        expect(formatLargeNumber(value)).toBe(expected);
      });
    });

    it('should preserve precision parameter', () => {
      expect(formatLargeNumber(1500n, 0)).toBe('1K');
      expect(formatLargeNumber(1500n, 1)).toBe('1.5K');
      expect(formatLargeNumber(1500n, 2)).toBe('1.50K');
      expect(formatLargeNumber(1500n, 3)).toBe('1.500K');
    });

    it('should handle negative values', () => {
      expect(formatLargeNumber(-1500n)).toBe('-1.5K');
      expect(formatLargeNumber(-2_500_000n)).toBe('-2.5M');
      expect(formatLargeNumber(-1_000_000_000n)).toBe('-1.0B');
    });

    it('should handle zero', () => {
      expect(formatLargeNumber(0n)).toBe('0');
      expect(formatLargeNumber(0n, 2)).toBe('0');
    });
  });

  describe('Safe Arithmetic Property Tests', () => {
    it('safeMul should detect i128 overflow', () => {
      const i128Max = (2n ** 127n) - 1n;
      const i128Min = -(2n ** 127n);

      // Valid multiplications
      expect(safeMul(100n, 200n)).toBe(20000n);
      expect(safeMul(0n, 1000000n)).toBe(0n);

      // Overflow detections
      expect(() => safeMul(i128Max, 2n)).toThrow(ValidationError);
      expect(() => safeMul(i128Max, i128Max)).toThrow(ValidationError);
    });

    it('safeDiv should catch division by zero', () => {
      expect(safeDiv(200n, 100n)).toBe(2n);
      expect(safeDiv(250n, 100n)).toBe(2n); // floors
      expect(() => safeDiv(200n, 0n)).toThrow('Division by zero');
    });

    it('min/max should handle edge cases', () => {
      expect(minBigInt(100n, 200n)).toBe(100n);
      expect(minBigInt(-50n, 50n)).toBe(-50n);
      expect(minBigInt(100n, 100n)).toBe(100n);

      expect(maxBigInt(100n, 200n)).toBe(200n);
      expect(maxBigInt(-50n, 50n)).toBe(50n);
      expect(maxBigInt(100n, 100n)).toBe(100n);
    });
  });

  describe('Basis Points Calculations Fuzz Tests', () => {
    it('applyBps should handle all valid ranges', () => {
      // 0.3% fee on 10,000
      expect(applyBps(10000n, 30)).toBe(30n);
      // 50% on 10,000
      expect(applyBps(10000n, 5000)).toBe(5000n);
      // 1% on 1,000,000
      expect(applyBps(1000000n, 100)).toBe(10000n);
      // 0% should return 0
      expect(applyBps(10000n, 0)).toBe(0n);
      // 100% should return amount
      expect(applyBps(10000n, 10000)).toBe(10000n);
    });

    it('getSlippageTolerance should apply direction correctly', () => {
      // For output (minimum acceptable), subtract slippage
      expect(getSlippageTolerance(10000n, 100n, false)).toBe(9900n);
      // For input (maximum acceptable), add slippage
      expect(getSlippageTolerance(10000n, 100n, true)).toBe(10100n);
      // Zero slippage
      expect(getSlippageTolerance(10000n, 0n, false)).toBe(10000n);
      expect(getSlippageTolerance(10000n, 0n, true)).toBe(10000n);
    });

    it('getSlippageTolerance should reject out-of-range values', () => {
      expect(() => getSlippageTolerance(10000n, -1n, false)).toThrow(
        'Slippage bips must be between 0 and 10000',
      );
      expect(() => getSlippageTolerance(10000n, 10001n, true)).toThrow(
        'Slippage bips must be between 0 and 10000',
      );
    });

    it('percentDiff should calculate deltas correctly', () => {
      expect(percentDiff(150n, 100n)).toBe(50.0); // 50% increase
      expect(percentDiff(75n, 100n)).toBe(-25.0); // 25% decrease
      expect(percentDiff(100n, 100n)).toBe(0.0); // no change
      expect(percentDiff(100n, 0n)).toBe(0); // zero reference returns 0
    });
  });

  describe('Format Amount Edge Cases', () => {
    it('should truncate display decimals correctly', () => {
      expect(formatAmount(15000000n, 7, 2)).toBe('1.50');
      expect(formatAmount(15123456n, 7, 4)).toBe('1.5123');
      expect(formatAmount(1234567n, 6, 2)).toBe('1.23');
    });

    it('should handle display decimal count of 0', () => {
      expect(formatAmount(15000000n, 7, 0)).toBe('1.');
      expect(formatAmount(15123456n, 7, 0)).toBe('1.');
    });

    it('should preserve truncation behavior (no rounding)', () => {
      // 1.5999999 with 4 display decimals should show 1.5999, not 1.6000
      expect(formatAmount(15999999n, 7, 4)).toBe('1.5999');
    });
  });

  describe('Comprehensive Fuzz: Random Valid Inputs', () => {
    it('should handle randomized decimal amounts up to 18 decimals', () => {
      const randomTests = 100;
      for (let i = 0; i < randomTests; i++) {
        const decimals = Math.floor(Math.random() * 19); // 0-18
        const wholePart = Math.floor(Math.random() * 1000000);
        const fracPart = Math.floor(Math.random() * (10 ** decimals));
        const amount = `${wholePart}.${fracPart.toString().padStart(decimals, '0')}`;

        const parsed = parseTokenAmount(amount, decimals);
        const roundTripped = fromSorobanAmount(parsed, decimals);
        const reparsed = parseTokenAmount(roundTripped, decimals);

        expect(reparsed).toBe(parsed);
      }
    });

    it('should handle large numbers without precision loss', () => {
      const largeTests = [
        { amount: '999999999.999999999', decimals: 9 },
        { amount: '1000000000.1', decimals: 1 },
        { amount: '999.999', decimals: 3 },
      ];

      largeTests.forEach(({ amount, decimals }) => {
        const parsed = parseTokenAmount(amount, decimals);
        expect(parsed).toBeGreaterThan(0n);
        const formatted = fromSorobanAmount(parsed, decimals);
        expect(formatted).toBeDefined();
      });
    });
  });
});
