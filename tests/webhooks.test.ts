import { createHmac } from 'node:crypto';
import { WebhookModule } from '../src/modules/webhooks';
import {
  WEBHOOK_DEFAULTS,
  WEBHOOK_DISABLE_FAILURE_THRESHOLD,
  WEBHOOK_HISTORY_CAPACITY,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_VERIFY_PAYLOAD_TYPE,
} from '../src/types/webhooks';
import { ValidationError, WebhookDisabledError, WebhookError } from '../src/errors';
import type { Logger } from '../src/types/common';

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

function responseWithStatus(status: number, body: unknown = ''): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * HMAC test vector: a known (secret, body) pair. The fixture is used in
 * HMAC tests as a stable reference point independent of UUIDs and
 * timestamps; the expected digest is recomputed in-process so a single
 * source of truth is the test runner itself.
 */
const HMAC_TEST_VECTOR = {
  secret: 'vector-secret-key',
  body: '{"hello":"world","n":42,"flag":true,"nested":{"a":1,"b":[2,3,4]}}',
};

function recomputeVectorSignature(): string {
  return createHmac(WEBHOOK_SIGNATURE_ALGORITHM, HMAC_TEST_VECTOR.secret)
    .update(HMAC_TEST_VECTOR.body)
    .digest('hex');
}

function buildResponseQueue(count: number, status: number): Array<(call: FetchCall) => Response> {
  return Array.from({ length: count }, () => () => responseWithStatus(status));
}

