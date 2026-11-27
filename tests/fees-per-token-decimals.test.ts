/**
 * Fees module — per-token-decimals suite.
 *
 * Fee math used to be Number-based and pinned to 7 decimals: `amountIn` was
 * decoded into a `number`, the fee was `amountIn * feeBps / 10000` in floats,
 * and every total was divided by a hardcoded `1e7`. This suite pins the fix:
 *
 *  - stroop-level values are preserved exactly (BigInt, no float rounding),
 *  - decimals come from each token's on-chain metadata, per token, and
 *  - a window holding more than one RPC page (200+ swaps) is aggregated
 *    across pages instead of stopping at page one.
 *
 * Covered surfaces: `getFeeRevenue()` (revenue) and `getLPYield()`'s fee
 * share (the LP claimable side), over decimals of 6, 7 and 12.
 */

import { FeeModule } from '../src/modules/fees';
import type { CoralSwapClient } from '../src/client';
import { clearTokenDecimalsCache } from '../src/utils/token-decimals';
import {
  CURRENT_LEDGER,
  PAIR_1,
  PAIR_2,
  TOKEN_A,
  USER_1,
  USER_2,
  swapEvent,
} from './fixtures/monitoring-events';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Pair under test (any valid contract address; reads are mocked). */
const PAIR = PAIR_1;
/** LP token address handed back by `pair.getLPTokenAddress()`. */
const LP_TOKEN = PAIR_2;
/** LP holder used by `getLPYield()`. */
const HOLDER = USER_1;

/** Tokens used across the scenarios — one address per decimal precision. */
const TOKEN_6 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4';
const TOKEN_7 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM';
const TOKEN_12 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5';
/** Token whose metadata read throws, to pin the 7-decimal fallback. */
const TOKEN_BROKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';

/** `decimals()` returned by each token's metadata. */
const DECIMALS: Record<string, number> = {
  [TOKEN_6]: 6,
  [TOKEN_7]: 7,
  [TOKEN_12]: 12,
};

/** Events sit just below the head so the default 30-day window contains them. */
const LEDGER_BASE = CURRENT_LEDGER - 400;
/** Server-side page cap the mock getEvents() enforces, like real RPC. */
const PAGE_CAP = 100;

/** Fee for `amountIn` at `feeBps`, exactly as the contract charges it. */
const feeOf = (amountIn: bigint, feeBps: number): bigint =>
  (amountIn * BigInt(feeBps)) / 10_000n;

/**
 * Assert two floats agree within a relative tolerance.
 *
 * Float totals (`totalFeeXLM`) legitimately differ from `BigInt / 10 ** d` in
 * the last few bits, so exact matching would be testing float associativity —
 * what matters is that the divisor is the token's decimals.
 */
function expectApprox(actual: number, expected: number, relTol = 1e-9): void {
  const error = Math.abs(actual - expected);
  expect(error).toBeLessThanOrEqual(Math.abs(expected) * relTol + Number.MIN_VALUE);
}

interface ClientFixture {
  /** Swap events served by the mocked `getEvents`. */
  events: ReturnType<typeof swapEvent>[];
  /** Token address → decimals; an omitted address makes metadata read fail. */
  decimals?: Record<string, number>;
  /** Max events returned per RPC page (real RPC caps pages too). */
  pageCap?: number;
  /** Live state behind `pair.getReserves()` / `pair.getTokens()`. */
  pool?: { token0: string; token1: string; reserve0: bigint; reserve1: bigint };
  /** Live state behind the LP token's `balance()` / `totalSupply()`. */
  lp?: { balance: bigint; totalSupply: bigint };
}

/**
 * Build a client whose reads and paginated `getEvents` serve the fixture.
 *
 * Pages are served the way Soroban RPC does: encoded-topic equality,
 * `startLedger` as an inclusive lower bound, `limit` as the page cap, and
 * cursor continuation resuming right after the matching paging token.
 */
