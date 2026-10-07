import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  WebhookConfig,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpointHealth,
  StoredWebhook,
  Webhook,
  WebhookDeliveryResult,
  WebhookEnvelope,
  WebhookEventName,
  WebhookHistoryEntry,
  WebhookHistoryPage,
  WebhookHistoryQuery,
  WebhookOptions,
  WebhookPayload,
  WebhookUpdate,
  WebhookVerifyOptions,
  WebhookVerifyResult,
  WEBHOOK_DEFAULTS,
  WEBHOOK_DISABLE_FAILURE_THRESHOLD,
  WEBHOOK_HISTORY_CAPACITY,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_VERIFY_PAYLOAD_TYPE,
} from '@/types/webhooks';
import { ValidationError, WebhookDisabledError, WebhookError } from '@/errors';
import type { Logger } from '@/types/common';

const MAX_ENDPOINTS = 20;
const MAX_PAYLOAD_BYTES = 262_144;

interface LoggerProvider {
  logger?: Logger;
}

export type WebhookModuleDeps = LoggerProvider | undefined;

interface WebhookState {
  history: WebhookHistoryEntry[];
  consecutiveFailures: number;
  disabled: boolean;
  disabledAt?: number;
  /** Why the webhook is disabled: explicitly by the caller, or automatically. */
  disabledReason?: 'manual' | 'auto';
  lastDelivery?: number;
}

export class WebhookModule {
  private readonly endpoints: Map<string, WebhookConfig> = new Map();
  private readonly deliveries: Map<string, WebhookDelivery> = new Map();
  private readonly healthCache: Map<string, WebhookEndpointHealth> = new Map();
  private readonly webhooks: Map<string, StoredWebhook> = new Map();
  private readonly webhookState: Map<string, WebhookState> = new Map();
  private readonly payloads: Map<string, string> = new Map();
  private readonly logger?: Logger;

  constructor(deps: WebhookModuleDeps = undefined) {
    this.logger = deps?.logger;
  }

  async registerEndpoint(config: WebhookConfig): Promise<string> {
    if (this.endpoints.size >= MAX_ENDPOINTS) {
      throw new ValidationError(`Maximum of ${MAX_ENDPOINTS} webhook endpoints reached`);
    }
    if (!config.url.startsWith('https://')) {
      throw new ValidationError('Webhook URL must use HTTPS', { url: config.url });
    }
    if (config.secret !== undefined && config.secret.trim().length === 0) {
      throw new ValidationError('webhook secret must not be empty');
    }
    if (config.headers) {
      const forbidden = ['content-type', 'x-coralswap-signature'];
      const keys = Object.keys(config.headers).map((k) => k.toLowerCase());
      const conflicts = forbidden.filter((f) => keys.includes(f));
      if (conflicts.length > 0) {
        throw new ValidationError(`Cannot override reserved headers: ${conflicts.join(', ')}`);
      }
    }
    const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.endpoints.set(id, { ...config, method: config.method ?? 'POST', payloadFormat: config.payloadFormat ?? 'json', enabled: config.enabled ?? true });
    this.healthCache.set(id, { webhookId: id, url: config.url, enabled: true, totalDeliveries: 0, successfulDeliveries: 0, failedDeliveries: 0, successRate: 1, averageResponseTimeMs: 0 });
    return id;
  }

  async updateEndpoint(webhookId: string, updates: Partial<WebhookConfig>): Promise<void> {
    const existing = this.endpoints.get(webhookId);
    if (!existing) throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    this.endpoints.set(webhookId, { ...existing, ...updates });
  }

  async deleteEndpoint(webhookId: string): Promise<void> {
    if (!this.endpoints.has(webhookId)) throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    this.endpoints.delete(webhookId);
    this.healthCache.delete(webhookId);
    for (const [dId, d] of this.deliveries) { if (d.webhookId === webhookId) this.deliveries.delete(dId); }
  }

  async listEndpoints(): Promise<WebhookConfig[]> { return Array.from(this.endpoints.values()); }

  async getEndpoint(webhookId: string): Promise<WebhookConfig> {
    const ep = this.endpoints.get(webhookId);
    if (!ep) throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    return ep;
  }

