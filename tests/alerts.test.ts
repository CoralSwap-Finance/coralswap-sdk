import { AlertModule } from '../src/modules/alerts';
import { InsufficientLiquidityError, ValidationError } from '../src/errors';
import type { CoralSwapClient } from '../src/client';
import type { ILAlertConfig, PriceAlertConfig } from '../src/types/alerts';

const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const TOKEN_C = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const PAIR = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function makeClient(
  reserves: { reserve0: bigint; reserve1: bigint },
  tokens: { token0: string; token1: string } = { token0: TOKEN_A, token1: TOKEN_B },
): CoralSwapClient {
  return {
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue(reserves),
      getTokens: jest.fn().mockResolvedValue(tokens),
    }),
  } as unknown as CoralSwapClient;
}

function makePriceConfig(
  overrides: Partial<PriceAlertConfig> = {},
): PriceAlertConfig {
  return {
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    pairAddress: PAIR,
    thresholdPrice: 2_000_000_000_000_000_000n,
    direction: 'above',
    ...overrides,
  };
}

function makeILConfig(overrides: Partial<ILAlertConfig> = {}): ILAlertConfig {
  return {
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
    pairAddress: PAIR,
    referencePrice: 1_000_000_000_000_000_000n,
    maxImpermanentLossBps: 500,
    ...overrides,
  };
}