function buildClient(fixture: ClientFixture): {
  client: CoralSwapClient;
  getEvents: jest.Mock;
  metadataCalls: string[];
} {
  const sorted = [...fixture.events].sort((a, b) => a.ledger - b.ledger);
  const pageCap = fixture.pageCap ?? PAGE_CAP;
  const decimals = { ...DECIMALS, ...fixture.decimals };
  const metadataCalls: string[] = [];

  const getEvents = jest.fn(async (request: {
    startLedger?: number;
    cursor?: string;
    limit?: number;
    filters?: Array<{ contractIds?: string[]; topics?: string[][] }>;
  }) => {
    const filter = request.filters?.[0] ?? {};
    const wantedTopics = new Set(filter.topics?.[0] ?? []);
    const wantedContracts = new Set(filter.contractIds ?? []);
    const matchesFilter = (event: (typeof sorted)[number]) =>
      (wantedContracts.size === 0 || wantedContracts.has(event.contractId!.toString())) &&
      wantedTopics.has(event.topic[0].toXdr('base64'));

    let candidates: typeof sorted;
    if (request.cursor !== undefined) {
      const all = sorted.filter(matchesFilter);
      const index = all.findIndex((event) => event.pagingToken === request.cursor);
      candidates = index >= 0 ? all.slice(index + 1) : [];
    } else {
      candidates = sorted.filter(
        (event) => event.ledger >= (request.startLedger ?? 0) && matchesFilter(event),
      );
    }

    const page = candidates.slice(0, Math.min(request.limit ?? pageCap, pageCap));
    return {
      events: page,
      latestLedger: CURRENT_LEDGER,
      cursor: page.length > 0 ? page[page.length - 1].pagingToken : undefined,
    };
  });

  const pool = fixture.pool ?? {
    token0: TOKEN_6,
    token1: TOKEN_7,
    reserve0: 0n,
    reserve1: 0n,
  };
  const lp = fixture.lp ?? { balance: 0n, totalSupply: 0n };

  const client = {
    getCurrentLedger: jest.fn().mockResolvedValue(CURRENT_LEDGER),
    server: {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: CURRENT_LEDGER }),
      getEvents,
    },
    pair: jest.fn().mockImplementation(() => ({
      getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
      getReserves: jest
        .fn()
        .mockResolvedValue({ reserve0: pool.reserve0, reserve1: pool.reserve1 }),
      getTokens: jest
        .fn()
        .mockResolvedValue({ token0: pool.token0, token1: pool.token1 }),
    })),
    lpToken: jest.fn().mockImplementation((address: string) => ({
      metadata: jest.fn(async () => {
        metadataCalls.push(address);
        const tokenDecimals = decimals[address];
        if (tokenDecimals === undefined) {
          throw new Error(`metadata unavailable for ${address}`);
        }
        return { name: 'Token', symbol: 'TKN', decimals: tokenDecimals };
      }),
      balance: jest.fn().mockResolvedValue(lp.balance),
      totalSupply: jest.fn().mockResolvedValue(lp.totalSupply),
    })),
  } as unknown as CoralSwapClient;

  return { client, getEvents, metadataCalls };
}

/** A swap whose fee lands in `tokenIn` at `feeBps`. */
function swapIn(tokenIn: string, amountIn: bigint, feeBps: number, offset: number) {
  return swapEvent(PAIR, LEDGER_BASE + offset, {
    amountIn,
    sender: USER_1,
    feeBps,
    tokenIn,
    tokenOut: TOKEN_A,
  });
}

beforeEach(() => {
  // Metadata is cached per address for the process lifetime; drop it so each
  // scenario observes its own token's decimals.
  clearTokenDecimalsCache();
});

// ---------------------------------------------------------------------------
// getFeeRevenue() — revenue math over token decimals
// ---------------------------------------------------------------------------

