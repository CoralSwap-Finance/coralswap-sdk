import { ValidationError } from '@/errors';
import {
  RegisterWebhookParams,
  UpdateWebhookParams,
  Webhook,
  WebhookEventType,
  WebhookStatus,
  WebhookVerificationResult,
} from '@/types/webhooks';

/** Maximum consecutive delivery failures before a webhook is auto-disabled. */
const AUTO_DISABLE_THRESHOLD = 5;

/** All supported event types — used as default subscription list. */
const ALL_EVENT_TYPES: WebhookEventType[] = [
  'swap',
  'liquidity_add',
  'liquidity_remove',
  'flash_loan',
  'price_alert',
  'fee_change',
];

/** Internal storage record augmenting the public Webhook shape. */
interface StoredWebhook extends Webhook {
  status: WebhookStatus;
}

/**
 * Minimal fetch-compatible interface used by WebhookModule.
 *
 * Accepting this as a constructor parameter keeps the module fully testable
 * without real HTTP calls.
 */
export interface FetchFn {
  (url: string, init: RequestInit): Promise<{ status: number }>;
}

/**
 * Manages webhook endpoint registration, verification, updates, and listing.
 *
 * @example
 * ```ts
 * import { WebhookModule } from '@coralswap/sdk';
 *
 * const webhooks = new WebhookModule();
 *
 * const { id } = await webhooks.registerWebhook({
 *   url: 'https://example.com/hooks/coralswap',
 *   events: ['swap', 'price_alert'],
 * });
 *
 * const result = await webhooks.verifyWebhook(id);
 * console.log('verified:', result.success);
 * ```
 */
export class WebhookModule {
  private readonly store: Map<string, StoredWebhook> = new Map();
  private readonly fetchFn: FetchFn;

  /**
   * @param fetchFn - Optional custom fetch implementation (useful in tests).
   *   Defaults to the global `fetch` when not provided.
   */
  constructor(fetchFn?: FetchFn) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as FetchFn);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a new webhook endpoint.
   *
   * The webhook is created in `unverified` status. Call {@link verifyWebhook}
   * to promote it to `active`.
   *
   * @param params - URL and optional event filter list.
   * @returns The newly created webhook.
   * @throws {ValidationError} If the URL is invalid or the event list contains
   *   unrecognised event types.
   */
  async registerWebhook(params: RegisterWebhookParams): Promise<Webhook> {
    this.validateUrl(params.url);

    const events = params.events ?? [...ALL_EVENT_TYPES];
    this.validateEventTypes(events);

    const id = generateId();
    const webhook: StoredWebhook = {
      id,
      url: params.url,
      events,
      verified: false,
      lastDelivery: null,
      failCount: 0,
      status: 'unverified',
    };

    this.store.set(id, webhook);
    return { ...webhook };
  }

  /**
   * Send a test payload to the endpoint and mark the webhook as verified on
   * HTTP 200, or unverified on any other outcome.
   *
   * @param webhookId - ID returned by {@link registerWebhook}.
   * @returns Verification outcome.
   * @throws {ValidationError} If the webhook ID does not exist.
   */
  async verifyWebhook(webhookId: string): Promise<WebhookVerificationResult> {
    const stored = this.requireWebhook(webhookId);

    const testPayload = {
      type: 'verification',
      webhookId,
      timestamp: new Date().toISOString(),
    };

    let statusCode: number | null = null;

    try {
      const response = await this.fetchFn(stored.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testPayload),
      });

      statusCode = response.status;

      if (response.status === 200) {
        stored.verified = true;
        stored.status = 'active';
        stored.failCount = 0;
        stored.lastDelivery = new Date().toISOString();
        return { success: true, statusCode };
      }

      // Non-200 — mark as unverified
      stored.verified = false;
      stored.status = 'unverified';
      return {
        success: false,
        statusCode,
        error: `Endpoint returned HTTP ${statusCode}`,
      };
    } catch (err) {
      stored.verified = false;
      stored.status = 'unverified';
      return {
        success: false,
        statusCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Update the URL or event filter list of an existing webhook.
   *
   * Changing the URL resets `verified` to `false` and status to `unverified`
   * because the new endpoint has not yet been confirmed.
   *
   * @param webhookId - ID of the webhook to update.
   * @param updates   - Fields to change (URL and/or events).
   * @returns The updated webhook snapshot.
   * @throws {ValidationError} If the webhook is not found, the new URL is
   *   invalid, or any event type is unrecognised.
   */
  async updateWebhook(
    webhookId: string,
    updates: UpdateWebhookParams,
  ): Promise<Webhook> {
    const stored = this.requireWebhook(webhookId);

    if (updates.url !== undefined) {
      this.validateUrl(updates.url);
      stored.url = updates.url;
      // Changing the URL invalidates the previous verification.
      stored.verified = false;
      stored.status = stored.status === 'disabled' ? 'disabled' : 'unverified';
    }

    if (updates.events !== undefined) {
      this.validateEventTypes(updates.events);
      stored.events = [...updates.events];
    }

    return { ...stored };
  }

  /**
   * Return all registered webhooks (all statuses).
   *
   * @returns Array of webhook snapshots ordered by insertion time.
   */
  async listWebhooks(): Promise<Webhook[]> {
    return Array.from(this.store.values()).map(w => ({ ...w }));
  }

  /**
   * Record a delivery attempt outcome for a webhook.
   *
   * Increments `failCount` on failure and auto-disables the webhook once
   * {@link AUTO_DISABLE_THRESHOLD} consecutive failures are reached. Resets
   * `failCount` to 0 on success.
   *
   * @param webhookId - Target webhook ID.
   * @param success   - Whether the delivery was acknowledged (HTTP 2xx).
   * @throws {ValidationError} If the webhook does not exist.
   */
  recordDelivery(webhookId: string, success: boolean): void {
    const stored = this.requireWebhook(webhookId);
    stored.lastDelivery = new Date().toISOString();

    if (success) {
      stored.failCount = 0;
    } else {
      stored.failCount += 1;
      if (stored.failCount > AUTO_DISABLE_THRESHOLD) {
        stored.status = 'disabled';
        stored.verified = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private requireWebhook(id: string): StoredWebhook {
    const stored = this.store.get(id);
    if (!stored) {
      throw new ValidationError(`Webhook not found: ${id}`, { id });
    }
    return stored;
  }

  private validateUrl(url: string): void {
    if (!url || typeof url !== 'string') {
      throw new ValidationError('Webhook URL must be a non-empty string', { url });
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ValidationError(
          'Webhook URL must use http or https protocol',
          { url },
        );
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError('Webhook URL is not a valid URL', { url });
    }
  }

  private validateEventTypes(events: WebhookEventType[]): void {
    if (!Array.isArray(events) || events.length === 0) {
      throw new ValidationError('events must be a non-empty array', { events });
    }
    for (const event of events) {
      if (!ALL_EVENT_TYPES.includes(event)) {
        throw new ValidationError(`Unrecognised event type: ${event}`, {
          event,
          valid: ALL_EVENT_TYPES,
        });
      }
    }
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
