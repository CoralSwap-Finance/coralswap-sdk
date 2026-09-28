/**
 * Tests for TaxReportingModule.exportTradeHistory()
 *
 * After the EventCursor migration, tax-reporting.ts no longer hand-rolls
 * getEvents request building or ScVal decoding. Instead it delegates to
 * EventCursor, which issues:
 *
 *   - One getEvents call for swap events   (topics: [["swap"]])
 *   - One getEvents call for liquidity events (topics: [["add_liquidity"], ["remove_liquidity"]])
 *
 * The mock below inspects the first topic in the first filter to route
 * the right fixture events to each call.
 */
import { CoralSwapClient } from "../src/client";
import { TaxReportingModule, TaxReportRow } from "../src/modules/tax-reporting";
import { Network } from "../src/types/common";
import { SorobanRpc } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET =
  "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const TX_HASH = "abc123txhash";

// ---------------------------------------------------------------------------
// ScVal-like builder helpers
//
// These mirror the shape returned by SorobanRpc.Server.getEvents() after the
// stellar-sdk has decoded the XDR. EventCursor reads these via the same duck-
// typed accessor pattern that the SDK uses on real responses.
// ---------------------------------------------------------------------------

const makeAddr = (addr: string) => ({
  address: () => ({ toString: () => addr }),
});

const makeI128 = (n: bigint) => ({
  i128: () => ({
    hi: () => ({ toString: () => String(n >> 64n) }),
    // Produce the unsigned representation of the low 64 bits, matching the
    // SDK's behaviour for all values — including those where bit 63 is set.
    lo: () => ({ toString: () => String(n & 0xFFFFFFFFFFFFFFFFn) }),
  }),
});

const makeU32 = (n: number) => ({ u32: () => n });
const makeSym = (s: string) => ({ sym: () => ({ toString: () => s }) });

function makeSwapEvent(opts: {
  sender: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  feeBps: number;
  txHash?: string;
  ledgerClosedAt?: string;
  ledger?: number;
}): Record<string, unknown> {
  const ledger = opts.ledger ?? 1000;
  return {
    topic: ["swap"],
    value: {
      map: () => [
        { key: makeSym("sender"), val: makeAddr(opts.sender) },
        { key: makeSym("token_in"), val: makeAddr(opts.tokenIn) },
        { key: makeSym("token_out"), val: makeAddr(opts.tokenOut) },
        { key: makeSym("amount_in"), val: makeI128(opts.amountIn) },
        { key: makeSym("amount_out"), val: makeI128(opts.amountOut) },
        { key: makeSym("fee_bps"), val: makeU32(opts.feeBps) },
      ],
    },
    txHash: opts.txHash ?? TX_HASH,
    ledger,
    ledgerClosedAt:
      opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
  };
}

function makeLiquidityEvent(opts: {
  type: "add_liquidity" | "remove_liquidity";
  provider: string;
  tokenA: string;
  tokenB: string;
  amountA: bigint;
  amountB: bigint;
  liquidity?: bigint;
  txHash?: string;
  ledgerClosedAt?: string;
  ledger?: number;
}): Record<string, unknown> {
  const ledger = opts.ledger ?? 1000;
  return {
    topic: [opts.type],
    value: {
      map: () => [
        { key: makeSym("provider"), val: makeAddr(opts.provider) },
        { key: makeSym("token_a"), val: makeAddr(opts.tokenA) },
        { key: makeSym("token_b"), val: makeAddr(opts.tokenB) },
        { key: makeSym("amount_a"), val: makeI128(opts.amountA) },
        { key: makeSym("amount_b"), val: makeI128(opts.amountB) },
        ...(opts.liquidity !== undefined
          ? [{ key: makeSym("liquidity"), val: makeI128(opts.liquidity) }]
          : []),
      ],
    },
    txHash: opts.txHash ?? TX_HASH,
    ledger,
    ledgerClosedAt:
      opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
  };
}

function mockEventsResponse(
  events: Record<string, unknown>[],
): SorobanRpc.Api.GetEventsResponse {
  return {
    events: events as unknown as SorobanRpc.Api.EventResponse[],
    latestLedger: 5000,
  };
}

/**
 * Route mock events to the correct getEvents call by inspecting the first
 * topic in the first filter of the request.
 *
 * After the EventCursor migration:
 *   - Swap cursor sends:      filters[0].topics[0] === ["swap"]
 *   - Liquidity cursor sends: filters[0].topics[0] === ["add_liquidity"]
 *                             AND filters[1].topics[0] === ["remove_liquidity"]
 *     (both in the same request)
 */
