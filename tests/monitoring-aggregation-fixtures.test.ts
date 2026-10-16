/**
 * Monitoring aggregation against fixture reserve/transfer streams.
 *
 * Every TVL / volume / fee figure the monitoring module reports must be
 * derived from on-chain data: reserves (live reads plus historical `sync`
 * events) and transfers (`swap` events). These tests pin exact expected
 * values for two fixture streams that differ in reserves, swap amounts, fee
 * rates, and senders, then assert the aggregates move with them — so a
 * hardcoded constant (the pre-rewrite behaviour of returning zeros) fails
 * immediately, and a fixture edit that doesn't move the output fails too.
 */

import { MonitoringModule, computeMetricChange } from '../src/modules/monitoring';
import type {
  MetricChange,
  MonitoringDashboard,
  PoolMetrics,
  ProtocolMetrics,
  ProtocolSummary,
  SystemMetrics,
} from '../src/types/monitoring';
import type { PoolHealth } from '../src/modules/monitoring';
import {
  PAIR_1,
  PAIR_2,
  STABLE_ADDR,
  TOKEN_A,
  TOKEN_B,
  USER_1,
  USER_2,
  USER_3,
  USER_4,
  CURRENT_START,
  createFixtureClient,
  swapEvent,
  syncEvent,
  type MonitoringFixture,
} from './fixtures/monitoring-events';

// ---------------------------------------------------------------------------
// Fixture streams
// ---------------------------------------------------------------------------

/**
 * Baseline stream: PAIR_1 holds 20 stable + 10 TOKEN_A (TOKEN_A prices at
 * $2), PAIR_2 holds 5 stable + 2.5 TOKEN_B (TOKEN_B prices at $2).
 *
 * Four swaps land inside the trailing-24h window ($37 volume, $0.146 fees at
 * 30/100 bps) and one sits just outside it, so windowing is observable too.
 * The two `sync` snapshots sit at the start of the window and are the source
 * of previous-window TVL.
 */
const FIXTURE_A: MonitoringFixture = {
  pairs: [PAIR_1, PAIR_2],
  pairSpecs: {
    [PAIR_1]: { reserve0: 200_000_000n, reserve1: 100_000_000n, token1: TOKEN_A, feeBps: 30 },
    [PAIR_2]: { reserve0: 50_000_000n, reserve1: 25_000_000n, token1: TOKEN_B, feeBps: 100 },
  },
  events: [
    syncEvent(PAIR_1, CURRENT_START - 100, 100_000_000n, 50_000_000n),
    syncEvent(PAIR_2, CURRENT_START - 100, 100_000_000n, 50_000_000n),
    // Previous window: excluded from the 24h figures, counted by getSystemMetrics.
    swapEvent(PAIR_1, CURRENT_START - 50, { amountIn: 100_000_000n, sender: USER_1, feeBps: 30 }),
    // Trailing 24h window.
    swapEvent(PAIR_1, CURRENT_START + 10, { amountIn: 100_000_000n, sender: USER_1, feeBps: 30 }),
    swapEvent(PAIR_1, CURRENT_START + 20, { amountIn: 200_000_000n, sender: USER_2, feeBps: 30 }),
    swapEvent(PAIR_1, CURRENT_START + 40, {
      amountIn: 10_000_000n,
      sender: USER_3,
      feeBps: 30,
      tokenIn: TOKEN_A,
      tokenOut: STABLE_ADDR,
    }),
    swapEvent(PAIR_2, CURRENT_START + 30, {
      amountIn: 50_000_000n,
      sender: USER_1,
      feeBps: 100,
      tokenOut: TOKEN_B,
    }),
  ],
};

/**
 * Same two pools, rewritten: reserves, token price ratios, swap sizes, fee
 * rates, senders, and the sync snapshots all change. Nothing about the
 * aggregates may stay the same across the two streams.
 */
