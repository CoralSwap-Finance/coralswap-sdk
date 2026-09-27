import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { getEventsPage, getAllEvents, RawEvent, EventsPage } from './get-events-page';
import { MIN_START_LEDGER } from '@/utils/event-cursor';

/**
 * Mock Soroban RPC Server for testing getEventsPage pagination and topic encoding.
 */
class MockRpcServer implements Partial<rpc.Server> {
  private callCount = 0;

  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.EventResponse[]> {
    this.callCount++;
    return this.generateMockEvents(request);
  }

  private generateMockEvents(request: rpc.Server.GetEventsRequest): rpc.Api.EventResponse[] {
    const { startLedger, filters, cursor, limit = 100 } = request;
    const contractIds = (filters?.[0] as any)?.contractIds ?? [];
    const topics = (filters?.[0] as any)?.topics ?? [];

    // Simulate pagination: return full page if no cursor, half page if cursor provided
    const isSecondPage = !!cursor;
    const pageSize = isSecondPage ? limit / 2 : limit;

    const events: any[] = [];
    for (let i = 0; i < pageSize; i++) {
      const ledgerSeq = startLedger + (isSecondPage ? Math.floor(limit / 2) : 0) + i;
      events.push({
        id: `event-${this.callCount}-${i}`,
        type: 'contract',
        ledger: ledgerSeq,
        ledgerClosedAt: new Date(Date.now() - (1000 - ledgerSeq) * 5000).toISOString(),
        contractId: contractIds[0] || `C${'A'.repeat(54)}`,
        topic: topics[0] || [],
        value: this.createMockSwapEventValue(),
        inSuccessfulContractInvocation: true,
        txHash: `tx-${this.callCount}-${i}`,
      });
    }

    return events;
  }

  private createMockSwapEventValue(): xdr.ScVal {
    // Create a mock ScVal map with swap event data
    return xdr.ScVal.scvMap([
      {
        key: xdr.ScVal.scvSymbol('amount_in'),
        val: xdr.ScVal.scvI128(xdr.Int64.fromString('1000000')),
      },
      {
        key: xdr.ScVal.scvSymbol('amount_out'),
        val: xdr.ScVal.scvI128(xdr.Int64.fromString('900000')),
      },
      {
        key: xdr.ScVal.scvSymbol('fee_bps'),
        val: xdr.ScVal.scvU32(30),
      },
    ]);
  }
}

