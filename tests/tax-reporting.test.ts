import { xdr, Address, nativeToScVal, SorobanRpc, Contract } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "../src/client";
import { TaxReportingModule, TaxReportRow } from "../src/modules/tax-reporting";
import { Network } from "../src/types/common";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET =
  "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const TX_HASH = "abc123txhash";
const PAIR_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// ---------------------------------------------------------------------------
// xdr.ScVal builder helpers (properly typed — matches SorobanRpc.Api.EventResponse)
// ---------------------------------------------------------------------------

function symbolVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: "address" });
}

function i128Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function u32Val(n: number): xdr.ScVal {
  return xdr.ScVal.scvU32(n);
}

/**
 * Build an ScMap ScVal from an array of [key, val] pairs.
 * Keys are encoded as symbols.
 */
function scMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  const mapEntries = entries.map(
    ([key, val]) => new xdr.ScMapEntry({ key: symbolVal(key), val }),
  );
  return xdr.ScVal.scvMap(mapEntries);
}

// ---------------------------------------------------------------------------
// Event builders that produce SorobanRpc.Api.EventResponse-shaped objects
//
// The SDK types EventResponse.topic as xdr.ScVal[] and EventResponse.value
// as xdr.ScVal, so mocks must use those types — not plain strings.
// ---------------------------------------------------------------------------

function makeSwapEventResponse(opts: {
  sender: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  feeBps: number;
  txHash?: string;
  ledgerClosedAt?: string;
  ledger?: number;
}): SorobanRpc.Api.EventResponse {
  const ledger = opts.ledger ?? 1000;
  return {
    id: "mock-id",
    type: "contract" as SorobanRpc.Api.EventType,
    ledger,
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
    pagingToken: "",
    inSuccessfulContractCall: true,
    txHash: opts.txHash ?? TX_HASH,
    contractId: new Contract(PAIR_ADDR),
    // topic is xdr.ScVal[] — first element is the event type symbol
    topic: [symbolVal("swap")],
    // value is an xdr.ScVal ScMap
    value: scMap([
      ["sender", addressVal(opts.sender)],
      ["token_in", addressVal(opts.tokenIn)],
      ["token_out", addressVal(opts.tokenOut)],
      ["amount_in", i128Val(opts.amountIn)],
      ["amount_out", i128Val(opts.amountOut)],
      ["fee_bps", u32Val(opts.feeBps)],
    ]),
  };
}

function makeLiquidityEventResponse(opts: {
  type: "add_liquidity" | "remove_liquidity";
  provider: string;
  tokenA: string;
  tokenB: string;
  amountA: bigint;
  amountB: bigint;
  txHash?: string;
  ledgerClosedAt?: string;
  ledger?: number;
}): SorobanRpc.Api.EventResponse {
  const ledger = opts.ledger ?? 1000;
  return {
    id: "mock-id",
    type: "contract" as SorobanRpc.Api.EventType,
    ledger,
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
    pagingToken: "",
    inSuccessfulContractCall: true,
    txHash: opts.txHash ?? TX_HASH,
    contractId: new Contract(PAIR_ADDR),
    topic: [symbolVal(opts.type)],
    value: scMap([
      ["provider", addressVal(opts.provider)],
      ["token_a", addressVal(opts.tokenA)],
      ["token_b", addressVal(opts.tokenB)],
      ["amount_a", i128Val(opts.amountA)],
      ["amount_b", i128Val(opts.amountB)],
    ]),
  };
}

