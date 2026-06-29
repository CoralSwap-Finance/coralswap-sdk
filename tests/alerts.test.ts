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
});
