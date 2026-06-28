import { getPriceDeviation, PriceFeed, DeviationResult } from '../src/modules/price-feed';

describe('getPriceDeviation', () => {
  const ORACLE_PRICE = 1000;

  function createPriceFeed(price: number): PriceFeed {
    return { getPrice: async () => price };
  }

  describe('acceptance criteria', () => {
    it('within bounds (10 bps deviation) returns isWithinBounds: true', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(1001, feed);
      expect(result.deviationBps).toBe(10);
      expect(result.isWithinBounds).toBe(true);
      expect(result.oraclePrice).toBe(ORACLE_PRICE);
    });

    it('exceeds bounds (200 bps deviation) returns isWithinBounds: false', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(1020, feed);
      expect(result.deviationBps).toBe(200);
      expect(result.isWithinBounds).toBe(false);
      expect(result.oraclePrice).toBe(ORACLE_PRICE);
    });

    it('exactly at boundary (50 bps) returns isWithinBounds: true', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(1005, feed);
      expect(result.deviationBps).toBe(50);
      expect(result.isWithinBounds).toBe(true);
      expect(result.oraclePrice).toBe(ORACLE_PRICE);
    });
  });

  describe('deviationBps accuracy', () => {
    it('computes 1 bps deviation accurately', async () => {
      const feed = createPriceFeed(1000);
      const result = await getPriceDeviation(1000.1, feed);
      expect(result.deviationBps).toBe(1);
    });

    it('computes 99 bps deviation accurately', async () => {
      const feed = createPriceFeed(1000);
      const result = await getPriceDeviation(1009.9, feed);
      expect(result.deviationBps).toBe(99);
    });

    it('rounds fractional bps to nearest integer', async () => {
      const feed = createPriceFeed(1000);
      const result = await getPriceDeviation(1000.25, feed);
      expect(result.deviationBps).toBe(3);
    });
  });

  describe('custom maxDeviationBps', () => {
    it('respects a custom threshold', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(1002, feed, 10);
      expect(result.deviationBps).toBe(20);
      expect(result.isWithinBounds).toBe(false);
    });

    it('passes with a generous threshold', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(1200, feed, 5000);
      expect(result.isWithinBounds).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles zero oracle price', async () => {
      const feed = createPriceFeed(0);
      const result = await getPriceDeviation(100, feed);
      expect(result.deviationBps).toBe(0);
      expect(result.isWithinBounds).toBe(true);
    });

    it('handles identical prices', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(ORACLE_PRICE, feed);
      expect(result.deviationBps).toBe(0);
      expect(result.isWithinBounds).toBe(true);
    });

    it('handles price below oracle', async () => {
      const feed = createPriceFeed(ORACLE_PRICE);
      const result = await getPriceDeviation(990, feed);
      expect(result.deviationBps).toBe(100);
      expect(result.isWithinBounds).toBe(false);
    });
  });
});
