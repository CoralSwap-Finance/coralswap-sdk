import {
  MonitoringModule,
  computeMetricChange,
  pickTopPools,
} from '../src/modules/monitoring';
import type { PoolTvlChange } from '../src/types/monitoring';
import { CoralSwapClient } from '../src/client';
import { ValidationError } from '../src/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STABLE_ADDR = 'CUSDC0000000000000000000000000000000000000000000000000000';
const TOKEN_A = 'CTOKENA00000000000000000000000000000000000000000000000000';
const TOKEN_B = 'CTOKENB00000000000000000000000000000000000000000000000000';
const PAIR_1 = 'CPAIR0000000000000000000000000000000000000000000000000001';
const PAIR_2 = 'CPAIR0000000000000000000000000000000000000000000000000002';
const USER_1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USER_2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const LEDGERS_PER_DAY = 17_280;

interface PairSpec {
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
}

function makeI128(n: bigint) {
  return {
    i128: () => ({
      hi: () => ({ toString: () => (n >> 64n).toString() }),
      lo: () => ({ toString: () => (n & ((1n << 64n) - 1n)).toString() }),
    }),
  };
}

function makeU32(n: number) {
  return { u32: () => n };
}

function makeAddr(s: string) {
  return { address: () => ({ toString: () => s }) };
}

function makeSym(s: string) {
  return { sym: () => ({ toString: () => s }) };
}

function makeSyncEvent(
  ledger: number,
  reserve0: bigint,
  reserve1: bigint,
  contractId: string,
) {
  return {
    topic: ['sync'],
    value: {
      map: () => [
        { key: makeSym('reserve0'), val: makeI128(reserve0) },
        { key: makeSym('reserve1'), val: makeI128(reserve1) },
      ],
    },
    ledger,
    contractId,
  };
}

function makeSwapEvent(opts: {
  ledger: number;
  amountIn: bigint;
  feeBps: number;
  tokenIn: string;
  sender: string;
  contractId: string;
}) {
  return {
    topic: ['swap'],
    value: {
      map: () => [
        { key: makeSym('amount_in'), val: makeI128(opts.amountIn) },
        { key: makeSym('fee_bps'), val: makeU32(opts.feeBps) },
        { key: makeSym('token_in'), val: makeAddr(opts.tokenIn) },
        { key: makeSym('sender'), val: makeAddr(opts.sender) },
        { key: makeSym('amount_out'), val: makeI128(opts.amountIn) },
        { key: makeSym('token_out'), val: makeAddr(TOKEN_B) },
      ],
    },
    ledger: opts.ledger,
    contractId: opts.contractId,
  };
}

function createMockClient(opts: {
  pairs?: string[];
  pairSpecs?: Record<string, PairSpec>;
  currentLedger?: number;
  eventsPerPair?: Record<string, unknown[]>;
} = {}): CoralSwapClient {
  const {
    pairs = [],
    pairSpecs = {},
    currentLedger = 100_000,
    eventsPerPair = {},
  } = opts;

  return {
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(pairs),
    },
    pair: jest.fn().mockImplementation((addr: string) => {
      const spec = pairSpecs[addr] ?? {};
      return {
        getReserves: jest.fn().mockResolvedValue({
          reserve0: spec.reserve0 ?? 10_000_000n,
          reserve1: spec.reserve1 ?? 10_000_000n,
        }),
        getTokens: jest.fn().mockResolvedValue({
          token0: spec.token0 ?? STABLE_ADDR,
          token1: spec.token1 ?? TOKEN_A,
        }),
      };
    }),
    server: {
      getEvents: jest.fn().mockImplementation(
        (req: { filters?: Array<{ contractIds?: string[]; topics?: string[][] }> }) => {
          const id = req?.filters?.[0]?.contractIds?.[0] ?? '';
          const topic = req?.filters?.[0]?.topics?.[0]?.[0];
          const events = (eventsPerPair[id] ?? []).filter((e) => {
            const ev = e as { topic?: string[] };
            return !topic || ev.topic?.[0] === topic;
          });
          return Promise.resolve({ events });
        },
      ),
    },
    getCurrentLedger: jest.fn().mockResolvedValue(currentLedger),
  } as unknown as CoralSwapClient;
}