const FIXTURE_B: MonitoringFixture = {
  pairs: [PAIR_1, PAIR_2],
  pairSpecs: {
    [PAIR_1]: { reserve0: 400_000_000n, reserve1: 100_000_000n, token1: TOKEN_A, feeBps: 50 },
    [PAIR_2]: { reserve0: 80_000_000n, reserve1: 40_000_000n, token1: TOKEN_B, feeBps: 30 },
  },
  events: [
    syncEvent(PAIR_1, CURRENT_START - 100, 100_000_000n, 25_000_000n),
    syncEvent(PAIR_2, CURRENT_START - 100, 100_000_000n, 100_000_000n),
    swapEvent(PAIR_1, CURRENT_START - 50, { amountIn: 50_000_000n, sender: USER_1, feeBps: 30 }),
    swapEvent(PAIR_1, CURRENT_START + 10, { amountIn: 400_000_000n, sender: USER_3, feeBps: 50 }),
    swapEvent(PAIR_1, CURRENT_START + 20, { amountIn: 50_000_000n, sender: USER_2, feeBps: 30 }),
    swapEvent(PAIR_1, CURRENT_START + 40, {
      amountIn: 10_000_000n,
      sender: USER_4,
      feeBps: 30,
      tokenIn: TOKEN_A,
      tokenOut: STABLE_ADDR,
    }),
    swapEvent(PAIR_2, CURRENT_START + 30, {
      amountIn: 100_000_000n,
      sender: USER_1,
      feeBps: 30,
      tokenOut: TOKEN_B,
    }),
    swapEvent(PAIR_2, CURRENT_START + 50, {
      amountIn: 70_000_000n,
      sender: USER_4,
      feeBps: 30,
      tokenOut: TOKEN_B,
    }),
  ],
};

/** Populated pools with no history at all: the control for "zeros mean empty". */
const FIXTURE_EMPTY: MonitoringFixture = {
  pairs: [PAIR_1, PAIR_2],
  pairSpecs: {
    [PAIR_1]: { reserve0: 0n, reserve1: 0n, token1: TOKEN_A, feeBps: 30 },
    [PAIR_2]: { reserve0: 0n, reserve1: 0n, token1: TOKEN_B, feeBps: 30 },
  },
  events: [],
};

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

interface PoolExpectation {
  tvlUSD: number;
  volume24hUSD: number;
  fees24hUSD: number;
  reserveRatio: number;
}

interface WindowExpectation {
  current: number;
  previous: number;
}

interface Expected {
  pair1: PoolExpectation;
  pair2: PoolExpectation;
  summary: Pick<ProtocolSummary, 'totalTVLUSD' | 'volume24hUSD' | 'fees24hUSD' | 'poolCount' | 'activePairCount'>;
  protocol: Pick<
    ProtocolMetrics,
    'tvlUSD' | 'volume24hUSD' | 'totalSwaps24h' | 'uniqueUsers24h' | 'avgSwapSizeUSD' | 'activePools'
  >;
  poolMetrics: {
    tvlUSD: number;
    volume24hUSD: number;
    totalSwaps24h: number;
    uniqueUsers24h: number;
    avgSwapSizeUSD: number;
    reserve0: bigint;
    reserve1: bigint;
    feeBps: number;
  };
  system: {
    tvl: WindowExpectation;
    volume: WindowExpectation;
    revenue: WindowExpectation;
    users: WindowExpectation;
    revenueUSD: number;
    /** Omitted for the empty control, where pool ranking is a tie. */
    topGrowing?: { pairAddress: string; previousTvlUSD: number; currentTvlUSD: number };
    topDeclining?: { pairAddress: string; previousTvlUSD: number; currentTvlUSD: number };
  };
  dashboard: Pick<MonitoringDashboard, 'totalLiquidityUSD' | 'volume24hUSD' | 'fees24hUSD'>;
}