  async deliver(webhookId: string, payload: Record<string, unknown>): Promise<WebhookDelivery> {
    const endpoint = this.endpoints.get(webhookId);
    if (!endpoint) throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    if (!endpoint.enabled) throw new ValidationError('Webhook endpoint is disabled');
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf-8') > MAX_PAYLOAD_BYTES) throw new ValidationError(`Payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`);
    const deliveryId = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const delivery: WebhookDelivery = { id: deliveryId, webhookId, alertId: (payload['alertId'] as string) ?? 'unknown', status: 'pending', sentAt: Math.floor(Date.now() / 1000), retryCount: 0 };
    this.deliveries.set(deliveryId, delivery);
    this.payloads.set(deliveryId, body);
    this.recordDeliveryAttempt(webhookId, delivery);
    await this.sendHttpRequest(endpoint, body, delivery);
    return this.deliveries.get(deliveryId)!;
  }

  async retryDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new ValidationError(`Delivery not found: ${deliveryId}`);
    if (delivery.status === 'success' || delivery.status === 'exhausted') throw new ValidationError(`Cannot retry delivery in status ${delivery.status}`);
    const endpoint = this.endpoints.get(delivery.webhookId);
    if (!endpoint) throw new ValidationError(`Webhook endpoint ${delivery.webhookId} not found`);
    const body = this.loadPayload(deliveryId);
    await this.sendHttpRequest(endpoint, body, delivery);
    return this.deliveries.get(deliveryId)!;
  }

  async getDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new ValidationError(`Delivery not found: ${deliveryId}`);
    return delivery;
  }

  async listDeliveries(webhookId: string, limit: number = 50): Promise<WebhookDelivery[]> {
    const result: WebhookDelivery[] = [];
    for (const delivery of this.deliveries.values()) { if (delivery.webhookId === webhookId) result.push(delivery); }
    result.sort((a, b) => b.sentAt - a.sentAt);
    return result.slice(0, limit);
  }

  async getEndpointHealth(webhookId: string): Promise<WebhookEndpointHealth> {
    const health = this.healthCache.get(webhookId);
    if (!health) throw new ValidationError(`Webhook endpoint not found: ${webhookId}`);
    return health;
  }

  /**
   * Register an HTTPS endpoint to receive CoralSwap event deliveries.
   *
   * Registration is local and synchronous with respect to the network: no
   * request is made to `url`, so the returned webhook starts `verified: false`.
   * Call {@link verifyWebhook} to run the handshake.
   *
   * @param url - Absolute `https://` endpoint. `http://` and every other
   *   scheme are rejected with a {@link ValidationError}.
   * @param events - Non-empty list of event names this endpoint subscribes
   *   to. Used to filter deliveries (see {@link sendWebhook}) and to pick the
   *   `X-Webhook-Event` header.
   * @param secret - Optional shared secret; when present every delivery is
   *   signed with HMAC-SHA256 in the {@link WEBHOOK_SIGNATURE_HEADER} header.
   * @returns The generated webhook id.
   * @throws {ValidationError} If the url is not a valid HTTPS URL, `events`
   *   is empty or holds non-string/empty entries, or `secret` is empty.
   */
  async registerWebhook(
    url: string,
    events: WebhookEventName[],
    secret?: string,
  ): Promise<string> {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new ValidationError('webhook url must not be empty', { url });
    }

    const parsed = parseHttpsUrl(url);
    if (!parsed) {
      throw new ValidationError(
        'webhook url must be a valid HTTPS URL',
        { url },
      );
    }

    if (!Array.isArray(events) || events.length === 0) {
      throw new ValidationError(
        'webhook events must be a non-empty array of strings',
        { events },
      );
    }

    for (const event of events) {
      if (typeof event !== 'string' || event.trim().length === 0) {
        throw new ValidationError(
          'webhook event names must be non-empty strings',
          { event },
        );
      }
    }

    if (secret !== undefined && (typeof secret !== 'string' || secret.length === 0)) {
      throw new ValidationError(
        'webhook secret must be a non-empty string when provided',
        { secretProvided: secret !== undefined },
      );
    }

    const id = generateId();
    const stored: StoredWebhook = {
      id,
      url: parsed.toString(),
      events: normalizeEvents(events),
      ...(secret !== undefined ? { secret } : {}),
      createdAt: Date.now(),
      verified: false,
    };
    this.webhooks.set(id, stored);
    this.webhookState.set(id, createInitialState());

    this.logger?.info('webhooks.registerWebhook: registered', {
      id,
      url: stored.url,
      events: stored.events,
      signed: secret !== undefined,
      verified: false,
    });

    return id;
  }

  /**
   * Update the mutable parts of a registered webhook.
   *
   * Accepts `url`, `events` and/or `secret`; omitted fields are preserved, as
   * are `id`, `createdAt` and the delivery counters. Validation mirrors
   * {@link registerWebhook}, so an invalid update throws a
   * {@link ValidationError} and leaves the stored webhook untouched.
   *
   * Changing the `url` points the webhook at a different endpoint, so:
   * - `verified` is reset to `false` — the previous handshake proves nothing
   *   about the new target — and the endpoint must be re-verified; and
   * - the consecutive-failure counter is cleared and the webhook is
   *   re-enabled, so a webhook auto-disabled because the old URL was dead
   *   resumes delivering once the endpoint is fixed.
   *
   * @throws {WebhookError} If no webhook with `webhookId` exists.
   * @throws {ValidationError} If any provided field is invalid.
   */
  async updateWebhook(webhookId: string, updates: WebhookUpdate): Promise<void> {
    const existing = this.webhooks.get(webhookId);
    if (!existing) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }
    if (updates === null || typeof updates !== 'object') {
      throw new ValidationError('webhook updates must be an object', { webhookId });
    }

    const next: StoredWebhook = { ...existing, events: [...existing.events] };
    const changed: string[] = [];

    if (updates.url !== undefined) {
      if (typeof updates.url !== 'string' || updates.url.trim().length === 0) {
        throw new ValidationError('webhook url must not be empty', { url: updates.url });
      }
      const parsed = parseHttpsUrl(updates.url);
      if (!parsed) {
        throw new ValidationError(
          'webhook url must be a valid HTTPS URL',
          { url: updates.url },
        );
      }
      next.url = parsed.toString();
      changed.push('url');
    }

    if (updates.events !== undefined) {
      if (!Array.isArray(updates.events) || updates.events.length === 0) {
        throw new ValidationError(
          'webhook events must be a non-empty array of strings',
          { events: updates.events },
        );
      }
      for (const event of updates.events) {
        if (typeof event !== 'string' || event.trim().length === 0) {
          throw new ValidationError(
            'webhook event names must be non-empty strings',
            { event },
          );
        }
      }
      next.events = normalizeEvents(updates.events);
      changed.push('events');
    }

    if (updates.secret !== undefined) {
      if (typeof updates.secret !== 'string' || updates.secret.length === 0) {
        throw new ValidationError(
          'webhook secret must be a non-empty string when provided',
          { webhookId },
        );
      }
      next.secret = updates.secret;
      changed.push('secret');
    }

    const urlChanged = next.url !== existing.url;
    if (urlChanged) {
      next.verified = false;
      this.resetFailureState(webhookId);
      changed.push('verified');
    }
    next.updatedAt = Date.now();

    this.webhooks.set(webhookId, next);

    this.logger?.info('webhooks.updateWebhook: updated', {
      webhookId,
      changed,
      verified: next.verified,
    });
  }

  /**
   * Deliver a payload to a registered webhook.
   *
   * The webhook only fires for events it subscribed to: pass the event type
   * via `options.event` and the delivery is skipped — no HTTP request, no
   * history entry — when that type is not in the webhook's `events`, returning
   * a result with `filtered: true`. When `options.event` is omitted the first
   * subscribed event is used, preserving the original behaviour for callers
   * that never subscribed to more than one event type.
   *
   * Delivery is attempted up to 1 + `maxRetries` times with exponential
   * backoff; auto-disable is applied by {@link recordOutcome} once
   * {@link WEBHOOK_DISABLE_FAILURE_THRESHOLD} consecutive failures pile up.
   *
   * @throws {WebhookError} If the webhook id is unknown.
   * @throws {WebhookDisabledError} If the webhook was disabled manually or
   *   auto-disabled after too many consecutive failures.
   * @throws {ValidationError} If `options.event` is not a non-empty string.
   */
  async sendWebhook<T extends WebhookPayload = WebhookPayload>(
    webhookId: string,
    payload: T,
    options: WebhookOptions = {},
  ): Promise<WebhookDeliveryResult> {
    const stored = this.webhooks.get(webhookId);
    if (!stored) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }

    const state = this.requireState(webhookId);
    if (state.disabled) {
      throw new WebhookDisabledError(webhookId, state.consecutiveFailures, {
        ...(state.disabledAt !== undefined ? { disabledAt: state.disabledAt } : {}),
      });
    }

    const requestedEvent = options.event;
    let event = pickEvent(stored.events);
    if (requestedEvent !== undefined) {
      if (typeof requestedEvent !== 'string' || requestedEvent.trim().length === 0) {
        throw new ValidationError('webhook event must be a non-empty string', {
          webhookId,
          event: requestedEvent,
        });
      }
      const normalizedEvent = requestedEvent.trim();
      if (!stored.events.includes(normalizedEvent)) {
        this.logger?.debug('webhooks.sendWebhook: event filtered out', {
          webhookId,
          event: normalizedEvent,
          subscribed: stored.events,
        });
        return { statusCode: 0, delivered: false, retryCount: 0, filtered: true };
      }
      event = normalizedEvent;
    }

    const config = resolveOptions(options);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new WebhookError('no fetch implementation available in this environment', {
        webhookId,
      });
    }

    const envelope: WebhookEnvelope<T> = {
      id: generateUUID(),
      timestamp: Date.now(),
      ...(event !== undefined ? { event } : {}),
      data: payload,
    };
    const body = JSON.stringify(envelope);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CoralSwap-SDK/1.0 (+webhooks)',
    };
    if (stored.secret) {
      headers[WEBHOOK_SIGNATURE_HEADER] = buildSignature(stored.secret, body);
    }
    if (envelope.event) {
      headers['X-Webhook-Event'] = envelope.event;
    }
    headers['X-Webhook-Delivery'] = envelope.id;

    let retryCount = 0;
    let attempts = 0;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const outcome = await attemptDelivery(fetchImpl, stored.url, body, headers, config.timeoutMs);
      attempts += 1;

      this.logger?.debug('webhooks.sendWebhook: attempt completed', {
        webhookId,
        attempt,
        maxRetries: config.maxRetries,
        statusCode: outcome.statusCode,
        delivered: outcome.delivered,
        networkError: outcome.networkError,
      });

      if (outcome.delivered) {
        if (attempt > 0) retryCount = attempt;
        this.recordOutcome(state, {
          deliveryId: envelope.id,
          timestamp: Date.now(),
          statusCode: outcome.statusCode,
          delivered: true,
          attempts,
          retryCount,
          outcome: 'success',
        });
        return {
          statusCode: outcome.statusCode,
          delivered: true,
          retryCount,
        };
      }

      const isFinalAttempt = attempt >= config.maxRetries;
      if (!shouldRetry(outcome, attempt, config.maxRetries)) {
        const classification = classifyOutcome(outcome);
        this.recordOutcome(state, {
          deliveryId: envelope.id,
          timestamp: Date.now(),
          statusCode: outcome.statusCode,
          delivered: false,
          attempts,
          retryCount: attempt,
          outcome: classification.outcome,
          ...(classification.errorMessage !== undefined
            ? { errorMessage: classification.errorMessage }
            : {}),
        });
        if (isFinalAttempt) {
          this.logger?.warn?.('webhooks.sendWebhook: delivery failed after retries', {
            webhookId,
            attempt,
            retryCount: config.maxRetries,
            lastStatus: outcome.statusCode,
            lastError: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? ''),
          });
        }
        return {
          statusCode: outcome.statusCode,
          delivered: false,
          retryCount: attempt,
        };
      }

      const delay = computeBackoff(attempt, config);
      this.logger?.debug('webhooks.sendWebhook: scheduling retry', {
        webhookId,
        nextDelayMs: delay,
      });
      await sleep(delay);
    }

    throw new WebhookError(
      'webhook delivery exited retry loop without a terminal outcome',
      { webhookId },
    );
  }

  /**
   * Run the verification handshake against a registered webhook.
   *
   * Posts a small signed challenge payload
   * (`{ type: 'webhook.verify', challenge, webhookId, timestamp }`) to the
   * endpoint's URL and records the outcome on the webhook:
   * - a 2xx response (200 by convention) marks it `verified: true`;
   * - any other status — or a network error/timeout — marks it
   *   `verified: false`, so a stale or misconfigured endpoint is never left
   *   looking healthy.
   *
   * Handshake failures are reported through the returned result rather than
   * thrown: `result.verified` is the boolean answer for "is this endpoint
   * reachable?", while `statusCode`, `latencyMs`, `challenge` and `error`
   * explain what happened. Only a missing webhook or a missing fetch
   * implementation throws.
   *
   * @throws {WebhookError} If the webhook id is unknown or the runtime has no
   *   `fetch` implementation (and no `fetchImpl` override was supplied).
   */
  async verifyWebhook(
    webhookId: string,
    options: WebhookVerifyOptions = {},
  ): Promise<WebhookVerifyResult> {
    const stored = this.webhooks.get(webhookId);
    if (!stored) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }

    const challenge = generateChallenge();
    const body = JSON.stringify({
      type: WEBHOOK_VERIFY_PAYLOAD_TYPE,
      challenge,
      webhookId,
      timestamp: Date.now(),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CoralSwap-SDK/1.0 (+webhooks)',
      'X-Webhook-Verify': '1',
    };
    if (stored.secret) {
      headers[WEBHOOK_SIGNATURE_HEADER] = buildSignature(stored.secret, body);
    }

    const timeoutMs = options.timeoutMs ?? WEBHOOK_DEFAULTS.timeoutMs;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new WebhookError('no fetch implementation available in this environment', {
        webhookId,
      });
    }

    const start = Date.now();
    try {
      const response = await runWithTimeout(fetchImpl, stored.url, {
        method: 'POST',
        headers,
        body,
      }, timeoutMs);
      const latencyMs = Date.now() - start;
      const verified = response.status >= 200 && response.status < 300;
      this.setVerified(stored, verified);
      this.logger?.debug('webhooks.verifyWebhook: handshake completed', {
        webhookId,
        statusCode: response.status,
        verified,
        latencyMs,
      });
      return {
        verified,
        statusCode: response.status,
        latencyMs,
        challenge,
        ...(verified ? {} : { error: `endpoint returned status ${response.status}` }),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.setVerified(stored, false);
      this.logger?.warn?.('webhooks.verifyWebhook: handshake failed', {
        webhookId,
        latencyMs,
        error: message,
      });
      return {
        verified: false,
        statusCode: 0,
        latencyMs,
        challenge,
        error: message,
      };
    }
  }

  getWebhookHistory(
    webhookId: string,
    query: WebhookHistoryQuery = {},
  ): WebhookHistoryPage {
    const stored = this.webhooks.get(webhookId);
    if (!stored) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }

    const state = this.requireState(webhookId);
    const limit = clampLimit(query.limit);
    const total = state.history.length;

    let startIndex = total;
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      const decoded = decodeCursor(query.cursor);
      if (decoded !== null && decoded >= 0 && decoded <= total) {
        startIndex = total - decoded;
      }
    } else if (typeof query.offset === 'number' && query.offset >= 0) {
      startIndex = total - query.offset;
    }

    const sliceEnd = Math.max(0, startIndex - limit);
    const items = state.history.slice(sliceEnd, startIndex).reverse();
    const nextOffset = total - startIndex + items.length;
    const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : null;

    return {
      items,
      nextCursor,
      total,
    };
  }

  /** Whether the endpoint passed its most recent verification handshake. */
  isWebhookVerified(webhookId: string): boolean {
    return this.webhooks.get(webhookId)?.verified === true;
  }

  isWebhookDisabled(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    return state?.disabled === true;
  }

  /**
   * Disable a webhook so {@link sendWebhook} throws
   * {@link WebhookDisabledError} instead of delivering. The disable is marked
   * `manual`, which means a later {@link updateWebhook} that changes the url
   * will not silently re-enable it (only auto-disables are reversed that way).
   */
  disableWebhook(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    if (!state) return false;
    if (!state.disabled) {
      state.disabled = true;
      state.disabledReason = 'manual';
      state.disabledAt = Date.now();
      this.logger?.info('webhooks.disableWebhook: webhook disabled', { webhookId });
    }
    return true;
  }

  /** Re-enable a disabled webhook and clear its consecutive-failure counter. */
  enableWebhook(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    if (!state) return false;
    if (state.disabled || state.consecutiveFailures > 0) {
      state.disabled = false;
      state.consecutiveFailures = 0;
      delete state.disabledAt;
      delete state.disabledReason;
      this.logger?.info('webhooks.enableWebhook: webhook re-enabled', { webhookId });
    }
    return true;
  }

  getWebhookFailureCount(webhookId: string): number {
    return this.webhookState.get(webhookId)?.consecutiveFailures ?? 0;
  }

  deleteWebhook(webhookId: string): boolean {
    const existed = this.webhooks.delete(webhookId);
    this.webhookState.delete(webhookId);
    if (existed) {
      this.logger?.info('webhooks.deleteWebhook: removed', { webhookId });
    }
    return existed;
  }

  /**
   * List every registered webhook.
   *
   * Returns `Webhook` views — configuration plus `verified`, `failCount` and
   * `lastDelivery` — so callers can build a dashboard from one call. The
   * returned objects are defensive copies: mutating them does not affect the
   * module's state. (`await` on the sync return value is a no-op, so the
   * method reads naturally from async call sites.)
   */
  listWebhooks(): Webhook[] {
    return Array.from(this.webhooks.values()).map((w) => this.toWebhook(w));
  }

  /**
   * List the webhooks subscribed to `event`, i.e. the endpoints a delivery of
   * that event type would actually be attempted for
   * (see {@link sendWebhook}). Webhooks disabled by consecutive failures are
   * excluded, since a real dispatch would throw for them.
   */
  listWebhooksForEvent(event: WebhookEventName): Webhook[] {
    if (typeof event !== 'string' || event.trim().length === 0) {
      throw new ValidationError('webhook event must be a non-empty string', { event });
    }
    return this.listWebhooks().filter(
      (w) => w.events.includes(event) && !this.isWebhookDisabled(w.id),
    );
  }

  /** Read a single webhook as a `Webhook` view, or `undefined` if unknown. */
  getWebhook(webhookId: string): Webhook | undefined {
    const stored = this.webhooks.get(webhookId);
    return stored ? this.toWebhook(stored) : undefined;
  }

  clear(): void {
    this.webhooks.clear();
    this.webhookState.clear();
    this.payloads.clear();
    this.logger?.info('webhooks.clear: cleared all webhooks');
  }

  private async sendHttpRequest(
    endpoint: WebhookConfig,
    body: string,
    delivery: WebhookDelivery,
  ): Promise<void> {
    this.updateDeliveryStatus(delivery.id, 'delivering');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'CoralSwap-Webhook/1.0',
        ...endpoint.headers,
      };

      if (endpoint.secret) {
        const signature = createHmac('sha256', endpoint.secret)
          .update(body)
          .digest('hex');
        headers['X-CoralSwap-Signature'] = signature;
      }

      const response = await fetch(endpoint.url, {
        method: endpoint.method ?? 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const isSuccess = response.status >= 200 && response.status < 300;

      this.updateDeliveryStatus(delivery.id, isSuccess ? 'success' : 'failed', {
        httpStatus: response.status,
        completedAt: Math.floor(Date.now() / 1000),
      });

      this.recordDeliveryAttempt(delivery.webhookId, {
        ...delivery,
        status: isSuccess ? 'success' : 'failed',
      });

      if (isSuccess) {
        this.payloads.delete(delivery.id);
        return;
      }

      if (delivery.retryCount < 3) {
        await this.scheduleRetry(delivery.id, delivery.retryCount + 1);
      } else {
        this.updateDeliveryStatus(delivery.id, 'exhausted');
        this.payloads.delete(delivery.id);
      }
    } catch (err) {
      this.updateDeliveryStatus(delivery.id, 'failed', {
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        completedAt: Math.floor(Date.now() / 1000),
      });

      this.recordDeliveryAttempt(delivery.webhookId, {
        ...delivery,
        status: 'failed',
      });

      if (delivery.retryCount < 3) {
        await this.scheduleRetry(delivery.id, delivery.retryCount + 1);
      } else {
        this.updateDeliveryStatus(delivery.id, 'exhausted');
        this.payloads.delete(delivery.id);
      }
    }
  }

  private async scheduleRetry(
    deliveryId: string,
    attempt: number,
  ): Promise<void> {
    const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, Math.max(0, attempt - 1)));
    await sleep(backoffMs);
    if (!this.deliveries.has(deliveryId)) return;
    await this.retryDelivery(deliveryId);
  }

  private updateDeliveryStatus(
    deliveryId: string,
    status: WebhookDeliveryStatus,
    extra?: Partial<WebhookDelivery>,
  ): void {
    const existing = this.deliveries.get(deliveryId);
    if (!existing) return;
    this.deliveries.set(deliveryId, {
      ...existing,
      ...extra,
      status,
      retryCount:
        status === 'failed' || status === 'exhausted'
          ? existing.retryCount + 1
          : existing.retryCount,
    });
  }

  private recordDeliveryAttempt(
    webhookId: string,
    _delivery: WebhookDelivery,
  ): void {
    const health = this.healthCache.get(webhookId);
    if (!health) return;

    const allDeliveries = Array.from(this.deliveries.values()).filter(
      (d) => d.webhookId === webhookId,
    );
    const successful = allDeliveries.filter(
      (d) => d.status === 'success',
    ).length;
    const total = allDeliveries.length;

    health.totalDeliveries = total;
    health.successfulDeliveries = successful;
    health.failedDeliveries = total - successful;
    health.successRate = total > 0 ? successful / total : 1;
    health.lastDeliveryAt = Math.floor(Date.now() / 1000);

    this.healthCache.set(webhookId, health);
  }

  private loadPayload(deliveryId: string): string {
    const body = this.payloads.get(deliveryId);
    if (body === undefined) {
      throw new ValidationError(`Payload for delivery not found: ${deliveryId}`);
    }
    return body;
  }

  private requireState(webhookId: string): WebhookState {
    const state = this.webhookState.get(webhookId);
    if (!state) {
      throw new WebhookError(`webhook state missing: ${webhookId}`, { webhookId });
    }
    return state;
  }

  /** Build the public `Webhook` view (a copy) for a stored record. */
  private toWebhook(stored: StoredWebhook): Webhook {
    const state = this.webhookState.get(stored.id);
    return {
      ...stored,
      events: [...stored.events],
      failCount: state?.consecutiveFailures ?? 0,
      ...(state?.lastDelivery !== undefined ? { lastDelivery: state.lastDelivery } : {}),
    };
  }

  /**
   * Persist the outcome of a verification handshake on the stored webhook.
   * `stored` is the live record held by the module, so the flag is visible to
   * {@link listWebhooks}/{@link getWebhook} without a re-read.
   */
  private setVerified(stored: StoredWebhook, verified: boolean): void {
    if (stored.verified === verified) return;
    stored.verified = verified;
    this.logger?.info('webhooks.setVerified: verification state changed', {
      webhookId: stored.id,
      verified,
    });
  }

  /**
   * Clear the consecutive-failure counter after the webhook's target changed.
   * Only auto-disables are reversed here: a manual {@link disableWebhook} is an
   * explicit operator decision and must be undone explicitly too.
   */
  private resetFailureState(webhookId: string): void {
    const state = this.webhookState.get(webhookId);
    if (!state) return;
    state.consecutiveFailures = 0;
    if (state.disabled && state.disabledReason === 'auto') {
      state.disabled = false;
      delete state.disabledAt;
      delete state.disabledReason;
      this.logger?.info('webhooks.resetFailureState: re-enabled after endpoint change', {
        webhookId,
      });
    }
  }

  private recordTerminal(state: WebhookState, entry: WebhookHistoryEntry): void {
    state.history.push(entry);
    if (state.history.length > WEBHOOK_HISTORY_CAPACITY) {
      state.history.splice(0, state.history.length - WEBHOOK_HISTORY_CAPACITY);
    }
  }

  private recordOutcome(state: WebhookState, entry: WebhookHistoryEntry): void {
    this.recordTerminal(state, entry);
    state.lastDelivery = entry.timestamp;
    if (entry.outcome === 'success') {
      if (state.consecutiveFailures !== 0) {
        state.consecutiveFailures = 0;
      }
      return;
    }
    if (entry.outcome === 'client') {
      if (state.consecutiveFailures !== 0) {
        state.consecutiveFailures = 0;
      }
      return;
    }
    state.consecutiveFailures += 1;
    if (
      state.consecutiveFailures >= WEBHOOK_DISABLE_FAILURE_THRESHOLD &&
      !state.disabled
    ) {
      state.disabled = true;
      state.disabledReason = 'auto';
      state.disabledAt = Date.now();
      this.logger?.warn?.('webhooks.sendWebhook: auto-disabled after consecutive failures', {
        consecutiveFailures: state.consecutiveFailures,
        threshold: WEBHOOK_DISABLE_FAILURE_THRESHOLD,
      });
    }
  }
}