function poolChange(
  pairAddress: string,
  absolute: number,
  previous = 100,
): PoolTvlChange {
  const current = previous + absolute;
  return {
    pairAddress,
    currentTvlUSD: current,
    previousTvlUSD: previous,
    tvlChange: computeMetricChange(current, previous),
  };
}

// ---------------------------------------------------------------------------
// computeMetricChange / pickTopPools
// ---------------------------------------------------------------------------

describe('computeMetricChange', () => {
  it('returns 0% when both values are zero', () => {
    expect(computeMetricChange(0, 0)).toEqual({ absolute: 0, percentage: 0 });
  });

  it('handles zero-to-nonzero transitions as 100%', () => {
    expect(computeMetricChange(50, 0)).toEqual({ absolute: 50, percentage: 100 });
    expect(computeMetricChange(-10, 0)).toEqual({ absolute: -10, percentage: 100 });
  });

  it('computes normal percentage changes', () => {
    expect(computeMetricChange(150, 100)).toEqual({ absolute: 50, percentage: 50 });
    expect(computeMetricChange(75, 100)).toEqual({ absolute: -25, percentage: -25 });
  });
});

describe('pickTopPools', () => {
  it('returns nulls when there are no pools', () => {
    expect(pickTopPools([])).toEqual({
      topGrowingPool: null,
      topDecliningPool: null,
    });
  });

  it('returns distinct growing and declining pools', () => {
    const growing = poolChange(PAIR_1, 200);
    const declining = poolChange(PAIR_2, -50);
    const result = pickTopPools([growing, declining]);

    expect(result.topGrowingPool?.pairAddress).toBe(PAIR_1);
    expect(result.topDecliningPool?.pairAddress).toBe(PAIR_2);
    expect(result.topGrowingPool?.pairAddress).not.toBe(
      result.topDecliningPool?.pairAddress,
    );
  });

  it('sets declining to null for a single growing pool', () => {
    const result = pickTopPools([poolChange(PAIR_1, 10)]);
    expect(result.topGrowingPool?.pairAddress).toBe(PAIR_1);
    expect(result.topDecliningPool).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSystemMetrics
// ---------------------------------------------------------------------------

describe('MonitoringModule.getSystemMetrics()', () => {
  it('handles a new protocol with no pairs / no historical data', async () => {
    const client = createMockClient({ pairs: [] });
    const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

    const metrics = await monitor.getSystemMetrics('24h');

    expect(metrics.tvlChange).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.volumeChange).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.userGrowth).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.revenueUSD).toBe(0);
    expect(metrics.topGrowingPool).toBeNull();
    expect(metrics.topDecliningPool).toBeNull();
  });

  it('handles pools with current TVL but no historical sync events (zero-to-nonzero)', async () => {
    const client = createMockClient({
      pairs: [PAIR_1],
      pairSpecs: {
        [PAIR_1]: {
          token0: STABLE_ADDR,
          token1: TOKEN_A,
          reserve0: 100_000_000n, // $10
          reserve1: 100_000_000n, // priced 1:1 → $10
        },
      },
      eventsPerPair: { [PAIR_1]: [] },
      currentLedger: 100_000,
    });
    const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

    const metrics = await monitor.getSystemMetrics('24h');

    // Current TVL = $20, previous = 0 → 100% growth
    expect(metrics.tvlChange.absolute).toBeCloseTo(20, 5);
    expect(metrics.tvlChange.percentage).toBe(100);
    expect(metrics.topGrowingPool?.pairAddress).toBe(PAIR_1);
    expect(metrics.topDecliningPool).toBeNull();
  });

  it('computes TVL, volume, user, and revenue changes across the period', async () => {
    const currentLedger = 100_000;
    const periodLedgers = LEDGERS_PER_DAY;
    const currentStart = currentLedger - periodLedgers;

    const client = createMockClient({
      pairs: [PAIR_1, PAIR_2],
      pairSpecs: {
        [PAIR_1]: {
          token0: STABLE_ADDR,
          token1: TOKEN_A,
          reserve0: 200_000_000n, // $20
          reserve1: 200_000_000n, // $20 → TVL $40
        },
        [PAIR_2]: {
          token0: STABLE_ADDR,
          token1: TOKEN_B,
          reserve0: 50_000_000n, // $5
          reserve1: 50_000_000n, // $5 → TVL $10
        },
      },
      eventsPerPair: {
        [PAIR_1]: [
          // Previous TVL snapshot: $20
          makeSyncEvent(currentStart - 100, 100_000_000n, 100_000_000n, PAIR_1),
          // Previous-period swap: $10 volume, 30 bps fee → $0.03
          makeSwapEvent({
            ledger: currentStart - 50,
            amountIn: 100_000_000n,
            feeBps: 30,
            tokenIn: STABLE_ADDR,
            sender: USER_1,
            contractId: PAIR_1,
          }),
          // Current-period swaps
          makeSwapEvent({
            ledger: currentStart + 10,
            amountIn: 200_000_000n, // $20
            feeBps: 30,
            tokenIn: STABLE_ADDR,
            sender: USER_1,
            contractId: PAIR_1,
          }),
          makeSwapEvent({
            ledger: currentStart + 20,
            amountIn: 100_000_000n, // $10
            feeBps: 30,
            tokenIn: STABLE_ADDR,
            sender: USER_2,
            contractId: PAIR_1,
          }),
        ],
        [PAIR_2]: [
          // Previous TVL snapshot: $30 → declining to $10
          makeSyncEvent(currentStart - 100, 150_000_000n, 150_000_000n, PAIR_2),
        ],
      },
      currentLedger,
    });

    const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });
    const metrics = await monitor.getSystemMetrics('24h');

    // PAIR_1: 40 - 20 = +20; PAIR_2: 10 - 30 = -20; total change = 0
    expect(metrics.tvlChange.absolute).toBeCloseTo(0, 5);
    expect(metrics.tvlChange.percentage).toBeCloseTo(0, 5);

    // Volume: current $30, previous $10 → +$20 / +200%
    expect(metrics.volumeChange.absolute).toBeCloseTo(20, 5);
    expect(metrics.volumeChange.percentage).toBeCloseTo(200, 5);

    // Users: current {USER_1, USER_2}=2, previous {USER_1}=1 → +1 / +100%
    expect(metrics.userGrowth).toEqual({ absolute: 1, percentage: 100 });

    // Revenue from current-period fees only: ($20+$10)*0.003 = $0.09
    expect(metrics.revenueUSD).toBeCloseTo(0.09, 5);

    // Distinct top pools by TVL change
    expect(metrics.topGrowingPool?.pairAddress).toBe(PAIR_1);
    expect(metrics.topDecliningPool?.pairAddress).toBe(PAIR_2);
    expect(metrics.topGrowingPool?.pairAddress).not.toBe(
      metrics.topDecliningPool?.pairAddress,
    );
  });

  it('defaults period to 24h and accepts 7d / 30d', async () => {
    const client = createMockClient({ pairs: [], currentLedger: 500_000 });
    const monitor = new MonitoringModule(client);

    await expect(monitor.getSystemMetrics()).resolves.toMatchObject({
      revenueUSD: 0,
      topGrowingPool: null,
    });
    await expect(monitor.getSystemMetrics('7d')).resolves.toBeDefined();
    await expect(monitor.getSystemMetrics('30d')).resolves.toBeDefined();
  });

  it('throws ValidationError for an invalid period', async () => {
    const client = createMockClient({ pairs: [] });
    const monitor = new MonitoringModule(client);

    await expect(
      monitor.getSystemMetrics('1h' as '24h'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