describe('getEventsPage', () => {
  let mockServer: MockRpcServer;

  beforeEach(() => {
    mockServer = new MockRpcServer();
  });

  describe('EventsPage structure', () => {
    it('should return correct EventsPage shape with all required fields', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        topics: ['swap'],
        startLedger: 100,
        limit: 10,
      });

      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('pageInfo');
      expect(result).toHaveProperty('ledgerRange');

      expect(Array.isArray(result.events)).toBe(true);
      expect(result.pageInfo).toHaveProperty('startCursor');
      expect(result.pageInfo).toHaveProperty('endCursor');
      expect(result.pageInfo).toHaveProperty('hasNextPage');
      expect(result.pageInfo).toHaveProperty('hasPreviousPage');
      expect(result.ledgerRange).toHaveProperty('startLedger');
      expect(result.ledgerRange).toHaveProperty('endLedger');
    });

    it('should return RawEvent objects with all required fields', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        topics: ['swap'],
        startLedger: 100,
        limit: 5,
      });

      expect(result.events.length).toBeGreaterThan(0);
      const event = result.events[0];

      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('ledger');
      expect(event).toHaveProperty('ledgerClosedAt');
      expect(event).toHaveProperty('contractId');
      expect(event).toHaveProperty('topics');
      expect(event).toHaveProperty('value');
      expect(event).toHaveProperty('inSuccessfulContractCall');

      expect(typeof event.id).toBe('string');
      expect(typeof event.ledger).toBe('number');
      expect(Array.isArray(event.topics)).toBe(true);
      expect(typeof event.value).toBe('string');
      expect(typeof event.inSuccessfulContractCall).toBe('boolean');
    });
  });

  describe('Topic encoding', () => {
    it('should encode bare topic strings as base64 XDR ScVal symbols', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          // Verify that topics are encoded as XDR
          const topics = request.filters?.[0]?.topics;
          expect(topics).toBeDefined();
          expect(Array.isArray(topics)).toBe(true);
          expect(topics[0]).toBeDefined();
          expect(Array.isArray(topics[0])).toBe(true);

          // Topics should be base64 XDR strings, not raw strings
          for (const topic of topics[0]) {
            expect(typeof topic).toBe('string');
            // XDR base64 strings should not match raw string "swap"
            expect(topic).not.toBe('swap');
          }

          return [];
        }),
      };

      await getEventsPage(server as any, {
        topics: ['swap'],
        startLedger: 100,
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should pass empty topics array when no topics provided', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          const topics = request.filters?.[0]?.topics;
          expect(topics).toEqual([]);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        startLedger: 100,
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });
  });

  describe('Pagination detection', () => {
    it('should set hasNextPage=true when results === limit', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        topics: ['swap'],
        startLedger: 100,
        limit: 10,
      });

      // Mock returns exactly limit events, so hasNextPage should be true
      if (result.events.length === 10) {
        expect(result.pageInfo.hasNextPage).toBe(true);
      }
    });

    it('should set hasNextPage=false when results < limit', async () => {
      // Create a server that always returns fewer events
      const server = {
        getEvents: jest.fn(async () => {
          const events: any[] = [];
          for (let i = 0; i < 5; i++) {
            events.push({
              id: `event-${i}`,
              type: 'contract',
              ledger: 100 + i,
              ledgerClosedAt: new Date().toISOString(),
              contractId: 'C' + 'A'.repeat(54),
              topic: [],
              value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
              inSuccessfulContractInvocation: true,
              txHash: `tx-${i}`,
            });
          }
          return events;
        }),
      };

      const result = await getEventsPage(server as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        startLedger: 100,
        limit: 10,
      });

      expect(result.events.length).toBeLessThan(10);
      expect(result.pageInfo.hasNextPage).toBe(false);
    });

    it('should set hasPreviousPage=true when cursor provided', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        startLedger: 100,
        cursor: 'previous-event-id',
        limit: 10,
      });

      expect(result.pageInfo.hasPreviousPage).toBe(true);
    });

    it('should set hasPreviousPage=false when no cursor provided', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        startLedger: 100,
        limit: 10,
      });

      expect(result.pageInfo.hasPreviousPage).toBe(false);
    });
  });

  describe('Cursor handling', () => {
    it('should pass cursor to RPC request when provided', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          expect(request.cursor).toBe('test-cursor-123');
          return [];
        }),
      };

      await getEventsPage(server as any, {
        startLedger: 100,
        cursor: 'test-cursor-123',
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should return endCursor from last event for pagination', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        startLedger: 100,
        limit: 5,
      });

      if (result.events.length > 0) {
        expect(result.pageInfo.endCursor).toBe(result.events[result.events.length - 1].id);
      }
    });

    it('should return startCursor from first event', async () => {
      const result = await getEventsPage(mockServer as any, {
        contractIds: ['C' + 'A'.repeat(54)],
        startLedger: 100,
        limit: 5,
      });

      if (result.events.length > 0) {
        expect(result.pageInfo.startCursor).toBe(result.events[0].id);
      }
    });
  });

  describe('Empty events handling', () => {
    it('should handle empty events array gracefully', async () => {
      const server = {
        getEvents: jest.fn(async () => []),
      };

      const result = await getEventsPage(server as any, {
        startLedger: 100,
        limit: 10,
      });

      expect(result.events).toEqual([]);
      expect(result.pageInfo.startCursor).toBeNull();
      expect(result.pageInfo.endCursor).toBeNull();
      expect(result.pageInfo.hasNextPage).toBe(false);
      expect(result.ledgerRange.endLedger).toBe(100);
    });
  });

  describe('Ledger anchoring', () => {
    it('should use MIN_START_LEDGER when startLedger not provided', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          expect(request.startLedger).toBe(MIN_START_LEDGER);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should pass startLedger correctly to RPC request', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          expect(request.startLedger).toBe(500);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        startLedger: 500,
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should respect endLedger for ledger range metadata', async () => {
      const result = await getEventsPage(mockServer as any, {
        startLedger: 100,
        endLedger: 200,
        limit: 10,
      });

      expect(result.ledgerRange.startLedger).toBe(100);
    });
  });

  describe('Filter passing', () => {
    it('should pass contractIds to RPC filters', async () => {
      const testContractId = 'C' + 'B'.repeat(54);
      const server = {
        getEvents: jest.fn(async (request: any) => {
          const contractIds = request.filters?.[0]?.contractIds;
          expect(contractIds).toEqual([testContractId]);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        contractIds: [testContractId],
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should pass empty contractIds when not provided', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          const contractIds = request.filters?.[0]?.contractIds;
          expect(contractIds).toEqual([]);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        limit: 10,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should pass limit to RPC request', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          expect(request.limit).toBe(500);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        startLedger: 100,
        limit: 500,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });

    it('should default limit to 100 when not provided', async () => {
      const server = {
        getEvents: jest.fn(async (request: any) => {
          expect(request.limit).toBe(100);
          return [];
        }),
      };

      await getEventsPage(server as any, {
        startLedger: 100,
      });

      expect(server.getEvents).toHaveBeenCalled();
    });
  });
});

describe('getAllEvents', () => {
  let mockServer: MockRpcServer;

  beforeEach(() => {
    mockServer = new MockRpcServer();
  });

  it('should fetch all pages until no more data', async () => {
    const server = {
      callCount: 0,
      getEvents: jest.fn(async (request: any) => {
        this.callCount++;
        const events: any[] = [];

        // Return 5 events per call (simulate pagination)
        for (let i = 0; i < 5; i++) {
          events.push({
            id: `event-${this.callCount}-${i}`,
            type: 'contract',
            ledger: 100 + i,
            ledgerClosedAt: new Date().toISOString(),
            contractId: 'C' + 'A'.repeat(54),
            topic: [],
            value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
            inSuccessfulContractInvocation: true,
            txHash: `tx-${this.callCount}-${i}`,
          });
        }

        // Return fewer events on second call to trigger stop
        if (this.callCount === 2) {
          return events.slice(0, 3);
        }

        return events;
      }),
    };

    const result = await getAllEvents(server as any, {
      startLedger: 100,
      limit: 5,
    });

    // Should have collected events from multiple pages
    expect(result.length).toBeGreaterThan(5);
    expect(Array.isArray(result)).toBe(true);

    // All items should be RawEvent objects
    for (const event of result) {
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('ledger');
      expect(event).toHaveProperty('contractId');
    }
  });

  it('should stop pagination when hasNextPage is false', async () => {
    let callCount = 0;
    const server = {
      getEvents: jest.fn(async (request: any) => {
        callCount++;

        // Stop returning data on second call
        if (callCount > 1) {
          return [];
        }

        const events: any[] = [];
        for (let i = 0; i < 10; i++) {
          events.push({
            id: `event-${i}`,
            type: 'contract',
            ledger: 100 + i,
            ledgerClosedAt: new Date().toISOString(),
            contractId: 'C' + 'A'.repeat(54),
            topic: [],
            value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
            inSuccessfulContractInvocation: true,
            txHash: `tx-${i}`,
          });
        }
        return events;
      }),
    };

    const result = await getAllEvents(server as any, {
      startLedger: 100,
      limit: 10,
    });

    // Should have exactly 10 events from first page
    expect(result.length).toBe(10);
    // Should have called getEvents twice (first returns data, second returns empty)
    expect(server.getEvents).toHaveBeenCalledTimes(2);
  });

  it('should return combined events from all pages', async () => {
    const server = {
      getEvents: jest.fn(async (request: any) => {
        const cursor = request.cursor;
        const events: any[] = [];

        // First page
        if (!cursor) {
          for (let i = 0; i < 5; i++) {
            events.push({
              id: `event-page1-${i}`,
              type: 'contract',
              ledger: 100 + i,
              ledgerClosedAt: new Date().toISOString(),
              contractId: 'C' + 'A'.repeat(54),
              topic: [],
              value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
              inSuccessfulContractInvocation: true,
              txHash: `tx-page1-${i}`,
            });
          }
        } else {
          // Second page (fewer events to stop pagination)
          for (let i = 0; i < 3; i++) {
            events.push({
              id: `event-page2-${i}`,
              type: 'contract',
              ledger: 105 + i,
              ledgerClosedAt: new Date().toISOString(),
              contractId: 'C' + 'A'.repeat(54),
              topic: [],
              value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
              inSuccessfulContractInvocation: true,
              txHash: `tx-page2-${i}`,
            });
          }
        }

        return events;
      }),
    };

    const result = await getAllEvents(server as any, {
      startLedger: 100,
      limit: 5,
    });

    // Should have combined events from both pages
    expect(result.length).toBe(8);
    expect(result.some(e => e.id.includes('page1'))).toBe(true);
    expect(result.some(e => e.id.includes('page2'))).toBe(true);
  });

  it('should return empty array when no events found', async () => {
    const server = {
      getEvents: jest.fn(async () => []),
    };

    const result = await getAllEvents(server as any, {
      startLedger: 100,
      limit: 10,
    });

    expect(result).toEqual([]);
  });

  it('should pass cursor from endCursor for subsequent pages', async () => {
    const capturedCursors: any[] = [];

    const server = {
      getEvents: jest.fn(async (request: any) => {
        capturedCursors.push(request.cursor);

        const cursor = request.cursor;
        if (!cursor) {
          return [
            {
              id: 'event-1',
              type: 'contract',
              ledger: 100,
              ledgerClosedAt: new Date().toISOString(),
              contractId: 'C' + 'A'.repeat(54),
              topic: [],
              value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
              inSuccessfulContractInvocation: true,
              txHash: 'tx-1',
            },
          ];
        } else if (cursor === 'event-1') {
          return [
            {
              id: 'event-2',
              type: 'contract',
              ledger: 101,
              ledgerClosedAt: new Date().toISOString(),
              contractId: 'C' + 'A'.repeat(54),
              topic: [],
              value: xdr.ScVal.scvI128(xdr.Int64.fromString('0')),
              inSuccessfulContractInvocation: true,
              txHash: 'tx-2',
            },
          ];
        }

        // Third call returns empty to stop
        return [];
      }),
    };

    const result = await getAllEvents(server as any, {
      startLedger: 100,
      limit: 1,
    });

    // Should have used cursor from first page for second page
    expect(capturedCursors[0]).toBeUndefined();
    expect(capturedCursors[1]).toBe('event-1');
    expect(result.length).toBe(2);
  });
});
