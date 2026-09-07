import { xdr } from "@stellar/stellar-sdk";
import {
  EventCursor,
  decodeEventTopic,
  encodeTopicForFilter,
  MIN_START_LEDGER,
  MAX_EVENT_LIMIT,
} from "../src/utils/event-cursor";
import { ValidationError } from "../src/errors";

describe("encodeTopicForFilter", () => {
  it("encodes a string as a base64 ScVal symbol", () => {
    const encoded = encodeTopicForFilter("swap");
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);

    // Round-trip: decode back to the original symbol
    const decoded = xdr.ScVal.fromXdr(encoded, "base64");
    expect(decoded.type).toBe("scvSymbol");
    expect(decoded.sym.toString()).toBe("swap");
  });

  it("encodes add_liquidity topic correctly", () => {
    const encoded = encodeTopicForFilter("add_liquidity");
    const decoded = xdr.ScVal.fromXdr(encoded, "base64");
    expect(decoded.sym.toString()).toBe("add_liquidity");
  });
});

describe("EventCursor", () => {
  const makeServer = (pages: Array<{ events: unknown[]; latestLedger?: number }>) => {
    let call = 0;
    return {
      getEvents: jest.fn().mockImplementation(async () => {
        const page = pages[call] ?? { events: [], latestLedger: 0 };
        call += 1;
        return page;
      }),
    };
  };

  it("encodes topics as ScVal symbols in the getEvents request", async () => {
    const server = makeServer([{ events: [], latestLedger: 100 }]);
    const cursor = new EventCursor({
      server: server as any,
      topics: ["swap"],
      startLedger: 10,
      limit: 50,
    });

    await cursor.fetchNext();

    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        startLedger: 10,
        limit: 50,
        filters: [
          expect.objectContaining({
            type: "contract",
            topics: [[encodeTopicForFilter("swap")]],
          }),
        ],
      }),
    );
  });

  it("passes contractIds when provided", async () => {
    const server = makeServer([{ events: [], latestLedger: 100 }]);
    const cursor = new EventCursor({
      server: server as any,
      contractIds: ["CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"],
      topics: ["add_liquidity"],
      startLedger: 1,
    });

    await cursor.fetchNext();

    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({
            contractIds: ["CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"],
          }),
        ],
      }),
    );
  });

  it("returns events from fetchNext and marks hasMore false when page is short", async () => {
    const events = [
      { ledger: 1, pagingToken: "a", topic: ["swap"], value: {} },
      { ledger: 2, pagingToken: "b", topic: ["swap"], value: {} },
    ];
    const server = makeServer([{ events, latestLedger: 200 }]);
    const cursor = new EventCursor({
      server: server as any,
      topics: ["swap"],
      startLedger: 1,
      limit: 10,
    });

    const page = await cursor.fetchNext();
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.latestLedger).toBe(200);
    expect(cursor.hasMore).toBe(false);
  });

  it("fetchAll aggregates pages up to maxEvents", async () => {
    const page1 = {
      events: [
        { ledger: 1, pagingToken: "a", topic: ["swap"], value: {} },
        { ledger: 2, pagingToken: "b", topic: ["swap"], value: {} },
      ],
      latestLedger: 10,
    };
    const page2 = {
      events: [{ ledger: 3, pagingToken: "c", topic: ["swap"], value: {} }],
      latestLedger: 10,
    };
    const server = makeServer([page1, page2]);
    const cursor = new EventCursor({
      server: server as any,
      topics: ["swap"],
      startLedger: 1,
      limit: 2,
    });

    const all = await cursor.fetchAll(3);
    expect(all).toHaveLength(3);
    expect(server.getEvents).toHaveBeenCalledTimes(2);
  });

  it("exposes pageInfo metadata and a truncated flag when a page hits the cap", async () => {
    const eventsPage1 = [
      { ledger: 1, txHash: 'a' },
      { ledger: 2, txHash: 'b' },
      { ledger: 3, txHash: 'c' },
    ];

    const server: any = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 500 }),
      getEvents: jest.fn().mockImplementation(async (req: any) => {
        if (req.startLedger === 1) {
          return {
            events: eventsPage1,
            latestLedger: 3,
            cursor: 'next-page',
          };
        }
        return { events: [], latestLedger: 3, cursor: 'final-page' };
      }),
    };

    const cursor = new EventCursor(server);
    const all = await cursor.scan({ fromLedger: 1, limit: 3 });

    expect(all.truncated).toBe(true);
    expect(all.pageInfo).toMatchObject({
      startLedger: 1,
      endLedger: 3,
      limit: 3,
      hasMore: true,
      nextCursor: 'next-page',
    });
  });

  // ---------------------------------------------------------------------------
  // limit validation
  // ---------------------------------------------------------------------------
  describe("limit validation", () => {
    let server: any;
    beforeEach(() => {
      server = {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 2000 }),
        getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 2000 }),
      };
    });

    it.each([0, -1, -100])("rejects limit=%i (non-positive)", async (bad) => {
      const cursor = new EventCursor(server);
      await expect(cursor.scan({ limit: bad })).rejects.toThrow(ValidationError);
    });

    it("rejects a decimal limit", async () => {
      const cursor = new EventCursor(server);
      await expect(cursor.scan({ limit: 1.5 })).rejects.toThrow(ValidationError);
    });

    it("rejects a limit above MAX_EVENT_LIMIT", async () => {
      const cursor = new EventCursor(server);
      await expect(cursor.scan({ limit: MAX_EVENT_LIMIT + 1 })).rejects.toThrow(ValidationError);
    });

    it("accepts limit=1 and limit=MAX_EVENT_LIMIT without throwing", async () => {
      const cursor = new EventCursor(server);
      await expect(cursor.scan({ limit: 1 })).resolves.not.toThrow();
      cursor.reset();
      await expect(cursor.scan({ limit: MAX_EVENT_LIMIT })).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Ledger anchoring floor (#437)
  // ---------------------------------------------------------------------------
  it("clamps the anchored cursor to ledger 1, never 0", async () => {
    const server: any = {
      // Chain head is younger than the default 1000-ledger window, so
      // `sequence - defaultWindow` is negative.
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 400 }),
      getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 400 }),
    };

    const cursor = new EventCursor(server);
    await cursor.scan();

    const req = server.getEvents.mock.calls[0][0];
    expect(req.startLedger).toBe(MIN_START_LEDGER);
    expect(req.startLedger).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Response topic decoding (#437)
  // ---------------------------------------------------------------------------
  describe("decodeEventTopic", () => {
    it("decodes a parsed ScVal symbol topic", () => {
      expect(decodeEventTopic(xdr.ScVal.scvSymbol("swap"))).toBe("swap");
    });

    it("decodes a base64 XDR topic as returned over raw JSON-RPC", () => {
      const encoded = xdr.ScVal.scvSymbol("add_liquidity").toXdr("base64");
      expect(decodeEventTopic(encoded)).toBe("add_liquidity");
    });

    it("decodes scvString topics as well as symbols", () => {
      expect(decodeEventTopic(xdr.ScVal.scvString("transfer"))).toBe("transfer");
    });

    // The whole point of the audit: a fixture that hands back a bare string
    // must not compare equal to the symbol it is imitating, otherwise mocks
    // silently hide the raw-string topic bug in the module under test.
    it("refuses a bare unencoded string", () => {
      expect(decodeEventTopic("swap")).toBe("");
    });

    it("returns an empty string for missing or non-topic values", () => {
      expect(decodeEventTopic(undefined)).toBe("");
      expect(decodeEventTopic(null)).toBe("");
      expect(decodeEventTopic(xdr.ScVal.scvU32(7))).toBe("");
    });
  });
});
