import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  WebhookConfig,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpointHealth,
  StoredWebhook,
  WebhookDeliveryResult,
  WebhookEnvelope,
  WebhookEventName,
  WebhookHistoryEntry,
  WebhookHistoryPage,
  WebhookHistoryQuery,
  WebhookOptions,
  WebhookPayload,
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
}

export class WebhookModule {
  private readonly endpoints: Map<string, WebhookConfig> = new Map();
  private readonly deliveries: Map<string, WebhookDelivery> = new Map();
  private readonly healthCache: Map<string, WebhookEndpointHealth> = new Map();
  private readonly webhooks: Map<string, StoredWebhook> = new Map();
  private readonly webhookState: Map<string, WebhookState> = new Map();
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
    const body = JSON.stringify(this.loadPayload(deliveryId));
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
      if (typeof event !== 'string' || event.length === 0) {
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
      events: [...events],
      ...(secret !== undefined ? { secret } : {}),
      createdAt: Date.now(),
    };
    this.webhooks.set(id, stored);
    this.webhookState.set(id, createInitialState());

    this.logger?.info('webhooks.registerWebhook: registered', {
      id,
      url: stored.url,
      events: stored.events,
      signed: secret !== undefined,
    });

    return id;
  }

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

    const config = resolveOptions(options);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new WebhookError('no fetch implementation available in this environment', {
        webhookId,
      });
    }

    const event = pickEvent(stored.events);
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

  isWebhookDisabled(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    return state?.disabled === true;
  }

  disableWebhook(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    if (!state) return false;
    if (!state.disabled) {
      state.disabled = true;
      state.disabledAt = Date.now();
      this.logger?.info('webhooks.disableWebhook: webhook disabled', { webhookId });
    }
    return true;
  }

  enableWebhook(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    if (!state) return false;
    if (state.disabled || state.consecutiveFailures > 0) {
      state.disabled = false;
      state.consecutiveFailures = 0;
      delete state.disabledAt;
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

  listWebhooks(): StoredWebhook[] {
    return Array.from(this.webhooks.values()).map((w) => ({
      ...w,
      events: [...w.events],
      ...(w.secret ? { secret: w.secret } : {}),
    }));
  }

  getWebhook(webhookId: string): StoredWebhook | undefined {
    return this.webhooks.get(webhookId);
  }

  clear(): void {
    this.webhooks.clear();
    this.webhookState.clear();
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

      if (!isSuccess && delivery.retryCount < 3) {
        await this.scheduleRetry(delivery.id, delivery.retryCount + 1);
      } else if (!isSuccess) {
        this.updateDeliveryStatus(delivery.id, 'exhausted');
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
      }
    }
  }

  private async scheduleRetry(
    _deliveryId: string,
    _attempt: number,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  private loadPayload(_deliveryId: string): Record<string, unknown> {
    return {};
  }

  private requireState(webhookId: string): WebhookState {
    const state = this.webhookState.get(webhookId);
    if (!state) {
      throw new WebhookError(`webhook state missing: ${webhookId}`, { webhookId });
    }
    return state;
  }

  private recordTerminal(state: WebhookState, entry: WebhookHistoryEntry): void {
    state.history.push(entry);
    if (state.history.length > WEBHOOK_HISTORY_CAPACITY) {
      state.history.splice(0, state.history.length - WEBHOOK_HISTORY_CAPACITY);
    }
  }

  private recordOutcome(state: WebhookState, entry: WebhookHistoryEntry): void {
    this.recordTerminal(state, entry);
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

function computeBackoff(attempt: number, config: Required<Omit<WebhookOptions, 'fetchImpl'>>): number {
  const raw = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(config.maxDelayMs, raw);
}

interface ResolvedOptions extends Required<Omit<WebhookOptions, 'fetchImpl'>> {
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
