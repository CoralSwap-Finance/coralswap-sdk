import { OracleModule, TWAPObservation, MIN_TWAP_WINDOW_SECONDS } from '../src/modules/oracle';
import { PRECISION } from '../src/config';
import { InsufficientLiquidityError } from '../src/errors';

function mockClient(pairOverrides: Record<string, (...args: any[]) => any> = {}) {
  return {
    pair: jest.fn().mockReturnValue({
      getCumulativePrices: jest.fn(),
      getTokens: jest.fn().mockResolvedValue({
        token0: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2ZCMJ',
        token1: 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7EEESNH5CS4NGOF',
      }),
      getReserves: jest.fn().mockResolvedValue({
        reserve0: 5000000000n,
        reserve1: 10000000000n,
      }),
      ...pairOverrides,
    }),
  } as any;
}

describe('OracleModule', () => {
  describe('computeTWAP', () => {
    let oracle: OracleModule;

    beforeEach(() => {
      oracle = new OracleModule(null as any);
    });

    it('calculates correct TWAP from two observations', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1600,
      };

      const result = oracle.computeTWAP(start, end);

      const expectedPrice0 = (1600000000000n - 1000000000000n) / BigInt(600);
      const expectedPrice1 = (800000000000n - 500000000000n) / BigInt(600);

      expect(result.price0TWAP).toBe(expectedPrice0);
      expect(result.price1TWAP).toBe(expectedPrice1);
      expect(result.timeWindow).toBe(600);
    });

    it('throws when time delta is zero', () => {
      const obs: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };

      expect(() => oracle.computeTWAP(obs, obs)).toThrow(
        'End observation must be after start observation',
      );
    });

    it('throws when end is before start', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 2000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1000,
      };

      expect(() => oracle.computeTWAP(start, end)).toThrow(
        'End observation must be after start observation',
      );
    });

    it('throws when time window is below minimum (manipulation resistance)', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1060, // Only 60 seconds elapsed
      };

      expect(() => oracle.computeTWAP(start, end)).toThrow(
        /TWAP window too short for manipulation resistance/,
      );
      expect(() => oracle.computeTWAP(start, end)).toThrow(
        new RegExp(`60s < ${MIN_TWAP_WINDOW_SECONDS}s minimum`),
      );
    });

    it('allows short window when enforceMinWindow is false', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1060, // Only 60 seconds elapsed
      };

      const result = oracle.computeTWAP(start, end, { enforceMinWindow: false });

      expect(result.timeWindow).toBe(60);
      expect(result.price0TWAP).toBe((1600000000000n - 1000000000000n) / 60n);
    });

    it('accepts time window at exactly the minimum threshold', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1000 + MIN_TWAP_WINDOW_SECONDS,
      };

      const result = oracle.computeTWAP(start, end);

      expect(result.timeWindow).toBe(MIN_TWAP_WINDOW_SECONDS);
      expect(result.price0TWAP).toBeTruthy();
    });
  });

  describe('observe', () => {
    it('caches observations from simulated pair responses', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      let callCount = 0;
      const cumulativeResponses = [
        {
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        },
        {
          price0CumulativeLast: 400000000n,
          price1CumulativeLast: 800000000n,
          blockTimestampLast: 1300,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(cumulativeResponses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      const obs1 = await oracle.observe(pairAddress);
      expect(obs1.price0CumulativeLast).toBe(100000000n);
      expect(obs1.blockTimestampLast).toBe(1000);
      expect(oracle.getObservationCount(pairAddress)).toBe(1);

      const obs2 = await oracle.observe(pairAddress);
      expect(obs2.price0CumulativeLast).toBe(400000000n);
      expect(obs2.blockTimestampLast).toBe(1300);
      expect(oracle.getObservationCount(pairAddress)).toBe(2);
    });
  });

  describe('getTWAP', () => {
    it('returns null when only one observation exists', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue({
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        }),
      });

      const oracle = new OracleModule(client);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).toBeNull();
    });

    it('returns correct TWAP result after multiple observations', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 1000000000000n,
          price1CumulativeLast: 2000000000000n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: 1500000000000n,
          price1CumulativeLast: 3000000000000n,
          blockTimestampLast: 10500,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).not.toBeNull();
      expect(result!.timeWindow).toBe(500);
      expect(result!.price0TWAP).toBe(
        (1500000000000n - 1000000000000n) / BigInt(500),
      );
      expect(result!.price1TWAP).toBe(
        (3000000000000n - 2000000000000n) / BigInt(500),
      );
      expect(result!.pairAddress).toBe(pairAddress);
    });

    it('returns null when timestamps have not advanced (stale data)', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const staleResponse = {
        price0CumulativeLast: 100000000n,
        price1CumulativeLast: 200000000n,
        blockTimestampLast: 5000,
      };

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue(staleResponse),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).toBeNull();
    });

    it('returns null when time window is below minimum', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 1000000000000n,
          price1CumulativeLast: 2000000000000n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: 1500000000000n,
          price1CumulativeLast: 3000000000000n,
          blockTimestampLast: 10060, // Only 60 seconds later
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).toBeNull();
    });

    it('returns TWAP when time window meets minimum threshold', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 1000000000000n,
          price1CumulativeLast: 2000000000000n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: 1500000000000n,
          price1CumulativeLast: 3000000000000n,
          blockTimestampLast: 10000 + MIN_TWAP_WINDOW_SECONDS,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).not.toBeNull();
      expect(result!.timeWindow).toBe(MIN_TWAP_WINDOW_SECONDS);
    });

    it('allows short window when enforceMinWindow is false', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 1000000000000n,
          price1CumulativeLast: 2000000000000n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: 1500000000000n,
          price1CumulativeLast: 3000000000000n,
          blockTimestampLast: 10060, // Only 60 seconds
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress, { enforceMinWindow: false });

      expect(result).not.toBeNull();
      expect(result!.timeWindow).toBe(60);
    });
  });

  describe('getSpotPrice', () => {
    it('computes spot price from reserves', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
      const reserve0 = 5000000000n;
      const reserve1 = 10000000000n;

      const client = mockClient({
        getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      });

      const oracle = new OracleModule(client);
      const spot = await oracle.getSpotPrice(pairAddress);

      expect(spot.price0Per1).toBe(
        (reserve0 * PRECISION.PRICE_SCALE) / reserve1,
      );
      expect(spot.price1Per0).toBe(
        (reserve1 * PRECISION.PRICE_SCALE) / reserve0,
      );
    });

    it('throws when pool has no liquidity', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const client = mockClient({
        getReserves: jest.fn().mockResolvedValue({
          reserve0: 0n,
          reserve1: 0n,
        }),
      });

      const oracle = new OracleModule(client);
      await expect(oracle.getSpotPrice(pairAddress)).rejects.toThrow(
        InsufficientLiquidityError,
      );
    });
  });

  describe('clearCache', () => {
    it('clears observations for a specific pair', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue({
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        }),
      });

      const oracle = new OracleModule(client);
      await oracle.observe(pairAddress);
      expect(oracle.getObservationCount(pairAddress)).toBe(1);

      oracle.clearCache(pairAddress);
      expect(oracle.getObservationCount(pairAddress)).toBe(0);
    });
  });

  describe('getPriceDeviation', () => {
    it('returns null when TWAP is not yet available', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue({
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        }),
      });

      const oracle = new OracleModule(client);
      const result = await oracle.getPriceDeviation(pairAddress);

      expect(result).toBeNull();
    });

    it('computes price deviation between TWAP and spot price', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      // Set up spot reserves: reserve0=5000, reserve1=10000
      // Spot price0Per1 = (5000 * PRICE_SCALE) / 10000 = PRICE_SCALE / 2
      const reserve0 = 5000000000n;
      const reserve1 = 10000000000n;

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 1000000000000n,
          price1CumulativeLast: 2000000000000n,
          blockTimestampLast: 10000,
        },
        {
          // Set up TWAP to be slightly different from spot
          // TWAP will be: (delta_cumulative / time_elapsed)
          // Let's make TWAP 10% higher than spot for price0
          price0CumulativeLast: 1000000000000n + BigInt(MIN_TWAP_WINDOW_SECONDS) * ((reserve0 * PRECISION.PRICE_SCALE) / reserve1) * 110n / 100n,
          price1CumulativeLast: 2000000000000n + BigInt(MIN_TWAP_WINDOW_SECONDS) * ((reserve1 * PRECISION.PRICE_SCALE) / reserve0) * 110n / 100n,
          blockTimestampLast: 10000 + MIN_TWAP_WINDOW_SECONDS,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
        getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getPriceDeviation(pairAddress);

      expect(result).not.toBeNull();
      expect(result!.price0DeviationBps).toBeGreaterThan(0);
      expect(result!.price1DeviationBps).toBeGreaterThan(0);
      expect(result!.twapPrice0).toBeTruthy();
      expect(result!.spotPrice0).toBeTruthy();
    });

    it('computes correct deviation in basis points when prices disagree', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const reserve0 = 1000000000n;
      const reserve1 = 1000000000n;

      // Create observations where TWAP differs from spot by exactly 5%
      const spotPrice0Per1 = (reserve0 * PRECISION.PRICE_SCALE) / reserve1;
      const twapPrice0 = spotPrice0Per1 * 105n / 100n; // 5% higher

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 0n,
          price1CumulativeLast: 0n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: twapPrice0 * BigInt(MIN_TWAP_WINDOW_SECONDS),
          price1CumulativeLast: ((reserve1 * PRECISION.PRICE_SCALE) / reserve0) * BigInt(MIN_TWAP_WINDOW_SECONDS),
          blockTimestampLast: 10000 + MIN_TWAP_WINDOW_SECONDS,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
        getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getPriceDeviation(pairAddress);

      expect(result).not.toBeNull();
      // Should be approximately 500 basis points (5%)
      expect(result!.price0DeviationBps).toBeGreaterThanOrEqual(450);
      expect(result!.price0DeviationBps).toBeLessThanOrEqual(550);
    });

    it('returns zero deviation when TWAP and spot prices match', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      const reserve0 = 1000000000n;
      const reserve1 = 2000000000n;

      const spotPrice0Per1 = (reserve0 * PRECISION.PRICE_SCALE) / reserve1;
      const spotPrice1Per0 = (reserve1 * PRECISION.PRICE_SCALE) / reserve0;

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 0n,
          price1CumulativeLast: 0n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: spotPrice0Per1 * BigInt(MIN_TWAP_WINDOW_SECONDS),
          price1CumulativeLast: spotPrice1Per0 * BigInt(MIN_TWAP_WINDOW_SECONDS),
          blockTimestampLast: 10000 + MIN_TWAP_WINDOW_SECONDS,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
        getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getPriceDeviation(pairAddress);

      expect(result).not.toBeNull();
      expect(result!.price0DeviationBps).toBe(0);
      expect(result!.price1DeviationBps).toBe(0);
    });

    it('handles large deviation correctly (flash loan attack scenario)', async () => {
      const pairAddress = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

      // Spot price is heavily manipulated (2x the TWAP)
      const reserve0 = 1000000000n;
      const reserve1 = 4000000000n; // Double the expected ratio

      const normalSpotPrice0 = (reserve0 * PRECISION.PRICE_SCALE) / (reserve1 / 2n);

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 0n,
          price1CumulativeLast: 0n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: normalSpotPrice0 * BigInt(MIN_TWAP_WINDOW_SECONDS),
          price1CumulativeLast: ((reserve1 / 2n) * PRECISION.PRICE_SCALE / reserve0) * BigInt(MIN_TWAP_WINDOW_SECONDS),
          blockTimestampLast: 10000 + MIN_TWAP_WINDOW_SECONDS,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
        getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getPriceDeviation(pairAddress);

      expect(result).not.toBeNull();
      // Deviation should be significant (around 100% = 10000 bps)
      expect(result!.price0DeviationBps).toBeGreaterThanOrEqual(5000);
    });
  });
});
