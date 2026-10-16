export type WebhookMethod = 'POST' | 'PUT' | 'PATCH';

export type WebhookPayloadFormat = 'json' | 'form';

export type WebhookDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'success'
  | 'failed'
  | 'exhausted';

export interface WebhookConfig {
  url: string;
  method?: WebhookMethod;
  payloadFormat?: WebhookPayloadFormat;
  headers?: Record<string, string>;
  secret?: string;
  label?: string;
  alertFilter?: string[];
  enabled?: boolean;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  alertId: string;
  status: WebhookDeliveryStatus;
  httpStatus?: number;
  sentAt: number;
  completedAt?: number;
  retryCount: number;
  errorMessage?: string;
}

export interface WebhookEndpointHealth {
  webhookId: string;
  url: string;
  enabled: boolean;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  successRate: number;
  averageResponseTimeMs: number;
  lastDeliveryAt?: number;
}

export type WebhookDeliveryStatusLegacy = 'pending' | 'delivering' | 'success' | 'failed' | 'exhausted';

export interface WebhookConfigLegacy {
  url: string;
  method?: WebhookMethod;
  payloadFormat?: WebhookPayloadFormat;
  headers?: Record<string, string>;
  secret?: string;
  label?: string;
  alertFilter?: string[];
  enabled?: boolean;
}

export interface WebhookDeliveryLegacy {
  id: string;
  webhookId: string;
  alertId: string;
  status: WebhookDeliveryStatusLegacy;
  httpStatus?: number;
  sentAt: number;
  completedAt?: number;
  retryCount: number;
  errorMessage?: string;
}

export interface WebhookEndpointHealthLegacy {
  webhookId: string;
  url: string;
  enabled: boolean;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  successRate: number;
  averageResponseTimeMs: number;
  lastDeliveryAt?: number;
}

export type WebhookEventName = string;

export interface WebhookConfigV2 {
  url: string;
  events: WebhookEventName[];
  secret?: string;
}

export type WebhookPayload<T = Record<string, unknown>> = T;

export interface WebhookEnvelope<T = Record<string, unknown>> {
  id: string;
  timestamp: number;
  event?: WebhookEventName;
  data: T;
}

export interface WebhookDeliveryResult {
  statusCode: number;
  delivered: boolean;
  retryCount: number;
  /**
   * Present and `true` only when the delivery was never attempted because
   * the event's type is not among the webhook's subscribed `events`
   * (see {@link WebhookOptions.event}). Undefined for every real attempt,
   * so the field is safe to ignore.
   */
  filtered?: boolean;
}

export interface WebhookOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Type of the event being dispatched. The webhook only fires when this
   * value is among its subscribed `events`; when omitted the first
   * subscribed event is used (legacy behaviour).
   */
  event?: WebhookEventName;
}

/**
 * Mutable subset of a registered webhook accepted by
 * {@link WebhookModule.updateWebhook}. Anything omitted is left untouched.
 */
export type WebhookUpdate = Partial<Pick<WebhookConfigV2, 'url' | 'events' | 'secret'>>;

export interface StoredWebhook extends WebhookConfigV2 {
  id: string;
  createdAt: number;
  /** Epoch-ms timestamp of the last {@link WebhookModule.updateWebhook} call. */
  updatedAt?: number;
  /**
   * Whether the endpoint passed its most recent verification handshake.
   *
   * A freshly registered webhook starts `false` (registration is a purely
   * local operation and performs no network I/O) and only flips to `true`
   * once `verifyWebhook()` receives a 2xx from the endpoint. A failed
   * handshake — or a change of `url`, which invalidates any previous
   * evidence about the endpoint — sets it back to `false`.
   */
  verified: boolean;
}

/**
 * Public view of a registered webhook: its configuration plus the live
 * delivery state used to decide whether it is still healthy.
 */
export interface Webhook extends StoredWebhook {
  /**
   * Consecutive delivery failures. Reset to `0` by any successful
   * delivery and by re-enabling the webhook; once it reaches
   * {@link WEBHOOK_DISABLE_FAILURE_THRESHOLD} the webhook is auto-disabled.
   */
  failCount: number;
  /** Epoch-ms timestamp of the most recent delivery attempt, if any. */
  lastDelivery?: number;
}

export const WEBHOOK_SIGNATURE_HEADER = 'X-Signature';
export const WEBHOOK_SIGNATURE_ALGORITHM = 'sha256';
export const WEBHOOK_DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  timeoutMs: 10_000,
} as const;

export const WEBHOOK_DISABLE_FAILURE_THRESHOLD = 5;
export const WEBHOOK_HISTORY_CAPACITY = 500;
export const WEBHOOK_VERIFY_PAYLOAD_TYPE = 'webhook.verify' as const;

export interface WebhookVerifyResult {
  verified: boolean;
  statusCode: number;
  latencyMs: number;
  challenge: string;
  error?: string;
}

export interface WebhookVerifyOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WebhookHistoryEntry {
  deliveryId: string;
  timestamp: number;
  statusCode: number;
  delivered: boolean;
  attempts: number;
  retryCount: number;
  outcome: 'success' | 'network' | 'client' | 'server';
  errorMessage?: string;
}

export interface WebhookHistoryQuery {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface WebhookHistoryPage {
  items: WebhookHistoryEntry[];
  nextCursor: string | null;
  total: number;
}