const EXPECTED_A: Expected = {
  pair1: { tvlUSD: 40, volume24hUSD: 32, fees24hUSD: 0.096, reserveRatio: 2 },
  pair2: { tvlUSD: 10, volume24hUSD: 5, fees24hUSD: 0.05, reserveRatio: 2 },
  summary: { totalTVLUSD: 50, volume24hUSD: 37, fees24hUSD: 0.146, poolCount: 2, activePairCount: 2 },
  protocol: {
    tvlUSD: 50,
    volume24hUSD: 37,
    totalSwaps24h: 4,
    uniqueUsers24h: 3,
    avgSwapSizeUSD: 37 / 4,
    activePools: 2,
  },
  poolMetrics: {
    tvlUSD: 40,
    volume24hUSD: 32,
    totalSwaps24h: 3,
    uniqueUsers24h: 3,
    avgSwapSizeUSD: 32 / 3,
    reserve0: 200_000_000n,
    reserve1: 100_000_000n,
    feeBps: 30,
  },
  system: {
    tvl: { current: 50, previous: 40 },
    volume: { current: 37, previous: 10 },
    revenue: { current: 0.146, previous: 0.03 },
    users: { current: 3, previous: 1 },
    revenueUSD: 0.146,
    topGrowing: { pairAddress: PAIR_1, previousTvlUSD: 20, currentTvlUSD: 40 },
    topDeclining: { pairAddress: PAIR_2, previousTvlUSD: 20, currentTvlUSD: 10 },
  },
  dashboard: { totalLiquidityUSD: 37.5, volume24hUSD: 37, fees24hUSD: 0.146 },
};

const EXPECTED_B: Expected = {
  pair1: { tvlUSD: 80, volume24hUSD: 49, fees24hUSD: 0.227, reserveRatio: 4 },
  pair2: { tvlUSD: 16, volume24hUSD: 17, fees24hUSD: 0.051, reserveRatio: 2 },
  summary: { totalTVLUSD: 96, volume24hUSD: 66, fees24hUSD: 0.278, poolCount: 2, activePairCount: 2 },
  protocol: {
    tvlUSD: 96,
    volume24hUSD: 66,
    totalSwaps24h: 5,
    uniqueUsers24h: 4,
    avgSwapSizeUSD: 66 / 5,
    activePools: 2,
  },
  poolMetrics: {
    tvlUSD: 80,
    volume24hUSD: 49,
    totalSwaps24h: 3,
    uniqueUsers24h: 3,
    avgSwapSizeUSD: 49 / 3,
    reserve0: 400_000_000n,
    reserve1: 100_000_000n,
    feeBps: 50,
  },
  system: {
    tvl: { current: 96, previous: 50 },
    volume: { current: 66, previous: 5 },
    revenue: { current: 0.278, previous: 0.015 },
    users: { current: 4, previous: 1 },
    revenueUSD: 0.278,
    topGrowing: { pairAddress: PAIR_1, previousTvlUSD: 20, currentTvlUSD: 80 },
    topDeclining: { pairAddress: PAIR_2, previousTvlUSD: 30, currentTvlUSD: 16 },
  },
  dashboard: { totalLiquidityUSD: 62, volume24hUSD: 66, fees24hUSD: 0.278 },
};

