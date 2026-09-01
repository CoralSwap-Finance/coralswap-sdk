/**
 * Round-robin connection pool for Soroban RPC endpoints.
 *
 * Manages a list of RPC endpoint URLs and distributes requests across them
 * using a round-robin strategy.  Failed endpoints are marked unhealthy and
 * skipped until they recover (health probe on next cycle).
 *
 * Design decisions
 * ----------------
 *  - Round-robin is stateless and fair across healthy endpoints.
 *  - An endpoint is marked unhealthy after `failureThreshold` consecutive
 *    failures.  It is automatically promoted back to healthy after
 *    `recoveryTimeMs` milliseconds (probe-based recovery).
 *  - If all endpoints are unhealthy, `getEndpoint()` throws `PoolExhaustedError`
 *    so callers get an actionable error immediately instead of a silent hang.
 */

export class PoolExhaustedError extends Error {
  constructor() {
    super('ConnectionPool: all endpoints are unhealthy');
    this.name = 'PoolExhaustedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ConnectionPoolOptions {
  /** After this many consecutive failures an endpoint is marked unhealthy. */
  failureThreshold?: number;
  /** Milliseconds before an unhealthy endpoint is re-tried. */
  recoveryTimeMs?: number;
}

interface EndpointState {
  url: string;
  consecutiveFailures: number;
  unhealthyAt: number | null;
}

export class ConnectionPool {
  private readonly endpoints: EndpointState[];
  private readonly failureThreshold: number;
  private readonly recoveryTimeMs: number;
  /** Index used by round-robin. Points into the *original* endpoints array. */
  private rrIndex: number = 0;

  constructor(urls: string[], options: ConnectionPoolOptions = {}) {
    if (!urls || urls.length === 0) {
      throw new Error('ConnectionPool requires at least one URL');
    }

    this.failureThreshold = options.failureThreshold ?? 3;
    this.recoveryTimeMs = options.recoveryTimeMs ?? 30_000;

    this.endpoints = urls.map((url) => ({
      url,
      consecutiveFailures: 0,
      unhealthyAt: null,
    }));
  }

  /**
   * Total number of endpoints in the pool (healthy + unhealthy).
   */
  get size(): number {
    return this.endpoints.length;
  }

  /**
   * Return the next healthy endpoint URL using round-robin selection.
   *
   * @throws {PoolExhaustedError} if no healthy endpoint is available.
   */
  getEndpoint(nowMs: number = Date.now()): string {
    // One full pass through all endpoints looking for a healthy one
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.rrIndex + i) % this.endpoints.length;
      const ep = this.endpoints[idx];

      if (this._isHealthy(ep, nowMs)) {
        // Advance round-robin pointer past this index for the next call
        this.rrIndex = (idx + 1) % this.endpoints.length;
        return ep.url;
      }
    }

    throw new PoolExhaustedError();
  }

  /**
   * Report a successful call to the given URL.
   * Resets consecutive failure count so the endpoint stays healthy.
   */
  reportSuccess(url: string): void {
    const ep = this._find(url);
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.unhealthyAt = null;
  }

  /**
   * Report a failed call to the given URL.
   * If `failureThreshold` is reached the endpoint is marked unhealthy.
   */
  reportFailure(url: string, nowMs: number = Date.now()): void {
    const ep = this._find(url);
    if (!ep) return;
    ep.consecutiveFailures += 1;
    if (ep.consecutiveFailures >= this.failureThreshold) {
      ep.unhealthyAt = nowMs;
    }
  }

  /**
   * Manually mark an endpoint as healthy again (e.g. after an external health probe).
   */
  markHealthy(url: string): void {
    const ep = this._find(url);
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.unhealthyAt = null;
  }

  /**
   * Returns a snapshot of healthy endpoint URLs at the current time.
   */
  healthyEndpoints(nowMs: number = Date.now()): string[] {
    return this.endpoints.filter((ep) => this._isHealthy(ep, nowMs)).map((ep) => ep.url);
  }

  /**
   * Returns a snapshot of unhealthy endpoint URLs at the current time.
   */
  unhealthyEndpoints(nowMs: number = Date.now()): string[] {
    return this.endpoints.filter((ep) => !this._isHealthy(ep, nowMs)).map((ep) => ep.url);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _isHealthy(ep: EndpointState, nowMs: number): boolean {
    if (ep.unhealthyAt === null) return true;
    // Auto-recover after recoveryTimeMs
    return nowMs - ep.unhealthyAt >= this.recoveryTimeMs;
  }

  private _find(url: string): EndpointState | undefined {
    return this.endpoints.find((ep) => ep.url === url);
  }
}