interface DeliveryOutcome {
  statusCode: number;
  delivered: boolean;
  networkError: boolean;
  error?: unknown;
}

interface OutcomeClassification {
  outcome: WebhookHistoryEntry['outcome'];
  errorMessage?: string;
}

async function attemptDelivery(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<DeliveryOutcome> {
  const init: RequestInit = {
    method: 'POST',
    headers,
    body,
  };

  try {
    const response = await runWithTimeout(fetchImpl, url, init, timeoutMs);
    const statusCode = response.status;
    const delivered = statusCode >= 200 && statusCode < 300;
    return { statusCode, delivered, networkError: false };
  } catch (err) {
    return {
      statusCode: 0,
      delivered: false,
      networkError: true,
      error: err,
    };
  }
}

async function runWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(
  outcome: DeliveryOutcome,
  attempt: number,
  maxRetries: number,
): boolean {
  if (attempt >= maxRetries) return false;

  if (outcome.networkError) return true;

  const code = outcome.statusCode;
  if (code === 429 || code === 408) return true;
  if (code >= 500 && code < 600) return true;
  return false;
}

function classifyOutcome(outcome: DeliveryOutcome): OutcomeClassification {
  if (outcome.networkError) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? '');
    return { outcome: 'network', errorMessage: message };
  }
  const code = outcome.statusCode;
  if (code >= 200 && code < 300) {
    return { outcome: 'success' };
  }
  if (code >= 500 && code < 600) {
    return { outcome: 'server', errorMessage: `server returned ${code}` };
  }
  return { outcome: 'client', errorMessage: `client returned ${code}` };
}

