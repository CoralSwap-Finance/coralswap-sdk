import {
  toSorobanAmount,
  parseTokenAmount,
  fromSorobanAmount,
  formatAmount,
  formatLargeNumber,
  toBps,
  applyBps,
  safeMul,
  safeDiv,
  minBigInt,
  maxBigInt,
} from '../src/utils/amounts';

describe('Amount Utilities', () => {
  describe('toSorobanAmount', () => {
    it('converts whole numbers', () => {
      expect(toSorobanAmount('1', 7)).toBe(10000000n);
    });

    it('converts decimal numbers', () => {
      expect(toSorobanAmount('1.5', 7)).toBe(15000000n);
    });

    it('handles zero', () => {
      expect(toSorobanAmount('0', 7)).toBe(0n);
    });

    it('truncates excess decimals', () => {
      expect(toSorobanAmount('1.123456789', 7)).toBe(11234567n);
    });

    it('pads short decimals', () => {
      expect(toSorobanAmount('1.5', 7)).toBe(15000000n);
    });
  });

  describe('parseTokenAmount', () => {
    it('parses whole amounts', () => {
      expect(parseTokenAmount('1', 7)).toBe(10000000n);
    });

    it('parses decimal amounts', () => {
      expect(parseTokenAmount('1.5', 7)).toBe(15000000n);
    });

    it('parses negative amounts', () => {
      expect(parseTokenAmount('-1.5', 7)).toBe(-15000000n);
    });

    it('trims whitespace', () => {
      expect(parseTokenAmount(' 1.5 ', 7)).toBe(15000000n);
    });

    it('throws on invalid format', () => {
      expect(() => parseTokenAmount('abc', 7)).toThrow('Invalid amount format');
    });

    it('throws on invalid decimals', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => parseTokenAmount('1', -1 as any)).toThrow('Invalid decimals');
    });
  });

  describe('fromSorobanAmount', () => {
    it('converts to decimal string', () => {
      expect(fromSorobanAmount(15000000n, 7)).toBe('1.5000000');
    });

    it('handles zero', () => {
      expect(fromSorobanAmount(0n, 7)).toBe('0.0000000');
    });

    it('handles negative amounts', () => {
      expect(fromSorobanAmount(-15000000n, 7)).toBe('-1.5000000');
    });
  });

  describe('formatAmount', () => {
    it('formats with display decimals', () => {
      expect(formatAmount(15000000n, 7, 2)).toBe('1.50');
    });

    it('formats with 4 display decimals by default', () => {
      expect(formatAmount(15123456n, 7)).toBe('1.5123');
    });
  });

  describe('toBps', () => {
    it('calculates basis points', () => {
      expect(toBps(30n, 10000n)).toBe(30);
    });

    it('handles zero denominator', () => {
      expect(toBps(30n, 0n)).toBe(0);
    });
  });

  describe('applyBps', () => {
    it('applies basis points to amount', () => {
      expect(applyBps(10000n, 30)).toBe(30n);
    });
  });

  describe('safeMul', () => {
    it('multiplies safely', () => {
      expect(safeMul(100n, 200n)).toBe(20000n);
    });

    it('returns 0n when first operand is zero', () => {
      expect(safeMul(0n, 1000000000000000000n)).toBe(0n);
    });

    it('returns 0n when second operand is zero', () => {
      expect(safeMul(1000000000000000000n, 0n)).toBe(0n);
    });

    it('returns 0n when both operands are zero', () => {
      expect(safeMul(0n, 0n)).toBe(0n);
    });

    it('handles large non-zero inputs correctly', () => {
      const big = BigInt('1000000000000000000');
      expect(safeMul(big, 2n)).toBe(2000000000000000000n);
    });
  });

  describe('safeDiv', () => {
    it('divides safely', () => {
      expect(safeDiv(200n, 100n)).toBe(2n);
    });

    it('throws on division by zero', () => {
      expect(() => safeDiv(200n, 0n)).toThrow('Division by zero');
    });
  });

  describe('minBigInt / maxBigInt', () => {
    it('returns minimum', () => {
      expect(minBigInt(100n, 200n)).toBe(100n);
    });

    it('returns maximum', () => {
      expect(maxBigInt(100n, 200n)).toBe(200n);
    });
  });

  describe('formatLargeNumber', () => {
    describe('suffix selection', () => {
      it('formats thousands with K suffix', () => {
        expect(formatLargeNumber(1500n)).toBe('1.5K');
      });

      it('formats millions with M suffix', () => {
        expect(formatLargeNumber(2500000n)).toBe('2.5M');
      });

      it('formats billions with B suffix', () => {
        expect(formatLargeNumber(1230000000n)).toBe('1.2B');
      });

      it('formats trillions with T suffix', () => {
        expect(formatLargeNumber(5_000_000_000_000n)).toBe('5.0T');
      });
    });

    describe('values below 1,000', () => {
      it('returns plain string for zero', () => {
        expect(formatLargeNumber(0n)).toBe('0');
      });

      it('returns plain string for small values', () => {
        expect(formatLargeNumber(42n)).toBe('42');
      });

      it('returns plain string for 999', () => {
        expect(formatLargeNumber(999n)).toBe('999');
      });
    });

    describe('boundary values', () => {
      it('formats exactly 1,000 with K suffix', () => {
        expect(formatLargeNumber(1000n)).toBe('1.0K');
      });

      it('formats exactly 1,000,000 with M suffix', () => {
        expect(formatLargeNumber(1_000_000n)).toBe('1.0M');
      });

      it('formats exactly 1,000,000,000 with B suffix', () => {
        expect(formatLargeNumber(1_000_000_000n)).toBe('1.0B');
      });

      it('formats exactly 1,000,000,000,000 with T suffix', () => {
        expect(formatLargeNumber(1_000_000_000_000n)).toBe('1.0T');
      });
    });

    describe('precision parameter', () => {
      it('uses default precision of 1', () => {
        expect(formatLargeNumber(1500n)).toBe('1.5K');
      });

      it('formats with precision 0 (no decimals)', () => {
        expect(formatLargeNumber(1500n, 0)).toBe('1K');
      });

      it('formats with precision 2', () => {
        expect(formatLargeNumber(1500n, 2)).toBe('1.50K');
      });

      it('formats with precision 3', () => {
        expect(formatLargeNumber(1_234_567n, 3)).toBe('1.234M');
      });

      it('truncates rather than rounds', () => {
        expect(formatLargeNumber(1999n, 1)).toBe('1.9K');
      });

      it('truncates with higher precision', () => {
        expect(formatLargeNumber(1_999_999n, 2)).toBe('1.99M');
      });
    });

    describe('negative values', () => {
      it('formats negative thousands', () => {
        expect(formatLargeNumber(-2500n)).toBe('-2.5K');
      });

      it('formats negative millions', () => {
        expect(formatLargeNumber(-2500000n)).toBe('-2.5M');
      });

      it('formats negative values below 1,000', () => {
        expect(formatLargeNumber(-42n)).toBe('-42');
      });

      it('formats negative billions', () => {
        expect(formatLargeNumber(-1_500_000_000n)).toBe('-1.5B');
      });
    });

    describe('very large values', () => {
      it('formats values above trillions with T suffix', () => {
        expect(formatLargeNumber(999_000_000_000_000n)).toBe('999.0T');
      });

      it('formats quadrillions with T suffix', () => {
        expect(formatLargeNumber(1_500_000_000_000_000n)).toBe('1500.0T');
      });
    });

    describe('error handling', () => {
      it('throws on negative precision', () => {
        expect(() => formatLargeNumber(1000n, -1)).toThrow(
          'Precision must be a non-negative integer',
        );
      });

      it('throws on non-integer precision', () => {
        expect(() => formatLargeNumber(1000n, 1.5)).toThrow(
          'Precision must be a non-negative integer',
        );
      });
    });
  });
});
