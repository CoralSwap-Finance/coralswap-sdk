
import { Fraction, Percent, Rounding } from '../src/utils/math';

describe('Fraction', () => {
  it('constructs correctly', () => {
    const f = new Fraction(1, 2);
    expect(f.numerator).toBe(1n);
    expect(f.denominator).toBe(2n);
  });

  it('add', () => {
    const f1 = new Fraction(1, 2);
    const f2 = new Fraction(1, 4);
    const sum = f1.add(f2);
    expect(sum.numerator).toBe(6n); // 1*4 + 1*2 = 6
    expect(sum.denominator).toBe(8n); // 2*4 = 8
    // Note: It doesn't auto-simplify, so 6/8 is expected unless logic added
  });

  it('sub', () => {
    const f1 = new Fraction(1, 2);
    const f2 = new Fraction(1, 4);
    const diff = f1.sub(f2);
    expect(diff.numerator).toBe(2n); // 1*4 - 1*2 = 2
    expect(diff.denominator).toBe(8n); // 8
  });

  it('multiply', () => {
    const f1 = new Fraction(1, 2);
    const f2 = new Fraction(2, 3);
    const prod = f1.multiply(f2);
    expect(prod.numerator).toBe(2n);
    expect(prod.denominator).toBe(6n);
  });

  it('divide', () => {
    const f1 = new Fraction(1, 2);
    const f2 = new Fraction(1, 4);
    const quot = f1.divide(f2);
    expect(quot.numerator).toBe(4n);
    expect(quot.denominator).toBe(2n);
  });

  describe('toFixed', () => {
    it('formats integers', () => {
      expect(new Fraction(5, 1).toFixed(2)).toBe('5.00');
    });

    it('formats simple fractions', () => {
      expect(new Fraction(1, 2).toFixed(2)).toBe('0.50');
    });

    it('formats recurring fractions', () => {
      expect(new Fraction(1, 3).toFixed(2)).toBe('0.33');
      expect(new Fraction(2, 3).toFixed(2)).toBe('0.67'); // Round half up
    });

    it('formats small numbers', () => {
      expect(new Fraction(1, 100).toFixed(2)).toBe('0.01');
      expect(new Fraction(1, 1000).toFixed(2)).toBe('0.00');
    });

    it('handles negative numbers', () => {
      expect(new Fraction(-1, 3).toFixed(2)).toBe('-0.33');
    });
  });

  describe('toSignificant', () => {
    it('formats simple fractions', () => {
      expect(new Fraction(1, 3).toSignificant(3)).toBe('0.333');
      expect(new Fraction(1, 2).toSignificant(3)).toBe('0.500');
    });

    it('formats > 1 numbers', () => {
      expect(new Fraction(12345, 1).toSignificant(3)).toBe('12300');
      expect(new Fraction(12345, 10).toSignificant(3)).toBe('1230'); // 1234.5 -> 1230
      expect(new Fraction(12345, 100).toSignificant(3)).toBe('123'); // 123.45 -> 123
    });

    it('formats < 1 numbers', () => {
      expect(new Fraction(1, 300).toSignificant(3)).toBe('0.00333');
      expect(new Fraction(123, 100000).toSignificant(3)).toBe('0.00123');
    });

    it('handles rounding edge cases', () => {
      // 0.0999 -> 0.10 with 2 sig figs
      expect(new Fraction(999, 10000).toSignificant(2)).toBe('0.10');
      
      // 0.00999 -> 0.010 with 2 sig figs
      expect(new Fraction(999, 100000).toSignificant(2)).toBe('0.010');
      
      // 99.9 -> 100 with 2 sig figs
      expect(new Fraction(999, 10).toSignificant(2)).toBe('100');
    });

    it('handles negative numbers', () => {
      expect(new Fraction(-1, 3).toSignificant(3)).toBe('-0.333');
    });
  });
});

describe('Percent', () => {
  it('converts correctly', () => {
    const p = new Percent(1, 100); // 1/100 = 1%
    expect(p.toSignificant(3)).toBe('1.00'); // 1.00%
    expect(p.toFixed(2)).toBe('1.00');
  });

  it('handles 100%', () => {
    const p = new Percent(1, 1); // 1/1 = 100%
    expect(p.toSignificant(3)).toBe('100');
  });

  it('handles small percentages', () => {
    const p = new Percent(1, 10000); // 0.01%
    expect(p.toSignificant(2)).toBe('0.010');
  });
});