function mockEventsResponse(
  events: SorobanRpc.Api.EventResponse[],
): SorobanRpc.Api.GetEventsResponse {
  return {
    events,
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
    const swapEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_500_000n,
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [swapEv] : []);
    });

    const csv = await tax.exportTradeHistory(USER);
    const rows = csv.split("\n");
    expect(rows).toHaveLength(2); // header + 1 data row
  });

  it("formats amounts in human-readable form (7 decimals)", async () => {
    const swapEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n, // 1.0
      amountOut: 9_500_000n, // 0.95
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [swapEv] : []);
    });

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain("1.0000000"); // amountIn
    expect(csv).toContain("0.9500000"); // amountOut
  });

  it("includes fee as human-readable amount", async () => {
    // amountIn = 10_000_000 stroops, feeBps = 30 → fee = 30/10000 * 10_000_000 = 30_000 stroops = 0.0030000
    const swapEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_970_000n,
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [swapEv] : []);
    });

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain("0.0030000");
  });

  // -------------------------------------------------------------------------
  // JSON format test
  // -------------------------------------------------------------------------

  it("returns valid JSON array when format is json", async () => {
    const swapEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 9_000_000n,
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [swapEv] : []);
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
    const addEv = makeLiquidityEventResponse({
      type: "add_liquidity",
      provider: USER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 50_000_000n,
      amountB: 100_000_000n,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      if (topicFilter === "add_liquidity") return mockEventsResponse([addEv]);
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
    const removeEv = makeLiquidityEventResponse({
      type: "remove_liquidity",
      provider: USER,
      tokenA: TOKEN_A,
      tokenB: TOKEN_B,
      amountA: 20_000_000n,
      amountB: 40_000_000n,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      if (topicFilter === "remove_liquidity")
        return mockEventsResponse([removeEv]);
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

    const oldEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
      ledgerClosedAt: oldDate,
    });
    const newEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 2_000_000n,
      amountOut: 1_800_000n,
      feeBps: 30,
      txHash: "newtxhash",
      ledgerClosedAt: newDate,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [oldEv, newEv] : []);
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

    const oldEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
      txHash: "oldtxhash",
      ledgerClosedAt: oldDate,
    });
    const newEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 2_000_000n,
      amountOut: 1_800_000n,
      feeBps: 30,
      ledgerClosedAt: newDate,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [oldEv, newEv] : []);
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
    const otherEv = makeSwapEventResponse({
      sender: OTHER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000_000n,
      amountOut: 900_000n,
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [otherEv] : []);
    });

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
  // Validation
  // -------------------------------------------------------------------------

  it("throws ValidationError for invalid address", async () => {
    await expect(tax.exportTradeHistory("NOT_AN_ADDRESS")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Correct CSV columns contain the right data
  // -------------------------------------------------------------------------

  it("CSV row contains correct token addresses and tx hash", async () => {
    const swapEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 5_000_000n,
      amountOut: 4_500_000n,
      feeBps: 30,
      txHash: "specific_tx",
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [swapEv] : []);
    });

    const csv = await tax.exportTradeHistory(USER);
    expect(csv).toContain(TOKEN_A);
    expect(csv).toContain(TOKEN_B);
    expect(csv).toContain("specific_tx");
  });

  // -------------------------------------------------------------------------
  // Large i128 values (sign-extension regression test)
  // -------------------------------------------------------------------------

  it("correctly decodes large i128 amounts (> 2^63) without sign-extension errors", async () => {
    // Amount just above 2^63: would be misread as negative by a buggy implementation
    const largeAmount = 2n ** 63n + 1_000_000n;
    const swapEv = makeSwapEventResponse({
      sender: USER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: largeAmount,
      amountOut: largeAmount - 1_000_000n,
      feeBps: 30,
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req) => {
      const topicFilter = (req.filters?.[0]?.topics?.[0] as string[])?.[0];
      return mockEventsResponse(topicFilter === "swap" ? [swapEv] : []);
    });

    const json = await tax.exportTradeHistory(USER, { format: "json" });
    const rows = JSON.parse(json) as TaxReportRow[];
    expect(rows).toHaveLength(1);
    // The amount should be positive (not a huge negative number)
    const amountInNum = parseFloat(rows[0].amountIn);
    expect(amountInNum).toBeGreaterThan(0);
  });
});