describe('FeeModule.getFeeRevenue() revenue math over token decimals', () => {
  // Three swaps chosen to prove exactness: a fee that floors mid-integer, a
  // fee that divides evenly, and a 10^24-scale fee whose low digits a double
  // cannot represent (Number(10^24 + 400) === 1e24).
  const FEE_A = 370_370n; // 123_456_789 * 30 / 10000
  const FEE_B = 2_962_962_963n; // 987_654_321_000 * 30 / 10000
  const FEE_C = 7_500_000_000_000_000_000_003n; // (10^24 + 400) * 75 / 10000
  const TOTAL = FEE_A + FEE_B + FEE_C; // 7_500_000_000_002_963_333_336n

  /** `TOTAL` rendered in human units at each precision. */
  const TOTAL_FORMATTED: Record<number, string> = {
    6: '7500000000002963.333336',
    7: '750000000000296.3333336',
    12: '7500000000.002963333336',
  };
  /** The first fee rendered in human units at each precision. */
  const FIRST_FEE_FORMATTED: Record<number, string> = {
    6: '0.370370',
    7: '0.0370370',
    12: '0.000000370370',
  };

  const scenarios = [
    { decimals: 6, token: TOKEN_6 },
    { decimals: 7, token: TOKEN_7 },
    { decimals: 12, token: TOKEN_12 },
  ];

  it.each(scenarios)(
    'aggregates fees at $decimals decimals from the token metadata',
    async ({ decimals, token }) => {
      const { client } = buildClient({
        events: [
          swapIn(token, 123_456_789n, 30, 10),
          swapIn(token, 987_654_321_000n, 30, 20),
          swapIn(token, 10n ** 24n + 400n, 75, 30),
        ],
      });

      const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

      // Stroop-level values survive: exact BigInt per swap and in the total.
      expect(revenue.swapCount).toBe(3);
      expect(revenue.history.map((entry) => entry.feeStroops)).toEqual([
        FEE_A,
        FEE_B,
        FEE_C,
      ]);
      expect(revenue.totalFeeStroops).toBe(TOTAL);

      // Decimals come from this token's metadata and are applied per token.
      expect(revenue.totalFeeByToken).toHaveLength(1);
      const [byToken] = revenue.totalFeeByToken;
      expect(byToken.token).toBe(token);
      expect(byToken.decimals).toBe(decimals);
      expect(byToken.feeStroops).toBe(TOTAL);
      expect(byToken.feeDisplay).toBeCloseTo(Number(TOTAL) / 10 ** decimals, 12);
      expect(revenue.history.every((entry) => entry.decimals === decimals)).toBe(
        true,
      );
      expect(revenue.history[0].feeXLM).toBeCloseTo(Number(FEE_A) / 10 ** decimals, 12);

      // The float field divides by 10 ** decimals — never by a fixed 1e7.
      expectApprox(revenue.totalFeeXLM, Number(TOTAL) / 10 ** decimals);
      expectApprox(byToken.feeDisplay, Number(TOTAL) / 10 ** decimals);
      if (decimals !== 7) {
        expect(revenue.totalFeeXLM).not.toBeCloseTo(Number(TOTAL) / 1e7, 0);
      }
    },
  );

  it('reads a token metadata once for the whole aggregation', async () => {
    const { client, metadataCalls } = buildClient({
      events: [
        swapIn(TOKEN_6, 1_000_000n, 30, 10),
        swapIn(TOKEN_6, 2_000_000n, 30, 20),
        swapIn(TOKEN_7, 3_000_000n, 30, 30),
      ],
    });

    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

    expect(revenue.totalFeeByToken.map((total) => total.decimals)).toEqual([6, 7]);
    expect(metadataCalls.filter((address) => address === TOKEN_6)).toHaveLength(1);
    expect(metadataCalls.filter((address) => address === TOKEN_7)).toHaveLength(1);
  });

  it('prices a token with unreadable metadata at the legacy 7 decimals', async () => {
    const { client } = buildClient({
      events: [swapIn(TOKEN_BROKEN, 123_456_789n, 30, 10)],
    });

    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

    const [byToken] = revenue.totalFeeByToken;
    expect(byToken.decimals).toBe(7);
    expect(byToken.feeStroops).toBe(370_370n);
    expect(byToken.feeDisplay).toBeCloseTo(0.0370370, 12);
  });

  it('rejects a non-positive limit before touching the chain', async () => {
    const { client } = buildClient({ events: [] });

    await expect(
      new FeeModule(client).getFeeRevenue(PAIR, { limit: 0 }),
    ).rejects.toThrow(/limit must be an integer between 1 and 10000/);
  });
});

