import { describe, it, expect } from 'vitest';
import {
  TOKEN_DECIMALS,
  PRICE_SCALE,
  BPS_DENOMINATOR,
  CONVERSION_SCALE,
  SCALE,
} from '@/utils/scale-constants';

describe('Scale Constants', () => {
  describe('TOKEN_DECIMALS', () => {
    it('equals 10^7 (Stellar precision)', () => {
      expect(TOKEN_DECIMALS).toBe(BigInt(10_000_000));
      expect(TOKEN_DECIMALS).toBe(10n ** 7n);
    });

    it('can convert stroops to tokens', () => {
      const stroops = BigInt(10_000_000);
      const tokens = stroops / TOKEN_DECIMALS;
      expect(tokens).toBe(1n);
    });
  });

  describe('PRICE_SCALE', () => {
    it('equals 10^8 for USD pricing', () => {
      expect(PRICE_SCALE).toBe(BigInt(100_000_000));
      expect(PRICE_SCALE).toBe(10n ** 8n);
    });

    it('scales price correctly', () => {
      const priceUSD = 1.5;
      const scaled = BigInt(Math.floor(priceUSD * 1e8));
      expect(scaled).toBe(BigInt(150_000_000));
    });
  });

  describe('BPS_DENOMINATOR', () => {
    it('equals 10^4 for basis points', () => {
      expect(BPS_DENOMINATOR).toBe(BigInt(10_000));
      expect(BPS_DENOMINATOR).toBe(10n ** 4n);
    });

    it('converts basis points to percentage', () => {
      const bps = 50n;
      const percent = (bps * 100n) / BPS_DENOMINATOR;
      expect(percent).toBe(0n);

      const bps2 = 500n;
      const percent2 = (bps2 * 100n) / BPS_DENOMINATOR;
      expect(percent2).toBe(5n);
    });
  });

  describe('CONVERSION_SCALE', () => {
    it('equals 10^7 for intermediate conversions', () => {
      expect(CONVERSION_SCALE).toBe(BigInt(10_000_000));
      expect(CONVERSION_SCALE).toBe(TOKEN_DECIMALS);
    });
  });

  describe('SCALE bundle', () => {
    it('includes all constants', () => {
      expect(SCALE.TOKEN_DECIMALS).toBe(TOKEN_DECIMALS);
      expect(SCALE.PRICE_SCALE).toBe(PRICE_SCALE);
      expect(SCALE.BPS_DENOMINATOR).toBe(BPS_DENOMINATOR);
      expect(SCALE.CONVERSION_SCALE).toBe(CONVERSION_SCALE);
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(SCALE)).toBe(true);
    });
  });

  describe('consistent scaling', () => {
    it('maintains precision across conversions', () => {
      const tokenAmount = 100n * TOKEN_DECIMALS;
      const converted = tokenAmount / TOKEN_DECIMALS;
      expect(converted).toBe(100n);
    });

    it('handles price to token conversion', () => {
      const pricePerToken = PRICE_SCALE;
      const tokenAmount = 10n * TOKEN_DECIMALS;
      const scaled = (pricePerToken * tokenAmount) / TOKEN_DECIMALS;
      expect(scaled).toBe(PRICE_SCALE);
    });
  });
});
