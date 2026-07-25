/**
 * Token-bucket rate limiter for throttling outbound RPC requests.
 *
 * Implements the token-bucket algorithm with configurable sustained rate
 * and burst capacity.  Uses `setTimeout` internally — no CPU spinning.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 20 });
 *
 * // Each call to acquire() consumes one token, blocking until one is available.
 * await limiter.acquire();
 * await someRpcCall();
 *
 * // Check remaining capacity without consuming.
 * console.log(limiter.getRemainingCapacity());
 * ```
 */

export interface RateLimiterOptions {
  /** Maximum sustained requests per second (e.g. 10). */
  maxRequestsPerSecond: number;
  /** Maximum number of tokens the bucket can hold (burst size). */
  maxBurst: number;
}

interface PendingRequest {
  resolve: () => void;
}

export class RateLimiter {
  private tokens: number;
  private readonly maxBurst: number;
  private readonly maxRequestsPerSecond: number;
  private lastRefillTime: number;
  private readonly queue: PendingRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RateLimiterOptions) {
    if (options.maxRequestsPerSecond <= 0) throw new Error('maxRequestsPerSecond must be > 0');
    if (options.maxBurst <= 0) throw new Error('maxBurst must be > 0');

    this.maxRequestsPerSecond = options.maxRequestsPerSecond;
    this.maxBurst = options.maxBurst;
    this.tokens = options.maxBurst;
    this.lastRefillTime = Date.now();
  }

  /**
   * Number of tokens currently available (read-only snapshot).
   * Triggers an internal refill calculation so the value is current.
   */
  getRemainingCapacity(): number {
    this._refill();
    return this.tokens;
  }

  /**
   * Number of requests waiting for a token.
   */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Consume one token, waiting if none are available.
   *
   * Returns a Promise that resolves once the token has been granted.
   * Requests are granted in FIFO order so starvation is impossible.
   */
  acquire(): Promise<void> {
    this._refill();

    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this._scheduleNext();
    });
  }

  /**
   * Attempt to consume one token without waiting.
   *
   * @returns `true` if a token was consumed, `false` if the bucket is empty.
   */
  tryAcquire(): boolean {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Stop the internal timer and drain the pending queue.
   * Pending requests are resolved immediately (tokens are "gifted").
   */
  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const pending of this.queue.splice(0)) {
      pending.resolve();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Compute tokens earned since last refill and add them to the bucket. */
  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd = Math.floor((elapsed * this.maxRequestsPerSecond) / 1000);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxBurst, this.tokens + tokensToAdd);
      this.lastRefillTime += Math.floor((tokensToAdd * 1000) / this.maxRequestsPerSecond);
    }
  }

  /** Schedule a one-shot timer to flush the queue when the next token arrives. */
  private _scheduleNext(): void {
    if (this.timer !== null) return;

    const delay = Math.max(1, Math.ceil(1000 / this.maxRequestsPerSecond));
    this.timer = setTimeout(() => {
      this.timer = null;
      this._refill();
      this._flush();
      if (this.queue.length > 0 && this.tokens < 1) {
        this._scheduleNext();
      }
    }, delay);
  }

  /** Grant tokens to waiting requests in FIFO order. */
  private _flush(): void {
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!.resolve();
    }
  }
}