const EXPECTED_EMPTY: Expected = {
  pair1: { tvlUSD: 0, volume24hUSD: 0, fees24hUSD: 0, reserveRatio: 0 },
  pair2: { tvlUSD: 0, volume24hUSD: 0, fees24hUSD: 0, reserveRatio: 0 },
  summary: { totalTVLUSD: 0, volume24hUSD: 0, fees24hUSD: 0, poolCount: 2, activePairCount: 2 },
  protocol: {
    tvlUSD: 0,
    volume24hUSD: 0,
    totalSwaps24h: 0,
    uniqueUsers24h: 0,
    avgSwapSizeUSD: 0,
    activePools: 0,
  },
  poolMetrics: {
    tvlUSD: 0,
    volume24hUSD: 0,
    totalSwaps24h: 0,
    uniqueUsers24h: 0,
    avgSwapSizeUSD: 0,
    reserve0: 0n,
    reserve1: 0n,
    feeBps: 30,
  },
  system: {
    tvl: { current: 0, previous: 0 },
    volume: { current: 0, previous: 0 },
    revenue: { current: 0, previous: 0 },
    users: { current: 0, previous: 0 },
    revenueUSD: 0,
  },
  dashboard: { totalLiquidityUSD: 0, volume24hUSD: 0, fees24hUSD: 0 },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Aggregates {
  poolHealth: Record<string, PoolHealth>;
  summary: ProtocolSummary;
  protocol: ProtocolMetrics;
  poolMetrics: PoolMetrics;
  system: SystemMetrics;
  dashboard: MonitoringDashboard;
}

/**
 * Run every aggregation surface over one fixture with a fresh module, so no
 * 60s metrics cache can leak values between scenarios.
 */
async function aggregate(fixture: MonitoringFixture): Promise<Aggregates> {
  const { client } = createFixtureClient(fixture);
  const monitor = new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });

  for (const category of ['liquidity', 'volume', 'fees'] as const) {
    for (const targetAddress of fixture.pairs) {
      const id = await monitor.registerMetric({
        name: `${category}:${targetAddress}`,
        category,
        targetAddress,
        granularity: '1h',
      });
      await monitor.collect(id);
    }
  }

  const [protocol, summary, system, pair1Health, pair2Health, poolMetrics, dashboard] =
    await Promise.all([
      monitor.getProtocolMetrics(),
      monitor.getProtocolSummary(),
      monitor.getSystemMetrics('24h'),
      monitor.getPoolHealth(PAIR_1),
      monitor.getPoolHealth(PAIR_2),
      monitor.getPoolMetrics(PAIR_1),
      monitor.getDashboard(),
    ]);

  return {
    poolHealth: { [PAIR_1]: pair1Health, [PAIR_2]: pair2Health },
    summary,
    protocol,
    poolMetrics,
    system,
    dashboard,
  };
}

function expectChange(actual: MetricChange, expected: WindowExpectation): void {
  const want = computeMetricChange(expected.current, expected.previous);
  expect(actual.absolute).toBeCloseTo(want.absolute, 6);
  expect(actual.percentage).toBeCloseTo(want.percentage, 6);
}

function expectPoolHealth(actual: PoolHealth, expected: PoolExpectation): void {
  expect(actual.operational).toBe(true);
  expect(actual.errors).toEqual([]);
  expect(actual.tvlUSD).toBeCloseTo(expected.tvlUSD, 6);
  expect(actual.volume24hUSD).toBeCloseTo(expected.volume24hUSD, 6);
  expect(actual.fees24hUSD).toBeCloseTo(expected.fees24hUSD, 6);
  expect(actual.reserveRatio).toBeCloseTo(expected.reserveRatio, 6);
}