function computeBackoff(attempt: number, config: Required<Omit<WebhookOptions, 'fetchImpl' | 'event'>>): number {
  const raw = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(config.maxDelayMs, raw);
}

interface ResolvedOptions extends Required<Omit<WebhookOptions, 'fetchImpl' | 'event'>> {
  fetchImpl?: typeof fetch;
}

function resolveOptions(options: WebhookOptions): ResolvedOptions {
  return {
    maxRetries: options.maxRetries ?? WEBHOOK_DEFAULTS.maxRetries,
    baseDelayMs: options.baseDelayMs ?? WEBHOOK_DEFAULTS.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? WEBHOOK_DEFAULTS.maxDelayMs,
    backoffMultiplier: options.backoffMultiplier ?? WEBHOOK_DEFAULTS.backoffMultiplier,
    timeoutMs: options.timeoutMs ?? WEBHOOK_DEFAULTS.timeoutMs,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
}

function parseHttpsUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || parsed.hostname.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pickEvent(events: WebhookEventName[]): WebhookEventName | undefined {
  return events.length > 0 ? events[0] : undefined;
}

/**
 * Trim event names and drop duplicates while preserving subscription order:
 * `[' il ', 'price', 'il']` becomes `['il', 'price']`. Called only after every
 * entry has been validated as a non-empty string.
 */
function normalizeEvents(events: WebhookEventName[]): WebhookEventName[] {
  const seen = new Set<string>();
  const normalized: WebhookEventName[] = [];
  for (const event of events) {
    const name = event.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function buildSignature(secret: string, body: string): string {
  const digest = createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(body).digest('hex');
  return `${WEBHOOK_SIGNATURE_ALGORITHM}=${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateUUID(): string {
  try {
    return randomUUID();
  } catch {
    return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function generateChallenge(): string {
  try {
    return randomBytes(16).toString('hex');
  } catch {
    return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function createInitialState(): WebhookState {
  return {
    history: [],
    consecutiveFailures: 0,
    disabled: false,
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^o:(\d+)$/.exec(decoded);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
