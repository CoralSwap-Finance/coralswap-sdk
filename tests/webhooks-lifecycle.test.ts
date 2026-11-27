/**
 * Behavioral state-machine suite for WebhookModule's delivery lifecycle
 * (issue #658): enqueue, transient failure -> redelivery, persistent
 * failure -> disable, success -> clear.
 *
 * The module's retry loop and its scheduling ("fake clock") are exercised
 * with Jest's fake timers against the real default backoff config
 * (WEBHOOK_DEFAULTS), rather than shrinking baseDelayMs to make the test
 * fast -- so the assertions cover the actual production timing, not a
 * stand-in for it.
 *
 * Note on the issue's "persistent 4xx -> disabled" framing: the module's
 * real, tested contract (see tests/webhooks.test.ts, "auto-disable after
 * consecutive failures") is that a 4xx response is terminal immediately
 * and does NOT count toward auto-disable -- only consecutive
 * retry-exhausted 5xx/network failures do. This suite locks in that real
 * contract rather than the issue's literal wording.
 */
import { WebhookModule } from '../src/modules/webhooks';
import { WEBHOOK_DEFAULTS, WEBHOOK_DISABLE_FAILURE_THRESHOLD } from '../src/types/webhooks';
import { WebhookDisabledError } from '../src/errors';

const VALID_URL = 'https://hooks.example.com/coral';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(
  responses: Array<(call: FetchCall) => Response | Promise<Response>>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = jest.fn(async (url: any, init?: any) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    const handler = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return handler(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function responseWithStatus(status: number): Response {
  return new Response('', { status, headers: { 'Content-Type': 'application/json' } });
}

function buildResponseQueue(count: number, status: number): Array<() => Response> {
  return Array.from({ length: count }, () => () => responseWithStatus(status));
}

// Worst-case cumulative backoff for one sendWebhook call under
// WEBHOOK_DEFAULTS: sleeps of baseDelayMs * multiplier^0, ^1, ^2 between
// the 4 attempts (initial + 3 retries) = 500 + 1000 + 2000 = 3500ms.
const FULL_EXHAUSTION_ADVANCE_MS =
  WEBHOOK_DEFAULTS.baseDelayMs * (1 + WEBHOOK_DEFAULTS.backoffMultiplier + WEBHOOK_DEFAULTS.backoffMultiplier ** 2) +
  1000; // headroom

describe('WebhookModule delivery lifecycle (schedule/retry/disable/clear)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('enqueue -> transient failure -> redelivered with the original payload -> success clears state', async () => {
    jest.useFakeTimers();
    const mock = installFetchMock([() => responseWithStatus(503), () => responseWithStatus(200)]);

    try {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']); // enqueue: register the destination
      expect(webhooks.getWebhookFailureCount(id)).toBe(0);

      const payload = { event: 'price', symbol: 'XLM/USDC', price: '0.1123', nested: { source: ['a', 'b'] } };

      const delivery = webhooks.sendWebhook(id, payload); // real default backoff, no baseDelayMs override
      await jest.advanceTimersByTimeAsync(WEBHOOK_DEFAULTS.baseDelayMs + 250);
      const result = await delivery;

      // Redelivered: two attempts, second one succeeding.
      expect(mock.calls).toHaveLength(2);
      expect(result.delivered).toBe(true);
      expect(result.retryCount).toBe(1);

      // Redelivery payload equality: the retried request carries the exact
      // same body as the original attempt, byte for byte.
      expect(mock.calls[1].init.body).toBe(mock.calls[0].init.body);
      const firstBody = JSON.parse(mock.calls[0].init.body as string);
      const secondBody = JSON.parse(mock.calls[1].init.body as string);
      expect(secondBody).toEqual(firstBody);
      expect(secondBody.data).toEqual(payload);

      // Success clears delivery state: no lingering failure count.
      expect(webhooks.getWebhookFailureCount(id)).toBe(0);
      expect(webhooks.isWebhookDisabled(id)).toBe(false);
    } finally {
      mock.restore();
    }
  });

  it('enqueue -> persistent transient failures -> disabled -> further sends rejected without a new request', async () => {
    jest.useFakeTimers();
    // WEBHOOK_DISABLE_FAILURE_THRESHOLD calls x up to 4 attempts each.
    const mock = installFetchMock(buildResponseQueue(WEBHOOK_DISABLE_FAILURE_THRESHOLD * 4, 500));

    try {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);

      for (let i = 0; i < WEBHOOK_DISABLE_FAILURE_THRESHOLD; i += 1) {
        const delivery = webhooks.sendWebhook(id, { i }); // real default backoff throughout
        await jest.advanceTimersByTimeAsync(FULL_EXHAUSTION_ADVANCE_MS);
        const result = await delivery;
        expect(result.delivered).toBe(false);
      }

      expect(webhooks.isWebhookDisabled(id)).toBe(true);
      expect(webhooks.getWebhookFailureCount(id)).toBe(WEBHOOK_DISABLE_FAILURE_THRESHOLD);

      // Every attempt within a single call still carried the same payload.
      const firstCallAttempts = mock.calls.slice(0, 4);
      for (const call of firstCallAttempts) {
        expect(call.init.body).toBe(firstCallAttempts[0].init.body);
      }

      // Disabled: no further HTTP request is made, and the caller sees why.
      const callsBeforeDisabledSend = mock.calls.length;
      await expect(webhooks.sendWebhook(id, { ping: true })).rejects.toThrow(WebhookDisabledError);
      expect(mock.calls.length).toBe(callsBeforeDisabledSend);
    } finally {
      mock.restore();
    }
  });
});
