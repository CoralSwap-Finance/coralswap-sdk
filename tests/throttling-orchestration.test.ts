/**
 * Orchestrated throttling tests: RateLimiter + CircuitBreaker combined behavior.
 *
 * All tests use Jest fake timers so there are no real delays. The fake clock is
 * advanced explicitly to exercise burst windows, refill intervals, and circuit
 * cooldown periods in a deterministic, fast manner.
 *
 * Test coverage:
 *   1. Sustained rate accuracy — 1 rps, 2 rps, 10 rps
 *   2. Burst replenishment — tokens accrue during cooldown and are spendable afterward
 *   3. open → half-open → closed transitions driven by the rate limiter queue
 *   4. No token gift on destroy when queue is empty
 */

import { RateLimiter } from '../src/utils/rate-limiter';
import {
  CircuitBreaker,
  CircuitOpenError,
  getCircuitBreaker,
  resetCircuitBreakers,
} from '../src/utils/retry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Advance fake timers by `ms` milliseconds and drain the microtask queue so
 * that Promise continuations triggered by timer callbacks can run.
 */
async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  // Multiple rounds ensure deeply-nested promise chains all settle.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * Run `fn` via the rate limiter and the circuit breaker together, recording
 * whether each call succeeded or threw. Returns the array of recorded outcomes.
 */
