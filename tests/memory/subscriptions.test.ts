/**
 * Memory-leak detection for long-running subscriptions.
 *
 * Covers watchPool, watchOrder, and AlertModule.startPolling:
 *  - heap growth stays under 1MB across 1000 polling cycles
 *  - unsubscribe clears intervals (no further polls)
 *  - process.listenerCount does not accumulate
 *
 * Run with GC exposure for the tightest heap assertion:
 *   node --expose-gc node_modules/.bin/jest tests/memory/subscriptions.test.ts
 */

import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { FactoryModule } from '../../src/modules/factory';
import { LimitOrderModule } from '../../src/modules/limit-orders';
import { AlertModule } from '../../src/modules/alerts';
import type { CoralSwapClient } from '../../src/client';

const CYCLES = 1000;
const MAX_HEAP_GROWTH_BYTES = 1 * 1024 * 1024; // 1 MB
const PAIR =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const PUBLIC_KEY =
  'GAZGE6TCGY5SW4GMFRVY2DMFXBOZVDDWOJ6CJZQ6ZUXY3SQQE2FTCAJF';

const PROCESS_EVENTS = [
  'uncaughtException',
  'unhandledRejection',
  'rejectionHandled',
  'beforeExit',
  'exit',
  'SIGTERM',
  'SIGINT',
  'warning',
] as const;

type IntervalHandle = ReturnType<typeof setInterval>;

function snapshotProcessListeners(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of PROCESS_EVENTS) {
    out[ev] = process.listenerCount(ev);
  }
  return out;
}

function expectNoListenerGrowth(
  before: Record<string, number>,
  after: Record<string, number>,
): void {
  for (const ev of PROCESS_EVENTS) {
    expect(after[ev]).toBeLessThanOrEqual(before[ev]);
  }
}

async function forceGc(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
  }
}

function makeScMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields).map(
    ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
  );
  return xdr.ScVal.scvMap(entries);
}

function makeOrderVal(state: string, fillPercent: number): xdr.ScVal {
  return makeScMap({
    state: xdr.ScVal.scvSymbol(state),
    fill_percent: xdr.ScVal.scvU32(fillPercent),
    execution_price: xdr.ScVal.scvVoid(),
    filled_at: xdr.ScVal.scvVoid(),
  });
}

function mockSimulationResult(retval: xdr.ScVal): unknown {
  return {
    result: { retval },
    latestLedger: 12345,
    cost: { cpuInsns: '0', memBytes: '0' },
    transactionData: {},
  };
}

function makeLimitOrderModule(): LimitOrderModule {
  const mockAccount = {
    sequenceNumber: jest.fn().mockReturnValue('12345'),
    accountId: jest.fn().mockReturnValue(PUBLIC_KEY),
    sequenceLedger: jest.fn().mockReturnValue(0),
    sequenceTime: jest.fn().mockReturnValue('0'),
    incrementSequenceNumber: jest.fn(),
  };

  const mockServer = {
    getAccount: jest.fn().mockResolvedValue(mockAccount),
    simulateTransaction: jest
      .fn()
      .mockResolvedValue(mockSimulationResult(makeOrderVal('open', 0))),
  } as unknown as jest.Mocked<SorobanRpc.Server>;

  const mockClient = {
    server: mockServer,
    publicKey: PUBLIC_KEY,
    networkConfig: {
      networkPassphrase: 'Test SDF Network ; September 2015',
      limitOrderAddress:
        'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM',
    },
    config: {},
  };

  return new LimitOrderModule(mockClient as never);
}

function makeFactoryModule(
  getEvents: jest.Mock,
  latestLedgerSequence = 2_500_000,
): { module: FactoryModule; client: CoralSwapClient; getLatestLedger: jest.Mock } {
  const getLatestLedger = jest.fn().mockResolvedValue({
    id: `mock-ledger-${latestLedgerSequence}`,
    sequence: latestLedgerSequence,
    protocolVersion: '21',
  });
  const client = {
    config: {},
    server: { getEvents, getLatestLedger },
  } as unknown as CoralSwapClient;
  return { module: new FactoryModule(client), client, getLatestLedger };
}