describe('AlertModule', () => {
  describe('checkPriceAlert()', () => {
    it('triggers an above alert when pool price meets the threshold', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const alert = await alerts.checkPriceAlert(makePriceConfig(), 'price-1');

      expect(alert).toMatchObject({
        id: 'price-1',
        type: 'price',
        currentPrice: 2_500_000_000_000_000_000n,
        status: 'triggered',
        triggered: true,
      });
    });

    it('keeps a below alert active when pool price is above the threshold', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const alert = await alerts.checkPriceAlert(
        makePriceConfig({ direction: 'below' }),
        'price-2',
      );

      expect(alert.status).toBe('active');
      expect(alert.triggered).toBe(false);
    });

    it('uses reversed reserves when tokenIn is token1', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const alert = await alerts.checkPriceAlert(
        makePriceConfig({
          tokenIn: TOKEN_B,
          tokenOut: TOKEN_A,
          thresholdPrice: 400_000_000_000_000_000n,
        }),
        'price-3',
      );

      expect(alert.currentPrice).toBe(400_000_000_000_000_000n);
      expect(alert.triggered).toBe(true);
    });

    it('rejects tokens that do not belong to the pair', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await expect(
        alerts.checkPriceAlert(makePriceConfig({ tokenOut: TOKEN_C }), 'price-4'),
      ).rejects.toThrow(ValidationError);
    });

    it('throws when the pool has no liquidity', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 0n, reserve1: 250n }));

      await expect(
        alerts.checkPriceAlert(makePriceConfig(), 'price-5'),
      ).rejects.toThrow(InsufficientLiquidityError);
    });
  });

  describe('checkILAlert()', () => {
    it('triggers when impermanent loss reaches the configured threshold', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 400n }));

      const alert = await alerts.checkILAlert(makeILConfig(), 'il-1');

      expect(alert).toMatchObject({
        id: 'il-1',
        type: 'il',
        currentPrice: 4_000_000_000_000_000_000n,
        currentILBps: 2000,
        status: 'triggered',
        triggered: true,
      });
    });

    it('keeps the alert active when impermanent loss is below threshold', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 121n }));

      const alert = await alerts.checkILAlert(
        makeILConfig({ maxImpermanentLossBps: 100 }),
        'il-2',
      );

      expect(alert.currentILBps).toBe(46);
      expect(alert.status).toBe('active');
      expect(alert.triggered).toBe(false);
    });

    it('validates the impermanent loss threshold range', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 400n }));

      await expect(
        alerts.checkILAlert(makeILConfig({ maxImpermanentLossBps: 10001 }), 'il-3'),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('checkHealthAlert()', () => {
    it('returns a health score for a pool', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const result = await alerts.checkHealthAlert({ pairAddress: PAIR }, 'health-1');

      expect(result).toMatchObject({
        id: 'health-1',
        type: 'health',
        currentHealthScore: 4000,
        status: 'active',
        triggered: false,
      });
    });

    it('throws when the pool has no liquidity', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 0n, reserve1: 250n }));

      await expect(
        alerts.checkHealthAlert({ pairAddress: PAIR }, 'health-2'),
      ).rejects.toThrow(InsufficientLiquidityError);
    });
  });

  describe('checkVolumeAlert()', () => {
    it('returns volume data for a pool', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const result = await alerts.checkVolumeAlert({ pairAddress: PAIR }, 'vol-1');

      expect(result).toMatchObject({
        id: 'vol-1',
        type: 'volume',
        currentVolume: 350n,
        status: 'active',
        triggered: false,
      });
    });

    it('throws when the pool has no liquidity', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 0n, reserve1: 0n }));

      await expect(
        alerts.checkVolumeAlert({ pairAddress: PAIR }, 'vol-2'),
      ).rejects.toThrow(InsufficientLiquidityError);
    });
  });

  describe('createAlert()', () => {
    it('creates a price alert and returns a string ID', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const id = await alerts.createAlert({
        type: 'price',
        target: PAIR,
        threshold: 2.5,
        direction: 'above',
      });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('creates an IL alert and returns a string ID', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const id = await alerts.createAlert({
        type: 'il',
        target: PAIR,
        threshold: 500,
        direction: 'above',
      });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('creates a health alert and returns a string ID', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const id = await alerts.createAlert({
        type: 'health',
        target: PAIR,
        threshold: 3000,
        direction: 'below',
      });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('creates a volume alert and returns a string ID', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const id = await alerts.createAlert({
        type: 'volume',
        target: PAIR,
        threshold: 100,
        direction: 'above',
      });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('validates IL threshold is between 0 and 10000', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await expect(
        alerts.createAlert({ type: 'il', target: PAIR, threshold: 15000, direction: 'above' }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates health threshold is between 0 and 10000', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await expect(
        alerts.createAlert({ type: 'health', target: PAIR, threshold: -1, direction: 'below' }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates price threshold is positive', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await expect(
        alerts.createAlert({ type: 'price', target: PAIR, threshold: 0, direction: 'above' }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates volume threshold is positive', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await expect(
        alerts.createAlert({ type: 'volume', target: PAIR, threshold: -5, direction: 'above' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('checkAlerts()', () => {
    it('returns triggered price alerts for the given address', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await alerts.createAlert({
        type: 'price',
        target: PAIR,
        threshold: 2,
        direction: 'above',
      });

      const results = await alerts.checkAlerts(PAIR);

      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].type).toBe('price');
    });

    it('returns empty array when no alerts match the address', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await alerts.createAlert({
        type: 'price',
        target: PAIR,
        threshold: 2,
        direction: 'above',
      });

      const results = await alerts.checkAlerts('COTHERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

      expect(results).toHaveLength(0);
    });

    it('returns active alerts that have not yet triggered', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      await alerts.createAlert({
        type: 'price',
        target: PAIR,
        threshold: 2,
        direction: 'below',
      });

      const results = await alerts.checkAlerts(PAIR);

      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
      expect(results[0].status).toBe('active');
    });
  });

  describe('deleteAlert()', () => {
    it('removes a stored alert', async () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      const id = await alerts.createAlert({
        type: 'price',
        target: PAIR,
        threshold: 2,
        direction: 'above',
      });

      alerts.deleteAlert(id);

      const results = await alerts.checkAlerts(PAIR);
      expect(results).toHaveLength(0);
    });

    it('throws for a non-existent alert ID', () => {
      const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));

      expect(() => alerts.deleteAlert('nonexistent-id')).toThrow(ValidationError);
    });
  });
});
