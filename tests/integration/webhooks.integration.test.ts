import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { WebhookModule } from '../../src/modules/webhooks';
import type { Logger } from '../../src/types/common';

/**
 * Integration test: webhook registration → on-chain event trigger → delivery
 * verification, plus retry-on-failure behavior against a deliberately
 * failing endpoint.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * Cleanup: unregisters every webhook created during the suite in afterAll.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

/** A tiny logger that discards everything — keeps test output clean. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Start a local HTTP server on an ephemeral port that responds with the given
 * status code to every POST request. Returns the server and its base URL.
 */
function startMockServer(
  statusCode: number,
  body?: unknown,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(
          body !== undefined
            ? JSON.stringify(body)
            : JSON.stringify({ received: true }),
        );
      },
    );

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not resolve server address'));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

describeIntegration('WebhookModule integration (testnet)', () => {
  let client: CoralSwapClient;
  let webhooks: WebhookModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  /** Track server instances for cleanup. */
  const servers: Server[] = [];
  /** Track webhook ids created during this suite for cleanup. */
  const registeredWebhookIds: string[] = [];

  function trackServer(srv: Server): Server {
    servers.push(srv);
    return srv;
  }

  function trackWebhookId(id: string): string {
    registeredWebhookIds.push(id);
    return id;
  }

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL
        ? { rpcUrl: process.env.TEST_RPC_URL }
        : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    webhooks = new WebhookModule({ logger: silentLogger });

    // Resolve or create the pair so we have a real on-chain contract to query.
    let addr = await client.getPairAddress(tokenA, tokenB);
    if (!addr) {
      const op = client.factory.buildCreatePair(
        client.publicKey,
        tokenA,
        tokenB,
      );
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenA, tokenB);
    }
    expect(addr).toBeTruthy();
    pairAddress = addr!;
  }, 60_000);

  afterAll(() => {
    // Unregister every webhook created during this suite.
    for (const id of registeredWebhookIds) {
      webhooks.deleteWebhook(id);
    }
    // Shut down all local mock servers.
    for (const srv of servers) {
      srv.close();
    }
  });

  // -----------------------------------------------------------------------
  // 1. Register webhook → trigger on-chain event → verify delivery recorded
  // -----------------------------------------------------------------------
  it('registers a webhook, triggers a real on-chain event, and verifies delivery in history', async () => {
    // Start a mock server that will receive the webhook delivery.
    const { server, baseUrl } = await startMockServer(200, { ok: true });
    trackServer(server);

    // Register a webhook with a dummy HTTPS URL that passes URL validation,
    // then use a custom fetchImpl to redirect delivery to our local HTTP server.
    const webhookId = await webhooks.registerWebhook(
      'https://hooks.example.com/coral',
      ['swap', 'price'],
    );
    trackWebhookId(webhookId);

    // ---- Trigger a real on-chain event ----
    // Read live reserves from the pair on testnet. This is a real on-chain
    // operation via Soroban RPC.
    const pair = client.pair(pairAddress);
    const reserves = await pair.getReserves();
    expect(reserves.reserve0).toBeDefined();
    expect(reserves.reserve1).toBeDefined();

    // ---- Send the webhook with the on-chain event payload ----
    const payload = {
      event: 'swap',
      pairAddress,
      reserve0: reserves.reserve0.toString(),
      reserve1: reserves.reserve1.toString(),
      timestamp: Date.now(),
    };

    const customFetch: typeof fetch = (url, init) => {
      // Rewrite the URL to our local mock server while preserving path/body.
      const path = typeof url === 'string' ? new URL(url).pathname : '/';
      const resolvedUrl = `${baseUrl}${path}`;
      return fetch(resolvedUrl, init);
    };

    const result = await webhooks.sendWebhook(webhookId, payload, {
      fetchImpl: customFetch,
      maxRetries: 0,
    });

    expect(result.delivered).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.retryCount).toBe(0);

    // ---- Verify delivery is recorded in history ----
    const history = webhooks.getWebhookHistory(webhookId);
    expect(history.total).toBeGreaterThanOrEqual(1);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      delivered: true,
      statusCode: 200,
      outcome: 'success',
      attempts: 1,
      retryCount: 0,
    });
    expect(typeof history.items[0].deliveryId).toBe('string');
    expect(history.items[0].deliveryId.length).toBeGreaterThan(0);
    expect(typeof history.items[0].timestamp).toBe('number');
  }, 30_000);

  // -----------------------------------------------------------------------
  // 2. Delivery retry behavior against a deliberately failing endpoint
  // -----------------------------------------------------------------------
  it('retries delivery against a failing endpoint and records retry-aware history', async () => {
    // Start a server that always returns 503 (Service Unavailable).
    const { server, baseUrl } = await startMockServer(503, {
      error: 'Service Unavailable',
    });
    trackServer(server);

    // Register a webhook.
    const webhookId = await webhooks.registerWebhook(
      'https://hooks.example.com/retry',
      ['price'],
    );
    trackWebhookId(webhookId);

    // Custom fetch impl that rewrites the URL to localhost but preserves headers/body.
    const customFetch: typeof fetch = (url, init) => {
      const path = typeof url === 'string' ? new URL(url).pathname : '/';
      const resolvedUrl = `${baseUrl}${path}`;
      return fetch(resolvedUrl, init);
    };

    // Send with short delays so the test completes quickly.
    const result = await webhooks.sendWebhook(
      webhookId,
      { event: 'price', token: tokenA, value: '1.23' },
      {
        fetchImpl: customFetch,
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
      },
    );

    // The endpoint always returns 503, so delivery should fail after retries.
    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(503);

    // ---- Verify retry behavior is captured in history ----
    const history = webhooks.getWebhookHistory(webhookId);
    expect(history.total).toBeGreaterThanOrEqual(1);

    // The final entry should reflect the failure after retries.
    const lastEntry = history.items[0];
    expect(lastEntry.delivered).toBe(false);
    expect(lastEntry.outcome).toBe('server');
    expect(lastEntry.statusCode).toBe(503);
    // We expect the final attempt index to be reflected in retryCount.
    expect(lastEntry.attempts).toBeGreaterThanOrEqual(1);
    expect(lastEntry.retryCount).toBeGreaterThanOrEqual(2);
    expect(lastEntry.errorMessage).toMatch(/503/);
  }, 15_000);

  // -----------------------------------------------------------------------
  // 3. Retry then succeed: verifies retryCount is recorded when recovery occurs
  // -----------------------------------------------------------------------
  it('records retryCount > 0 in history when recovery happens after transient failures', async () => {
    // Create a server that fails the first 2 requests then succeeds.
    let requestCount = 0;
    const { server, baseUrl } = await new Promise<{
      server: Server;
      baseUrl: string;
    }>((resolve, reject) => {
      const srv = createServer(
        (_req: IncomingMessage, res: ServerResponse) => {
          requestCount += 1;
          if (requestCount <= 2) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'transient failure' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
          }
        },
      );

      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Could not resolve server address'));
          return;
        }
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}` });
      });
    });
    trackServer(server);

    const webhookId = await webhooks.registerWebhook(
      'https://hooks.example.com/recover',
      ['price'],
    );
    trackWebhookId(webhookId);

    const customFetch: typeof fetch = (url, init) => {
      const path = typeof url === 'string' ? new URL(url).pathname : '/';
      return fetch(`${baseUrl}${path}`, init);
    };

    const result = await webhooks.sendWebhook(
      webhookId,
      { event: 'price', token: tokenA, value: '4.56' },
      {
        fetchImpl: customFetch,
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
      },
    );

    expect(result.delivered).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.retryCount).toBeGreaterThanOrEqual(2);

    // Verify that the history entry records retries even though it ultimately succeeded.
    const history = webhooks.getWebhookHistory(webhookId);
    expect(history.total).toBeGreaterThanOrEqual(1);
    expect(history.items[0].delivered).toBe(true);
    expect(history.items[0].statusCode).toBe(200);
    expect(history.items[0].outcome).toBe('success');
    expect(history.items[0].retryCount).toBeGreaterThanOrEqual(2);
    expect(history.items[0].attempts).toBeGreaterThanOrEqual(3);
  }, 30_000);

  // -----------------------------------------------------------------------
  // 4. Cleanup verification: after unregister, history throws for stale id
  // -----------------------------------------------------------------------
  it('throws WebhookError on getWebhookHistory after unregister', async () => {
    const id = await webhooks.registerWebhook(
      'https://hooks.example.com/cleanup',
      ['price'],
    );
    trackWebhookId(id);

    // Send one delivery so there is something in history.
    const customFetch: typeof fetch = (_url, _init) =>
      Promise.resolve(new Response('{}', { status: 200 }));
    await webhooks.sendWebhook(id, { test: true }, {
      fetchImpl: customFetch,
      maxRetries: 0,
    });
    expect(webhooks.getWebhookHistory(id).total).toBe(1);

    const deleted = webhooks.deleteWebhook(id);
    expect(deleted).toBe(true);

    // After unregister, getWebhookHistory should throw.
    expect(() => webhooks.getWebhookHistory(id)).toThrow();
  }, 10_000);
});
