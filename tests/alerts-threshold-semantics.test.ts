/**
 * Threshold-alert semantics fixtures (issue #678).
 *
 * Pins, for every fixture, the direction string stored on the alert, the
 * comparison used to trigger it (>= for "above", <= for "below", so boundary
 * equality triggers in both directions) and the resulting status string, all
 * evaluated through the public API with the USD-canonical pair fallback price
 * (reserveQuote * 10^8 / reserveToken, oriented by the alert's token).
 */
import { AlertModule } from '../src/modules/alerts';
import type { CoralSwapClient } from '../src/client';
import { ValidationError } from '../src/errors';
import { nativeToScVal } from '@stellar/stellar-sdk';

const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const PAIR = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const USD_SCALE = 100_000_000n;

function makeClient(reserves: { reserve0: bigint; reserve1: bigint }): CoralSwapClient {
  return {
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue(reserves),
      getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_A, token1: TOKEN_B }),
    }),
  } as unknown as CoralSwapClient;
}

interface Fixture {
  name: string;
  /** Token the alert watches; its USD price is quoted in the other pair token. */
  token: string;
  reserves: { reserve0: bigint; reserve1: bigint };
  direction: 'above' | 'below';
  /** Threshold in USD, scaled by 10^8. */
  targetPriceUSD: bigint;
  /** Price the fallback must compute, scaled by 10^8. */
  expectedPrice: bigint;
  expectedStatus: 'active' | 'triggered';
}

// Pool: 100 A against 250 B, so A = 2.50 B and B = 0.40 A.
const fixtures: Fixture[] = [
  {
    name: 'above: price over threshold triggers',
    token: TOKEN_A,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'above',
    targetPriceUSD: 2n * USD_SCALE,
    expectedPrice: 250_000_000n,
    expectedStatus: 'triggered',
  },
  {
    name: 'above: price under threshold stays active',
    token: TOKEN_A,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'above',
    targetPriceUSD: 3n * USD_SCALE,
    expectedPrice: 250_000_000n,
    expectedStatus: 'active',
  },
  {
    name: 'above: boundary equality triggers (>=)',
    token: TOKEN_A,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'above',
    targetPriceUSD: 250_000_000n,
    expectedPrice: 250_000_000n,
    expectedStatus: 'triggered',
  },
  {
    name: 'below: price under threshold triggers',
    token: TOKEN_A,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'below',
    targetPriceUSD: 3n * USD_SCALE,
    expectedPrice: 250_000_000n,
    expectedStatus: 'triggered',
  },
  {
    name: 'below: price over threshold stays active',
    token: TOKEN_A,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'below',
    targetPriceUSD: 2n * USD_SCALE,
    expectedPrice: 250_000_000n,
    expectedStatus: 'active',
  },
  {
    name: 'below: boundary equality triggers (<=)',
    token: TOKEN_A,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'below',
    targetPriceUSD: 250_000_000n,
    expectedPrice: 250_000_000n,
    expectedStatus: 'triggered',
  },
  {
    name: 'token1 alert quotes the reversed reserves (0.40, not 2.50)',
    token: TOKEN_B,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'above',
    targetPriceUSD: 1n * USD_SCALE,
    expectedPrice: 40_000_000n,
    expectedStatus: 'active',
  },
  {
    name: 'token1 alert below 0.50 triggers on the reversed price',
    token: TOKEN_B,
    reserves: { reserve0: 100n, reserve1: 250n },
    direction: 'below',
    targetPriceUSD: 50_000_000n,
    expectedPrice: 40_000_000n,
    expectedStatus: 'triggered',
  },
];

