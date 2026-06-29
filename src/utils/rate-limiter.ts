/**
 * Token-bucket rate limiter for throttling outbound RPC requests.
 *
 * Implements the classic token-bucket algorithm:
 *  - The bucket holds at most `capacity` tokens.
 *  - Tokens refill at `refillRate` tokens per `refillIntervalMs` milliseconds.
 *  - Each call to `acquire()` waits until a token is available, then consumes it.
 *  - Requests are served in FIFO order so starvation is impossible.
 */

export interface RateLimiterOptions {
  /** Maximum number of tokens the bucket can hold (burst size). */
  capacity: number;
  /** Number of tokens added per refill interval. */
  refillRate: number;
  /** Milliseconds between refills. */
  refillIntervalMs: number;
}

interface PendingRequest {
  resolve: () => void;
}

export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly refillIntervalMs: number;
  private lastRefillTime: number;
  private readonly queue: PendingRequest[] = [];
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RateLimiterOptions) {
    if (options.capacity <= 0) throw new Error('capacity must be > 0');
    if (options.refillRate <= 0) throw new Error('refillRate must be > 0');
    if (options.refillIntervalMs <= 0) throw new Error('refillIntervalMs must be > 0');

    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.refillIntervalMs = options.refillIntervalMs;
    this.tokens = options.capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Current number of tokens available (read-only snapshot).
   * Triggers an internal refill calculation to return the latest count.
   */
  get availableTokens(): number {
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
   * Requests are granted in FIFO order.
   */
  acquire(): Promise<void> {
    this._refill();

    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this._scheduleRefill();
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
   * Stop the internal refill timer and drain the pending queue.
   * Pending requests are resolved immediately (tokens are "gifted").
   */
  destroy(): void {
    if (this.refillTimer !== null) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    // Resolve all waiting requests so they don't leak
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
    const intervals = Math.floor(elapsed / this.refillIntervalMs);

    if (intervals > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + intervals * this.refillRate);
      this.lastRefillTime += intervals * this.refillIntervalMs;
    }
  }

  /** Start a periodic timer to flush the queue as tokens become available. */
  private _scheduleRefill(): void {
    if (this.refillTimer !== null) return;

    this.refillTimer = setInterval(() => {
      this._refill();
      this._flush();

      if (this.queue.length === 0) {
        clearInterval(this.refillTimer!);
        this.refillTimer = null;
      }
    }, this.refillIntervalMs);
  }

  /** Grant tokens to waiting requests in FIFO order. */
  private _flush(): void {
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!.resolve();
    }
  }
}