function makeTopicRouter(options: {
  swapEvents?: Record<string, unknown>[];
  addEvents?: Record<string, unknown>[];
  removeEvents?: Record<string, unknown>[];
}) {
  return async (req: SorobanRpc.Server.GetEventsRequest): Promise<SorobanRpc.Api.GetEventsResponse> => {
    const firstTopic =
      (req.filters?.[0]?.topics?.[0] as string[] | undefined)?.[0] ?? "";

    if (firstTopic === "swap") {
      return mockEventsResponse(options.swapEvents ?? []);
    }
    if (firstTopic === "add_liquidity" || firstTopic === "remove_liquidity") {
      // The liquidity cursor sends add + remove in the same request.
      // Return all matching events for both topic types.
      return mockEventsResponse([
        ...(options.addEvents ?? []),
        ...(options.removeEvents ?? []),
      ]);
    }
    return mockEventsResponse([]);
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("TaxReportingModule.exportTradeHistory()", () => {
  let client: CoralSwapClient;
  let tax: TaxReportingModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    // Stub getCurrentLedger
    jest.spyOn(client, "getCurrentLedger").mockResolvedValue(5000);

    tax = new TaxReportingModule(client);
  });

  afterEach(() => jest.restoreAllMocks());

  // -------------------------------------------------------------------------
  // CSV format tests
  // -------------------------------------------------------------------------

  it("returns CSV with correct headers", async () => {
    jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(mockEventsResponse([]));

    const csv = await tax.exportTradeHistory(USER);
    const header = csv.split("\n")[0];
    expect(header).toBe(
      "Date,Type,Token In,Amount In,Token Out,Amount Out,Fee,USD Value,Tx Hash",
    );
  });

  it("returns one CSV row per swap event", async () => {
    const swapEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_500_000n,
      feeBps: 30,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [swapEv] }));

    const csv = await tax.exportTradeHistory(USER);
    const rows = csv.split("\n");
    expect(rows).toHaveLength(2); // header + 1 data row
  });

  it("formats amounts in human-readable form (7 decimals)", async () => {
    const swapEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n, // 1.0
      amountOut: 9_500_000n, // 0.95
      feeBps: 30,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [swapEv] }));

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain("1.0000000"); // amountIn
    expect(csv).toContain("0.9500000"); // amountOut
  });

  it("includes fee as human-readable amount", async () => {
    // amountIn = 10_000_000 stroops, feeBps = 30 → fee = 30 * 10_000_000 / 10000 = 30000 stroops = 0.0030000
    const swapEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_970_000n,
      feeBps: 30,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [swapEv] }));

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain("0.0030000");
  });

  // -------------------------------------------------------------------------
  // i128 correctness — sign-extension bug regression test
  // -------------------------------------------------------------------------

  it("correctly decodes i128 amounts where the low 64 bits have bit 63 set", async () => {
    // Construct an amountIn where lo has bit 63 set.
    // A naïve implementation that doesn't mask lo would sign-extend it, producing
    // a wildly wrong (negative or huge) bigint.
    //
    // Example: 2^63 = 9223372036854775808n
    // Correct i128: hi=0, lo=9223372036854775808n → value = 9223372036854775808n
    // Buggy (signed lo): hi=0, lo=-9223372036854775808n → value = -9223372036854775808n
    const amountIn = 9_223_372_036_854_775_808n; // 2^63, bit 63 of lo is set
    const amountOut = 9_000_000_000_000_000_000n;

    const swapEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn,
      amountOut,
      feeBps: 0,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [swapEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];

    // The human-readable amountIn should be 2^63 / 10^7 = 922337203685.4775808
    // We just check that it is a positive number and not obviously wrong.
    expect(rows).toHaveLength(1);
    const parsedAmountIn = parseFloat(rows[0].amountIn);
    expect(parsedAmountIn).toBeGreaterThan(0);
    // The buggy path would produce a negative value or something near -922337203685
    expect(parsedAmountIn).toBeGreaterThan(900_000_000_000);
  });

  // -------------------------------------------------------------------------
  // JSON format test
  // -------------------------------------------------------------------------

  it("returns valid JSON array when format is json", async () => {
    const swapEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_000_000n,
      feeBps: 30,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [swapEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const parsed = JSON.parse(json) as TaxReportRow[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe("swap");
    expect(parsed[0].txHash).toBe(TX_HASH);
  });

  // -------------------------------------------------------------------------
  // Liquidity events
  // -------------------------------------------------------------------------

  it("includes add_liquidity events", async () => {
    const addEv = makeLiquidityEvent({
      type: "add_liquidity",
      provider: USER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 50_000_000n,
      amountB: 100_000_000n,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ addEvents: [addEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    const liq = rows.find((r) => r.type === "add_liquidity");
    expect(liq).toBeDefined();
    expect(liq!.amountIn).toBe("5.0000000");
    expect(liq!.amountOut).toBe("10.0000000");
  });

  it("includes remove_liquidity events", async () => {
    const removeEv = makeLiquidityEvent({
      type: "remove_liquidity",
      provider: USER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 20_000_000n,
      amountB: 40_000_000n,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ removeEvents: [removeEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    const liq = rows.find((r) => r.type === "remove_liquidity");
    expect(liq).toBeDefined();
  });

  it("includes both add_liquidity and remove_liquidity in a single call", async () => {
    const addEv = makeLiquidityEvent({
      type: "add_liquidity",
      provider: USER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 50_000_000n,
      amountB: 100_000_000n,
      txHash: "addTxHash",
    });
    const removeEv = makeLiquidityEvent({
      type: "remove_liquidity",
      provider: USER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 20_000_000n,
      amountB: 40_000_000n,
      txHash: "removeTxHash",
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ addEvents: [addEv], removeEvents: [removeEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows.some((r) => r.type === "add_liquidity")).toBe(true);
    expect(rows.some((r) => r.type === "remove_liquidity")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Date filtering
  // -------------------------------------------------------------------------

  it("filters events by fromDate", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z").toISOString();
    const newDate = new Date("2024-06-01T00:00:00Z").toISOString();

    const oldEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
      ledgerClosedAt: oldDate,
    });
    const newEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 2_000_000n,
      amountOut: 1_800_000n,
      feeBps: 30,
      txHash: "newtxhash",
      ledgerClosedAt: newDate,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [oldEv, newEv] }));

    const json = await tax.exportTradeHistory(USER, {
      format: "json",
      fromDate: new Date("2024-01-01"),
    });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("newtxhash");
  });

  it("filters events by toDate", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z").toISOString();
    const newDate = new Date("2024-06-01T00:00:00Z").toISOString();

    const oldEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
      txHash: "oldtxhash",
      ledgerClosedAt: oldDate,
    });
    const newEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 2_000_000n,
      amountOut: 1_800_000n,
      feeBps: 30,
      ledgerClosedAt: newDate,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [oldEv, newEv] }));

    const json = await tax.exportTradeHistory(USER, {
      format: "json",
      toDate: new Date("2023-12-31"),
    });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("oldtxhash");
  });

  // -------------------------------------------------------------------------
  // Filters out events from other addresses
  // -------------------------------------------------------------------------

  it("excludes swap events from other senders", async () => {
    const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const otherEv = makeSwapEvent({
      sender: OTHER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ swapEvents: [otherEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(0);
  });

  it("excludes liquidity events from other providers", async () => {
    const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const otherEv = makeLiquidityEvent({
      type: "add_liquidity",
      provider: OTHER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 50_000_000n,
      amountB: 100_000_000n,
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(makeTopicRouter({ addEvents: [otherEv] }));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Empty response
  // -------------------------------------------------------------------------

  it("returns only header row in CSV when there are no events", async () => {
    jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(mockEventsResponse([]));

    const csv = await tax.exportTradeHistory(USER);
    expect(csv.split("\n")).toHaveLength(1);
  });

  it("returns empty JSON array when there are no events", async () => {
    jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(mockEventsResponse([]));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    expect(JSON.parse(json)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // EventCursor request structure verification
  // -------------------------------------------------------------------------

  it("passes startLedger to getEvents", async () => {
    const getEventsSpy = jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(mockEventsResponse([]));

    await tax.exportTradeHistory(USER);

    // getCurrentLedger returns 5000; DEFAULT_HISTORY_WINDOW = 17280; startLedger = max(0, 5000-17280) = 0
    expect(getEventsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 0 }),
    );
  });

  it("swap cursor uses topic filter [['swap']]", async () => {
    const getEventsSpy = jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(mockEventsResponse([]));

    await tax.exportTradeHistory(USER);

    // At least one call should use "swap" as the first filter topic
    const swapCall = getEventsSpy.mock.calls.find((args) => {
      const req = args[0] as SorobanRpc.Server.GetEventsRequest;
      return (req.filters?.[0]?.topics?.[0] as string[])?.[0] === "swap";
    });
    expect(swapCall).toBeDefined();
  });

  it("liquidity cursor sends add_liquidity and remove_liquidity in the same request", async () => {
    const getEventsSpy = jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(mockEventsResponse([]));

    await tax.exportTradeHistory(USER);

    // Find the call with the liquidity topics
    const liqCall = getEventsSpy.mock.calls.find((args) => {
      const req = args[0] as SorobanRpc.Server.GetEventsRequest;
      const topicSet = new Set(
        (req.filters ?? []).flatMap(
          (f) => (f.topics?.[0] as string[] | undefined) ?? [],
        ),
      );
      return topicSet.has("add_liquidity") || topicSet.has("remove_liquidity");
    });
    expect(liqCall).toBeDefined();

    // Both add_liquidity and remove_liquidity should be in the same request
    const req = liqCall![0] as SorobanRpc.Server.GetEventsRequest;
    const allTopics = (req.filters ?? []).flatMap(
      (f) => (f.topics?.[0] as string[] | undefined) ?? [],
    );
    expect(allTopics).toContain("add_liquidity");
    expect(allTopics).toContain("remove_liquidity");
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("throws ValidationError for invalid address", async () => {
    await expect(
      tax.exportTradeHistory("NOT_AN_ADDRESS"),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Robustness: malformed events are skipped
  // -------------------------------------------------------------------------

  it("skips malformed swap events and returns valid ones", async () => {
    const malformed = {
      topic: ["swap"],
      value: null,
      txHash: "bad",
      ledger: 1000,
      ledgerClosedAt: new Date(1_700_000_000_000).toISOString(),
    };

    const valid = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
      txHash: "goodhash",
    });

    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation(
        makeTopicRouter({
          swapEvents: [malformed as unknown as Record<string, unknown>, valid],
        }),
      );

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("goodhash");
  });
});
