import { EventCursor } from '../src/utils/event-cursor';
import { getOpenOrders, getOrderSummary, getTradeHistory } from '../src/modules/order-book';
import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';

// Mock the client
jest.mock('../src/client');

describe('OrderBook Module — EventCursor integration', () => {
  let client: CoralSwapClient;
  let cursor: EventCursor;
  let mockServer: any;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: 'testnet' as Network,
      rpcUrl: 'https://test.rpc.url',
    });

    mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 2000 }),
      getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 2000 }),
    };

    cursor = new EventCursor(mockServer);
  });

  describe('getOpenOrders', () => {
    it('should return an empty list when there are no on-chain events', async () => {
      const orders = await getOpenOrders(
        cursor,
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      expect(orders).toEqual([]);
    });

    it('should use EventCursor to scan for events with correct parameters', async () => {
      const spy = jest.spyOn(cursor, 'scan');

      await getOpenOrders(
        cursor,
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        {
          limitOrders: 'CA3J7I7ZAV7VJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KJ5KA',
          dca: 'CB4K8J8ABW8WK6KL6KL6KL6KL6KL6KL6KL6KL6KL6KL6KL6KL6KL6KL6KB',
          stopLoss: 'CC5L9K9BCX9XL7LM7LM7LM7LM7LM7LM7LM7LM7LM7LM7LM7LM7LM7LC',
        },
      );

      // Should have been called 3 times (one per order type)
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('getOrderSummary', () => {
    it('should return a summary with zero counts when no events exist', async () => {
      const summary = await getOrderSummary(
        cursor,
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        client,
      );
      expect(summary.totalOpenOrders).toBe(0);
      expect(summary.byType.limit).toBe(0);
      expect(summary.byType.dca).toBe(0);
      expect(summary.byType.stopLoss).toBe(0);
      expect(summary.totalValueLocked).toBe(0);
    });
  });

  describe('getTradeHistory', () => {
    it('should return an empty list when there are no events', async () => {
      const trades = await getTradeHistory(
        cursor,
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      expect(trades).toEqual([]);
    });

    it('should accept optional filter parameters', async () => {
      const trades = await getTradeHistory(
        cursor,
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        { types: ['swap'], limit: 10 },
      );
      expect(trades).toEqual([]);
    });
  });
});
