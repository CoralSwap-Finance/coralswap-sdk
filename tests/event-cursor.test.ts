import { xdr } from "@stellar/stellar-sdk";
import EventCursor, {
  decodeEventTopic,
  MIN_START_LEDGER,
} from "../src/utils/event-cursor";

describe("EventCursor", () => {
  it("anchors initial cursor via getLatestLedger and uses defaultWindow", async () => {
    const server: any = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 2000 }),
      getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 2000 }),
    };

    const cursor = new EventCursor(server);
    await cursor.scan();

    // anchored to 2000 - 1000
    expect(server.getLatestLedger).toHaveBeenCalled();
    expect(server.getEvents).toHaveBeenCalled();
    const req = server.getEvents.mock.calls[0][0];
    expect(req.startLedger).toBe(1000);
  });

  it("encodes topic filters as base64 XDR ScVal, not raw strings", async () => {
    let captured: any = null;
    const server: any = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 2000 }),
      getEvents: jest.fn().mockImplementation(async (req: any) => {
        captured = req;
        return { events: [], latestLedger: 2000 };
      }),
    };

    const cursor = new EventCursor(server);
    await cursor.scan({ topics: ["swap"] });

    expect(captured).not.toBeNull();
    const topicEntry = captured.filters[0].topics[0][0];
    const expected = xdr.ScVal.scvSymbol("swap").toXDR("base64");
    expect(topicEntry).toBe(expected);
    expect(topicEntry).not.toBe("swap");
  });

  it("paginates when responses are full and aggregates results", async () => {
    const eventsPage1 = [
      { ledger: 1, txHash: 'a' },
      { ledger: 2, txHash: 'b' },
      { ledger: 3, txHash: 'c' },
    ];
    const eventsPage2 = [
      { ledger: 4, txHash: 'd' },
      { ledger: 5, txHash: 'e' },
    ];

    let call = 0;
    const server: any = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 500 }),
      getEvents: jest.fn().mockImplementation(async (req: any) => {
        call += 1;
        if (call === 1) return { events: eventsPage1, latestLedger: 5 };
        return { events: eventsPage2, latestLedger: 5 };
      }),
    };

    const cursor = new EventCursor(server);
    const all = await cursor.scan({ fromLedger: 1, limit: 3 });

    expect(server.getEvents).toHaveBeenCalledTimes(2);
    expect(all.map((e: any) => e.txHash)).toEqual(['a','b','c','d','e']);
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
      const encoded = xdr.ScVal.scvSymbol("add_liquidity").toXDR("base64");
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
