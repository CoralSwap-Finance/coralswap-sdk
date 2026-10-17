/**
 * Unit tests for RateLimiter (token-bucket algorithm).
 *
 * All tests use Jest fake timers so there are no real delays and timing
 * assertions stay deterministic and fast.
 */

import { RateLimiter, RateLimiterDestroyedError } from '../src/utils/rate-limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Advance fake timers AND flush microtask queue so that Promise continuations
 * scheduled inside RateLimiter timer callbacks have a chance to run.
 */
async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------

  describe('constructor validation', () => {
    it('throws when maxRequestsPerSecond is 0', () => {
      expect(
        () => new RateLimiter({ maxRequestsPerSecond: 0, maxBurst: 5 }),
      ).toThrow('maxRequestsPerSecond must be > 0');
    });

    it('throws when maxRequestsPerSecond is negative', () => {
      expect(
        () => new RateLimiter({ maxRequestsPerSecond: -1, maxBurst: 5 }),
      ).toThrow('maxRequestsPerSecond must be > 0');
    });

    it('throws when maxBurst is 0', () => {
      expect(
        () => new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 0 }),
      ).toThrow('maxBurst must be > 0');
    });

    it('throws when maxBurst is negative', () => {
      expect(
        () => new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: -1 }),
      ).toThrow('maxBurst must be > 0');
    });
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts with maxBurst tokens', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 5 });
      expect(limiter.getRemainingCapacity()).toBe(5);
      limiter.destroy();
    });

    it('reports zero items in queue initially', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      expect(limiter.queueLength).toBe(0);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // tryAcquire — non-blocking token consumption
  // -------------------------------------------------------------------------

  describe('tryAcquire()', () => {
    it('returns true and decrements token count when tokens are available', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.getRemainingCapacity()).toBe(2);
      limiter.destroy();
    });

    it('returns false when bucket is empty', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 1 });
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
      limiter.destroy();
    });

    it('can drain all tokens to zero', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.getRemainingCapacity()).toBe(0);
      expect(limiter.tryAcquire()).toBe(false);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Token-bucket refill accuracy
  // -------------------------------------------------------------------------

  describe('token refill accuracy', () => {
    it('replenishes tokens after one refill interval', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);

      await tick(100);

      expect(limiter.getRemainingCapacity()).toBe(1);
      limiter.destroy();
    });

    it('does not exceed maxBurst when multiple intervals elapse', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      await tick(1000);

      expect(limiter.getRemainingCapacity()).toBe(3);
      limiter.destroy();
    });

    it('adds multiple tokens per interval when maxRequestsPerSecond > 1', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 30, maxBurst: 10 });
      for (let i = 0; i < 10; i++) limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);

      await tick(100);

      expect(limiter.getRemainingCapacity()).toBe(3);
      limiter.destroy();
    });

    it('accrues sub-interval elapsed time and pays it out on the next boundary (no token loss)', async () => {
      // 10 rps → one token per 100ms. Drain, then advance 150ms: only one
      // full interval has elapsed, so exactly 1 token is minted and 50ms of
      // credit is carried over via lastRefillTime.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 5 });
      for (let i = 0; i < 5; i++) limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);

      await tick(150);
      expect(limiter.getRemainingCapacity()).toBe(1);

      // Next boundary only needs the remaining 50ms of carried-over credit.
      await tick(50);
      expect(limiter.getRemainingCapacity()).toBe(2);

      limiter.destroy();
    });

    it('rounds refill down: sub-threshold elapsed time mints no token and no credit is lost', async () => {
      // 5 rps → one token per 200ms. 199ms is just under the boundary.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 5, maxBurst: 2 });
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);

      await tick(199);
      expect(limiter.getRemainingCapacity()).toBe(0);

      // The 199ms of credit was preserved — a further 1ms crosses the boundary.
      await tick(1);
      expect(limiter.getRemainingCapacity()).toBe(1);

      limiter.destroy();
    });

    it('caps refill at maxBurst without distorting the refill clock', async () => {
      // 10 rps, burst 3. Waiting 1s earns 10 tokens but only 3 fit; the refill
      // clock must still advance by the full token-earning time so the next
      // interval starts from a consistent boundary.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      for (let i = 0; i < 3; i++) limiter.tryAcquire();

      await tick(1000);
      expect(limiter.getRemainingCapacity()).toBe(3); // capped, not 10

      // Immediately after the cap, draining and waiting one interval yields
      // exactly one more token — the clock did not double-count the cap.
      for (let i = 0; i < 3; i++) limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);

      await tick(100);
      expect(limiter.getRemainingCapacity()).toBe(1);

      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Burst behaviour
  // -------------------------------------------------------------------------

  describe('burst behaviour', () => {
    it('allows up to maxBurst requests immediately without waiting', async () => {
      const burst = 5;
      const limiter = new RateLimiter({ maxRequestsPerSecond: 1, maxBurst: burst });
      const results: boolean[] = [];

      for (let i = 0; i < burst; i++) {
        results.push(limiter.tryAcquire());
      }

      expect(results).toEqual([true, true, true, true, true]);
      expect(limiter.getRemainingCapacity()).toBe(0);
      limiter.destroy();
    });

    it('rejects the (maxBurst + 1)th tryAcquire in a burst', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 1, maxBurst: 2 });
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // acquire() — async FIFO ordering
  // -------------------------------------------------------------------------

  describe('acquire() — FIFO ordering', () => {
    it('resolves immediately when tokens are available', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      const resolved = jest.fn();

      limiter.acquire().then(resolved);
      await Promise.resolve();

      expect(resolved).toHaveBeenCalledTimes(1);
      limiter.destroy();
    });

    it('queues requests when bucket is empty', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 1 });
      limiter.tryAcquire();

      const resolved = jest.fn();
      const rejected = jest.fn();
      limiter.acquire().then(resolved, rejected);
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled();
      expect(limiter.queueLength).toBe(1);

      limiter.destroy();
      await Promise.resolve();

      // Destroy rejects the queued waiter instead of granting it a token.
      expect(resolved).not.toHaveBeenCalled();
      expect(rejected).toHaveBeenCalledTimes(1);
    });

    it('resolves queued requests in FIFO order after refill', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 1 });
      limiter.tryAcquire();

      const order: number[] = [];
      limiter.acquire().then(() => order.push(1));
      limiter.acquire().then(() => order.push(2));
      limiter.acquire().then(() => order.push(3));

      await tick(100);
      await tick(100);
      await tick(100);

      expect(order).toEqual([1, 2, 3]);
      limiter.destroy();
    });

    it('handles multiple concurrent acquire() calls within burst capacity', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      const promises = [limiter.acquire(), limiter.acquire(), limiter.acquire()];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance: enforces rate limit without exceeding by more than 1 request
  // -------------------------------------------------------------------------

  describe('rate limit enforcement', () => {
    it('does not exceed maxRequestsPerSecond in steady state', async () => {
      // 3 req/s with burst of 3. After burst is consumed, at most 1 token
      // refills per ~333ms interval.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 3, maxBurst: 3 });

      // Drain the burst
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);

      // After 1 second (3 tokens worth of refill time), we should have at most 3 tokens
      await tick(1000);
      expect(limiter.getRemainingCapacity()).toBe(3);

      // Consume all 3 — they should all succeed
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);

      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // destroy()
  // -------------------------------------------------------------------------

  describe('destroy()', () => {
    it('rejects pending requests with RateLimiterDestroyedError when destroyed', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 1 });
      limiter.tryAcquire();

      const resolved = jest.fn();
      const rejected = jest.fn();
      limiter.acquire().then(resolved, rejected);
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled();
      expect(limiter.queueLength).toBe(1);

      limiter.destroy();
      await Promise.resolve();

      // Teardown must NOT gift tokens: the waiter is rejected, not resolved.
      expect(resolved).not.toHaveBeenCalled();
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(rejected.mock.calls[0][0]).toBeInstanceOf(RateLimiterDestroyedError);
    });

    it('rejects every queued waiter in FIFO order when destroyed', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 1 });
      limiter.tryAcquire();

      const order: string[] = [];
      const settled: Promise<void>[] = [
        limiter.acquire().then(
          () => order.push('a-resolved'),
          () => order.push('a-rejected'),
        ),
        limiter.acquire().then(
          () => order.push('b-resolved'),
          () => order.push('b-rejected'),
        ),
        limiter.acquire().then(
          () => order.push('c-resolved'),
          () => order.push('c-rejected'),
        ),
      ];
      await Promise.resolve();
      expect(limiter.queueLength).toBe(3);

      limiter.destroy();
      await Promise.all(settled);

      // All rejected (no burst), and no waiter was silently granted a token.
      expect(order).toEqual(['a-rejected', 'b-rejected', 'c-rejected']);
      expect(limiter.getRemainingCapacity()).toBe(0);
    });

    it('stops the timer so no more tokens are generated', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 2 });
      limiter.tryAcquire();
      limiter.tryAcquire();

      limiter.destroy();

      await tick(500);

      expect(limiter.queueLength).toBe(0);
    });
  });
});
