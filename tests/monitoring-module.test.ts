import { MonitoringModule } from '../src/modules/monitoring';
import { CoralSwapClient } from '../src/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STABLE_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const PAIR_ADDR_1 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PAIR_ADDR_2 = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR7CHFDYSFDBILE';

interface PairSpec {
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
  feeBps?: number;
}

function makeMockPair(spec: PairSpec = {}) {
  return {
    getReserves: jest.fn().mockResolvedValue({
      reserve0: spec.reserve0 ?? 100_000_000n, // 10 units (7 decimals)
      reserve1: spec.reserve1 ?? 100_000_000n,
    }),
    getTokens: jest.fn().mockResolvedValue({
      token0: spec.token0 ?? STABLE_ADDR,
      token1: spec.token1 ?? TOKEN_A,
    }),
    getDynamicFee: jest.fn().mockResolvedValue(spec.feeBps ?? 30),
  };
}

function makeSwapEvent(ledger: number, amountIn: bigint, feeBps: number, tokenIn: string, sender: string) {
  const makeI128 = (n: bigint) => ({
    i128: () => ({ hi: () => ({ toString: () => (n >> 64n).toString() }), lo: () => ({ toString: () => (n & ((1n << 64n) - 1n)).toString() }) }),
  });
  const makeU32 = (n: number) => ({ u32: () => n });
  const makeAddr = (s: string) => ({ address: () => ({ toString: () => s }) });

  const entries = [
    { key: { sym: () => ({ toString: () => 'amount_in' }) }, val: makeI128(amountIn) },
    { key: { sym: () => ({ toString: () => 'fee_bps' }) }, val: makeU32(feeBps) },
    { key: { sym: () => ({ toString: () => 'token_in' }) }, val: makeAddr(tokenIn) },
    { key: { sym: () => ({ toString: () => 'amount_out' }) }, val: makeI128(amountIn - (amountIn * BigInt(feeBps)) / 10000n) },
    { key: { sym: () => ({ toString: () => 'token_out' }) }, val: makeAddr(TOKEN_B) },
    { key: { sym: () => ({ toString: () => 'sender' }) }, val: makeAddr(sender) },
  ];

  return {
    topic: ['swap'],
    value: { map: () => entries },
    ledger,
    contractId: PAIR_ADDR_1,
    txHash: `txhash_${ledger}`,
    ledgerClosedAt: new Date(ledger * 5000).toISOString(),
  };
}

