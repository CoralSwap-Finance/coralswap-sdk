import EventCursor from "../src/utils/event-cursor";

describe("EventCursor - Timeline Continuity Suite (#657 / #29)", () => {
  it("fetches > page-size event runs on a single ledger without skipping any events", async () => {
    // Generate 250 events all on ledger 100
    const TOTAL_EVENTS = 250;
    const PAGE_LIMIT = 50;
    const LEDGER_SEQ = 100;

    const allMockEvents = Array.from({ length: TOTAL_EVENTS }, (_, i) => ({
      id: `0000000000100-${String(i).padStart(6, "0")}`,
      ledger: LEDGER_SEQ,
      txHash: `tx_${i}`,
      pagingToken: `cursor_${i + 1}`,
      topic: ["swap"],
      value: { amount: i },
    }));

    const getEventsCalls: any[] = [];
    const server: any = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 500 }),
      getEvents: jest.fn().mockImplementation(async (req: any) => {
        getEventsCalls.push(req);
        let startIdx = 0;
        if (req.cursor) {
          const match = req.cursor.match(/cursor_(\d+)/);
          if (match) {
            startIdx = parseInt(match[1], 10);
          }
        }
        const slice = allMockEvents.slice(startIdx, startIdx + PAGE_LIMIT);
        const lastInSlice = slice[slice.length - 1];
        return {
          events: slice,
          latestLedger: 500,
          cursor: lastInSlice ? lastInSlice.pagingToken : null,
        };
      }),
    };

    const cursor = new EventCursor(server);
    const results = await cursor.scan({ fromLedger: LEDGER_SEQ, limit: PAGE_LIMIT });

    // Must fetch all 250 events across sequential cursor advances
    expect(results).toHaveLength(TOTAL_EVENTS);
    expect(getEventsCalls.length).toBeGreaterThanOrEqual(5);

    // Verify sequential continuity: no event indices skipped
    results.forEach((ev: any, idx: number) => {
      expect(ev.txHash).toBe(`tx_${idx}`);
      expect(ev.ledger).toBe(LEDGER_SEQ);
    });
  });

  it("maintains timeline continuity across multi-page, multi-ledger runs", async () => {
    // Ledger 100 has 80 events, Ledger 101 has 80 events (Total 160, Page Limit 30)
    const ledger100Events = Array.from({ length: 80 }, (_, i) => ({
      id: `0000000000100-${String(i).padStart(6, "0")}`,
      ledger: 100,
      txHash: `l100_tx_${i}`,
      pagingToken: `cursor_100_${i + 1}`,
    }));
    const ledger101Events = Array.from({ length: 80 }, (_, i) => ({
      id: `0000000000101-${String(i).padStart(6, "0")}`,
      ledger: 101,
      txHash: `l101_tx_${i}`,
      pagingToken: `cursor_101_${i + 1}`,
    }));

    const combined = [...ledger100Events, ...ledger101Events];

    const server: any = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 500 }),
      getEvents: jest.fn().mockImplementation(async (req: any) => {
        let startIdx = 0;
        if (req.cursor) {
          const idx = combined.findIndex((e) => e.pagingToken === req.cursor);
          if (idx !== -1) startIdx = idx + 1;
        }
        const slice = combined.slice(startIdx, startIdx + 30);
        const last = slice[slice.length - 1];
        return {
          events: slice,
          latestLedger: 500,
          cursor: last ? last.pagingToken : null,
        };
      }),
    };

    const cursor = new EventCursor(server);
    const results = await cursor.scan({ fromLedger: 100, limit: 30 });

    expect(results).toHaveLength(160);
    expect(results.filter((e: any) => e.ledger === 100)).toHaveLength(80);
    expect(results.filter((e: any) => e.ledger === 101)).toHaveLength(80);
  });
});
