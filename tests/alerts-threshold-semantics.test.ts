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
});