function createMockClient(opts: {
  pairs?: string[];
  pairSpecs?: Record<string, PairSpec>;
  currentLedger?: number;
  eventsByContractId?: Record<string, ReturnType<typeof makeSwapEvent>[]>;
} = {}) {
  const { pairs = [], pairSpecs = {}, currentLedger = 100_000, eventsByContractId = {} } = opts;

  const getEvents = jest.fn().mockImplementation(
    (req: { filters?: Array<{ contractIds?: string[] }> }) => {
      const id = req?.filters?.[0]?.contractIds?.[0] ?? '';
      return Promise.resolve({ events: eventsByContractId[id] ?? [] });
    },
  );

  const client = {
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(pairs),
    },
    pair: jest.fn().mockImplementation((addr: string) => makeMockPair(pairSpecs[addr] ?? {})),
    server: { getEvents },
    getCurrentLedger: jest.fn().mockResolvedValue(currentLedger),
  } as unknown as CoralSwapClient;

  return { client, getEvents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MonitoringModule', () => {
  describe('getProtocolMetrics()', () => {
    it('aggregates TVL and active pool count across pools, pricing via stableAddresses', async () => {
      const { client } = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        pairSpecs: {
          [PAIR_ADDR_1]: { token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 100_000_000n, reserve1: 100_000_000n },
          [PAIR_ADDR_2]: { token0: STABLE_ADDR, token1: TOKEN_B, reserve0: 0n, reserve1: 0n }, // empty pool
        },
      });
      const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

      const metrics = await monitor.getProtocolMetrics();

      // Pair 1: 10 USDC + 10 TOKEN_A, TOKEN_A priced at $1 via reserve ratio = $20 TVL
      expect(metrics.tvlUSD).toBeCloseTo(20, 5);
      // Pair 2 has zero reserves -- excluded from active pool count
      expect(metrics.activePools).toBe(1);
      expect(metrics.computedAt).toBeGreaterThan(0);
    });

    it('derives totalSwaps24h, uniqueUsers24h, volume24hUSD, avgSwapSizeUSD from swap history', async () => {
      const events = [
        makeSwapEvent(99_500, 10_000_000n, 30, STABLE_ADDR, 'GALICE'), // 1 USDC in
        makeSwapEvent(99_600, 20_000_000n, 30, STABLE_ADDR, 'GBOB'), // 2 USDC in
        makeSwapEvent(99_700, 10_000_000n, 30, STABLE_ADDR, 'GALICE'), // same sender again
      ];
      const { client } = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: { token0: STABLE_ADDR, token1: TOKEN_A } },
        eventsByContractId: { '': events }, // protocol-wide query has no contractId filter
      });
      const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

      const metrics = await monitor.getProtocolMetrics();

      expect(metrics.totalSwaps24h).toBe(3);
      expect(metrics.uniqueUsers24h).toBe(2); // GALICE + GBOB
      expect(metrics.volume24hUSD).toBeCloseTo(4, 5); // 1 + 2 + 1 USDC
      expect(metrics.avgSwapSizeUSD).toBeCloseTo(4 / 3, 5);
    });

    it('returns cached results within the 60s TTL without re-querying RPC', async () => {
      const { client } = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: { token0: STABLE_ADDR, token1: TOKEN_A } },
      });
      const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

      const first = await monitor.getProtocolMetrics();
      const callCountAfterFirst = (client.factory.getAllPairs as jest.Mock).mock.calls.length;
      const second = await monitor.getProtocolMetrics();

      expect(second).toBe(first); // same cached object reference
      expect((client.factory.getAllPairs as jest.Mock).mock.calls.length).toBe(callCountAfterFirst);
    });

    it('sets tvlUSD to 0 when no stableAddresses are configured', async () => {
      const { client } = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: {} },
      });
      const monitor = new MonitoringModule(client); // no stableAddresses

      const metrics = await monitor.getProtocolMetrics();

      expect(metrics.tvlUSD).toBe(0);
    });
  });

  describe('getPoolMetrics()', () => {
    it('returns reserves, fee, and USD valuation for a single pool', async () => {
      const { client } = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: {
          [PAIR_ADDR_1]: { token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 50_000_000n, reserve1: 50_000_000n, feeBps: 25 },
        },
      });
      const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

      const metrics = await monitor.getPoolMetrics(PAIR_ADDR_1);

      expect(metrics.pairAddress).toBe(PAIR_ADDR_1);
      expect(metrics.reserve0).toBe(50_000_000n);
      expect(metrics.reserve1).toBe(50_000_000n);
      expect(metrics.feeBps).toBe(25);
      expect(metrics.tvlUSD).toBeCloseTo(10, 5); // 5 USDC + 5 TOKEN_A @ $1
    });

    it('scopes swap history to the given pair', async () => {
      const events = [makeSwapEvent(99_900, 30_000_000n, 30, STABLE_ADDR, 'GCAROL')];
      const { client, getEvents } = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: { token0: STABLE_ADDR, token1: TOKEN_A } },
        eventsByContractId: { [PAIR_ADDR_1]: events },
      });
      const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

      const metrics = await monitor.getPoolMetrics(PAIR_ADDR_1);

      expect(metrics.totalSwaps24h).toBe(1);
      expect(metrics.uniqueUsers24h).toBe(1);
      expect(metrics.volume24hUSD).toBeCloseTo(3, 5);
      expect(getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [expect.objectContaining({ contractIds: [PAIR_ADDR_1] })],
        }),
      );
    });

    it('caches per-pool results within the 60s TTL', async () => {
      const { client } = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: {} },
      });
      const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

      const first = await monitor.getPoolMetrics(PAIR_ADDR_1);
      const callCountAfterFirst = (client.pair as jest.Mock).mock.calls.length;
      const second = await monitor.getPoolMetrics(PAIR_ADDR_1);

      expect(second).toBe(first);
      expect((client.pair as jest.Mock).mock.calls.length).toBe(callCountAfterFirst);
    });

    it('throws ValidationError for an invalid pair address', async () => {
      const { client } = createMockClient();
      const monitor = new MonitoringModule(client);

      await expect(monitor.getPoolMetrics('')).rejects.toThrow();
    });
  });
});