/** Assert every surface of one fixture produced exactly the derived values. */
function expectDerived(agg: Aggregates, expected: Expected): void {
  expectPoolHealth(agg.poolHealth[PAIR_1], expected.pair1);
  expectPoolHealth(agg.poolHealth[PAIR_2], expected.pair2);

  expect(agg.summary.totalTVLUSD).toBeCloseTo(expected.summary.totalTVLUSD, 6);
  expect(agg.summary.volume24hUSD).toBeCloseTo(expected.summary.volume24hUSD, 6);
  expect(agg.summary.fees24hUSD).toBeCloseTo(expected.summary.fees24hUSD, 6);
  expect(agg.summary.poolCount).toBe(expected.summary.poolCount);
  expect(agg.summary.activePairCount).toBe(expected.summary.activePairCount);

  expect(agg.protocol.tvlUSD).toBeCloseTo(expected.protocol.tvlUSD, 6);
  expect(agg.protocol.volume24hUSD).toBeCloseTo(expected.protocol.volume24hUSD, 6);
  expect(agg.protocol.avgSwapSizeUSD).toBeCloseTo(expected.protocol.avgSwapSizeUSD, 6);
  expect(agg.protocol.totalSwaps24h).toBe(expected.protocol.totalSwaps24h);
  expect(agg.protocol.uniqueUsers24h).toBe(expected.protocol.uniqueUsers24h);
  expect(agg.protocol.activePools).toBe(expected.protocol.activePools);

  expect(agg.poolMetrics.tvlUSD).toBeCloseTo(expected.poolMetrics.tvlUSD, 6);
  expect(agg.poolMetrics.volume24hUSD).toBeCloseTo(expected.poolMetrics.volume24hUSD, 6);
  expect(agg.poolMetrics.avgSwapSizeUSD).toBeCloseTo(expected.poolMetrics.avgSwapSizeUSD, 6);
  expect(agg.poolMetrics.totalSwaps24h).toBe(expected.poolMetrics.totalSwaps24h);
  expect(agg.poolMetrics.uniqueUsers24h).toBe(expected.poolMetrics.uniqueUsers24h);
  expect(agg.poolMetrics.reserve0).toBe(expected.poolMetrics.reserve0);
  expect(agg.poolMetrics.reserve1).toBe(expected.poolMetrics.reserve1);
  expect(agg.poolMetrics.feeBps).toBe(expected.poolMetrics.feeBps);

  expectChange(agg.system.tvlChange, expected.system.tvl);
  expectChange(agg.system.volumeChange, expected.system.volume);
  expectChange(agg.system.revenueChange, expected.system.revenue);
  expectChange(agg.system.userGrowth, expected.system.users);
  expect(agg.system.revenueUSD).toBeCloseTo(expected.system.revenueUSD, 6);

  if (expected.system.topGrowing) {
    expect(agg.system.topGrowingPool?.pairAddress).toBe(expected.system.topGrowing.pairAddress);
    expect(agg.system.topGrowingPool?.previousTvlUSD).toBeCloseTo(
      expected.system.topGrowing.previousTvlUSD,
      6,
    );
    expect(agg.system.topGrowingPool?.currentTvlUSD).toBeCloseTo(
      expected.system.topGrowing.currentTvlUSD,
      6,
    );
  }
  if (expected.system.topDeclining) {
    expect(agg.system.topDecliningPool?.pairAddress).toBe(expected.system.topDeclining.pairAddress);
    expect(agg.system.topDecliningPool?.previousTvlUSD).toBeCloseTo(
      expected.system.topDeclining.previousTvlUSD,
      6,
    );
    expect(agg.system.topDecliningPool?.currentTvlUSD).toBeCloseTo(
      expected.system.topDeclining.currentTvlUSD,
      6,
    );
  }

  expect(agg.dashboard.totalLiquidityUSD).toBeCloseTo(expected.dashboard.totalLiquidityUSD, 6);
  expect(agg.dashboard.volume24hUSD).toBeCloseTo(expected.dashboard.volume24hUSD, 6);
  expect(agg.dashboard.fees24hUSD).toBeCloseTo(expected.dashboard.fees24hUSD, 6);
}

