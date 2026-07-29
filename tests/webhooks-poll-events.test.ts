/**
 * Tests for WebhookModule.pollEvents() — the event-triggered delivery
 * capability that uses the shared EventCursor utility.
 */

import { WebhookModule } from '../src/modules/webhooks';
import { WebhookError } from '../src/errors';
import type { SorobanRpc } from '@stellar/stellar-sdk';

const VALID_URL = 'https://hooks.example.com/coral';
const OTHER_URL = 'https://other.example.com/hook';

// Minimal mock of SorobanRpc.Server for event polling tests
function makeServer(
  events: Partial<SorobanRpc.Api.EventResponse>[],
): SorobanRpc.Server {
  return {
    getEvents: jest.fn().mockResolvedValue({
      events,
      latestLedger: 2000,
    }),
  } as unknown as SorobanRpc.Server;
}

function makeEvent(opts: {
  topicString?: string;
  ledger?: number;
  contractId?: string;
  id?: string;
}): Partial<SorobanRpc.Api.EventResponse> {
  return {
    topic: [opts.topicString ?? 'swap'] as any,
    contractId: opts.contractId ?? 'PAIR_ABC' as any,
    ledger: opts.ledger ?? 1500,
    id: opts.id ?? 'txhash_001',
  };
}

function makeFetchMock(status: number = 200) {
  const original = globalThis.fetch;
  const mock = jest.fn().mockResolvedValue(new Response('{}', { status }));
  globalThis.fetch = mock as any;
  return { mock, restore: () => { globalThis.fetch = original; } };
}