describe('threshold alert semantics (fixtures)', () => {
  it.each(fixtures)('$name', async (f) => {
    const alerts = new AlertModule(makeClient(f.reserves));
    const id = await alerts.createThresholdPriceAlert({
      tokenAddress: f.token,
      targetPriceUSD: f.targetPriceUSD,
      direction: f.direction,
      pairAddress: PAIR,
    });

    const triggered = await alerts.checkThresholdPriceAlerts();
    const alert = alerts.getPriceAlert(id);

    expect(alert).not.toBeNull();
    expect(alert!.direction).toBe(f.direction);
    expect(alert!.lastKnownPrice).toBe(f.expectedPrice);
    expect(alert!.status).toBe(f.expectedStatus);
    expect(triggered.includes(id)).toBe(f.expectedStatus === 'triggered');
  });

  it('rejects a direction string other than "above" or "below"', async () => {
    const alerts = new AlertModule(makeClient({ reserve0: 100n, reserve1: 250n }));
    await expect(
      alerts.createThresholdPriceAlert({
        tokenAddress: TOKEN_A,
        targetPriceUSD: USD_SCALE,
        direction: 'sideways' as unknown as 'above',
        pairAddress: PAIR,
      }),
    ).rejects.toThrow('direction must be "above" or "below"');
  });

  describe('RedStone oracle and inputPricesUSD semantics', () => {
    const ORACLE_ADDR = 'CC4YVLFRDJB3I32FKEHLSP7ZUE5DP73QHB54SQIBO6MXBFP7FIMVTG2I';

    it('queries RedStone oracle when oracleAddress is configured', async () => {
      const client = makeClient({ reserve0: 100n, reserve1: 250n });
      (client as any).simulateTransaction = jest.fn().mockResolvedValue({
        success: true,
        returnValue: nativeToScVal(300_000_000n, { type: 'i128' }),
      });

      const alerts = new AlertModule(client, ORACLE_ADDR);
      const id = await alerts.createThresholdPriceAlert({
        tokenAddress: TOKEN_A,
        targetPriceUSD: 250_000_000n,
        direction: 'above',
      });

      const triggered = await alerts.checkThresholdPriceAlerts();
      expect(triggered).toEqual([id]);

      const alert = alerts.getPriceAlert(id);
      expect(alert?.status).toBe('triggered');
      expect(alert?.lastKnownPrice).toBe(300_000_000n);
      expect((client as any).simulateTransaction).toHaveBeenCalled();
    });

    it('supports oracle returning an object containing price', async () => {
      const client = makeClient({ reserve0: 100n, reserve1: 250n });
      (client as any).simulateTransaction = jest.fn().mockResolvedValue({
        success: true,
        returnValue: nativeToScVal({ price: 350_000_000n }),
      });

      const alerts = new AlertModule(client, ORACLE_ADDR);
      const price = await alerts['getTokenPriceUSD'](TOKEN_A);
      expect(price).toBe(350_000_000n);
    });

    it('throws ValidationError when oracle fails and does NOT fall back to pair ratio', async () => {
      const client = makeClient({ reserve0: 100n, reserve1: 250n });
      (client as any).simulateTransaction = jest.fn().mockResolvedValue({
        success: false,
      });

      const alerts = new AlertModule(client, ORACLE_ADDR);
      const id = await alerts.createThresholdPriceAlert({
        tokenAddress: TOKEN_A,
        targetPriceUSD: 200_000_000n, // would trigger under pair ratio (250_000_000n)
        direction: 'above',
        pairAddress: PAIR,
      });

      // Simulation fails, so getTokenPriceUSD throws; checkThresholdPriceAlerts catches and skips
      const triggered = await alerts.checkThresholdPriceAlerts();
      expect(triggered).toEqual([]);

      const alert = alerts.getPriceAlert(id);
      expect(alert?.status).toBe('active');
      expect(alert?.lastKnownPrice).toBeUndefined();

      // Directly calling getTokenPriceUSD throws ValidationError
      await expect(
        alerts['getTokenPriceUSD'](TOKEN_A, PAIR),
      ).rejects.toThrow(ValidationError);
    });

    it('uses inputPricesUSD Map directly when provided', async () => {
      const client = makeClient({ reserve0: 100n, reserve1: 250n });
      const alerts = new AlertModule(client);
      const id = await alerts.createThresholdPriceAlert({
        tokenAddress: TOKEN_A,
        targetPriceUSD: 500_000_000n,
        direction: 'above',
      });

      const priceMap = new Map<string, bigint>([[TOKEN_A, 550_000_000n]]);
      const triggered = await alerts.checkThresholdPriceAlerts(priceMap);
      expect(triggered).toEqual([id]);

      const alert = alerts.getPriceAlert(id);
      expect(alert?.status).toBe('triggered');
      expect(alert?.lastKnownPrice).toBe(550_000_000n);
    });

    it('uses inputPricesUSD Record directly when provided', async () => {
      const client = makeClient({ reserve0: 100n, reserve1: 250n });
      const alerts = new AlertModule(client);
      const id = await alerts.createThresholdPriceAlert({
        tokenAddress: TOKEN_A,
        targetPriceUSD: 500_000_000n,
        direction: 'above',
      });

      const triggered = await alerts.checkThresholdPriceAlerts({ [TOKEN_A]: 520_000_000n });
      expect(triggered).toEqual([id]);

      const alert = alerts.getPriceAlert(id);
      expect(alert?.status).toBe('triggered');
      expect(alert?.lastKnownPrice).toBe(520_000_000n);
    });

    it('throws ValidationError when neither oracle nor pairAddress is provided', async () => {
      const client = makeClient({ reserve0: 100n, reserve1: 250n });
      const alerts = new AlertModule(client); // no oracleAddress
      await expect(alerts['getTokenPriceUSD'](TOKEN_A)).rejects.toThrow(
        'Cannot fetch price: no oracle address or pair address provided',
      );
    });
  });
});
