import { ConnectionPoolExhaustedError } from "@/errors";

const DEFAULT_FAILURE_TIMEOUT_MS = 30_000;

export interface ConnectionPoolOptions {
  failureTimeoutMs?: number;
}

/**
 * Round-robin connection pool with health-check-based failover.
 *
 * Endpoints that are marked as failed are temporarily excluded from
 * rotation for `failureTimeoutMs` (default 30s). After the timeout
 * the endpoint is automatically retried on the next selection.
 */
export class ConnectionPool {
  private readonly endpoints: string[] = [];
  private readonly failedAt: Map<string, number> = new Map();
  private readonly failureTimeoutMs: number;
  private currentIndex: number = 0;

  constructor(options?: ConnectionPoolOptions) {
    this.failureTimeoutMs = options?.failureTimeoutMs ?? DEFAULT_FAILURE_TIMEOUT_MS;
  }

  /**
   * Add an endpoint to the pool. Duplicates are ignored.
   */
  addEndpoint(url: string): void {
    if (!this.endpoints.includes(url)) {
      this.endpoints.push(url);
    }
  }

  /**
   * Remove an endpoint from the pool and clear any failure state.
   */
  removeEndpoint(url: string): void {
    const idx = this.endpoints.indexOf(url);
    if (idx === -1) return;

    this.endpoints.splice(idx, 1);
    this.failedAt.delete(url);

    if (this.endpoints.length > 0) {
      this.currentIndex = this.currentIndex % this.endpoints.length;
    } else {
      this.currentIndex = 0;
    }
  }

  /**
   * Mark an endpoint as failed. The endpoint will be skipped for
   * `failureTimeoutMs` before it is retried automatically.
   */
  markFailed(url: string): void {
    this.failedAt.set(url, Date.now());
  }

  /**
   * Return the next healthy endpoint in round-robin order.
   *
   * @throws ConnectionPoolExhaustedError if no healthy endpoints are available.
   */
  getNextEndpoint(): string {
    const len = this.endpoints.length;
    if (len === 0) {
      throw new ConnectionPoolExhaustedError("No endpoints available in the connection pool");
    }

    const startIndex = this.currentIndex;
    for (let i = 0; i < len; i++) {
      const idx = (startIndex + i) % len;
      const endpoint = this.endpoints[idx];
      if (!this.isFailed(endpoint)) {
        this.currentIndex = (idx + 1) % len;
        return endpoint;
      }
    }

    throw new ConnectionPoolExhaustedError("No healthy endpoints available");
  }

  /**
   * List currently healthy endpoints (not failed or past the timeout).
   */
  getHealthyEndpoints(): string[] {
    return this.endpoints.filter((url) => !this.isFailed(url));
  }

  private isFailed(url: string): boolean {
    const failedAt = this.failedAt.get(url);
    if (failedAt === undefined) return false;
    if (Date.now() - failedAt >= this.failureTimeoutMs) {
      this.failedAt.delete(url);
      return false;
    }
    return true;
  }
}
