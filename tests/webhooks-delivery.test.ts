import {
  WebhookDeliveryQueue,
  FakeClock,
  WebhookDeliveryOutcome,
  WebhookEndpoint,
  WebhookPayload,
  WebhookTransport,
} from '../src/webhooks';
import { ValidationError } from '../src/errors';

/**
 * Transport whose outcomes are scripted in advance, so tests can drive the
 * delivery state machine through an exact sequence of transient failures,
 * client errors, and successes without any real network I/O.
 */
class ScriptedTransport implements WebhookTransport {
  readonly calls: Array<{ endpoint: WebhookEndpoint; payload: WebhookPayload }> = [];
  private cursor = 0;

  constructor(private readonly script: WebhookDeliveryOutcome[]) {}

  async send(endpoint: WebhookEndpoint, payload: WebhookPayload): Promise<WebhookDeliveryOutcome> {
    this.calls.push({ endpoint, payload });
    const outcome = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    return outcome;
  }
}

describe('WebhookDeliveryQueue', () => {
  describe('enqueue', () => {
    it('creates a pending delivery due immediately, carrying the given payload', () => {
      const clock = new FakeClock(1_000);
      const queue = new WebhookDeliveryQueue({ clock });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const payload = { event: 'swap', amountIn: '1000000' };

      const delivery = queue.enqueue(endpoint.id, payload);

      expect(delivery.status).toBe('pending');
      expect(delivery.attempts).toBe(0);
      expect(delivery.endpointId).toBe(endpoint.id);
      expect(delivery.payload).toBe(payload);
      expect(delivery.nextAttemptAt).toBe(1_000);
      expect(delivery.createdAt).toBe(1_000);
      expect(queue.dueDeliveries().map((d) => d.id)).toEqual([delivery.id]);
    });

    it('rejects enqueueing against an unknown endpoint', () => {
      const queue = new WebhookDeliveryQueue({ clock: new FakeClock() });
      expect(() => queue.enqueue('whe_missing', {})).toThrow(ValidationError);
    });

    it('rejects enqueueing against a disabled endpoint', async () => {
      const clock = new FakeClock();
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { maxConsecutiveClientErrors: 1 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      queue.enqueue(endpoint.id, { n: 1 });

      const transport = new ScriptedTransport([{ statusCode: 404 }]);
      await queue.processDue(transport);
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(true);

      expect(() => queue.enqueue(endpoint.id, { n: 2 })).toThrow(ValidationError);
    });
  });

  describe('transient failure -> redelivery', () => {
    it('reschedules the same delivery with the original payload after a 5xx response', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 1_000, backoffMultiplier: 2, maxDelayMs: 60_000 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const payload = { event: 'flash_loan', amount: '500', fee: '1' };
      const delivery = queue.enqueue(endpoint.id, payload);

      const transport = new ScriptedTransport([{ statusCode: 503 }, { statusCode: 200 }]);

      // First attempt: transient failure.
      await queue.processDue(transport);
      expect(transport.calls).toHaveLength(1);
      expect(delivery.status).toBe('pending');
      expect(delivery.attempts).toBe(1);
      expect(delivery.lastStatusCode).toBe(503);
      expect(delivery.nextAttemptAt).toBe(1_000);
      expect(delivery.payload).toBe(payload);
      expect(delivery.payload).toEqual({ event: 'flash_loan', amount: '500', fee: '1' });
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);

      // Not due yet: processing again before the backoff elapses is a no-op.
      await queue.processDue(transport);
      expect(transport.calls).toHaveLength(1);

      // Advance past the scheduled retry time and attempt again.
      clock.advance(1_000);
      await queue.processDue(transport);

      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[1].payload).toBe(payload);
      expect(transport.calls[1].payload).toEqual(transport.calls[0].payload);
      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts).toBe(2);
      expect(delivery.lastStatusCode).toBe(200);
    });

    it('backs off exponentially across repeated transient failures', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 1_000, backoffMultiplier: 2, maxDelayMs: 60_000, maxAttempts: 10 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const delivery = queue.enqueue(endpoint.id, { n: 1 });
      const transport = new ScriptedTransport([
        { error: new Error('ECONNRESET') },
        { error: new Error('ECONNRESET') },
        { error: new Error('ECONNRESET') },
      ]);

      const backoffDelays = [1_000, 2_000, 4_000];
      let expectedNextAttemptAt = 0;
      for (const backoffDelay of backoffDelays) {
        const attemptedAt = clock.now();
        await queue.processDue(transport);
        expectedNextAttemptAt = attemptedAt + backoffDelay;
        expect(delivery.nextAttemptAt).toBe(expectedNextAttemptAt);
        clock.advance(backoffDelay);
      }

      expect(transport.calls).toHaveLength(3);
      expect(delivery.status).toBe('pending');
      expect(delivery.lastError).toBe('ECONNRESET');
    });

    it('disables the endpoint once transient failures exhaust maxAttempts', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxAttempts: 3 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const delivery = queue.enqueue(endpoint.id, { n: 1 });
      const transport = new ScriptedTransport([{ statusCode: 500 }]);

      for (let i = 0; i < 3; i++) {
        await queue.processDue(transport);
        clock.advance(1);
      }

      expect(transport.calls).toHaveLength(3);
      expect(delivery.status).toBe('disabled');
      expect(delivery.disabledReason).toBe('max_attempts_exceeded');
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(true);

      // A further tick makes no additional attempt: the endpoint is disabled.
      await queue.processDue(transport);
      expect(transport.calls).toHaveLength(3);
    });
  });

  describe('persistent 4xx -> disabled', () => {
    it('disables the endpoint after a run of consecutive client errors', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: {
          baseDelayMs: 100,
          backoffMultiplier: 1,
          maxDelayMs: 100,
          maxConsecutiveClientErrors: 3,
        },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const delivery = queue.enqueue(endpoint.id, { event: 'order', id: 'abc' });
      const transport = new ScriptedTransport([{ statusCode: 404 }]);

      // First two 4xx responses: retried, endpoint still active.
      await queue.processDue(transport);
      expect(delivery.status).toBe('pending');
      expect(queue.getEndpoint(endpoint.id)?.consecutiveClientErrors).toBe(1);
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);
      clock.advance(100);

      await queue.processDue(transport);
      expect(delivery.status).toBe('pending');
      expect(queue.getEndpoint(endpoint.id)?.consecutiveClientErrors).toBe(2);
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);
      clock.advance(100);

      // Third consecutive 4xx: now "persistent" -> disabled.
      await queue.processDue(transport);
      expect(transport.calls).toHaveLength(3);
      expect(delivery.status).toBe('disabled');
      expect(delivery.disabledReason).toBe('persistent_client_error');
      const disabledEndpoint = queue.getEndpoint(endpoint.id)!;
      expect(disabledEndpoint.disabled).toBe(true);
      expect(disabledEndpoint.disabledReason).toBe('persistent_client_error');

      // Disabled endpoints stop receiving attempts entirely.
      clock.advance(1_000_000);
      await queue.processDue(transport);
      expect(transport.calls).toHaveLength(3);
    });

    it('cascades disablement to every other pending delivery on the same endpoint', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 0, backoffMultiplier: 1, maxConsecutiveClientErrors: 1 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const first = queue.enqueue(endpoint.id, { n: 1 });
      const second = queue.enqueue(endpoint.id, { n: 2 });
      const transport = new ScriptedTransport([{ statusCode: 401 }]);

      await queue.processDue(transport);

      expect(first.status).toBe('disabled');
      expect(second.status).toBe('disabled');
      expect(second.disabledReason).toBe('persistent_client_error');
    });

    it('a transient failure resets the consecutive client-error streak', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 0, backoffMultiplier: 1, maxConsecutiveClientErrors: 2 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      queue.enqueue(endpoint.id, { n: 1 });
      const transport = new ScriptedTransport([
        { statusCode: 400 },
        { statusCode: 503 },
        { statusCode: 400 },
      ]);

      await queue.processDue(transport); // 400: streak = 1
      await queue.processDue(transport); // 503: streak resets to 0
      await queue.processDue(transport); // 400: streak = 1 again, not disabled

      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);
      expect(queue.getEndpoint(endpoint.id)?.consecutiveClientErrors).toBe(1);
    });
  });

  describe('success -> cleared', () => {
    it('marks the delivery delivered and drops it from the due queue', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({ clock });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const payload = { event: 'sync', reserve0: '100', reserve1: '200' };
      const delivery = queue.enqueue(endpoint.id, payload);
      const transport = new ScriptedTransport([{ statusCode: 204 }]);

      await queue.processDue(transport);

      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts).toBe(1);
      expect(delivery.lastStatusCode).toBe(204);
      expect(delivery.lastError).toBeUndefined();
      expect(delivery.payload).toEqual(payload);
      expect(queue.dueDeliveries()).toHaveLength(0);
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);
    });

    it('resets the consecutive client-error count on success', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 0, backoffMultiplier: 1, maxConsecutiveClientErrors: 5 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      queue.enqueue(endpoint.id, { n: 1 });
      const transport = new ScriptedTransport([{ statusCode: 400 }, { statusCode: 200 }]);

      // First attempt: 4xx, below the disable threshold -> retried immediately (baseDelayMs: 0).
      await queue.processDue(transport);
      expect(queue.getEndpoint(endpoint.id)?.consecutiveClientErrors).toBe(1);

      // Second attempt of the same delivery: success resets the streak.
      await queue.processDue(transport);
      expect(transport.calls).toHaveLength(2);
      expect(queue.getEndpoint(endpoint.id)?.consecutiveClientErrors).toBe(0);
    });
  });

  describe('full lifecycle', () => {
    it('walks enqueue -> transient retry -> persistent 4xx -> disabled end to end', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: {
          baseDelayMs: 1_000,
          backoffMultiplier: 2,
          maxDelayMs: 60_000,
          maxConsecutiveClientErrors: 2,
        },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const payload = { event: 'stop_loss_triggered', orderId: 'ord_1' };
      const delivery = queue.enqueue(endpoint.id, payload);

      const transport = new ScriptedTransport([
        { error: new Error('ETIMEDOUT') }, // transient -> retry
        { statusCode: 422 }, // client error #1 -> retry
        { statusCode: 422 }, // client error #2 -> persistent -> disable
      ]);

      // Step 1: enqueue.
      expect(delivery.status).toBe('pending');
      expect(delivery.attempts).toBe(0);

      // Step 2: transient failure -> redelivered with the original payload.
      await queue.processDue(transport);
      expect(delivery.status).toBe('pending');
      expect(delivery.attempts).toBe(1);
      expect(delivery.payload).toBe(payload);
      clock.advance(1_000);

      // Step 3: first client error -> still retried (not yet "persistent").
      await queue.processDue(transport);
      expect(delivery.status).toBe('pending');
      expect(delivery.attempts).toBe(2);
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);
      clock.advance(2_000);

      // Step 4: second consecutive client error -> persistent -> disabled.
      await queue.processDue(transport);
      expect(delivery.status).toBe('disabled');
      expect(delivery.disabledReason).toBe('persistent_client_error');
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(true);
      expect(delivery.payload).toEqual(payload);

      expect(transport.calls.map((c) => c.payload)).toEqual([payload, payload, payload]);
    });

    it('walks enqueue -> transient retry -> success -> cleared end to end', async () => {
      const clock = new FakeClock(0);
      const queue = new WebhookDeliveryQueue({
        clock,
        retryPolicy: { baseDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 60_000 },
      });
      const endpoint = queue.registerEndpoint('https://example.com/hook');
      const payload = { event: 'dca_executed', planId: 'dca_1', amount: '250' };
      const delivery = queue.enqueue(endpoint.id, payload);

      const transport = new ScriptedTransport([
        { statusCode: 500 },
        { error: new Error('socket hang up') },
        { statusCode: 200 },
      ]);

      await queue.processDue(transport); // 500 -> retry
      expect(delivery.status).toBe('pending');
      clock.advance(500);

      await queue.processDue(transport); // network error -> retry
      expect(delivery.status).toBe('pending');
      clock.advance(1_000);

      await queue.processDue(transport); // success -> cleared
      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts).toBe(3);
      expect(queue.getEndpoint(endpoint.id)?.disabled).toBe(false);

      for (const call of transport.calls) {
        expect(call.payload).toBe(payload);
      }
    });
  });
});
