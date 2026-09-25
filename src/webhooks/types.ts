/**
 * Lifecycle state of a single webhook delivery attempt sequence.
 *
 * - `pending` -- enqueued or scheduled for a (re)attempt at `nextAttemptAt`.
 * - `in_flight` -- an attempt is currently being sent.
 * - `delivered` -- terminal; the endpoint acknowledged with a 2xx response.
 * - `disabled` -- terminal; retries were abandoned (see {@link DisableReason}).
 */
export type DeliveryStatus = "pending" | "in_flight" | "delivered" | "disabled";

/** Why a delivery (and its endpoint) stopped receiving retries. */
export type DisableReason = "persistent_client_error" | "max_attempts_exceeded";

/**
 * A registered destination for webhook deliveries.
 *
 * Tracks its own consecutive-4xx count so the queue can decide when a run of
 * client errors has become "persistent" enough to disable the endpoint.
 */
export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  disabled: boolean;
  disabledReason?: DisableReason;
  consecutiveClientErrors: number;
}

/** Arbitrary JSON-serialisable body delivered to a webhook endpoint. */
export type WebhookPayload = Record<string, unknown>;

/** A single queued delivery and its retry bookkeeping. */
export interface WebhookDelivery {
  readonly id: string;
  readonly endpointId: string;
  /** The original payload, unchanged across every retry attempt. */
  readonly payload: WebhookPayload;
  readonly createdAt: number;
  status: DeliveryStatus;
  attempts: number;
  /** Epoch ms at which this delivery becomes eligible for its next attempt. */
  nextAttemptAt: number;
  lastStatusCode?: number;
  lastError?: string;
  disabledReason?: DisableReason;
}

/** Result of a single delivery attempt against an endpoint. */
export interface WebhookDeliveryOutcome {
  /** HTTP status code returned by the endpoint, when a response was received. */
  statusCode?: number;
  /** Transport-level failure (network error, timeout) when no response was received. */
  error?: Error;
}

/** Sends a webhook payload to an endpoint and reports the outcome. */
export interface WebhookTransport {
  send(
    endpoint: WebhookEndpoint,
    payload: WebhookPayload,
  ): Promise<WebhookDeliveryOutcome>;
}
