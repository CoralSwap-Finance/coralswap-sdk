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
// ScVal-like builder helpers (mirrors swap-history.test.ts)
// ---------------------------------------------------------------------------

const makeAddr = (addr: string) => ({
  address: () => ({ toString: () => addr }),
});

const makeI128 = (n: bigint) => ({
  i128: () => ({
    hi: () => ({ toString: () => String(n >> 64n) }),
    lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
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
}): Record<string, unknown> {
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
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
  };
}

function makeLiquidityEvent(opts: {
  type: "add_liquidity" | "remove_liquidity";
  provider: string;
  tokenA: string;
  tokenB: string;
  amountA: bigint;
  amountB: bigint;
  txHash?: string;
  ledgerClosedAt?: string;
}): Record<string, unknown> {
  return {
    topic: [opts.type],
    value: {
      map: () => [
        { key: makeSym("provider"), val: makeAddr(opts.provider) },
        { key: makeSym("token_a"), val: makeAddr(opts.tokenA) },
        { key: makeSym("token_b"), val: makeAddr(opts.tokenB) },
        { key: makeSym("amount_a"), val: makeI128(opts.amountA) },
        { key: makeSym("amount_b"), val: makeI128(opts.amountB) },
      ],
    },
    txHash: opts.txHash ?? TX_HASH,
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
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

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [swapEv] : []);
    });

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

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [swapEv] : []);
    });

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain("1.0000000"); // amountIn
    expect(csv).toContain("0.9500000"); // amountOut
  });

  it("includes fee as human-readable amount", async () => {
    // amountIn = 10_000_000 stroops, feeBps = 30 → fee = 30_000 / 10000 * 10_000_000 = 30000 stroops = 0.0030000
    const swapEv = makeSwapEvent({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_970_000n,
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [swapEv] : []);
    });

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain("0.0030000");
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

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [swapEv] : []);
    });

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

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      if (topic === "add_liquidity") return mockEventsResponse([addEv]);
      return mockEventsResponse([]);
    });

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

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      if (topic === "remove_liquidity") return mockEventsResponse([removeEv]);
      return mockEventsResponse([]);
    });

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    const liq = rows.find((r) => r.type === "remove_liquidity");
    expect(liq).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Date filtering
  // -------------------------------------------------------------------------

  it("filters events by fromDate", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z").toISOString();
    const newDate = new Date("2024-06-01T00:00:00Z").toISOString();

    const oldEv = makeSwapEvent({
      sender: USER, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
      amountIn: 1_000_000n, amountOut: 900_000n, feeBps: 30,
      ledgerClosedAt: oldDate,
    });
    const newEv = makeSwapEvent({
      sender: USER, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
      amountIn: 2_000_000n, amountOut: 1_800_000n, feeBps: 30,
      txHash: "newtxhash",
      ledgerClosedAt: newDate,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [oldEv, newEv] : []);
    });

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
      sender: USER, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
      amountIn: 1_000_000n, amountOut: 900_000n, feeBps: 30,
      txHash: "oldtxhash",
      ledgerClosedAt: oldDate,
    });
    const newEv = makeSwapEvent({
      sender: USER, tokenIn: TOKEN_A, tokenOut: TOKEN_B,
      amountIn: 2_000_000n, amountOut: 1_800_000n, feeBps: 30,
      ledgerClosedAt: newDate,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [oldEv, newEv] : []);
    });

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

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topic = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topic === "swap" ? [otherEv] : []);
    });

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Empty response
  // -------------------------------------------------------------------------

  it("returns only header row in CSV when there are no events", async () => {
    jest.spyOn(client.server, "getEvents").mockResolvedValue(mockEventsResponse([]));

    const csv = await tax.exportTradeHistory(USER);
    expect(csv.split("\n")).toHaveLength(1);
  });

  it("returns empty JSON array when there are no events", async () => {
    jest.spyOn(client.server, "getEvents").mockResolvedValue(mockEventsResponse([]));

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    expect(JSON.parse(json)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("throws ValidationError for invalid address", async () => {
    await expect(
      tax.exportTradeHistory("NOT_AN_ADDRESS"),
    ).rejects.toThrow();
  });
});
