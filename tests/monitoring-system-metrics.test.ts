import { xdr, Address, Contract, nativeToScVal, rpc } from '@stellar/stellar-sdk';
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

const STABLE_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const PAIR_1 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PAIR_2 = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const USER_1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USER_2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const LEDGERS_PER_DAY = 17_280;
const CURRENT_LEDGER = 100_000;
const CURRENT_START = CURRENT_LEDGER - LEDGERS_PER_DAY;

const TOPIC_SYNC = xdr.ScVal.scvSymbol('sync').toXDR('base64');
const TOPIC_SWAP = xdr.ScVal.scvSymbol('swap').toXDR('base64');

function scMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

const addr = (a: string) => nativeToScVal(Address.fromString(a), { type: 'address' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

let eventSeq = 0;

/** A `getEvents` response entry shaped exactly like real Soroban RPC output. */
function makeEvent(contract: string, topic: string, ledger: number, value: xdr.ScVal): rpc.Api.EventResponse {
  eventSeq++;
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date(ledger * 5000).toISOString(),
    contractId: new Contract(contract),
    id: String(eventSeq).padStart(8, '0'),
    pagingToken: String(eventSeq),
    inSuccessfulContractCall: true,
    txHash: `tx_${eventSeq}`,
    topic: [xdr.ScVal.scvSymbol(topic)],
    value,
  } as unknown as rpc.Api.EventResponse;
}

function syncEvent(contract: string, ledger: number, reserve0: bigint, reserve1: bigint) {
  return makeEvent(contract, 'sync', ledger, scMap([
    ['reserve0', i128(reserve0)],
    ['reserve1', i128(reserve1)],
  ]));
}

function swapEvent(contract: string, ledger: number, amountIn: bigint, sender: string, feeBps = 30) {
  return makeEvent(contract, 'swap', ledger, scMap([
    ['sender', addr(sender)],
    ['token_in', addr(STABLE_ADDR)],
    ['token_out', addr(TOKEN_A)],
    ['amount_in', i128(amountIn)],
    ['amount_out', i128(amountIn)],
    ['fee_bps', xdr.ScVal.scvU32(feeBps)],
  ]));
}

interface PairSpec {
  reserve0: bigint;
  reserve1: bigint;
  token0?: string;
  token1?: string;
}

interface GetEventsRequest {
  startLedger: number;
  limit: number;
  filters: Array<{ contractIds?: string[]; topics?: string[][] }>;
}

/**
 * Mock client whose `getEvents` mirrors real Soroban RPC matching: topic
 * filters only match base64-encoded XDR ScVal symbols (a raw `'sync'` string
 * matches nothing), and `contractIds`, `startLedger`, and `limit` are honoured.
 */
function createMockClient(opts: {
  pairs?: string[];
  pairSpecs?: Record<string, PairSpec>;
  events?: rpc.Api.EventResponse[];
} = {}) {
  const { pairs = [], pairSpecs = {}, events = [] } = opts;
  const sorted = [...events].sort((a, b) => a.ledger - b.ledger);

  const getEvents = jest.fn(async (req: GetEventsRequest) => {
    const filter = req.filters[0] ?? {};
    const wantedTopics = new Set(filter.topics?.[0] ?? []);
    const wantedContracts = new Set(filter.contractIds ?? []);
    const matches = sorted.filter(
      (e) =>
        e.ledger >= req.startLedger &&
        (wantedContracts.size === 0 || wantedContracts.has(e.contractId!.toString())) &&
        wantedTopics.has(e.topic[0].toXDR('base64')),
    );
    return { events: matches.slice(0, req.limit), latestLedger: CURRENT_LEDGER };
  });

  const client = {
    factory: { getAllPairs: jest.fn().mockResolvedValue(pairs) },
    pair: jest.fn((address: string) => {
      const spec = pairSpecs[address] ?? { reserve0: 10_000_000n, reserve1: 10_000_000n };
      return {
        getReserves: jest.fn().mockResolvedValue({ reserve0: spec.reserve0, reserve1: spec.reserve1 }),
        getTokens: jest.fn().mockResolvedValue({
          token0: spec.token0 ?? STABLE_ADDR,
          token1: spec.token1 ?? TOKEN_A,
        }),
      };
    }),
    server: {
      getEvents,
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: CURRENT_LEDGER }),
    },
    getCurrentLedger: jest.fn().mockResolvedValue(CURRENT_LEDGER),
  } as unknown as CoralSwapClient;

  return { client, getEvents };
}