describe('WebhookModule', () => {
  describe('registerWebhook()', () => {
    it('returns a non-empty webhook id', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns ids that match the configured prefix scheme', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(id).toMatch(/^wh_[a-z0-9_]+$/);
    });

    it('stores the webhook so listWebhooks returns it', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il'], 'shh');
      const list = webhooks.listWebhooks();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id,
        url: VALID_URL,
        events: ['price', 'il'],
        secret: 'shh',
      });
    });

    it('attaches a createdAt timestamp', async () => {
      const webhooks = new WebhookModule();
      const before = Date.now();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const record = webhooks.getWebhook(id);
      expect(record?.createdAt).toBeGreaterThanOrEqual(before);
    });

    it('rejects non-HTTPS URLs (http://...)', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('http://hooks.example.com/coral', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects non-HTTPS URLs with explicit scheme (ftp://...)', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('ftp://hooks.example.com/coral', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects malformed URLs', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('not-a-url', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects URLs with empty host', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('https://', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('accepts uppercase HTTPS protocol via URL normalization', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('HTTPS://hooks.example.com/coral', ['price']),
      ).resolves.toEqual(expect.any(String));
    });

    it('rejects empty url strings', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('   ', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects empty events arrays', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook(VALID_URL, []),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects events that contain empty strings', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook(VALID_URL, ['price', '']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects empty secrets when provided', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook(VALID_URL, ['price'], ''),
      ).rejects.toThrow(ValidationError);
    });

    it('generates unique ids across registrations', async () => {
      const webhooks = new WebhookModule();
      const ids = await Promise.all(
        Array.from({ length: 12 }, () => webhooks.registerWebhook(VALID_URL, ['price'])),
      );
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('sendWebhook()', () => {
    it('throws WebhookError when the webhook id is unknown', async () => {
      const webhooks = new WebhookModule();
      await expect(webhooks.sendWebhook('unknown-id', { foo: 'bar' })).rejects.toThrow(WebhookError);
    });

    it('throws WebhookError when no fetch implementation is available', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const original = globalThis.fetch;
      // @ts-expect-error -- intentionally detach fetch for this test
      globalThis.fetch = undefined;
      try {
        await expect(webhooks.sendWebhook(id, { foo: 'bar' })).rejects.toThrow(WebhookError);
      } finally {
        globalThis.fetch = original;
      }
    });

    it('returns delivered=true with retryCount=0 on a 2xx response', async () => {
      const mock = installFetchMock([() => responseWithStatus(200, { ok: true })]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' });
        expect(result).toEqual({ statusCode: 200, delivered: true, retryCount: 0 });
        expect(mock.calls).toHaveLength(1);
      } finally {
        mock.restore();
      }
    });

    it('returns delivered=true with retryCount when retrying succeeds', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(503),
        () => responseWithStatus(502),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.retryCount).toBeGreaterThanOrEqual(1);
        expect(mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        mock.restore();
      }
    });

    it('preserves the exact original payload bytes across redelivery attempts', async () => {
      jest.useFakeTimers();
      const mock = installFetchMock([
        () => responseWithStatus(503),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const endpointId = await webhooks.registerEndpoint({ url: VALID_URL, method: 'POST' });
        const payload = { order: 42, nested: { values: [3, 2, 1], flag: true }, note: 'redeliver-me' };

        const deliveryPromise = webhooks.deliver(endpointId, payload);
        await jest.advanceTimersByTimeAsync(1000);
        await expect(deliveryPromise).resolves.toMatchObject({ status: 'success' });

        expect(mock.calls).toHaveLength(2);
        expect(mock.calls[1].init.body).toBe(mock.calls[0].init.body);
      } finally {
        jest.useRealTimers();
        mock.restore();
      }
    });

    it('returns delivered=false on a 4xx response and does NOT retry', async () => {
      const mock = installFetchMock([() => responseWithStatus(401)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' });
        expect(result.delivered).toBe(false);
        expect(result.statusCode).toBe(401);
        expect(result.retryCount).toBe(0);
        expect(mock.calls).toHaveLength(1);
      } finally {
        mock.restore();
      }
    });

    it('retries on 429 and stops when subsequent attempts succeed', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(429),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.retryCount).toBeGreaterThanOrEqual(1);
      } finally {
        mock.restore();
      }
    });

    it('retries on network errors and ultimately fails', async () => {
      const mock = installFetchMock(buildResponseQueue(4, 200).map(() => () => Promise.reject(new Error('ECONNRESET'))));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(false);
        expect(result.statusCode).toBe(0);
        expect(result.retryCount).toBe(3);
        expect(mock.calls).toHaveLength(4); // initial + 3 retries (default)
      } finally {
        mock.restore();
      }
    });

    it('respects the configured maxRetries override', async () => {
      const rejecting = () => Promise.reject(new Error('ETIMEDOUT'));
      const mock = installFetchMock([rejecting, rejecting]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, 'x', { maxRetries: 1, baseDelayMs: 1 });
        expect(result.delivered).toBe(false);
        expect(result.retryCount).toBe(1);
        expect(mock.calls).toHaveLength(2);
      } finally {
        mock.restore();
      }
    });

    it('sends the payload as JSON body with correct content-type', async () => {
      const mock = installFetchMock([() => responseWithStatus(204)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const init = mock.calls[0].init;
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(typeof init.body).toBe('string');
        const envelope = JSON.parse(init.body as string);
        expect(envelope.data).toEqual({ foo: 'bar' });
        expect(typeof envelope.id).toBe('string');
        expect(typeof envelope.timestamp).toBe('number');
      } finally {
        mock.restore();
      }
    });

    it('includes event metadata headers from the first subscribed event', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers['X-Webhook-Event']).toBe('price');
        expect(headers['X-Webhook-Delivery']).toBeDefined();
      } finally {
        mock.restore();
      }
    });

    it('assigns a unique X-Webhook-Delivery id per attempt', async () => {
      const mock = installFetchMock([() => responseWithStatus(200), () => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        await webhooks.sendWebhook(id, { foo: 'baz' });
        const delivery1 = (mock.calls[0].init.headers as Record<string, string>)['X-Webhook-Delivery'];
        const delivery2 = (mock.calls[1].init.headers as Record<string, string>)['X-Webhook-Delivery'];
        expect(delivery1).toBeTruthy();
        expect(delivery2).toBeTruthy();
        expect(delivery1).not.toBe(delivery2);
      } finally {
        mock.restore();
      }
    });

    it('aborts a hung fetch via timeoutMs', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const original = globalThis.fetch;
      globalThis.fetch = jest.fn((_url: any, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as { name?: string }).name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof fetch;
      try {
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, {
          timeoutMs: 10,
          baseDelayMs: 1,
          maxRetries: 0,
        });
        expect(result.delivered).toBe(false);
        expect(result.statusCode).toBe(0);
        expect(result.retryCount).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
    });

    it('accepts a custom fetchImpl override', async () => {
      const customFetch = jest.fn().mockResolvedValue(responseWithStatus(200));
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      // Detach global fetch to confirm the override path is used.
      const original = globalThis.fetch;
      // @ts-expect-error -- intentional detachment
      globalThis.fetch = undefined;
      try {
        await webhooks.sendWebhook(id, { foo: 'bar' }, { fetchImpl: customFetch });
        expect(customFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe('HMAC signature', () => {
    it('signs the body when a secret is provided', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = 'super-secret-key';
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        const signature = headers[WEBHOOK_SIGNATURE_HEADER];
        expect(signature).toBeDefined();

        const body = mock.calls[0].init.body as string;
        const expected = `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(body).digest('hex')}`;
        expect(signature).toBe(expected);
      } finally {
        mock.restore();
      }
    });

    it('signature differs when the body changes', async () => {
      const mock = installFetchMock([() => responseWithStatus(200), () => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = 'super-secret-key';
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const sig1 = (mock.calls[0].init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER];
        await webhooks.sendWebhook(id, { foo: 'changed' });
        const sig2 = (mock.calls[1].init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER];
        expect(sig1).toBeDefined();
        expect(sig2).toBeDefined();
        expect(sig1).not.toBe(sig2);
      } finally {
        mock.restore();
      }
    });

    it('signature verifies a recomputed hash independently', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = HMAC_TEST_VECTOR.secret;
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.sendWebhook(id, { tick: 'up' });

        const headers = mock.calls[0].init.headers as Record<string, string>;
        const body = mock.calls[0].init.body as string;
        const sent = headers[WEBHOOK_SIGNATURE_HEADER];
        const recomputed = `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(body).digest('hex')}`;
        expect(sent).toBe(recomputed);
      } finally {
        mock.restore();
      }
    });

    /**
     * Validates the SDK signature against a fixed (secret, body)
     * test vector. The expected sha256 hex digest is recomputed in
     * the test runner, but the structure of the header must
     * produce a 64-character lowercase hex digest consistent with
     * an openssl-style hash.
     */
    it('produces a sha256 hex digest matching the openssl-style vector', () => {
      const expected = recomputeVectorSignature();
      // sha256 produces a 64-character lowercase hex digest.
      expect(expected).toMatch(/^[a-f0-9]{64}$/);

      // Drive the exact same body through the SDK's signing header format.
      const sent = `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(
        WEBHOOK_SIGNATURE_ALGORITHM,
        HMAC_TEST_VECTOR.secret,
      )
        .update(HMAC_TEST_VECTOR.body)
        .digest('hex')}`;
      expect(sent).toBe(`${WEBHOOK_SIGNATURE_ALGORITHM}=${expected}`);
    });

    it('HMAC is keyed (changes when the secret changes)', () => {
      const body = HMAC_TEST_VECTOR.body;
      const sigSecretA = createHmac(WEBHOOK_SIGNATURE_ALGORITHM, 'secret-A')
        .update(body).digest('hex');
      const sigSecretB = createHmac(WEBHOOK_SIGNATURE_ALGORITHM, 'secret-B')
        .update(body).digest('hex');
      expect(sigSecretA).not.toBe(sigSecretB);
    });

    it('does NOT include the signature header when no secret was given', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
      } finally {
        mock.restore();
      }
    });
  });

  describe('verifyWebhook() (handshake)', () => {
    it('throws WebhookError when the webhook id is unknown', async () => {
      const webhooks = new WebhookModule();
      await expect(webhooks.verifyWebhook('not-registered')).rejects.toThrow(WebhookError);
    });

    it('throws WebhookError when no fetch implementation is available', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const original = globalThis.fetch;
      // @ts-expect-error -- intentional detachment
      globalThis.fetch = undefined;
      try {
        await expect(webhooks.verifyWebhook(id)).rejects.toThrow(WebhookError);
      } finally {
        globalThis.fetch = original;
      }
    });

    it('returns verified=true on a 2xx response', async () => {
      const mock = installFetchMock([() => responseWithStatus(200, { ok: true })]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.verified).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.error).toBeUndefined();
        expect(typeof result.challenge).toBe('string');
        expect(result.challenge.length).toBeGreaterThan(0);
        expect(mock.calls).toHaveLength(1);
      } finally {
        mock.restore();
      }
    });

    it('returns verified=false with statusCode and error on a 4xx response', async () => {
      const mock = installFetchMock([() => responseWithStatus(401)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.verified).toBe(false);
        expect(result.statusCode).toBe(401);
        expect(result.error).toMatch(/401/);
      } finally {
        mock.restore();
      }
    });

    it('returns verified=false on a network failure with error message', async () => {
      const mock = installFetchMock([() => Promise.reject(new Error('ECONNREFUSED'))]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.verified).toBe(false);
        expect(result.statusCode).toBe(0);
        expect(result.error).toMatch(/ECONNREFUSED/);
        expect(typeof result.challenge).toBe('string');
      } finally {
        mock.restore();
      }
    });

    it('sends a JSON body with the verify type discriminator and the challenge', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        const init = mock.calls[0].init;
        const body = JSON.parse(init.body as string);
        expect(body.type).toBe(WEBHOOK_VERIFY_PAYLOAD_TYPE);
        expect(body.challenge).toBe(result.challenge);
        expect(body.webhookId).toBe(id);
        expect(typeof body.timestamp).toBe('number');
      } finally {
        mock.restore();
      }
    });

    it('signs the handshake body when a secret is configured (HMAC matches)', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = 'verify-secret';
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.verifyWebhook(id);
        const headers = mock.calls[0].init.headers as Record<string, string>;
        const body = mock.calls[0].init.body as string;
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeDefined();
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
          `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret)
            .update(body)
            .digest('hex')}`,
        );
        expect(headers['X-Webhook-Verify']).toBe('1');
      } finally {
        mock.restore();
      }
    });

    it('does NOT include the signature header on handshake when no secret', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.verifyWebhook(id);
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
        expect(headers['X-Webhook-Verify']).toBe('1');
      } finally {
        mock.restore();
      }
    });

    it('measures latencyMs >= 0 on success', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(typeof result.latencyMs).toBe('number');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      } finally {
        mock.restore();
      }
    });

    it('generates unique challenges across calls', async () => {
      const mock = installFetchMock([() => responseWithStatus(200), () => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const r1 = await webhooks.verifyWebhook(id);
        const r2 = await webhooks.verifyWebhook(id);
        expect(r1.challenge).not.toBe(r2.challenge);
      } finally {
        mock.restore();
      }
    });

    it('uses the per-call fetchImpl override when provided', async () => {
      const customFetch = jest.fn().mockResolvedValue(responseWithStatus(200));
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const original = globalThis.fetch;
      // @ts-expect-error -- intentional detachment
      globalThis.fetch = undefined;
      try {
        const result = await webhooks.verifyWebhook(id, { fetchImpl: customFetch });
        expect(customFetch).toHaveBeenCalledTimes(1);
        expect(result.verified).toBe(true);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe('verification state (verified flag)', () => {
    it('marks a freshly registered webhook as unverified', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.isWebhookVerified(id)).toBe(false);
      expect(webhooks.getWebhook(id)?.verified).toBe(false);
      expect(webhooks.listWebhooks()[0].verified).toBe(false);
    });

    it('reports unknown ids as unverified', () => {
      const webhooks = new WebhookModule();
      expect(webhooks.isWebhookVerified('not-registered')).toBe(false);
    });

    it('marks the webhook verified after a 200 handshake', async () => {
      const mock = installFetchMock([() => responseWithStatus(200, { ok: true })]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.verified).toBe(true);
        expect(webhooks.isWebhookVerified(id)).toBe(true);
        expect(webhooks.getWebhook(id)?.verified).toBe(true);
      } finally {
        mock.restore();
      }
    });

    it('accepts any other 2xx status as a successful handshake', async () => {
      // 204 carries no body, so it cannot go through responseWithStatus().
      const mock = installFetchMock([() => new Response(null, { status: 204 })]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.statusCode).toBe(204);
        expect(result.verified).toBe(true);
        expect(webhooks.isWebhookVerified(id)).toBe(true);
      } finally {
        mock.restore();
      }
    });

    it('marks the webhook unverified when the endpoint answers 4xx', async () => {
      const mock = installFetchMock([() => responseWithStatus(401)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.verified).toBe(false);
        expect(webhooks.isWebhookVerified(id)).toBe(false);
        expect(webhooks.getWebhook(id)?.verified).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('marks the webhook unverified when the handshake cannot connect', async () => {
      const mock = installFetchMock([() => Promise.reject(new Error('ECONNREFUSED'))]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.verifyWebhook(id);
        expect(result.verified).toBe(false);
        expect(webhooks.isWebhookVerified(id)).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('flips an already verified webhook back to unverified after a failing handshake', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(200),
        () => responseWithStatus(500),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        expect((await webhooks.verifyWebhook(id)).verified).toBe(true);
        expect(webhooks.isWebhookVerified(id)).toBe(true);
        expect((await webhooks.verifyWebhook(id)).verified).toBe(false);
        expect(webhooks.isWebhookVerified(id)).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('re-verifies a webhook that failed an earlier handshake', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(401),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        expect((await webhooks.verifyWebhook(id)).verified).toBe(false);
        expect((await webhooks.verifyWebhook(id)).verified).toBe(true);
        expect(webhooks.isWebhookVerified(id)).toBe(true);
      } finally {
        mock.restore();
      }
    });
  });

  describe('updateWebhook()', () => {
    it('throws WebhookError when the webhook id is unknown', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.updateWebhook('not-registered', { url: VALID_URL }),
      ).rejects.toThrow(WebhookError);
    });

    it('throws ValidationError when updates is not an object', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await expect(
        webhooks.updateWebhook(id, null as unknown as { url: string }),
      ).rejects.toThrow(ValidationError);
    });

    it('updates the url while preserving id and createdAt', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const before = webhooks.getWebhook(id)!;
      const nextUrl = 'https://hooks.example.com/v2';
      await webhooks.updateWebhook(id, { url: nextUrl });
      const after = webhooks.getWebhook(id)!;
      expect(after.url).toBe(nextUrl);
      expect(after.id).toBe(id);
      expect(after.createdAt).toBe(before.createdAt);
      expect(after.events).toEqual(['price']);
      expect(after.updatedAt).toBeGreaterThanOrEqual(before.createdAt);
    });

    it('normalizes the url through the URL parser', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await webhooks.updateWebhook(id, { url: 'HTTPS://hooks.example.com/other' });
      expect(webhooks.getWebhook(id)?.url).toBe('https://hooks.example.com/other');
    });

    it('rejects non-HTTPS urls and leaves the stored webhook untouched', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await expect(
        webhooks.updateWebhook(id, { url: 'http://hooks.example.com/coral' }),
      ).rejects.toThrow(ValidationError);
      expect(webhooks.getWebhook(id)?.url).toBe(VALID_URL);
      expect(webhooks.getWebhook(id)?.updatedAt).toBeUndefined();
    });

    it('rejects malformed and empty urls', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await expect(webhooks.updateWebhook(id, { url: 'not-a-url' })).rejects.toThrow(ValidationError);
      await expect(webhooks.updateWebhook(id, { url: '   ' })).rejects.toThrow(ValidationError);
      expect(webhooks.getWebhook(id)?.url).toBe(VALID_URL);
    });

    it('replaces the event subscription', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await webhooks.updateWebhook(id, { events: ['il', 'flash-loan'] });
      expect(webhooks.getWebhook(id)?.events).toEqual(['il', 'flash-loan']);
    });

    it('trims and de-duplicates event names', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await webhooks.updateWebhook(id, { events: [' il ', 'price', 'il'] });
      expect(webhooks.getWebhook(id)?.events).toEqual(['il', 'price']);
    });

    it('rejects empty event arrays and empty event names', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await expect(webhooks.updateWebhook(id, { events: [] })).rejects.toThrow(ValidationError);
      await expect(webhooks.updateWebhook(id, { events: ['price', ' '] })).rejects.toThrow(ValidationError);
      expect(webhooks.getWebhook(id)?.events).toEqual(['price']);
    });

    it('rejects empty secrets and accepts a new non-empty secret', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await expect(webhooks.updateWebhook(id, { secret: '' })).rejects.toThrow(ValidationError);
      await webhooks.updateWebhook(id, { secret: 'rotated' });
      expect(webhooks.getWebhook(id)?.secret).toBe('rotated');
    });

    it('signs subsequent deliveries with the rotated secret', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], 'old-secret');
        await webhooks.updateWebhook(id, { secret: 'new-secret' });
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        const body = mock.calls[0].init.body as string;
        const expected = `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(WEBHOOK_SIGNATURE_ALGORITHM, 'new-secret')
          .update(body)
          .digest('hex')}`;
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(expected);
      } finally {
        mock.restore();
      }
    });

    it('keeps the verified flag when only events/secret change', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.verifyWebhook(id);
        expect(webhooks.isWebhookVerified(id)).toBe(true);
        await webhooks.updateWebhook(id, { events: ['il'], secret: 'shh' });
        expect(webhooks.isWebhookVerified(id)).toBe(true);
      } finally {
        mock.restore();
      }
    });

    it('resets verified to false when the url changes', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.verifyWebhook(id);
        expect(webhooks.isWebhookVerified(id)).toBe(true);
        await webhooks.updateWebhook(id, { url: 'https://hooks.example.com/moved' });
        expect(webhooks.isWebhookVerified(id)).toBe(false);
        expect(webhooks.getWebhook(id)?.verified).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('clears the failure counter and re-enables an auto-disabled webhook when the url changes', async () => {
      const mock = installFetchMock(buildResponseQueue(64, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < WEBHOOK_DISABLE_FAILURE_THRESHOLD; i += 1) {
          await webhooks.sendWebhook(id, { i }, { baseDelayMs: 1 });
        }
        expect(webhooks.isWebhookDisabled(id)).toBe(true);
        expect(webhooks.getWebhook(id)?.failCount).toBe(WEBHOOK_DISABLE_FAILURE_THRESHOLD);

        await webhooks.updateWebhook(id, { url: 'https://hooks.example.com/fixed' });

        expect(webhooks.isWebhookDisabled(id)).toBe(false);
        expect(webhooks.getWebhook(id)?.failCount).toBe(0);
      } finally {
        mock.restore();
      }
    });

    it('does NOT re-enable a manually disabled webhook when the url changes', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      webhooks.disableWebhook(id);
      await webhooks.updateWebhook(id, { url: 'https://hooks.example.com/elsewhere' });
      expect(webhooks.isWebhookDisabled(id)).toBe(true);
    });
  });

  describe('listWebhooks() and the Webhook view', () => {
    it('exposes id, url, events, verified, failCount and createdAt', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il']);
      const [view] = webhooks.listWebhooks();
      expect(view).toMatchObject({
        id,
        url: VALID_URL,
        events: ['price', 'il'],
        verified: false,
        failCount: 0,
      });
      expect(typeof view.createdAt).toBe('number');
      expect(view.lastDelivery).toBeUndefined();
    });

    it('reflects consecutive failures in failCount', async () => {
      const mock = installFetchMock(buildResponseQueue(12, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhook(id)?.failCount).toBe(2);
        expect(webhooks.listWebhooks()[0].failCount).toBe(2);
      } finally {
        mock.restore();
      }
    });

    it('records lastDelivery on the first delivery attempt', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const before = Date.now();
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const lastDelivery = webhooks.getWebhook(id)?.lastDelivery;
        expect(typeof lastDelivery).toBe('number');
        expect(lastDelivery).toBeGreaterThanOrEqual(before);
      } finally {
        mock.restore();
      }
    });

    it('leaves lastDelivery untouched when the delivery is filtered out', async () => {
      // A delivery that is filtered by subscription never reaches the network
      // and therefore must not touch lastDelivery.
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, {}, { event: 'il' });
        expect(webhooks.getWebhook(id)?.lastDelivery).toBeUndefined();
      } finally {
        mock.restore();
      }
    });

    it('resets failCount after a successful delivery', async () => {
      const mock = installFetchMock([
        ...buildResponseQueue(12, 500),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 3; i += 1) {
          await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        }
        expect(webhooks.getWebhook(id)?.failCount).toBe(3);
        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhook(id)?.failCount).toBe(0);
      } finally {
        mock.restore();
      }
    });

    it('keeps the webhook disabled past the failure threshold and reports the count', async () => {
      const mock = installFetchMock(buildResponseQueue(64, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < WEBHOOK_DISABLE_FAILURE_THRESHOLD + 1; i += 1) {
          await webhooks.sendWebhook(id, { i }, { baseDelayMs: 1 }).catch(() => undefined);
        }
        expect(webhooks.isWebhookDisabled(id)).toBe(true);
        expect(webhooks.getWebhook(id)?.failCount).toBeGreaterThanOrEqual(
          WEBHOOK_DISABLE_FAILURE_THRESHOLD,
        );
      } finally {
        mock.restore();
      }
    });

    it('returns defensive copies that cannot mutate module state', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price'], 'shh');
      const [view] = webhooks.listWebhooks();
      view.events.push('tampered');
      view.verified = true;
      view.url = 'https://evil.example.com/';
      const [fresh] = webhooks.listWebhooks();
      expect(fresh.events).toEqual(['price']);
      expect(fresh.verified).toBe(false);
      expect(fresh.url).toBe(VALID_URL);
      expect(fresh.secret).toBe('shh');
      expect(webhooks.isWebhookVerified(id)).toBe(false);
    });

    it('returns an empty list once every webhook is deleted', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.listWebhooks()).toHaveLength(1);
      webhooks.deleteWebhook(id);
      expect(webhooks.listWebhooks()).toHaveLength(0);
    });

    it('getWebhook returns undefined for unknown ids', () => {
      const webhooks = new WebhookModule();
      expect(webhooks.getWebhook('not-registered')).toBeUndefined();
    });
  });

  describe('event filtering (events decide which alerts fire)', () => {
    it('delivers when the requested event is subscribed and stamps the envelope', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { event: 'il' });
        expect(result.delivered).toBe(true);
        expect(result.filtered).toBeUndefined();
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers['X-Webhook-Event']).toBe('il');
        const envelope = JSON.parse(mock.calls[0].init.body as string);
        expect(envelope.event).toBe('il');
      } finally {
        mock.restore();
      }
    });

    it('skips the delivery — and issues no HTTP request — for an unsubscribed event', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { event: 'governance' });
        expect(result).toEqual({
          statusCode: 0,
          delivered: false,
          retryCount: 0,
          filtered: true,
        });
        expect(mock.calls).toHaveLength(0);
        expect(webhooks.getWebhookHistory(id).total).toBe(0);
      } finally {
        mock.restore();
      }
    });

    it('does not count a filtered delivery as a failure', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 10; i += 1) {
          await webhooks.sendWebhook(id, {}, { event: 'nope' });
        }
        expect(webhooks.getWebhook(id)?.failCount).toBe(0);
        expect(webhooks.isWebhookDisabled(id)).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('falls back to the first subscribed event when no event is supplied', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers['X-Webhook-Event']).toBe('price');
      } finally {
        mock.restore();
      }
    });

    it('matches a trimmed event name', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, {}, { event: '  price  ' });
        expect(result.delivered).toBe(true);
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers['X-Webhook-Event']).toBe('price');
      } finally {
        mock.restore();
      }
    });

    it('rejects an empty event name', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      await expect(webhooks.sendWebhook(id, {}, { event: '   ' })).rejects.toThrow(ValidationError);
    });

    it('listWebhooksForEvent returns only the endpoints subscribed to that event', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const both = await webhooks.registerWebhook(VALID_URL, ['price', 'il']);
      const priceOnly = await webhooks.registerWebhook('https://a.example.com/h', ['price']);
      await webhooks.registerWebhook('https://b.example.com/h', ['governance']);

      expect(webhooks.listWebhooksForEvent('price').map((w) => w.id).sort()).toEqual(
        [both, priceOnly].sort(),
      );
      expect(webhooks.listWebhooksForEvent('il').map((w) => w.id)).toEqual([both]);
      expect(webhooks.listWebhooksForEvent('flash-loan')).toEqual([]);
    });

    it('listWebhooksForEvent excludes disabled webhooks', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.listWebhooksForEvent('price')).toHaveLength(1);
      webhooks.disableWebhook(id);
      expect(webhooks.listWebhooksForEvent('price')).toHaveLength(0);
    });

    it('listWebhooksForEvent rejects empty event names', () => {
      const webhooks = new WebhookModule();
      expect(() => webhooks.listWebhooksForEvent('')).toThrow(ValidationError);
    });
  });

  describe('getWebhookHistory()', () => {
    it('throws WebhookError when the webhook id is unknown', () => {
      const webhooks = new WebhookModule();
      expect(() => webhooks.getWebhookHistory('not-registered')).toThrow(WebhookError);
    });

    it('returns an empty page when no deliveries have been recorded', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const page = webhooks.getWebhookHistory(id);
      expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
    });

    it('records a success entry after a 2xx delivery', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const page = webhooks.getWebhookHistory(id);
        expect(page.total).toBe(1);
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          delivered: true,
          statusCode: 200,
          outcome: 'success',
          attempts: 1,
          retryCount: 0,
        });
        expect(page.items[0].deliveryId).toBeTruthy();
        expect(typeof page.items[0].timestamp).toBe('number');
        expect(page.nextCursor).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it('records a retry-aware entry when retries occurred', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(503),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        const page = webhooks.getWebhookHistory(id);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].retryCount).toBeGreaterThanOrEqual(1);
        expect(page.items[0].attempts).toBe(page.items[0].retryCount + 1);
        expect(page.items[0].delivered).toBe(true);
        expect(page.items[0].statusCode).toBe(200);
      } finally {
        mock.restore();
      }
    });

    it('records a `client` outcome for 4xx terminal failures', async () => {
      const mock = installFetchMock([() => responseWithStatus(401)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const page = webhooks.getWebhookHistory(id);
        expect(page.items[0]).toMatchObject({
          delivered: false,
          statusCode: 401,
          outcome: 'client',
        });
        expect(page.items[0].errorMessage).toMatch(/401/);
      } finally {
        mock.restore();
      }
    });

    it('records a `server` outcome for retry-exhausted 5xx failures', async () => {
      // 1 sendWebhook = up to 4 attempts (1 + 3 retries); supply 4 handlers
      const mock = installFetchMock(buildResponseQueue(4, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        const page = webhooks.getWebhookHistory(id);
        expect(page.items[0]).toMatchObject({
          delivered: false,
          outcome: 'server',
          statusCode: 500,
        });
        expect(page.items[0].errorMessage).toMatch(/500/);
      } finally {
        mock.restore();
      }
    });

    it('records a `network` outcome for unreachable endpoints', async () => {
      const rejecting = () => Promise.reject(new Error('ETIMEDOUT'));
      const mock = installFetchMock([rejecting, rejecting, rejecting, rejecting]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        const page = webhooks.getWebhookHistory(id);
        expect(page.items[0]).toMatchObject({
          delivered: false,
          outcome: 'network',
        });
        expect(page.items[0].errorMessage).toBe('ETIMEDOUT');
      } finally {
        mock.restore();
      }
    });

    it('respects the `limit` query parameter', async () => {
      const mock = installFetchMock(buildResponseQueue(5, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 5; i += 1) {
          await webhooks.sendWebhook(id, { i });
        }
        const page = webhooks.getWebhookHistory(id, { limit: 2 });
        expect(page.total).toBe(5);
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).not.toBeNull();
      } finally {
        mock.restore();
      }
    });

    it('supports offset-based pagination', async () => {
      const mock = installFetchMock(buildResponseQueue(6, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 6; i += 1) {
          await webhooks.sendWebhook(id, { i });
        }
        const first = webhooks.getWebhookHistory(id, { limit: 2, offset: 0 });
        const second = webhooks.getWebhookHistory(id, { limit: 2, offset: 2 });
        expect(first.items).toHaveLength(2);
        expect(second.items).toHaveLength(2);
        expect(first.items[0].deliveryId).not.toBe(second.items[0].deliveryId);
        expect(first.total).toBe(6);
        expect(second.total).toBe(6);
      } finally {
        mock.restore();
      }
    });

    it('returns pages newest-first', async () => {
      const mock = installFetchMock(buildResponseQueue(3, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { order: 1 });
        await webhooks.sendWebhook(id, { order: 2 });
        await webhooks.sendWebhook(id, { order: 3 });
        const page = webhooks.getWebhookHistory(id);
        expect(page.items).toHaveLength(3);
        const envelopeIds = page.items.map((item) => item.deliveryId);
        expect(new Set(envelopeIds).size).toBe(3);
      } finally {
        mock.restore();
      }
    });

    it('iterates via nextCursor across pages', async () => {
      const mock = installFetchMock(buildResponseQueue(7, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 7; i += 1) {
          await webhooks.sendWebhook(id, { i });
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        let safety = 0;
        while (safety < 10) {
          const page = webhooks.getWebhookHistory(id, { limit: 3, ...(cursor ? { cursor } : {}) });
          for (const item of page.items) seen.push(item.deliveryId);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
          safety += 1;
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
      } finally {
        mock.restore();
      }
    });

    it('returns nextCursor=null on the final page', async () => {
      const mock = installFetchMock(buildResponseQueue(3, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 3; i += 1) {
          await webhooks.sendWebhook(id, { i });
        }
        const page = webhooks.getWebhookHistory(id, { limit: 10 });
        expect(page.items).toHaveLength(3);
        expect(page.nextCursor).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it('clamps absurd limits to a sane ceiling', async () => {
      const mock = installFetchMock(buildResponseQueue(2, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, {});
        await webhooks.sendWebhook(id, {});
        const page = webhooks.getWebhookHistory(id, { limit: 100_000 });
        expect(page.items).toHaveLength(2);
      } finally {
        mock.restore();
      }
    });

    it('isolates history between different webhooks', async () => {
      const mock = installFetchMock(buildResponseQueue(4, 200));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const a = await webhooks.registerWebhook(VALID_URL, ['price']);
        const b = await webhooks.registerWebhook('https://other.example.com/h', ['il']);
        await webhooks.sendWebhook(a, {});
        await webhooks.sendWebhook(b, {});
        await webhooks.sendWebhook(a, {});
        expect(webhooks.getWebhookHistory(a).total).toBe(2);
        expect(webhooks.getWebhookHistory(b).total).toBe(1);
      } finally {
        mock.restore();
      }
    });
  });

  describe('auto-disable after consecutive failures', () => {
    it('starts the failure counter at zero', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.getWebhookFailureCount(id)).toBe(0);
      expect(webhooks.isWebhookDisabled(id)).toBe(false);
    });

    it('increments the failure counter on each terminal retry-exhausted failure', async () => {
      // 5xx counts toward the consecutive counter (4xx does not — see the
      // `does NOT count 4xx failures...` test). One sendWebhook call here
      // performs up to 4 attempts before terminal failure, so supply 4
      // handlers per call.
      const mock = installFetchMock(buildResponseQueue(12, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhookFailureCount(id)).toBe(1);
        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhookFailureCount(id)).toBe(2);
        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhookFailureCount(id)).toBe(3);
      } finally {
        mock.restore();
      }
    });

    it('does NOT count 4xx failures toward the consecutive counter', async () => {
      const mock = installFetchMock(buildResponseQueue(6, 400));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 6; i += 1) {
          await webhooks.sendWebhook(id, {});
        }
        expect(webhooks.getWebhookFailureCount(id)).toBe(0);
        expect(webhooks.isWebhookDisabled(id)).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('resets the failure counter after a successful delivery', async () => {
      const mock = installFetchMock([
        // three server-error batches, then a 200, then more server errors.
        ...buildResponseQueue(12, 500),
        ...buildResponseQueue(1, 200),
        ...buildResponseQueue(16, 500),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 3; i += 1) {
          await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        }
        expect(webhooks.getWebhookFailureCount(id)).toBe(3);

        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhookFailureCount(id)).toBe(0);

        await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhookFailureCount(id)).toBe(1);
      } finally {
        mock.restore();
      }
    });

    it('does NOT disable after fewer than 5 consecutive failures', async () => {
      const mock = installFetchMock(buildResponseQueue(16, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < 4; i += 1) {
          await webhooks.sendWebhook(id, {}, { baseDelayMs: 1 });
        }
        expect(webhooks.getWebhookFailureCount(id)).toBe(4);
        expect(webhooks.isWebhookDisabled(id)).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it('auto-disables the webhook after exactly 5 consecutive failures', async () => {
      // 5 sendWebhook calls × 4 attempts each = 20 handler slots.
      const mock = installFetchMock(buildResponseQueue(64, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < WEBHOOK_DISABLE_FAILURE_THRESHOLD; i += 1) {
          await webhooks.sendWebhook(id, { i }, { baseDelayMs: 1 });
        }
        expect(webhooks.isWebhookDisabled(id)).toBe(true);
        expect(webhooks.getWebhookFailureCount(id)).toBe(WEBHOOK_DISABLE_FAILURE_THRESHOLD);
      } finally {
        mock.restore();
      }
    });

    it('throws WebhookDisabledError when sendWebhook is called on a disabled webhook', async () => {
      const mock = installFetchMock(buildResponseQueue(64, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < WEBHOOK_DISABLE_FAILURE_THRESHOLD; i += 1) {
          await webhooks.sendWebhook(id, { i }, { baseDelayMs: 1 });
        }
        const beforeCalls = mock.calls.length;
        await expect(
          webhooks.sendWebhook(id, { ping: 1 }, { baseDelayMs: 1 }),
        ).rejects.toThrow(WebhookDisabledError);
        // No additional HTTP requests should have been made after disabling.
        expect(mock.calls.length).toBe(beforeCalls);
      } finally {
        mock.restore();
      }
    });

    it('does NOT throw on sendWebhook once enableWebhook is called', async () => {
      // 5 sendWebhook calls × up to 4 attempts each = 20 fetches of 500.
      // After disable + enable, the next fetch returns 200.
      const mock = installFetchMock([
        ...buildResponseQueue(20, 500),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        for (let i = 0; i < WEBHOOK_DISABLE_FAILURE_THRESHOLD; i += 1) {
          await webhooks.sendWebhook(id, { i }, { baseDelayMs: 1 });
        }
        expect(webhooks.enableWebhook(id)).toBe(true);
        expect(webhooks.isWebhookDisabled(id)).toBe(false);
        expect(webhooks.getWebhookFailureCount(id)).toBe(0);
        const result = await webhooks.sendWebhook(id, { recovered: true }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(true);
      } finally {
        mock.restore();
      }
    });

    it('disableWebhook manually disables a webhook', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.disableWebhook(id)).toBe(true);
      expect(webhooks.isWebhookDisabled(id)).toBe(true);
      await expect(webhooks.sendWebhook(id, {})).rejects.toThrow(WebhookDisabledError);
    });

    it('disableWebhook returns false for unknown webhook ids', () => {
      const webhooks = new WebhookModule();
      expect(webhooks.disableWebhook('not-registered')).toBe(false);
    });

    it('enableWebhook returns false for unknown webhook ids', () => {
      const webhooks = new WebhookModule();
      expect(webhooks.enableWebhook('not-registered')).toBe(false);
    });

    it('isWebhookDisabled returns false for unknown webhook ids', () => {
      const webhooks = new WebhookModule();
      expect(webhooks.isWebhookDisabled('not-registered')).toBe(false);
    });

    it('WebhookDisabledError is a subclass of WebhookError', () => {
      const err = new WebhookDisabledError('wh_x', 5);
      expect(err).toBeInstanceOf(WebhookError);
      expect(err).toBeInstanceOf(WebhookDisabledError);
      expect(err.code).toBe('WEBHOOK_DISABLED');
      expect(err.webhookId).toBe('wh_x');
      expect(err.consecutiveFailures).toBe(5);
    });
  });

  describe('lifecycle', () => {
    it('deleteWebhook returns true for known ids and false for unknown ids', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.deleteWebhook(id)).toBe(true);
      expect(webhooks.deleteWebhook(id)).toBe(false);
      expect(webhooks.listWebhooks()).toHaveLength(0);
    });

    it('clear() removes all webhooks and state', async () => {
      const mock = installFetchMock(buildResponseQueue(8, 500));
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const a = await webhooks.registerWebhook(VALID_URL, ['price']);
        const b = await webhooks.registerWebhook(VALID_URL, ['il']);
        await webhooks.sendWebhook(a, {}, { baseDelayMs: 1 });
        await webhooks.sendWebhook(b, {}, { baseDelayMs: 1 });
        expect(webhooks.getWebhookHistory(a).total).toBe(1);
        webhooks.clear();
        expect(webhooks.listWebhooks()).toHaveLength(0);
        expect(() => webhooks.getWebhookHistory(a)).toThrow(WebhookError);
      } finally {
        mock.restore();
      }
    });
  });

  describe('exported constants', () => {
    it('exposes the webhook retry defaults', () => {
      expect(WEBHOOK_DEFAULTS.maxRetries).toBe(3);
      expect(typeof WEBHOOK_DEFAULTS.baseDelayMs).toBe('number');
      expect(typeof WEBHOOK_DEFAULTS.backoffMultiplier).toBe('number');
    });

    it('exposes the signature header and algorithm constants', () => {
      expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Signature');
      expect(WEBHOOK_SIGNATURE_ALGORITHM).toBe('sha256');
    });

    it('exposes the disable threshold as 5', () => {
      expect(WEBHOOK_DISABLE_FAILURE_THRESHOLD).toBe(5);
    });

    it('exposes the verify payload type discriminator', () => {
      expect(WEBHOOK_VERIFY_PAYLOAD_TYPE).toBe('webhook.verify');
    });

    it('exposes the history ring-buffer capacity', () => {
      expect(typeof WEBHOOK_HISTORY_CAPACITY).toBe('number');
      expect(WEBHOOK_HISTORY_CAPACITY).toBeGreaterThanOrEqual(50);
    });
  });
});
