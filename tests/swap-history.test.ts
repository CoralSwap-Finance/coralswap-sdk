import { CoralSwapClient } from "../src/client";
import { SwapModule } from "../src/modules/swap";
import { Network } from "../src/types/common";
import { SwapHistoryFilter, SwapHistoryEvent } from "../src/types/swap";
import { ValidationError } from "../src/errors";
import { rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET =
  "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

const PAIR_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAIR_B = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const TOKEN_X = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_Y = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const TOKEN_Z = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
const USER_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USER_2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// ---------------------------------------------------------------------------
// Raw event builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal raw event object that mimics the shape returned by
 * SorobanRpc.Server.getEvents(), with ScVal-like accessors for the value map.
 */
function makeRawSwapEvent(opts: {
  contractId: string;
  sender: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  feeBps: number;
  ledger: number;
  txHash: string;
  ledgerClosedAt?: string;
}): Record<string, unknown> {
  const makeAddr = (addr: string) => ({
    address: () => ({ toString: () => addr }),
  });

  const makeI128 = (n: bigint) => ({
    i128: () => ({
      hi: () => ({ toString: () => String(n >> 64n) }),
      lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
    }),
  });

  const makeU32 = (n: number) => ({
    u32: () => n,
  });

  const makeSym = (s: string) => ({
    sym: () => ({ toString: () => s }),
  });

  const mapEntries = [
    { key: makeSym("sender"), val: makeAddr(opts.sender) },
    { key: makeSym("token_in"), val: makeAddr(opts.tokenIn) },
    { key: makeSym("token_out"), val: makeAddr(opts.tokenOut) },
    { key: makeSym("amount_in"), val: makeI128(opts.amountIn) },
    { key: makeSym("amount_out"), val: makeI128(opts.amountOut) },
    { key: makeSym("fee_bps"), val: makeU32(opts.feeBps) },
  ];

  return {
    topic: ["swap"],
    value: { map: () => mapEntries },
    contractId: opts.contractId,
    ledger: opts.ledger,
    txHash: opts.txHash,
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(opts.ledger * 1000).toISOString(),
  };
}

/** Build a mock getEvents response. */
function makeEventsResponse(
  events: Record<string, unknown>[],
): SorobanRpc.Api.GetEventsResponse {
  return {
    events: events as unknown as SorobanRpc.Api.EventResponse[],
    latestLedger: 2000,
  };
}

const EXPECTED_SWAP_TOPIC = xdr.ScVal.scvSymbol("swap").toXdr("base64");

function mockGetEvents(
  client: CoralSwapClient,
  events: Record<string, unknown>[],
): jest.SpyInstance {
  const response = makeEventsResponse(events);
  const spy = jest.spyOn(client.server, "getEvents").mockImplementation((req) => {
    const topic0 = req.filters?.[0]?.topics?.[0]?.[0];
    if (topic0 !== EXPECTED_SWAP_TOPIC) {
      return Promise.resolve({ events: [], latestLedger: req.startLedger ?? 0 } as unknown as SorobanRpc.Api.GetEventsResponse);
    }
    return Promise.resolve(response);
  });
  return spy;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SwapModule.getSwapHistory()", () => {
  let client: CoralSwapClient;
  let swapModule: SwapModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    swapModule = new SwapModule(client);

    // Default: current ledger = 2000
    jest.spyOn(client, "getCurrentLedger").mockResolvedValue(2000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty / no-match cases
  // -------------------------------------------------------------------------

  describe("empty results", () => {
    it("returns [] when RPC returns no events", async () => {
      mockGetEvents(client, []);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });
      expect(result).toEqual([]);
    });

    it("returns [] when no events match the userAddress filter", async () => {
      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1500,
        txHash: "tx1",
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({ userAddress: USER_2 });
      expect(result).toEqual([]);
    });

    it("returns [] when RPC response has no events array", async () => {
      jest
        .spyOn(client.server, "getEvents")
        .mockImplementation((req) => {
          const topic0 = req.filters?.[0]?.topics?.[0]?.[0];
          if (topic0 !== EXPECTED_SWAP_TOPIC) {
            return Promise.resolve({ events: [], latestLedger: 0 } as unknown as SorobanRpc.Api.GetEventsResponse);
          }
          return Promise.resolve({ latestLedger: 2000 } as unknown as SorobanRpc.Api.GetEventsResponse);
        });

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });
      expect(result).toEqual([]);
    });

    it("returns [] when all events are beyond toLedger", async () => {
      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1900, // beyond toLedger of 1800
        txHash: "tx1",
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({
        pairAddress: PAIR_A,
        fromLedger: 1000,
        toLedger: 1800,
      });
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Filter by pairAddress
  // -------------------------------------------------------------------------

  describe("filter by pairAddress", () => {
    it("returns only swaps for the specified pair", async () => {
      const eventA = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1500,
        txHash: "txA",
      });

      mockGetEvents(client, [eventA]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(1);
      expect(result[0].pairAddress).toBe(PAIR_A);
      expect(result[0].txHash).toBe("txA");
    });

    it("passes pairAddress as contractId filter to getEvents", async () => {
      const getEventsSpy = mockGetEvents(client, []);

      await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(getEventsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.arrayContaining([
            expect.objectContaining({ contractIds: [PAIR_A] }),
          ]),
        }),
      );
    });

    it("returns correct event fields for a pair swap", async () => {
      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 5000000n,
        amountOut: 4850000n,
        feeBps: 30,
        ledger: 1750,
        txHash: "tx_detail",
        ledgerClosedAt: "2024-01-15T12:00:00Z",
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(1);
      const swap = result[0];
      expect(swap.txHash).toBe("tx_detail");
      expect(swap.amountIn).toBe(5000000n);
      expect(swap.amountOut).toBe(4850000n);
      expect(swap.tokenIn).toBe(TOKEN_X);
      expect(swap.tokenOut).toBe(TOKEN_Y);
      expect(swap.sender).toBe(USER_1);
      expect(swap.pairAddress).toBe(PAIR_A);
      expect(swap.ledger).toBe(1750);
      expect(swap.feeBps).toBe(30);
      expect(typeof swap.timestamp).toBe("number");
    });

    it("returns multiple swaps for the same pair", async () => {
      const events = [
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 1000n,
          amountOut: 900n,
          feeBps: 30,
          ledger: 1500,
          txHash: "tx1",
        }),
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_2,
          tokenIn: TOKEN_Y,
          tokenOut: TOKEN_X,
          amountIn: 2000n,
          amountOut: 1800n,
          feeBps: 30,
          ledger: 1600,
          txHash: "tx2",
        }),
      ];

      mockGetEvents(client, events);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(2);
      expect(result[0].txHash).toBe("tx1");
      expect(result[1].txHash).toBe("tx2");
    });
  });

  // -------------------------------------------------------------------------
  // Filter by userAddress
  // -------------------------------------------------------------------------

  describe("filter by userAddress", () => {
    it("returns only swaps initiated by the specified user", async () => {
      const events = [
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 1000n,
          amountOut: 900n,
          feeBps: 30,
          ledger: 1500,
          txHash: "tx_user1",
        }),
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_2,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 2000n,
          amountOut: 1800n,
          feeBps: 30,
          ledger: 1600,
          txHash: "tx_user2",
        }),
      ];

      mockGetEvents(client, events);

      const result = await swapModule.getSwapHistory({ userAddress: USER_1 });

      expect(result).toHaveLength(1);
      expect(result[0].sender).toBe(USER_1);
      expect(result[0].txHash).toBe("tx_user1");
    });

    it("returns swaps across multiple pairs for the same user", async () => {
      const events = [
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 1000n,
          amountOut: 900n,
          feeBps: 30,
          ledger: 1500,
          txHash: "tx_pairA",
        }),
        makeRawSwapEvent({
          contractId: PAIR_B,
          sender: USER_1,
          tokenIn: TOKEN_Y,
          tokenOut: TOKEN_Z,
          amountIn: 500n,
          amountOut: 450n,
          feeBps: 25,
          ledger: 1600,
          txHash: "tx_pairB",
        }),
      ];

      mockGetEvents(client, events);

      const result = await swapModule.getSwapHistory({ userAddress: USER_1 });

      expect(result).toHaveLength(2);
      expect(result[0].pairAddress).toBe(PAIR_A);
      expect(result[1].pairAddress).toBe(PAIR_B);
    });
  });

  // -------------------------------------------------------------------------
  // Combined filters (AND semantics)
  // -------------------------------------------------------------------------

  describe("combined pairAddress + userAddress filters", () => {
    it("returns only swaps matching both pair AND user", async () => {
      const events = [
        // Matches pair A AND user 1 → should be included
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 1000n,
          amountOut: 900n,
          feeBps: 30,
          ledger: 1500,
          txHash: "tx_match",
        }),
        // Matches pair A but NOT user 1 → excluded
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_2,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 2000n,
          amountOut: 1800n,
          feeBps: 30,
          ledger: 1600,
          txHash: "tx_wrong_user",
        }),
      ];

      mockGetEvents(client, events);

      const result = await swapModule.getSwapHistory({
        pairAddress: PAIR_A,
        userAddress: USER_1,
      });

      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe("tx_match");
      expect(result[0].sender).toBe(USER_1);
      expect(result[0].pairAddress).toBe(PAIR_A);
    });

    it("returns [] when pair matches but user does not", async () => {
      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_2,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1500,
        txHash: "tx1",
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({
        pairAddress: PAIR_A,
        userAddress: USER_1,
      });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Ledger range filtering
  // -------------------------------------------------------------------------

  describe("ledger range filtering", () => {
    it("defaults to last 1000 ledgers when no range is specified", async () => {
      const getEventsSpy = mockGetEvents(client, []);

      await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(getEventsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 1000 }), // 2000 - 1000
      );
    });

    it("uses provided fromLedger and toLedger", async () => {
      const getEventsSpy = mockGetEvents(client, []);

      await swapModule.getSwapHistory({
        pairAddress: PAIR_A,
        fromLedger: 500,
        toLedger: 800,
      });

      expect(getEventsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 500 }),
      );
    });

    it("excludes events beyond toLedger", async () => {
      const events = [
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 1000n,
          amountOut: 900n,
          feeBps: 30,
          ledger: 750, // within range
          txHash: "tx_in_range",
        }),
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: 2000n,
          amountOut: 1800n,
          feeBps: 30,
          ledger: 850, // beyond toLedger of 800
          txHash: "tx_out_of_range",
        }),
      ];

      mockGetEvents(client, events);

      const result = await swapModule.getSwapHistory({
        pairAddress: PAIR_A,
        fromLedger: 500,
        toLedger: 800,
      });

      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe("tx_in_range");
    });

    it("throws ValidationError when fromLedger > toLedger", async () => {
      mockGetEvents(client, []);

      await expect(
        swapModule.getSwapHistory({
          pairAddress: PAIR_A,
          fromLedger: 1500,
          toLedger: 1000,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        swapModule.getSwapHistory({
          pairAddress: PAIR_A,
          fromLedger: 1500,
          toLedger: 1000,
        }),
      ).rejects.toThrow("fromLedger (1500) must not be greater than toLedger (1000)");
    });

    it("clamps fromLedger to 0 when currentLedger < 1000", async () => {
      jest.spyOn(client, "getCurrentLedger").mockResolvedValue(500);

      const getEventsSpy = mockGetEvents(client, []);

      await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(getEventsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 0 }), // max(0, 500 - 1000) = 0
      );
    });
  });

  // -------------------------------------------------------------------------
  // Limit
  // -------------------------------------------------------------------------

  describe("limit", () => {
    it("respects the limit parameter", async () => {
      const events = Array.from({ length: 10 }, (_, i) =>
        makeRawSwapEvent({
          contractId: PAIR_A,
          sender: USER_1,
          tokenIn: TOKEN_X,
          tokenOut: TOKEN_Y,
          amountIn: BigInt(1000 + i),
          amountOut: BigInt(900 + i),
          feeBps: 30,
          ledger: 1500 + i,
          txHash: `tx${i}`,
        }),
      );

      mockGetEvents(client, events);

      const result = await swapModule.getSwapHistory({
        pairAddress: PAIR_A,
        limit: 3,
      });

      expect(result).toHaveLength(3);
    });

    it("passes limit to getEvents request", async () => {
      const getEventsSpy = mockGetEvents(client, []);

      await swapModule.getSwapHistory({ pairAddress: PAIR_A, limit: 50 });

      expect(getEventsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });

    it("uses default limit of 200 when not specified", async () => {
      const getEventsSpy = mockGetEvents(client, []);

      await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(getEventsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 200 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe("input validation", () => {
    it("throws ValidationError for invalid pairAddress", async () => {
      await expect(
        swapModule.getSwapHistory({ pairAddress: "not-a-valid-address" }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for invalid userAddress", async () => {
      await expect(
        swapModule.getSwapHistory({ userAddress: "not-a-valid-address" }),
      ).rejects.toThrow(ValidationError);
    });

    it("accepts valid G... userAddress", async () => {
      mockGetEvents(client, []);

      await expect(
        swapModule.getSwapHistory({ userAddress: USER_1 }),
      ).resolves.toEqual([]);
    });

    it("accepts valid C... pairAddress", async () => {
      mockGetEvents(client, []);

      await expect(
        swapModule.getSwapHistory({ pairAddress: PAIR_A }),
      ).resolves.toEqual([]);
    });

    it("accepts empty filter object (no filters)", async () => {
      mockGetEvents(client, []);

      await expect(swapModule.getSwapHistory({})).resolves.toEqual([]);
    });

    it("accepts no argument (default filter)", async () => {
      mockGetEvents(client, []);

      await expect(swapModule.getSwapHistory()).resolves.toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed / mixed event data
  // -------------------------------------------------------------------------

  describe("robustness", () => {
    it("skips malformed events and returns valid ones", async () => {
      const validEvent = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1500,
        txHash: "tx_valid",
      });

      // Malformed: value is null
      const malformedEvent = {
        topic: ["swap"],
        value: null,
        contractId: PAIR_A,
        ledger: 1501,
        txHash: "tx_bad",
      };

      mockGetEvents(client, [malformedEvent as unknown as Record<string, unknown>, validEvent]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe("tx_valid");
    });

    it("skips events with non-swap topics", async () => {
      const nonSwapEvent = {
        topic: ["add_liquidity"],
        value: { map: () => [] },
        contractId: PAIR_A,
        ledger: 1500,
        txHash: "tx_liq",
      };

      const swapEvent = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1501,
        txHash: "tx_swap",
      });

      mockGetEvents(client, [nonSwapEvent as unknown as Record<string, unknown>, swapEvent]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe("tx_swap");
    });

    it("handles events with missing txHash gracefully", async () => {
      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1500,
        txHash: "",
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // Return type shape
  // -------------------------------------------------------------------------

  describe("return type shape", () => {
    it("returns SwapHistoryEvent objects with all required fields", async () => {
      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000000n,
        amountOut: 980000n,
        feeBps: 30,
        ledger: 1750,
        txHash: "tx_shape",
        ledgerClosedAt: "2024-06-01T00:00:00Z",
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result).toHaveLength(1);
      const swap: SwapHistoryEvent = result[0];

      // All required fields present
      expect(typeof swap.txHash).toBe("string");
      expect(typeof swap.amountIn).toBe("bigint");
      expect(typeof swap.amountOut).toBe("bigint");
      expect(typeof swap.tokenIn).toBe("string");
      expect(typeof swap.tokenOut).toBe("string");
      expect(typeof swap.sender).toBe("string");
      expect(typeof swap.pairAddress).toBe("string");
      expect(typeof swap.ledger).toBe("number");
      expect(typeof swap.timestamp).toBe("number");
      expect(typeof swap.feeBps).toBe("number");

      // Correct values
      expect(swap.amountIn).toBe(1000000n);
      expect(swap.amountOut).toBe(980000n);
      expect(swap.tokenIn).toBe(TOKEN_X);
      expect(swap.tokenOut).toBe(TOKEN_Y);
      expect(swap.sender).toBe(USER_1);
      expect(swap.pairAddress).toBe(PAIR_A);
      expect(swap.ledger).toBe(1750);
      expect(swap.feeBps).toBe(30);
    });

    it("derives timestamp from ledgerClosedAt when available", async () => {
      const closedAt = "2024-06-01T12:00:00Z";
      const expectedTimestamp = Math.floor(new Date(closedAt).getTime() / 1000);

      const event = makeRawSwapEvent({
        contractId: PAIR_A,
        sender: USER_1,
        tokenIn: TOKEN_X,
        tokenOut: TOKEN_Y,
        amountIn: 1000n,
        amountOut: 900n,
        feeBps: 30,
        ledger: 1750,
        txHash: "tx_ts",
        ledgerClosedAt: closedAt,
      });

      mockGetEvents(client, [event]);

      const result = await swapModule.getSwapHistory({ pairAddress: PAIR_A });

      expect(result[0].timestamp).toBe(expectedTimestamp);
    });
  });
});