function monitorFor(client: CoralSwapClient) {
  return new MonitoringModule(client, { stableAddresses: [STABLE_ADDR] });
}

function poolChange(pairAddress: string, absolute: number, previous = 100): PoolTvlChange {
  const current = previous + absolute;
  return { pairAddress, currentTvlUSD: current, previousTvlUSD: previous, tvlChange: computeMetricChange(current, previous) };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('computeMetricChange', () => {
  it('returns 0% when both values are zero', () => {
    expect(computeMetricChange(0, 0)).toEqual({ absolute: 0, percentage: 0 });
  });

  it('treats a zero baseline with a nonzero current value as 100%', () => {
    expect(computeMetricChange(50, 0)).toEqual({ absolute: 50, percentage: 100 });
  });

  it('computes normal percentage changes', () => {
    expect(computeMetricChange(150, 100)).toEqual({ absolute: 50, percentage: 50 });
    expect(computeMetricChange(75, 100)).toEqual({ absolute: -25, percentage: -25 });
  });
});

describe('pickTopPools', () => {
  it('returns nulls when there are no pools', () => {
    expect(pickTopPools([])).toEqual({ topGrowingPool: null, topDecliningPool: null });
  });

  it('returns distinct growing and declining pools', () => {
    const result = pickTopPools([poolChange(PAIR_1, 200), poolChange(PAIR_2, -50)]);
    expect(result.topGrowingPool?.pairAddress).toBe(PAIR_1);
    expect(result.topDecliningPool?.pairAddress).toBe(PAIR_2);
  });

  it('classifies a single pool by the sign of its change', () => {
    expect(pickTopPools([poolChange(PAIR_1, 10)]).topDecliningPool).toBeNull();
    expect(pickTopPools([poolChange(PAIR_1, -10)]).topGrowingPool).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSystemMetrics()
// ---------------------------------------------------------------------------

describe('MonitoringModule.getSystemMetrics()', () => {
  it('returns zeroed metrics for a protocol with no pairs', async () => {
    const { client, getEvents } = createMockClient();
    const metrics = await monitorFor(client).getSystemMetrics();

    expect(metrics.tvlChange).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.volumeChange).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.revenueChange).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.userGrowth).toEqual({ absolute: 0, percentage: 0 });
    expect(metrics.revenueUSD).toBe(0);
    expect(metrics.topGrowingPool).toBeNull();
    expect(getEvents).not.toHaveBeenCalled();
  });

  it('computes non-zero previous-window TVL, volume, revenue, and users from historical events', async () => {
    const { client } = createMockClient({
      pairs: [PAIR_1, PAIR_2],
      pairSpecs: {
        [PAIR_1]: { reserve0: 200_000_000n, reserve1: 200_000_000n }, // $40 now
        [PAIR_2]: { reserve0: 50_000_000n, reserve1: 50_000_000n, token1: TOKEN_B }, // $10 now
      },
      events: [
        syncEvent(PAIR_1, CURRENT_START - 100, 100_000_000n, 100_000_000n), // $20 then
        swapEvent(PAIR_1, CURRENT_START - 50, 100_000_000n, USER_1), // $10 previous
        swapEvent(PAIR_1, CURRENT_START + 10, 200_000_000n, USER_1), // $20 current
        swapEvent(PAIR_1, CURRENT_START + 20, 100_000_000n, USER_2), // $10 current
        syncEvent(PAIR_2, CURRENT_START - 100, 150_000_000n, 150_000_000n), // $30 then
      ],
    });

    const metrics = await monitorFor(client).getSystemMetrics('24h');

    // PAIR_1: $20 → $40, PAIR_2: $30 → $10; protocol $50 → $50
    expect(metrics.tvlChange.absolute).toBeCloseTo(0, 6);
    expect(metrics.topGrowingPool?.pairAddress).toBe(PAIR_1);
    expect(metrics.topGrowingPool?.previousTvlUSD).toBeCloseTo(20, 6);
    expect(metrics.topDecliningPool?.pairAddress).toBe(PAIR_2);
    expect(metrics.topDecliningPool?.previousTvlUSD).toBeCloseTo(30, 6);

    // Volume $10 → $30
    expect(metrics.volumeChange.absolute).toBeCloseTo(20, 6);
    expect(metrics.volumeChange.percentage).toBeCloseTo(200, 6);

    // Revenue at 30 bps: $0.03 → $0.09
    expect(metrics.revenueChange.absolute).toBeCloseTo(0.06, 6);
    expect(metrics.revenueChange.percentage).toBeCloseTo(200, 6);
    expect(metrics.revenueUSD).toBeCloseTo(0.09, 6);

    // Users {USER_1} → {USER_1, USER_2}
    expect(metrics.userGrowth).toEqual({ absolute: 1, percentage: 100 });
  });

  it('values previous TVL from the latest sync at or before the window start, not a sum of syncs', async () => {
    const { client } = createMockClient({
      pairs: [PAIR_1],
      pairSpecs: { [PAIR_1]: { reserve0: 100_000_000n, reserve1: 100_000_000n } }, // $20 now
      events: [
        syncEvent(PAIR_1, CURRENT_START - 300, 500_000_000n, 500_000_000n),
        syncEvent(PAIR_1, CURRENT_START - 200, 300_000_000n, 300_000_000n),
        syncEvent(PAIR_1, CURRENT_START, 50_000_000n, 50_000_000n), // $10: the snapshot
        syncEvent(PAIR_1, CURRENT_START + 1, 900_000_000n, 900_000_000n), // current window: ignored
      ],
    });

    const metrics = await monitorFor(client).getSystemMetrics();

    expect(metrics.topGrowingPool?.previousTvlUSD).toBeCloseTo(10, 6);
    expect(metrics.tvlChange).toEqual({ absolute: expect.closeTo(10, 6), percentage: expect.closeTo(100, 6) });
  });

  it('reports a zero previous TVL for pools with no historical sync events', async () => {
    const { client } = createMockClient({
      pairs: [PAIR_1],
      pairSpecs: { [PAIR_1]: { reserve0: 100_000_000n, reserve1: 100_000_000n } },
    });

    const metrics = await monitorFor(client).getSystemMetrics();

    expect(metrics.tvlChange.absolute).toBeCloseTo(20, 6);
    expect(metrics.tvlChange.percentage).toBe(100);
  });

  it('sends only base64 XDR topic filters to getEvents, via the shared cursor', async () => {
    const { client, getEvents } = createMockClient({
      pairs: [PAIR_1],
      events: [swapEvent(PAIR_1, CURRENT_START - 10, 10_000_000n, USER_1)],
    });

    const metrics = await monitorFor(client).getSystemMetrics();

    const topics = getEvents.mock.calls.flatMap((call) => call[0].filters[0].topics?.[0] ?? []);
    expect(new Set(topics)).toEqual(new Set([TOPIC_SYNC, TOPIC_SWAP]));
    for (const call of getEvents.mock.calls) {
      expect(call[0].filters[0].contractIds).toEqual([PAIR_1]);
      expect(call[0].startLedger).toBe(CURRENT_LEDGER - 2 * LEDGERS_PER_DAY);
    }
    // The mock only matches encoded topics, so a non-zero figure proves the encoding.
    expect(metrics.volumeChange.absolute).toBeCloseTo(-1, 6);
  });

  it('paginates past a single page of historical swaps', async () => {
    const swaps = Array.from({ length: 1500 }, (_, i) =>
      swapEvent(PAIR_1, CURRENT_START - 1500 + i, 10_000_000n, USER_1), // $1 each
    );
    const { client, getEvents } = createMockClient({ pairs: [PAIR_1], events: swaps });

    const metrics = await monitorFor(client).getSystemMetrics();

    expect(metrics.volumeChange.absolute).toBeCloseTo(-1500, 6);
    const swapCalls = getEvents.mock.calls.filter((c) => c[0].filters[0].topics?.[0][0] === TOPIC_SWAP);
    expect(swapCalls.length).toBeGreaterThan(1);
  });

  it('scans back two full periods for 7d and clamps the start ledger to 1 on a young chain', async () => {
    const { client, getEvents } = createMockClient({ pairs: [PAIR_1] });
    await monitorFor(client).getSystemMetrics('7d');

    // 2 × 7d (241,920 ledgers) exceeds CURRENT_LEDGER, so the scan starts at ledger 1.
    expect(getEvents.mock.calls.every((c) => c[0].startLedger === 1)).toBe(true);
  });

  it('surfaces RPC failures instead of reporting a silent zero previous window', async () => {
    const { client, getEvents } = createMockClient({ pairs: [PAIR_1] });
    getEvents.mockRejectedValue(new Error('startLedger must be within the ledger range'));

    await expect(monitorFor(client).getSystemMetrics()).rejects.toThrow('ledger range');
  });

  it('throws ValidationError for an unsupported period', async () => {
    const { client } = createMockClient();
    await expect(monitorFor(client).getSystemMetrics('1h' as '24h')).rejects.toBeInstanceOf(ValidationError);
  });
});
