import type { CoralSwapClient } from '../src/client';
import { ValidationError } from '../src/errors';
import { MonitoringModule } from '../src/modules/monitoring';

const PAIR = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function makeClient(): CoralSwapClient {
  return {
    getCurrentLedger: jest.fn().mockResolvedValue(50_000),
    factory: {
      getAllPairs: jest.fn().mockResolvedValue([PAIR]),
    },
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({ reserve0: 100n, reserve1: 200n }),
      getTokens: jest.fn().mockResolvedValue({
        token0: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        token1: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
      }),
    }),
  } as unknown as CoralSwapClient;
}

describe('MonitoringModule.getSystemMetrics()', () => {
  it.each(['24h', '7d', '30d'] as const)('accepts the %s period', async (period) => {
    const metrics = await new MonitoringModule(makeClient()).getSystemMetrics(period);

    expect(metrics.period).toBe(period);
    expect(metrics.healthy).toBe(true);
    expect(metrics.poolCount).toBe(1);
    expect(metrics.activePairCount).toBe(1);
    expect(metrics.timestamp).toEqual(expect.any(String));
  });

  it('uses 24h by default', async () => {
    const metrics = await new MonitoringModule(makeClient()).getSystemMetrics();

    expect(metrics.period).toBe('24h');
  });

  it('surfaces invalid input as the SDK ValidationError with input context', async () => {
    await expect(
      new MonitoringModule(makeClient()).getSystemMetrics('1y' as '24h'),
    ).rejects.toMatchObject({
      name: ValidationError.name,
      message: expect.stringContaining('system metrics period (1y)'),
    });
  });
});
