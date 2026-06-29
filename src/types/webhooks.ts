/** Event types that a webhook can subscribe to. */
export type WebhookEventType =
  | 'swap'
  | 'liquidity_add'
  | 'liquidity_remove'
  | 'flash_loan'
  | 'price_alert'
  | 'fee_change';

/** Current lifecycle state of a registered webhook. */
export type WebhookStatus = 'active' | 'unverified' | 'disabled';

/**
 * A registered webhook endpoint.
 *
 * `failCount` tracks consecutive delivery failures; the webhook is
 * auto-disabled once it exceeds the configured threshold (default 5).
 */
export interface Webhook {
  /** Unique identifier assigned at registration time. */
  id: string;
  /** Target URL that receives POST payloads. */
  url: string;
  /** Event types that trigger a delivery to this endpoint. */
  events: WebhookEventType[];
  /** Whether the endpoint has passed the verification handshake. */
  verified: boolean;
  /** ISO-8601 timestamp of the most recent delivery attempt, or null. */
  lastDelivery: string | null;
  /** Number of consecutive delivery failures since the last success. */
  failCount: number;
  /** Current lifecycle status of the webhook. */
  status: WebhookStatus;
}

/** Parameters accepted by `registerWebhook`. */
export interface RegisterWebhookParams {
  /** HTTPS URL that will receive event payloads. */
  url: string;
  /**
   * Event types to subscribe to.
   * Defaults to all event types when omitted.
   */
  events?: WebhookEventType[];
}

/** Fields that may be changed via `updateWebhook`. */
export interface UpdateWebhookParams {
  /** New target URL. */
  url?: string;
  /** Replacement event filter list. */
  events?: WebhookEventType[];
}

/** Outcome returned by `verifyWebhook`. */
export interface WebhookVerificationResult {
  /** Whether the test payload was acknowledged with HTTP 200. */
  success: boolean;
  /** HTTP status received from the endpoint, or null on network error. */
  statusCode: number | null;
  /** Error message when `success` is false. */
  error?: string;
}