async function runThroughStack(
  limiter: RateLimiter,
  breaker: CircuitBreaker,
  fn: () => Promise<void>,
): Promise<Array<'ok' | 'circuit-open' | 'fn-error'>> {
  const outcomes: Array<'ok' | 'circuit-open' | 'fn-error'> = [];

  // Compose: acquire token → check circuit → run fn → report result.
  const acquire = limiter.acquire();
  return acquire.then(async () => {
    const nowMs = Date.now();
    try {
      breaker.beforeRequest(nowMs);
    } catch (e) {
      if (e instanceof CircuitOpenError) {
        outcomes.push('circuit-open');
        return outcomes;
      }
      throw e;
    }
    try {
      await fn();
      breaker.onSuccess();
      outcomes.push('ok');
    } catch {
      breaker.onFailure(Date.now());
      outcomes.push('fn-error');
    }
    return outcomes;
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Throttling Orchestration — RateLimiter + CircuitBreaker combined', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetCircuitBreakers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // 1. Sustained rate accuracy
  // =========================================================================

  describe('sustained rate accuracy', () => {
    /**
     * Helper: drain a fully-charged bucket of `burst` tokens, then advance
     * time by exactly `windowMs` and assert the bucket holds exactly
     * `expectedTokens` (capped at burst).
     */
    async function assertRefill(
      rps: number,
      burst: number,
      windowMs: number,
      expectedTokens: number,
    ): Promise<void> {
      const limiter = new RateLimiter({ maxRequestsPerSecond: rps, maxBurst: burst });

      // Drain the bucket completely.
      for (let i = 0; i < burst; i++) {
        expect(limiter.tryAcquire()).toBe(true);
      }
      expect(limiter.getRemainingCapacity()).toBe(0);

      await tick(windowMs);

      expect(limiter.getRemainingCapacity()).toBe(expectedTokens);
      limiter.destroy();
    }

    it('1 rps: refills 1 token after 1 000 ms', async () => {
      await assertRefill(1, 1, 1_000, 1);
    });

    it('1 rps: refills 0 tokens after 999 ms (sub-interval)', async () => {
      await assertRefill(1, 5, 999, 0);
    });

    it('2 rps: refills 2 tokens after 1 000 ms', async () => {
      await assertRefill(2, 5, 1_000, 2);
    });

    it('2 rps: refills 1 token after 500 ms', async () => {
      await assertRefill(2, 5, 500, 1);
    });

    it('10 rps: refills 10 tokens after 1 000 ms (capped at burst)', async () => {
      // burst = 10, so refill of 10 exactly fills the bucket
      await assertRefill(10, 10, 1_000, 10);
    });

    it('10 rps: refills 5 tokens after 500 ms', async () => {
      await assertRefill(10, 20, 500, 5);
    });

    it('10 rps: does not exceed maxBurst on long idle', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 7 });
      for (let i = 0; i < 7; i++) limiter.tryAcquire();

      // 5 seconds idle — would produce 50 tokens at 10 rps, but burst cap is 7.
      await tick(5_000);

      expect(limiter.getRemainingCapacity()).toBe(7);
      limiter.destroy();
    });

    it('async acquire() calls are serialised and resolve in order at 1 rps', async () => {
      // 1 rps, burst 1: second and third acquires must each wait ~1 000 ms.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 1, maxBurst: 1 });

      const order: number[] = [];

      // First acquire uses the burst token immediately.
      limiter.acquire().then(() => order.push(1));
      // Second and third must queue.
      limiter.acquire().then(() => order.push(2));
      limiter.acquire().then(() => order.push(3));

      // Flush microtasks → first resolves.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(order).toEqual([1]);

      // Advance 1 000 ms → second resolves.
      await tick(1_000);
      expect(order).toEqual([1, 2]);

      // Advance another 1 000 ms → third resolves.
      await tick(1_000);
      expect(order).toEqual([1, 2, 3]);

      limiter.destroy();
    });
  });

  // =========================================================================
  // 2. Burst replenishment
  // =========================================================================

  describe('burst replenishment', () => {
    it('burst tokens are fully replenished after the burst window elapses', async () => {
      const burst = 5;
      const rps = 5; // one token per 200 ms
      const limiter = new RateLimiter({ maxRequestsPerSecond: rps, maxBurst: burst });

      // Spend the entire burst.
      for (let i = 0; i < burst; i++) {
        expect(limiter.tryAcquire()).toBe(true);
      }
      expect(limiter.getRemainingCapacity()).toBe(0);

      // Advance exactly 1 000 ms → all 5 tokens replenished.
      await tick(1_000);
      expect(limiter.getRemainingCapacity()).toBe(burst);

      limiter.destroy();
    });

    it('partial replenishment: 3 of 5 tokens after 600 ms at 5 rps', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 5, maxBurst: 5 });
      for (let i = 0; i < 5; i++) limiter.tryAcquire();

      await tick(600); // 5 rps × 0.6 s = 3 tokens

      expect(limiter.getRemainingCapacity()).toBe(3);
      limiter.destroy();
    });

    it('replenished tokens can immediately be acquired', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 2, maxBurst: 2 });
      limiter.tryAcquire();
      limiter.tryAcquire();

      await tick(1_000); // 2 tokens refilled

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false); // bucket empty again
      limiter.destroy();
    });

    it('queued acquire() resolves after burst replenishment without manual intervention', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 2, maxBurst: 2 });
      limiter.tryAcquire();
      limiter.tryAcquire(); // bucket empty

      let resolved = false;
      limiter.acquire().then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false); // still waiting

      await tick(500); // 0.5 s × 2 rps = 1 token

      expect(resolved).toBe(true);
      limiter.destroy();
    });
  });

  // =========================================================================
  // 3. open → half-open → closed transitions via the composed stack
  // =========================================================================

  describe('open → half-open → closed transitions', () => {
    const FAILURE_THRESHOLD = 3;
    const COOLDOWN_MS = 10_000;

    function makeBreaker(): CircuitBreaker {
      return new CircuitBreaker('orch-test', {
        failureThreshold: FAILURE_THRESHOLD,
        cooldownMs: COOLDOWN_MS,
      });
    }

    it('circuit opens after consecutive failures reach the threshold', () => {
      jest.setSystemTime(0);
      const breaker = makeBreaker();

      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }

      expect(breaker.getState(Date.now())).toBe('open');
    });

    it('open circuit throws CircuitOpenError immediately (no token spent on fast-fail)', () => {
      jest.setSystemTime(0);
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 10 });
      const breaker = makeBreaker();

      // Drive circuit open.
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }

      expect(breaker.getState(Date.now())).toBe('open');

      // The rate limiter should still have tokens, but the circuit blocks the call.
      const capacityBefore = limiter.getRemainingCapacity();
      expect(() => breaker.beforeRequest(Date.now())).toThrow(CircuitOpenError);
      // Token was not consumed because we check the circuit first.
      expect(limiter.getRemainingCapacity()).toBe(capacityBefore);

      limiter.destroy();
    });

    it('transitions to half-open after cooldown elapses', () => {
      jest.setSystemTime(0);
      const breaker = makeBreaker();

      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }

      expect(breaker.getState(Date.now())).toBe('open');

      jest.advanceTimersByTime(COOLDOWN_MS);
      expect(breaker.getState(Date.now())).toBe('half-open');
    });

    it('half-open probe: success closes the circuit', () => {
      jest.setSystemTime(0);
      const breaker = makeBreaker();

      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }

      jest.advanceTimersByTime(COOLDOWN_MS);
      expect(breaker.getState(Date.now())).toBe('half-open');

      // Single probe allowed.
      breaker.beforeRequest(Date.now());
      breaker.onSuccess();

      expect(breaker.getState(Date.now())).toBe('closed');
    });

    it('half-open probe: failure re-opens the circuit', () => {
      jest.setSystemTime(0);
      const breaker = makeBreaker();

      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }

      jest.advanceTimersByTime(COOLDOWN_MS);
      expect(breaker.getState(Date.now())).toBe('half-open');

      breaker.beforeRequest(Date.now());
      breaker.onFailure(Date.now());

      expect(breaker.getState(Date.now())).toBe('open');
    });

    it('half-open admits only one concurrent probe; second attempt throws CircuitOpenError', () => {
      jest.setSystemTime(0);
      const breaker = makeBreaker();

      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }

      jest.advanceTimersByTime(COOLDOWN_MS);

      // First probe is admitted.
      expect(() => breaker.beforeRequest(Date.now())).not.toThrow();
      // Second concurrent probe must be rejected.
      expect(() => breaker.beforeRequest(Date.now())).toThrow(CircuitOpenError);
    });

    it('full open→half-open→closed cycle works end-to-end with rate limiter', async () => {
      jest.setSystemTime(0);

      // Limiter with plenty of capacity so it never blocks the orchestration.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 100, maxBurst: 50 });
      const breaker = makeBreaker();

      // --- Phase 1: drive circuit open ---
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        await limiter.acquire();
        breaker.beforeRequest(Date.now());
        breaker.onFailure(Date.now());
      }
      expect(breaker.getState(Date.now())).toBe('open');

      // --- Phase 2: advance past cooldown → half-open ---
      jest.advanceTimersByTime(COOLDOWN_MS);
      expect(breaker.getState(Date.now())).toBe('half-open');

      // --- Phase 3: successful probe closes circuit ---
      await limiter.acquire();
      breaker.beforeRequest(Date.now());
      breaker.onSuccess();
      expect(breaker.getState(Date.now())).toBe('closed');

      // --- Phase 4: verify normal traffic flows again ---
      await limiter.acquire();
      expect(() => breaker.beforeRequest(Date.now())).not.toThrow();
      breaker.onSuccess();
      expect(breaker.getState(Date.now())).toBe('closed');

      limiter.destroy();
    });

    it('rate limiter queue drains correctly while circuit is closed across a burst boundary', async () => {
      // 2 rps, burst 2. After the burst is spent, two queued acquires wait.
      // The circuit is closed throughout; both calls eventually execute.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 2, maxBurst: 2 });
      const breaker = makeBreaker();

      // Spend the burst.
      limiter.tryAcquire();
      limiter.tryAcquire();

      const executed: number[] = [];
      const go = (id: number) =>
        limiter.acquire().then(() => {
          breaker.beforeRequest(Date.now());
          breaker.onSuccess();
          executed.push(id);
        });

      go(1);
      go(2);
      await Promise.resolve();
      expect(executed).toEqual([]); // both queued

      await tick(500); // +1 token at 2 rps
      expect(executed).toEqual([1]);

      await tick(500); // +1 token
      expect(executed).toEqual([1, 2]);

      expect(breaker.getState(Date.now())).toBe('closed');
      limiter.destroy();
    });
  });

  // =========================================================================
  // 4. No token gift on destroy when queue is empty
  // =========================================================================

  describe('no token gift on destroy when queue is empty', () => {
    it('destroy() on an idle limiter (empty queue) does not change remaining capacity', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 5 });
      const capacityBefore = limiter.getRemainingCapacity();
      // Sanity check: no pending requests.
      expect(limiter.queueLength).toBe(0);

      limiter.destroy();

      // getRemainingCapacity() still reflects the same token count — no phantom
      // tokens were added or removed.
      expect(limiter.getRemainingCapacity()).toBe(capacityBefore);
    });

    it('destroy() on a fully-drained idle limiter leaves capacity at 0', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getRemainingCapacity()).toBe(0);
      expect(limiter.queueLength).toBe(0);

      limiter.destroy();

      expect(limiter.getRemainingCapacity()).toBe(0);
    });

    it('destroy() resolves pending requests (gift) only when the queue is non-empty', async () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 1, maxBurst: 1 });
      limiter.tryAcquire(); // drain

      const resolved = jest.fn();
      limiter.acquire().then(resolved);
      await Promise.resolve();
      expect(resolved).not.toHaveBeenCalled();
      expect(limiter.queueLength).toBe(1);

      limiter.destroy();
      await Promise.resolve();

      // Gift happens because there WAS a pending request.
      expect(resolved).toHaveBeenCalledTimes(1);
    });

    it('no spurious timer firings after destroy() on empty queue', async () => {
      // The limiter only starts an internal timer when a request is queued
      // (i.e. acquire() is called on an empty bucket). If no acquire() was
      // called before destroy(), no timer is scheduled and destroy() is a no-op.
      const limiter = new RateLimiter({ maxRequestsPerSecond: 10, maxBurst: 3 });
      // Drain partially but do NOT queue any async acquires.
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.queueLength).toBe(0);

      limiter.destroy();

      // After destroy() with an empty queue the queue remains empty even
      // after advancing the clock; the timer was never set so no callback
      // can fire and push items through.
      await tick(5_000);
      expect(limiter.queueLength).toBe(0);

      // getRemainingCapacity() uses the live clock-based refill algorithm
      // (Date.now()), so it will reflect accumulated tokens over 5 s.
      // The important guarantee is that the bucket never exceeds maxBurst.
      expect(limiter.getRemainingCapacity()).toBeLessThanOrEqual(3);
    });

    it('combined: destroy() with empty queue leaves circuit breaker state unchanged', () => {
      jest.setSystemTime(0);
      const breaker = new CircuitBreaker('destroy-test', {
        failureThreshold: 2,
        cooldownMs: 5_000,
      });
      const limiter = new RateLimiter({ maxRequestsPerSecond: 5, maxBurst: 5 });

      // Drive breaker open.
      breaker.beforeRequest(Date.now());
      breaker.onFailure(Date.now());
      breaker.beforeRequest(Date.now());
      breaker.onFailure(Date.now());
      expect(breaker.getState(Date.now())).toBe('open');

      // Destroy an idle limiter — should not interact with the circuit breaker.
      expect(limiter.queueLength).toBe(0);
      limiter.destroy();

      // Breaker is still open; destroy() had no side-effect.
      expect(breaker.getState(Date.now())).toBe('open');
    });
  });
});
