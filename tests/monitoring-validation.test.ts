import { ValidationError } from '../src/errors';
import { MonitoringPeriodSchema } from '../src/schemas';
import { MonitoringModule } from '../src/modules/monitoring';
import type { CoralSwapClient } from '../src/client';

describe('MonitoringPeriodSchema', () => {
  it.each(['24h', '7d', '30d'] as const)('accepts %s', (period) => {
    expect(MonitoringPeriodSchema.parse(period)).toBe(period);
  });

  it.each(['1y', '24H', '', 24])('rejects %p', (period) => {
    expect(MonitoringPeriodSchema.safeParse(period).success).toBe(false);
  });
});

describe('MonitoringModule.getSystemMetrics() period validation', () => {
  it('rejects an unsupported period through the shared schema helper, before any RPC call', async () => {
    const getAllPairs = jest.fn();
    const client = { factory: { getAllPairs } } as unknown as CoralSwapClient;

    await expect(new MonitoringModule(client).getSystemMetrics('1y' as '24h')).rejects.toMatchObject({
      name: ValidationError.name,
      message: expect.stringContaining('system metrics period (1y)'),
    });
    expect(getAllPairs).not.toHaveBeenCalled();
  });
});
