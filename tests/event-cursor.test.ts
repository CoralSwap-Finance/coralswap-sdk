import { xdr } from "@stellar/stellar-sdk";
import {
  EventCursor,
  decodeEventTopic,
  encodeTopicForFilter,
} from "../src/utils/event-cursor";

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