// ---------------------------------------------------------------------------
// getFeeRevenue() — pages
// ---------------------------------------------------------------------------

describe('FeeModule.getFeeRevenue() page handling', () => {
  const SWAPS = 250;
  const PER_SWAP_FEE = feeOf(1_000_000n, 30); // 3_000n

  function events(count: number) {
    return Array.from({ length: count }, (_, index) =>
      swapIn(TOKEN_6, 1_000_000n, 30, index),
    );
  }

  it('aggregates 200+ events across multiple RPC pages', async () => {
    const { client, getEvents } = buildClient({
      events: events(SWAPS),
      pageCap: PAGE_CAP,
    });

    // `limit` is the per-request page size: full pages keep the scan going.
    const revenue = await new FeeModule(client).getFeeRevenue(PAIR, {
      limit: PAGE_CAP,
    });

    expect(revenue.swapCount).toBe(SWAPS);
    expect(revenue.history).toHaveLength(SWAPS);
    // 250 events at a 100-event page size cannot fit in a single response.
    expect(getEvents.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Every page after the first continues from the previous page's cursor.
    expect(
      getEvents.mock.calls
        .slice(1)
        .every((call) => typeof call[0].cursor === 'string'),
    ).toBe(true);

    // Stroops stay exact across pages: 250 * 3000.
    expect(revenue.totalFeeStroops).toBe(BigInt(SWAPS) * PER_SWAP_FEE);
    expect(revenue.totalFeeByToken[0].decimals).toBe(6);
    expect(revenue.totalFeeByToken[0].feeDisplay).toBeCloseTo(0.75, 12);
  });

  it('pages through the whole window at the default page size of 200', async () => {
    const { client, getEvents } = buildClient({ events: events(SWAPS), pageCap: 200 });

    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

    // The default limit sizes each page; it does not cap the aggregation.
    expect(getEvents.mock.calls[0][0].limit).toBe(200);
    expect(getEvents.mock.calls.length).toBe(2);
    expect(revenue.swapCount).toBe(SWAPS);
    expect(revenue.totalFeeStroops).toBe(BigInt(SWAPS) * PER_SWAP_FEE);
    expect(revenue.totalFeeByToken[0].feeDisplay).toBeCloseTo(0.75, 12);
  });

  it('ignores swaps past toLedger and zero-fee swaps', async () => {
    const { client } = buildClient({
      events: [
        ...events(3),
        swapEvent(PAIR, CURRENT_LEDGER + 10, {
          amountIn: 1_000_000n,
          sender: USER_2,
          feeBps: 30,
          tokenIn: TOKEN_6,
          tokenOut: TOKEN_A,
        }),
        swapIn(TOKEN_6, 1_000_000n, 0, 5),
      ],
    });

    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

    expect(revenue.swapCount).toBe(3);
    expect(revenue.history.every((entry) => entry.feeBps === 30)).toBe(true);
    expect(revenue.totalFeeStroops).toBe(3n * PER_SWAP_FEE);
  });
});

// ---------------------------------------------------------------------------
// getLPYield() — claimable fee share over token decimals
// ---------------------------------------------------------------------------

describe('FeeModule.getLPYield() claim fee share over token decimals', () => {
  const RESERVE0 = 1_500_000n; // 1.5 units at 6 decimals
  const RESERVE1 = 2_500_000_000_000n; // 2.5 units at 12 decimals
  const BALANCE = 25n;
  const SUPPLY = 100n;
  /** Two 1_000_000-unit swaps at 30 bps = 3000 stroops each, charged in T6. */
  const REVENUE_STROOPS = 6_000n;

  it('values each reserve with its own token decimals', async () => {
    const { client, metadataCalls } = buildClient({
      events: [
        swapIn(TOKEN_6, 1_000_000n, 30, 10),
        swapIn(TOKEN_6, 1_000_000n, 30, 20),
      ],
      pool: { token0: TOKEN_6, token1: TOKEN_12, reserve0: RESERVE0, reserve1: RESERVE1 },
      lp: { balance: BALANCE, totalSupply: SUPPLY },
    });

    const result = await new FeeModule(client).getLPYield(PAIR, HOLDER);

    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);
    expect(revenue.history.every((entry) => entry.decimals === 6)).toBe(true);
    expect(result.lpSharePercent).toBeCloseTo(25, 9);
    // (1_500_000 / 10^6) + (2_500_000_000_000 / 10^12) = 1.5 + 2.5 = 4.0,
    // times the 25% share. A hardcoded 1e7 gives 0.15 + 250_000 instead.
    expect(result.lpValueXLM).toBeCloseTo(1.0, 9);

    // Claimable fee share: 6000 stroops at 6 decimals = 0.006, 25% of it.
    expect(result.totalFeeRevenueXLM).toBeCloseTo(0.006, 9);
    expect(result.lpFeeShareXLM).toBeCloseTo(0.0015, 9);
    expect(result.totalFeeRevenueXLM).not.toBeCloseTo(6000 / 1e7, 9);
    expect(result.aprPercent).toBeGreaterThan(0);

    // The 6-decimal token is read once and reused by revenue and yield.
    expect(metadataCalls.filter((address) => address === TOKEN_6)).toHaveLength(1);
    expect(metadataCalls.filter((address) => address === TOKEN_12)).toHaveLength(1);
  });

  it('keeps a 7/7 pool on the legacy 7-decimal reading', async () => {
    const { client } = buildClient({
      events: [swapIn(TOKEN_7, 1_000_000n, 30, 10)],
      pool: {
        token0: TOKEN_7,
        token1: TOKEN_7,
        reserve0: 20_000_000n, // 2.0 units at 7 decimals
        reserve1: 10_000_000n, // 1.0 unit at 7 decimals
      },
      lp: { balance: BALANCE, totalSupply: SUPPLY },
    });

    const result = await new FeeModule(client).getLPYield(PAIR, HOLDER);
    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

    expect(revenue.history.every((entry) => entry.decimals === 7)).toBe(true);
    expect(result.lpValueXLM).toBeCloseTo((2.0 + 1.0) * 0.25, 9);
    // 3000 stroops at 7 decimals = 0.0003, 25% share.
    expect(result.lpFeeShareXLM).toBeCloseTo(0.000075, 12);
  });

  it('reports the token decimals even when the holder owns no LP tokens', async () => {
    const { client } = buildClient({
      events: [],
      pool: { token0: TOKEN_6, token1: TOKEN_12, reserve0: RESERVE0, reserve1: RESERVE1 },
      lp: { balance: 0n, totalSupply: SUPPLY },
    });

    const result = await new FeeModule(client).getLPYield(PAIR, HOLDER);
    const revenue = await new FeeModule(client).getFeeRevenue(PAIR);

    expect(revenue.totalFeeByToken).toEqual([]);
    expect(result.lpSharePercent).toBe(0);
    expect(result.lpValueXLM).toBe(0);
    expect(result.lpFeeShareXLM).toBe(0);
    expect(result.aprPercent).toBe(0);
  });
});
