import { xdr } from '@stellar/stellar-sdk';
import { MonitoringModule } from '../src/modules/monitoring';

describe('MonitoringModule', () => {
  let mockClient: any;
  let monitoring: MonitoringModule;

  beforeEach(() => {
    mockClient = {
      getCurrentLedger: jest.fn().mockResolvedValue(100000),
      server: {
        getEvents: jest.fn(),
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 100000 }),
      },
      factory: {
        getAllPairs: jest.fn().mockResolvedValue(['CPAIR1', 'CPAIR2']),
      },
      pair: jest.fn().mockReturnValue({
        getReserves: jest.fn().mockResolvedValue({ reserve0: 100000000n, reserve1: 200000000n }),
        getTokens: jest.fn().mockResolvedValue(['CTOKEN0', 'CTOKEN1']),
      }),
    };

    monitoring = new MonitoringModule(mockClient);
  });

  describe('getSystemMetrics() & EventCursor migration', () => {
    it('queries previous-window TVL, volume, and revenue using EventCursor with ScVal topics', async () => {
      // Mock EventResponses for sync and swap events
      const mockSyncEvent = {
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('reserve0'),
            val: xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: xdr.Uint64.fromString('50000000'), hi: xdr.Int64.fromString('0') })),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('reserve1'),
            val: xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: xdr.Uint64.fromString('150000000'), hi: xdr.Int64.fromString('0') })),
          }),
        ]),
      };

      const mockSwapEvent = {
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('amount_in'),
            val: xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: xdr.Uint64.fromString('1000000000'), hi: xdr.Int64.fromString('0') })),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('fee_bps'),
            val: xdr.ScVal.scvU32(30),
          }),
        ]),
      };

      mockClient.server.getEvents.mockImplementation((request: any) => {
        const topics = request.filters[0]?.topics?.[0] ?? [];
        const syncTopic = xdr.ScVal.scvSymbol('sync').toXDR('base64');
        const swapTopic = xdr.ScVal.scvSymbol('swap').toXDR('base64');

        if (topics.includes(syncTopic)) {
          return Promise.resolve({ events: [mockSyncEvent], cursor: 'c_sync' });
        }
        if (topics.includes(swapTopic)) {
          return Promise.resolve({ events: [mockSwapEvent], cursor: 'c_swap' });
        }
        return Promise.resolve({ events: [] });
      });

      const metrics = await monitoring.getSystemMetrics(10000);

      expect(metrics.previousTVLUSD).toBeGreaterThan(0);
      expect(metrics.previousVolume24hUSD).toBeGreaterThan(0);
      expect(metrics.previousRevenue24hUSD).toBeGreaterThan(0);
      expect(metrics.previousWindowTVLUSD).toBe(metrics.previousTVLUSD);
      expect(metrics.previousWindowVolumeUSD).toBe(metrics.previousVolume24hUSD);
      expect(metrics.previousWindowRevenueUSD).toBe(metrics.previousRevenue24hUSD);

      // Verify topic filters passed to getEvents were ScVal encoded
      expect(mockClient.server.getEvents).toHaveBeenCalled();
      const calls = mockClient.server.getEvents.mock.calls;
      const topicFilters = calls.map((c: any) => c[0].filters[0].topics[0][0]);
      expect(topicFilters).toContain(xdr.ScVal.scvSymbol('sync').toXDR('base64'));
      expect(topicFilters).toContain(xdr.ScVal.scvSymbol('swap').toXDR('base64'));
    });

    it('returns zero for previous metrics when no historical events exist', async () => {
      mockClient.server.getEvents.mockResolvedValue({ events: [] });

      const metrics = await monitoring.getSystemMetrics();

      expect(metrics.previousTVLUSD).toBe(0);
      expect(metrics.previousVolume24hUSD).toBe(0);
      expect(metrics.previousRevenue24hUSD).toBe(0);
    });
  });

  describe('fetchPreviousReserves() & fetchPoolSwapActivity()', () => {
    it('fetchPreviousReserves returns 0 when pair list is empty', async () => {
      const res = await monitoring.fetchPreviousReserves([], 100, 200);
      expect(res.tvlUSD).toBe(0);
    });

    it('fetchPoolSwapActivity returns 0 when pair list is empty', async () => {
      const res = await monitoring.fetchPoolSwapActivity([], 100, 200);
      expect(res.volumeUSD).toBe(0);
      expect(res.revenueUSD).toBe(0);
    });
  });

  describe('Pool and System health probes', () => {
    it('returns pool health for valid pair', async () => {
      const health = await monitoring.getPoolHealth('CPAIR1');
      expect(health.operational).toBe(true);
      expect(health.reserveRatio).toBe(0.5);
    });

    it('checks system health', async () => {
      const sysHealth = await monitoring.checkSystemHealth();
      expect(sysHealth.healthy).toBe(true);
      expect(sysHealth.rpc.connected).toBe(true);
      expect(sysHealth.rpc.latestLedger).toBe(100000);
    });

    it('returns protocol summary', async () => {
      const summary = await monitoring.getProtocolSummary();
      expect(summary.poolCount).toBe(2);
      expect(summary.activePairCount).toBe(2);
    });
  });
});