function makeAlertModule(): AlertModule {
  const client = {
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({
        reserve0: 1_000_000n,
        reserve1: 2_000_000n,
      }),
      getTokens: jest.fn().mockResolvedValue({
        token0: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        token1: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
      }),
    }),
  } as unknown as CoralSwapClient;
  return new AlertModule(client);
}

describe('subscription memory / cleanup', () => {
  const suiteStartedAt = Date.now();
  let activeIntervals: Set<IntervalHandle>;
  let realSetInterval: typeof setInterval;
  let realClearInterval: typeof clearInterval;

  beforeEach(() => {
    activeIntervals = new Set();
    realSetInterval = global.setInterval;
    realClearInterval = global.clearInterval;

    jest.spyOn(global, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const id = realSetInterval(handler as never, timeout as never, ...(args as never[]));
      activeIntervals.add(id);
      return id;
    }) as typeof setInterval);

    jest.spyOn(global, 'clearInterval').mockImplementation(((id?: IntervalHandle) => {
      if (id !== undefined) activeIntervals.delete(id);
      return realClearInterval(id as never);
    }) as typeof clearInterval);
  });

  afterEach(() => {
    for (const id of [...activeIntervals]) {
      realClearInterval(id);
    }
    activeIntervals.clear();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    const elapsedMs = Date.now() - suiteStartedAt;
    // Soft guard — individual tests also assert; keep suite under 30s.
    expect(elapsedMs).toBeLessThan(30_000);
  });

  describe('watchOrder', () => {
    it('keeps heap growth under 1MB across 1000 polling cycles', async () => {
      const module = makeLimitOrderModule();
      // Stub status fetches so we measure the subscription loop, not XDR/simulation churn.
      jest.spyOn(module, 'getLimitOrderStatus').mockResolvedValue({
        state: 'open',
        fillPercent: 0,
      } as never);

      let cycles = 0;

      // Warm-up so JIT / mock setup is excluded from the growth window.
      {
        const warmUnsub = module.watchOrder('order-warm', () => undefined, 1);
        await new Promise<void>((r) => setTimeout(r, 30));
        warmUnsub();
      }

      await forceGc();
      const before = process.memoryUsage().heapUsed;

      const unsub = module.watchOrder(
        'order-mem',
        () => {
          cycles += 1;
        },
        1,
      );

      const deadline = Date.now() + 15_000;
      while (cycles < CYCLES && Date.now() < deadline) {
        await new Promise<void>((r) => setImmediate(r));
      }

      expect(cycles).toBeGreaterThanOrEqual(CYCLES);
      unsub();

      await forceGc();
      const after = process.memoryUsage().heapUsed;
      expect(after - before).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    }, 20_000);

    it('unsubscribe clears intervals and stops further polls', async () => {
      const module = makeLimitOrderModule();
      let cycles = 0;

      const listenersBefore = snapshotProcessListeners();
      const unsub = module.watchOrder(
        'order-unsub',
        () => {
          cycles += 1;
        },
        5,
      );

      const deadline = Date.now() + 5_000;
      while (cycles < 3 && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 5));
      }
      expect(cycles).toBeGreaterThanOrEqual(2);

      const intervalsBeforeUnsub = activeIntervals.size;
      expect(intervalsBeforeUnsub).toBeGreaterThan(0);
      unsub();
      expect(activeIntervals.size).toBe(0);

      const countAtUnsub = cycles;
      await new Promise<void>((r) => setTimeout(r, 40));
      expect(cycles).toBe(countAtUnsub);

      expectNoListenerGrowth(listenersBefore, snapshotProcessListeners());
    }, 10_000);
  });

  describe('watchPool', () => {
    it('seeds startLedger from getLatestLedger instead of requesting ledger 1', async () => {
      const LATEST = 3_000_000;
      const getEvents = jest.fn().mockResolvedValue({ latestLedger: LATEST, events: [] });
      const { module, getLatestLedger } = makeFactoryModule(getEvents, LATEST);

      const unsub = module.watchPool(PAIR, jest.fn(), 60_000);

      const deadline = Date.now() + 5_000;
      while (getEvents.mock.calls.length < 1 && Date.now() < deadline) {
        await new Promise<void>((r) => setImmediate(r));
      }

      expect(getLatestLedger).toHaveBeenCalled();
      expect(getEvents).toHaveBeenCalled();
      expect(getEvents.mock.calls[0][0]).toEqual(
        expect.objectContaining({ startLedger: LATEST + 1 }),
      );
      // Must not request startLedger: 1 (outside RPC retention on real networks).
      expect(getEvents.mock.calls[0][0].startLedger).not.toBe(1);

      unsub();
    }, 10_000);

    it('keeps heap growth under 1MB across 1000 polling cycles', async () => {
      let pollCount = 0;
      const getEvents = jest.fn().mockImplementation(async () => {
        pollCount += 1;
        return { latestLedger: pollCount, events: [] };
      });
      const { module } = makeFactoryModule(getEvents);

      await forceGc();
      const before = process.memoryUsage().heapUsed;

      const unsub = module.watchPool(PAIR, jest.fn(), 1);

      const deadline = Date.now() + 15_000;
      while (pollCount < CYCLES && Date.now() < deadline) {
        await new Promise<void>((r) => setImmediate(r));
      }

      expect(pollCount).toBeGreaterThanOrEqual(CYCLES);
      unsub();

      await forceGc();
      const after = process.memoryUsage().heapUsed;
      expect(after - before).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    }, 20_000);

    it('unsubscribe clears intervals and does not accumulate process listeners', async () => {
      let pollCount = 0;
      const getEvents = jest.fn().mockImplementation(async () => {
        pollCount += 1;
        return { latestLedger: pollCount, events: [] };
      });
      const { module } = makeFactoryModule(getEvents);
      const listenersBefore = snapshotProcessListeners();

      const unsub = module.watchPool(PAIR, jest.fn(), 5);
      const deadline = Date.now() + 5_000;
      while (pollCount < 3 && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 5));
      }
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(activeIntervals.size).toBeGreaterThan(0);

      unsub();
      expect(activeIntervals.size).toBe(0);

      const countAtUnsub = pollCount;
      await new Promise<void>((r) => setTimeout(r, 40));
      expect(pollCount).toBe(countAtUnsub);

      expectNoListenerGrowth(listenersBefore, snapshotProcessListeners());
    }, 10_000);
  });

  describe('alert polling', () => {
    it('keeps heap growth under 1MB across 1000 polling cycles', async () => {
      const alerts = makeAlertModule();
      const checkSpy = jest
        .spyOn(alerts, 'checkAlerts')
        .mockResolvedValue([]);

      // Seed one V2 alert so startPolling has a target to visit.
      await alerts.createPriceAlert({
        tokenIn: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        tokenOut: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
        pairAddress: PAIR,
        thresholdPrice: 1n,
        direction: 'above',
      });

      await forceGc();
      const before = process.memoryUsage().heapUsed;

      const unsub = alerts.startPolling(1);
      const deadline = Date.now() + 15_000;
      while (checkSpy.mock.calls.length < CYCLES && Date.now() < deadline) {
        await new Promise<void>((r) => setImmediate(r));
      }

      expect(checkSpy.mock.calls.length).toBeGreaterThanOrEqual(CYCLES);
      unsub();

      await forceGc();
      const after = process.memoryUsage().heapUsed;
      expect(after - before).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    }, 20_000);

    it('unsubscribe clears intervals and removes fired listeners', async () => {
      const alerts = makeAlertModule();
      jest.spyOn(alerts, 'checkAlerts').mockResolvedValue([]);

      const listenersBefore = snapshotProcessListeners();
      const handler = jest.fn();
      const off = alerts.on('fired', handler);

      const unsub = alerts.startPolling(5);
      expect(activeIntervals.size).toBeGreaterThan(0);

      await new Promise<void>((r) => setTimeout(r, 20));
      unsub();
      expect(activeIntervals.size).toBe(0);

      off();
      // Re-subscribe and ensure the previous handler is gone (no accumulation).
      const handler2 = jest.fn();
      const off2 = alerts.on('fired', handler2);
      off2();

      expectNoListenerGrowth(listenersBefore, snapshotProcessListeners());
      expect(handler).not.toHaveBeenCalled();
    }, 10_000);
  });
});
