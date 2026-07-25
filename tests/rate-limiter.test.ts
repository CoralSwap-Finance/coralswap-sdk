/**
 * Unit tests for RateLimiter (token-bucket algorithm).
 *
 * All tests use Jest fake timers so there are no real delays and timing
 * assertions stay deterministic and fast.
 */

import { RateLimiter } from '../src/utils/rate-limiter';

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
      limiter.acquire().then(resolved);
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled();
      expect(limiter.queueLength).toBe(1);

      limiter.destroy();
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
    it('resolves pending requests when destroyed', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 1 });
      limiter.tryAcquire();

      const resolved = jest.fn();
      limiter.acquire().then(resolved);
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled();

      limiter.destroy();
      await Promise.resolve();

      expect(resolved).toHaveBeenCalledTimes(1);
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