describe('WebhookModule.pollEvents()', () => {
  describe('server dependency', () => {
    it('throws WebhookError when no server was provided to constructor', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.pollEvents({ startLedger: 1000 }),
      ).rejects.toThrow(WebhookError);
    });

    it('throws a descriptive error message about the missing server', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.pollEvents({ startLedger: 1000 }),
      ).rejects.toThrow(/server/i);
    });
  });

  describe('no subscriptions', () => {
    it('returns empty array when no webhooks are registered', async () => {
      const server = makeServer([makeEvent({ topicString: 'swap', ledger: 1500 })]);
      const webhooks = new WebhookModule({ server });
      const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });
      expect(results).toEqual([]);
    });

    it('does NOT call server.getEvents when no webhooks are registered', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.pollEvents({ startLedger: 1000 });
      expect(server.getEvents).not.toHaveBeenCalled();
    });
  });

  describe('EventCursor integration', () => {
    it('calls server.getEvents with the correct startLedger', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      await webhooks.pollEvents({ startLedger: 1234, endLedger: 5678 });

      expect(server.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 1234 }),
      );
    });

    it('passes contractIds to the getEvents filter', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      await webhooks.pollEvents({
        startLedger: 1000,
        contractIds: ['PAIR_X', 'PAIR_Y'],
      });

      const request = (server.getEvents as jest.Mock).mock.calls[0][0];
      expect(request.filters[0].contractIds).toEqual(['PAIR_X', 'PAIR_Y']);
    });

    it('includes all subscribed event types as topics in the request', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap', 'add_liquidity']);
      await webhooks.pollEvents({ startLedger: 1000 });

      const request = (server.getEvents as jest.Mock).mock.calls[0][0];
      const topics = request.filters[0].topics[0] as string[];
      expect(topics).toContain('swap');
      expect(topics).toContain('add_liquidity');
    });

    it('unions event types across multiple registered webhooks into topics', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      await webhooks.registerWebhook(OTHER_URL, ['add_liquidity', 'remove_liquidity']);
      await webhooks.pollEvents({ startLedger: 1000 });

      const request = (server.getEvents as jest.Mock).mock.calls[0][0];
      const topics = request.filters[0].topics[0] as string[];
      expect(topics).toContain('swap');
      expect(topics).toContain('add_liquidity');
      expect(topics).toContain('remove_liquidity');
    });

    it('uses the configured limit via options.limit', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      await webhooks.pollEvents({ startLedger: 1000, limit: 42 });

      const request = (server.getEvents as jest.Mock).mock.calls[0][0];
      expect(request.limit).toBe(42);
    });

    it('defaults limit to 200 when not provided', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      await webhooks.pollEvents({ startLedger: 1000 });

      const request = (server.getEvents as jest.Mock).mock.calls[0][0];
      expect(request.limit).toBe(200);
    });
  });

  describe('ledger range enforcement (EventCursor.isWithinRange)', () => {
    it('skips events before startLedger', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 500 }),
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);
        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });
        expect(results).toHaveLength(0);
        expect(fetch.mock).not.toHaveBeenCalled();
      } finally {
        fetch.restore();
      }
    });

    it('skips events after endLedger', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 2500 }),
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);
        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });
        expect(results).toHaveLength(0);
        expect(fetch.mock).not.toHaveBeenCalled();
      } finally {
        fetch.restore();
      }
    });

    it('processes events within [startLedger, endLedger] inclusive', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1000 }), // boundary start
          makeEvent({ topicString: 'swap', ledger: 1500 }), // middle
          makeEvent({ topicString: 'swap', ledger: 2000 }), // boundary end
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);
        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });
        expect(results).toHaveLength(3);
      } finally {
        fetch.restore();
      }
    });

    it('processes all events when endLedger is not specified', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1000 }),
          makeEvent({ topicString: 'swap', ledger: 50000 }),
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);
        const results = await webhooks.pollEvents({ startLedger: 1000 });
        expect(results).toHaveLength(2);
      } finally {
        fetch.restore();
      }
    });
  });

  describe('webhook routing', () => {
    it('triggers only webhooks subscribed to the matching event type', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1500 }),
        ]);
        const webhooks = new WebhookModule({ server });
        const swapId = await webhooks.registerWebhook(VALID_URL, ['swap']);
        const liquidityId = await webhooks.registerWebhook(OTHER_URL, ['add_liquidity']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(results).toHaveLength(1);
        expect(results[0].webhookId).toBe(swapId);
        expect(results.some((r) => r.webhookId === liquidityId)).toBe(false);
      } finally {
        fetch.restore();
      }
    });

    it('triggers multiple webhooks when they both subscribe to the same event', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1500 }),
        ]);
        const webhooks = new WebhookModule({ server });
        const id1 = await webhooks.registerWebhook(VALID_URL, ['swap']);
        const id2 = await webhooks.registerWebhook(OTHER_URL, ['swap']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(results).toHaveLength(2);
        const delivered = results.map((r) => r.webhookId);
        expect(delivered).toContain(id1);
        expect(delivered).toContain(id2);
      } finally {
        fetch.restore();
      }
    });

    it('triggers multiple events to a webhook subscribed to several event types', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1400 }),
          makeEvent({ topicString: 'add_liquidity', ledger: 1500 }),
        ]);
        const webhooks = new WebhookModule({ server });
        const id = await webhooks.registerWebhook(VALID_URL, ['swap', 'add_liquidity']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.webhookId === id)).toBe(true);
      } finally {
        fetch.restore();
      }
    });

    it('skips delivery for events not in any webhook subscription', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'fee_update', ledger: 1500 }),
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });
        expect(results).toHaveLength(0);
        expect(fetch.mock).not.toHaveBeenCalled();
      } finally {
        fetch.restore();
      }
    });
  });

  describe('delivery result passthrough', () => {
    it('records delivered=true on a 200 response', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([makeEvent({ topicString: 'swap', ledger: 1500 })]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(results).toHaveLength(1);
        expect(results[0].result.delivered).toBe(true);
        expect(results[0].result.statusCode).toBe(200);
      } finally {
        fetch.restore();
      }
    });

    it('records delivered=false on a 4xx response', async () => {
      const fetch = makeFetchMock(401);
      try {
        const server = makeServer([makeEvent({ topicString: 'swap', ledger: 1500 })]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(results).toHaveLength(1);
        expect(results[0].result.delivered).toBe(false);
        expect(results[0].result.statusCode).toBe(401);
      } finally {
        fetch.restore();
      }
    });

    it('includes event metadata in each result', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1500, contractId: 'PAIR_XYZ' }),
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);

        const results = await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(results).toHaveLength(1);
        expect(results[0].event.ledger).toBe(1500);
        expect(results[0].event.contractId).toBe('PAIR_XYZ');
      } finally {
        fetch.restore();
      }
    });

    it('includes event type and payload in the delivered webhook body', async () => {
      const fetch = makeFetchMock(200);
      try {
        const server = makeServer([
          makeEvent({ topicString: 'swap', ledger: 1500, contractId: 'PAIR_XYZ' }),
        ]);
        const webhooks = new WebhookModule({ server });
        await webhooks.registerWebhook(VALID_URL, ['swap']);

        await webhooks.pollEvents({ startLedger: 1000, endLedger: 2000 });

        expect(fetch.mock).toHaveBeenCalled();
        const body = JSON.parse(
          (fetch.mock.mock.calls[0][1] as RequestInit).body as string,
        );
        expect(body.data.event).toBe('swap');
        expect(body.data.ledger).toBe(1500);
        expect(body.data.contractId).toBe('PAIR_XYZ');
      } finally {
        fetch.restore();
      }
    });
  });

  describe('return value', () => {
    it('returns empty array when server returns empty events', async () => {
      const server = makeServer([]);
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      const results = await webhooks.pollEvents({ startLedger: 1000 });
      expect(results).toEqual([]);
    });

    it('returns empty array when server returns null/undefined events', async () => {
      const server = {
        getEvents: jest.fn().mockResolvedValue(null),
      } as unknown as SorobanRpc.Server;
      const webhooks = new WebhookModule({ server });
      await webhooks.registerWebhook(VALID_URL, ['swap']);
      const results = await webhooks.pollEvents({ startLedger: 1000 });
      expect(results).toEqual([]);
    });
  });
});