/** Flat TVL/volume/fee figures used by the zero and change assertions. */
function keyFigures(agg: Aggregates): Array<[string, number]> {
  return [
    ['poolHealth[PAIR_1].tvlUSD', agg.poolHealth[PAIR_1].tvlUSD],
    ['poolHealth[PAIR_1].volume24hUSD', agg.poolHealth[PAIR_1].volume24hUSD],
    ['poolHealth[PAIR_1].fees24hUSD', agg.poolHealth[PAIR_1].fees24hUSD],
    ['poolHealth[PAIR_2].tvlUSD', agg.poolHealth[PAIR_2].tvlUSD],
    ['poolHealth[PAIR_2].volume24hUSD', agg.poolHealth[PAIR_2].volume24hUSD],
    ['poolHealth[PAIR_2].fees24hUSD', agg.poolHealth[PAIR_2].fees24hUSD],
    ['summary.totalTVLUSD', agg.summary.totalTVLUSD],
    ['summary.volume24hUSD', agg.summary.volume24hUSD],
    ['summary.fees24hUSD', agg.summary.fees24hUSD],
    ['protocol.tvlUSD', agg.protocol.tvlUSD],
    ['protocol.volume24hUSD', agg.protocol.volume24hUSD],
    ['poolMetrics.tvlUSD', agg.poolMetrics.tvlUSD],
    ['poolMetrics.volume24hUSD', agg.poolMetrics.volume24hUSD],
    ['system.tvlChange.absolute', agg.system.tvlChange.absolute],
    ['system.volumeChange.absolute', agg.system.volumeChange.absolute],
    ['system.revenueChange.absolute', agg.system.revenueChange.absolute],
    ['system.revenueUSD', agg.system.revenueUSD],
    ['dashboard.totalLiquidityUSD', agg.dashboard.totalLiquidityUSD],
    ['dashboard.volume24hUSD', agg.dashboard.volume24hUSD],
    ['dashboard.fees24hUSD', agg.dashboard.fees24hUSD],
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Monitoring aggregation from fixture reserve/transfer streams', () => {
  const scenarios: Array<[string, MonitoringFixture, Expected]> = [
    ['baseline', FIXTURE_A, EXPECTED_A],
    ['mutated', FIXTURE_B, EXPECTED_B],
  ];

  it.each(scenarios)(
    'derives TVL, volume and fees from the "%s" fixture, not from constants',
    async (_label, fixture, expected) => {
      expectDerived(await aggregate(fixture), expected);
    },
  );

  it('changes every aggregate when the fixture stream changes', async () => {
    const beforeAgg = await aggregate(FIXTURE_A);
    const afterAgg = await aggregate(FIXTURE_B);
    const before = keyFigures(beforeAgg);
    const after = keyFigures(afterAgg);

    const comparable: Array<[string, number, number]> = [
      ...before.map(([label, value], i) => [label, value, after[i][1]] as [string, number, number]),
      [
        'protocol.totalSwaps24h',
        beforeAgg.protocol.totalSwaps24h,
        afterAgg.protocol.totalSwaps24h,
      ],
      [
        'protocol.uniqueUsers24h',
        beforeAgg.protocol.uniqueUsers24h,
        afterAgg.protocol.uniqueUsers24h,
      ],
      // activePairCount is structural (readable pairs), so it is asserted in
      // expectDerived rather than here — the fixture pair set is unchanged.
      ['poolMetrics.feeBps', beforeAgg.poolMetrics.feeBps, afterAgg.poolMetrics.feeBps],
      [
        'system.userGrowth.absolute',
        beforeAgg.system.userGrowth.absolute,
        afterAgg.system.userGrowth.absolute,
      ],
    ];

    const unchanged = comparable
      .filter(([, prev, next]) => prev === next)
      .map(([label, value]) => `${label} stayed at ${value}`);
    expect(unchanged).toEqual([]);
  });

  it('reports non-zero TVL, volume, and fees for a populated fixture', async () => {
    const agg = await aggregate(FIXTURE_A);

    const zeroed = keyFigures(agg)
      .filter(([, value]) => !(value > 0))
      .map(([label]) => label);
    expect(zeroed).toEqual([]);
    expect(agg.protocol.totalSwaps24h).toBeGreaterThan(0);
    expect(agg.protocol.uniqueUsers24h).toBeGreaterThan(0);
  });

  it('reports zeros only when the fixture stream carries no reserve or transfer data', async () => {
    const agg = await aggregate(FIXTURE_EMPTY);

    expectDerived(agg, EXPECTED_EMPTY);
    const nonZero = keyFigures(agg)
      .filter(([, value]) => value !== 0)
      .map(([label, value]) => `${label}=${value}`);
    expect(nonZero).toEqual([]);
    expect(agg.protocol.totalSwaps24h).toBe(0);
    expect(agg.protocol.uniqueUsers24h).toBe(0);
    expect(agg.protocol.activePools).toBe(0);
    expect(agg.system.topGrowingPool?.currentTvlUSD).toBe(0);
    expect(agg.system.topDecliningPool?.currentTvlUSD).toBe(0);
  });
});
