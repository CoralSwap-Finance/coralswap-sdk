import { WebhookDeliveryOutcome, WebhookEndpoint, WebhookPayload, WebhookTransport } from "./types";

export interface FetchWebhookTransportOptions {
  /** Abort an attempt after this many ms. Defaults to 10_000. */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

/**
 * Default {@link WebhookTransport} that POSTs the JSON-encoded payload to the
 * endpoint URL over HTTP.
 *
 * Network failures and timeouts are captured as `{ error }` outcomes rather
 * than thrown, so the delivery queue's state machine can decide how to react
 * without every caller needing a try/catch.
 */
export class FetchWebhookTransport implements WebhookTransport {
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: FetchWebhookTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.headers = options.headers ?? {};
  }

  async send(
    endpoint: WebhookEndpoint,
    payload: WebhookPayload,
  ): Promise<WebhookDeliveryOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { statusCode: response.status };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }
}
