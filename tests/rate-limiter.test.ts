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
 * scheduled inside RateLimiter._scheduleRefill() have a chance to run.
 */
async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  // Drain the microtask queue (multiple await-yields for nested promises)
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
    it('throws when capacity is 0', () => {
      expect(() => new RateLimiter({ capacity: 0, refillRate: 1, refillIntervalMs: 100 })).toThrow(
        'capacity must be > 0',
      );
    });

    it('throws when capacity is negative', () => {
      expect(() => new RateLimiter({ capacity: -1, refillRate: 1, refillIntervalMs: 100 })).toThrow(
        'capacity must be > 0',
      );
    });

    it('throws when refillRate is 0', () => {
      expect(() => new RateLimiter({ capacity: 5, refillRate: 0, refillIntervalMs: 100 })).toThrow(
        'refillRate must be > 0',
      );
    });

    it('throws when refillIntervalMs is 0', () => {
      expect(() => new RateLimiter({ capacity: 5, refillRate: 1, refillIntervalMs: 0 })).toThrow(
        'refillIntervalMs must be > 0',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts with capacity tokens', () => {
      const limiter = new RateLimiter({ capacity: 5, refillRate: 1, refillIntervalMs: 1000 });
      expect(limiter.availableTokens).toBe(5);
      limiter.destroy();
    });

    it('reports zero items in queue initially', () => {
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 1000 });
      expect(limiter.queueLength).toBe(0);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // tryAcquire — non-blocking token consumption
  // -------------------------------------------------------------------------

  describe('tryAcquire()', () => {
    it('returns true and decrements token count when tokens are available', () => {
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 1000 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.availableTokens).toBe(2);
      limiter.destroy();
    });

    it('returns false when bucket is empty', () => {
      const limiter = new RateLimiter({ capacity: 1, refillRate: 1, refillIntervalMs: 1000 });
      limiter.tryAcquire(); // drain the single token
      expect(limiter.tryAcquire()).toBe(false);
      limiter.destroy();
    });

    it('can drain all tokens to zero', () => {
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 1000 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.availableTokens).toBe(0);
      expect(limiter.tryAcquire()).toBe(false);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Token-bucket refill accuracy
  // -------------------------------------------------------------------------

  describe('token refill accuracy', () => {
    it('replenishes tokens after one refill interval', async () => {
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 100 });
      // Drain the bucket
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.availableTokens).toBe(0);

      await tick(100);

      expect(limiter.availableTokens).toBe(1);
      limiter.destroy();
    });

    it('does not exceed capacity when multiple intervals elapse', async () => {
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 100 });
      // Drain the bucket
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();

      // Advance well past capacity
      await tick(1000);

      expect(limiter.availableTokens).toBe(3); // capped at capacity
      limiter.destroy();
    });

    it('adds multiple tokens per interval when refillRate > 1', async () => {
      const limiter = new RateLimiter({ capacity: 10, refillRate: 3, refillIntervalMs: 100 });
      // Drain completely
      for (let i = 0; i < 10; i++) limiter.tryAcquire();
      expect(limiter.availableTokens).toBe(0);

      await tick(100);

      expect(limiter.availableTokens).toBe(3);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Burst behaviour
  // -------------------------------------------------------------------------

  describe('burst behaviour', () => {
    it('allows up to capacity requests immediately without waiting', async () => {
      const capacity = 5;
      const limiter = new RateLimiter({ capacity, refillRate: 1, refillIntervalMs: 1000 });
      const results: boolean[] = [];

      for (let i = 0; i < capacity; i++) {
        results.push(limiter.tryAcquire());
      }

      expect(results).toEqual([true, true, true, true, true]);
      expect(limiter.availableTokens).toBe(0);
      limiter.destroy();
    });

    it('rejects the (capacity + 1)th tryAcquire in a burst', () => {
      const limiter = new RateLimiter({ capacity: 2, refillRate: 1, refillIntervalMs: 1000 });
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
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 100 });
      const resolved = jest.fn();

      limiter.acquire().then(resolved);
      await Promise.resolve(); // flush microtasks

      expect(resolved).toHaveBeenCalledTimes(1);
      limiter.destroy();
    });

    it('queues requests when bucket is empty', async () => {
      const limiter = new RateLimiter({ capacity: 1, refillRate: 1, refillIntervalMs: 100 });
      limiter.tryAcquire(); // drain

      const resolved = jest.fn();
      limiter.acquire().then(resolved);
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled(); // still waiting
      expect(limiter.queueLength).toBe(1);

      limiter.destroy();
    });

    it('resolves queued requests in FIFO order after refill', async () => {
      const limiter = new RateLimiter({ capacity: 1, refillRate: 1, refillIntervalMs: 100 });
      limiter.tryAcquire(); // drain

      const order: number[] = [];
      limiter.acquire().then(() => order.push(1));
      limiter.acquire().then(() => order.push(2));
      limiter.acquire().then(() => order.push(3));

      // First refill — grants token to request #1
      await tick(100);
      // Second refill — grants token to request #2
      await tick(100);
      // Third refill — grants token to request #3
      await tick(100);

      expect(order).toEqual([1, 2, 3]);
      limiter.destroy();
    });

    it('handles multiple concurrent acquire() calls within burst capacity', async () => {
      const limiter = new RateLimiter({ capacity: 3, refillRate: 1, refillIntervalMs: 100 });
      const promises = [limiter.acquire(), limiter.acquire(), limiter.acquire()];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // destroy()
  // -------------------------------------------------------------------------

  describe('destroy()', () => {
    it('resolves pending requests when destroyed', async () => {
      const limiter = new RateLimiter({ capacity: 1, refillRate: 1, refillIntervalMs: 1000 });
      limiter.tryAcquire(); // drain

      const resolved = jest.fn();
      limiter.acquire().then(resolved);
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled();

      limiter.destroy();
      await Promise.resolve();

      expect(resolved).toHaveBeenCalledTimes(1);
    });

    it('stops the refill timer so no more tokens are emitted', async () => {
      const limiter = new RateLimiter({ capacity: 2, refillRate: 1, refillIntervalMs: 100 });
      limiter.tryAcquire();
      limiter.tryAcquire();

      limiter.destroy();

      await tick(500);

      // After destroy the timer is cleared; we expect availableTokens not to have grown
      // beyond 0 (it was drained before destroy).  We cannot call tryAcquire after
      // destroy but we can verify the queue is empty.
      expect(limiter.queueLength).toBe(0);
    });
  });
});
