import { ValidationError } from "@/errors";
import { Clock, SystemClock } from "./clock";
import {
  DisableReason,
  WebhookDelivery,
  WebhookDeliveryOutcome,
  WebhookEndpoint,
  WebhookPayload,
  WebhookTransport,
} from "./types";

/** Tunables for the schedule/retry/disable state machine. */
export interface RetryPolicyOptions {
  /** Delay before the first retry, in ms. Defaults to 1_000. */
  baseDelayMs?: number;
  /** Multiplier applied to the delay on each subsequent retry. Defaults to 2. */
  backoffMultiplier?: number;
  /** Upper bound on the computed backoff delay, in ms. Defaults to 5 minutes. */
  maxDelayMs?: number;
  /** Attempts allowed before a transient-failure delivery is disabled. Defaults to 10. */
  maxAttempts?: number;
  /** Consecutive 4xx responses before the endpoint is disabled. Defaults to 3. */
  maxConsecutiveClientErrors?: number;
}

interface RetryPolicy {
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
  maxConsecutiveClientErrors: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 10,
  maxConsecutiveClientErrors: 3,
};

export interface WebhookDeliveryQueueOptions {
  /** Time source for scheduling. Defaults to {@link SystemClock}. */
  clock?: Clock;
  retryPolicy?: RetryPolicyOptions;
}

/**
 * In-memory webhook delivery pipeline: enqueue a payload for an endpoint,
 * attempt delivery through a {@link WebhookTransport}, and apply the
 * schedule/retry/disable-on-4xx state machine to the outcome.
 *
 * - A transient failure (5xx status or a transport-level error) reschedules
 *   the same delivery -- same payload, incremented attempt count -- after an
 *   exponential backoff.
 * - A run of consecutive 4xx responses (a client-side, non-recoverable
 *   error) disables the endpoint once it reaches `maxConsecutiveClientErrors`
 *   and stops all of its pending deliveries.
 * - A 2xx response clears the delivery: it is marked `delivered` and drops
 *   out of the retry queue.
 *
 * Driven by an injected {@link Clock}, so tests can use a {@link FakeClock}
 * to assert the full lifecycle without real timers.
 */
export class WebhookDeliveryQueue {
  private readonly clock: Clock;
  private readonly policy: RetryPolicy;
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private endpointSeq = 0;
  private deliverySeq = 0;

  constructor(options: WebhookDeliveryQueueOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
  }

  /** Register a new delivery destination. */
  registerEndpoint(url: string): WebhookEndpoint {
    if (!url) {
      throw new ValidationError("Webhook endpoint URL is required");
    }
    this.endpointSeq += 1;
    const endpoint: WebhookEndpoint = {
      id: `whe_${this.endpointSeq}`,
      url,
      disabled: false,
      consecutiveClientErrors: 0,
    };
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  getEndpoint(endpointId: string): WebhookEndpoint | undefined {
    return this.endpoints.get(endpointId);
  }

  /** Enqueue a payload for immediate (next `processDue`) delivery. */
  enqueue(endpointId: string, payload: WebhookPayload): WebhookDelivery {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new ValidationError(`Unknown webhook endpoint: ${endpointId}`, {
        endpointId,
      });
    }
    if (endpoint.disabled) {
      throw new ValidationError(
        `Webhook endpoint ${endpointId} is disabled`,
        { endpointId },
      );
    }

    this.deliverySeq += 1;
    const now = this.clock.now();
    const delivery: WebhookDelivery = {
      id: `whd_${this.deliverySeq}`,
      endpointId,
      payload,
      createdAt: now,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
    };
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  getDelivery(deliveryId: string): WebhookDelivery | undefined {
    return this.deliveries.get(deliveryId);
  }

  listDeliveries(): WebhookDelivery[] {
    return Array.from(this.deliveries.values());
  }

  /** Deliveries eligible for an attempt right now: pending, due, active endpoint. */
  dueDeliveries(): WebhookDelivery[] {
    const now = this.clock.now();
    return this.listDeliveries().filter((delivery) => {
      if (delivery.status !== "pending") return false;
      if (delivery.nextAttemptAt > now) return false;
      const endpoint = this.endpoints.get(delivery.endpointId);
      return !!endpoint && !endpoint.disabled;
    });
  }

  /** Attempt every currently-due delivery against `transport`. */
  async processDue(transport: WebhookTransport): Promise<void> {
    for (const delivery of this.dueDeliveries()) {
      await this.attempt(delivery, transport);
    }
  }

  private async attempt(
    delivery: WebhookDelivery,
    transport: WebhookTransport,
  ): Promise<void> {
    const endpoint = this.endpoints.get(delivery.endpointId);
    if (!endpoint || endpoint.disabled) return;

    delivery.status = "in_flight";
    delivery.attempts += 1;

    const outcome = await transport.send(endpoint, delivery.payload);
    this.applyOutcome(delivery, endpoint, outcome);
  }

  private applyOutcome(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    outcome: WebhookDeliveryOutcome,
  ): void {
    const { statusCode, error } = outcome;
    delivery.lastStatusCode = statusCode;

    const isSuccess = statusCode !== undefined && statusCode >= 200 && statusCode < 300;
    if (isSuccess) {
      delivery.status = "delivered";
      delivery.lastError = undefined;
      endpoint.consecutiveClientErrors = 0;
      return;
    }

    const isClientError = statusCode !== undefined && statusCode >= 400 && statusCode < 500;
    if (isClientError) {
      delivery.lastError = undefined;
      endpoint.consecutiveClientErrors += 1;

      if (endpoint.consecutiveClientErrors >= this.policy.maxConsecutiveClientErrors) {
        this.disableEndpoint(endpoint, "persistent_client_error");
        return;
      }

      this.scheduleRetry(delivery);
      return;
    }

    // Transient failure: a 5xx status, or a transport-level error with no response.
    delivery.lastError = error?.message;
    endpoint.consecutiveClientErrors = 0;

    if (delivery.attempts >= this.policy.maxAttempts) {
      this.disableEndpoint(endpoint, "max_attempts_exceeded");
      return;
    }

    this.scheduleRetry(delivery);
  }

  private scheduleRetry(delivery: WebhookDelivery): void {
    const backoff = Math.min(
      this.policy.maxDelayMs,
      this.policy.baseDelayMs * Math.pow(this.policy.backoffMultiplier, delivery.attempts - 1),
    );
    delivery.status = "pending";
    delivery.nextAttemptAt = this.clock.now() + backoff;
  }

  private disableEndpoint(endpoint: WebhookEndpoint, reason: DisableReason): void {
    endpoint.disabled = true;
    endpoint.disabledReason = reason;

    for (const delivery of this.deliveries.values()) {
      if (
        delivery.endpointId === endpoint.id &&
        (delivery.status === "pending" || delivery.status === "in_flight")
      ) {
        delivery.status = "disabled";
        delivery.disabledReason = reason;
      }
    }
  }
}
