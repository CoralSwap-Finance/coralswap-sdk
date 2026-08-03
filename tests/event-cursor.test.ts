import { EventCursor } from '../src/utils/event-cursor';
import type { SorobanRpc } from '@stellar/stellar-sdk';

describe('EventCursor', () => {
  describe('constructor validation', () => {
    it('throws when topics array is empty', () => {
      expect(() => new EventCursor({ topics: [] })).toThrow(TypeError);
      expect(() => new EventCursor({ topics: [] })).toThrow('topics must be a non-empty array');
    });

    it('throws when topics contains empty strings', () => {
      expect(() => new EventCursor({ topics: ['swap', ''] })).toThrow(TypeError);
      expect(() => new EventCursor({ topics: ['swap', ''] })).toThrow('non-empty string');
    });

    it('throws when topics contains non-strings', () => {
      expect(() => new EventCursor({ topics: ['swap', null as any] })).toThrow(TypeError);
    });

    it('throws when endLedger < startLedger', () => {
      expect(() =>
        new EventCursor({ topics: ['swap'], startLedger: 1000, endLedger: 500 }),
      ).toThrow(TypeError);
      expect(() =>
        new EventCursor({ topics: ['swap'], startLedger: 1000, endLedger: 500 }),
      ).toThrow('endLedger (500) must be >= startLedger (1000)');
    });

    it('accepts valid configuration with defaults', () => {
      const cursor = new EventCursor({ topics: ['swap'] });
      expect(cursor.start).toBe(0);
      expect(cursor.end).toBeUndefined();
      expect(cursor.limit).toBe(200);
    });

    it('accepts valid configuration with explicit options', () => {
      const cursor = new EventCursor({
        topics: ['swap', 'add_liquidity'],
        contractIds: ['CDLZFC...'],
        startLedger: 1000,
        endLedger: 2000,
        pageLimit: 100,
      });
      expect(cursor.start).toBe(1000);
      expect(cursor.end).toBe(2000);
      expect(cursor.limit).toBe(100);
    });
  });

  describe('buildRequest()', () => {
    it('builds a GetEventsRequest with correct structure', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        contractIds: ['PAIR_A', 'PAIR_B'],
        startLedger: 1000,
        pageLimit: 50,
      });

      const request = cursor.buildRequest();

      expect(request).toMatchObject<SorobanRpc.Server.GetEventsRequest>({
        startLedger: 1000,
        filters: [
          {
            type: 'contract',
            contractIds: ['PAIR_A', 'PAIR_B'],
            topics: [['swap']],
          },
        ],
        limit: 50,
      });
    });

    it('builds request with multiple topics', () => {
      const cursor = new EventCursor({
        topics: ['swap', 'add_liquidity', 'remove_liquidity'],
        startLedger: 500,
      });

      const request = cursor.buildRequest();

      expect(request.filters[0].topics).toEqual([['swap', 'add_liquidity', 'remove_liquidity']]);
    });

    it('allows startLedger override', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
      });

      const request = cursor.buildRequest(1500);
      expect(request.startLedger).toBe(1500);
    });

    it('uses empty contractIds when not provided', () => {
      const cursor = new EventCursor({ topics: ['swap'] });
      const request = cursor.buildRequest();
      expect(request.filters[0].contractIds).toEqual([]);
    });
  });

  describe('isWithinRange()', () => {
    it('returns true for ledger >= startLedger when no endLedger', () => {
      const cursor = new EventCursor({ topics: ['swap'], startLedger: 1000 });
      expect(cursor.isWithinRange(1000)).toBe(true);
      expect(cursor.isWithinRange(1001)).toBe(true);
      expect(cursor.isWithinRange(10000)).toBe(true);
    });

    it('returns false for ledger < startLedger', () => {
      const cursor = new EventCursor({ topics: ['swap'], startLedger: 1000 });
      expect(cursor.isWithinRange(999)).toBe(false);
      expect(cursor.isWithinRange(0)).toBe(false);
    });

    it('returns true for ledger within [startLedger, endLedger]', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
        endLedger: 2000,
      });
      expect(cursor.isWithinRange(1000)).toBe(true);
      expect(cursor.isWithinRange(1500)).toBe(true);
      expect(cursor.isWithinRange(2000)).toBe(true);
    });

    it('returns false for ledger > endLedger', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
        endLedger: 2000,
      });
      expect(cursor.isWithinRange(2001)).toBe(false);
      expect(cursor.isWithinRange(10000)).toBe(false);
    });

    it('returns false for ledger < startLedger when endLedger is set', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
        endLedger: 2000,
      });
      expect(cursor.isWithinRange(999)).toBe(false);
    });
  });

  describe('isPastEnd()', () => {
    it('returns false when no endLedger is configured', () => {
      const cursor = new EventCursor({ topics: ['swap'], startLedger: 1000 });
      expect(cursor.isPastEnd(1000)).toBe(false);
      expect(cursor.isPastEnd(10000)).toBe(false);
    });

    it('returns false for ledger <= endLedger', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
        endLedger: 2000,
      });
      expect(cursor.isPastEnd(1000)).toBe(false);
      expect(cursor.isPastEnd(1999)).toBe(false);
      expect(cursor.isPastEnd(2000)).toBe(false);
    });

    it('returns true for ledger > endLedger', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
        endLedger: 2000,
      });
      expect(cursor.isPastEnd(2001)).toBe(true);
      expect(cursor.isPastEnd(10000)).toBe(true);
    });
  });

  describe('accessors', () => {
    it('exposes start, end, and limit via getters', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        startLedger: 1000,
        endLedger: 2000,
        pageLimit: 150,
      });

      expect(cursor.start).toBe(1000);
      expect(cursor.end).toBe(2000);
      expect(cursor.limit).toBe(150);
    });

    it('returns undefined for end when not configured', () => {
      const cursor = new EventCursor({ topics: ['swap'], startLedger: 1000 });
      expect(cursor.end).toBeUndefined();
    });
  });

  describe('usage example', () => {
    it('demonstrates typical event-scanning loop pattern', () => {
      const cursor = new EventCursor({
        topics: ['swap'],
        contractIds: ['PAIR_ADDRESS'],
        startLedger: 1000,
        endLedger: 2000,
        pageLimit: 100,
      });

      // Build the request
      const request = cursor.buildRequest();
      expect(request.startLedger).toBe(1000);
      expect(request.limit).toBe(100);

      // Simulate filtering events returned by the RPC
      const mockEvents = [
        { ledger: 999 },   // before range
        { ledger: 1000 },  // in range
        { ledger: 1500 },  // in range
        { ledger: 2000 },  // in range
        { ledger: 2001 },  // past end
      ];

      const filtered = mockEvents.filter((ev) => cursor.isWithinRange(ev.ledger));
      expect(filtered).toHaveLength(3);
      expect(filtered.map((ev) => ev.ledger)).toEqual([1000, 1500, 2000]);

      // Demonstrate early-exit optimization
      const inRange: number[] = [];
      for (const ev of mockEvents) {
        if (cursor.isPastEnd(ev.ledger)) {
          break; // stop scanning once we're past the end
        }
        if (cursor.isWithinRange(ev.ledger)) {
          inRange.push(ev.ledger);
        }
      }
      expect(inRange).toEqual([1000, 1500, 2000]);
    });
  });
});
