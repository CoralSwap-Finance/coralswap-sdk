/**
 * Unit tests for ConnectionPool.
 *
 * Tests cover round-robin distribution, failover, recovery, and edge cases.
 * No real network calls are made — time is controlled via `Date.now` mocking
 * through the optional `nowMs` parameter on pool methods.
 */

import { ConnectionPool, PoolExhaustedError } from '../src/utils/connection-pool';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const URL_A = 'https://rpc-a.example.com';
const URL_B = 'https://rpc-b.example.com';
const URL_C = 'https://rpc-c.example.com';

const DEFAULT_FAILURE_THRESHOLD = 3;
const RECOVERY_MS = 30_000;

// ---------------------------------------------------------------------------
// ConnectionPool — constructor
// ---------------------------------------------------------------------------

describe('ConnectionPool — constructor', () => {
  it('throws when constructed with an empty URL array', () => {
    expect(() => new ConnectionPool([])).toThrow('at least one URL');
  });

  it('creates a pool with the correct size', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C]);
    expect(pool.size).toBe(3);
  });

  it('creates a single-endpoint pool', () => {
    const pool = new ConnectionPool([URL_A]);
    expect(pool.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round-robin distribution
// ---------------------------------------------------------------------------

describe('round-robin distribution', () => {
  it('cycles through all endpoints in order', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C]);

    expect(pool.getEndpoint()).toBe(URL_A);
    expect(pool.getEndpoint()).toBe(URL_B);
    expect(pool.getEndpoint()).toBe(URL_C);
    expect(pool.getEndpoint()).toBe(URL_A); // wraps around
  });

  it('returns the only endpoint repeatedly for a single-endpoint pool', () => {
    const pool = new ConnectionPool([URL_A]);

    expect(pool.getEndpoint()).toBe(URL_A);
    expect(pool.getEndpoint()).toBe(URL_A);
    expect(pool.getEndpoint()).toBe(URL_A);
  });

  it('distributes requests evenly across N endpoints', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C]);
    const counts: Record<string, number> = { [URL_A]: 0, [URL_B]: 0, [URL_C]: 0 };
    const total = 9; // divisible by 3

    for (let i = 0; i < total; i++) {
      counts[pool.getEndpoint()]++;
    }

    expect(counts[URL_A]).toBe(3);
    expect(counts[URL_B]).toBe(3);
    expect(counts[URL_C]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Failure reporting and unhealthy marking
// ---------------------------------------------------------------------------

describe('failure reporting', () => {
  it('reports success resets consecutive failure count', () => {
    const pool = new ConnectionPool([URL_A], { failureThreshold: 2 });
    pool.reportFailure(URL_A);
    pool.reportSuccess(URL_A);
    // After success the endpoint is healthy; should still be returned
    expect(pool.getEndpoint()).toBe(URL_A);
  });

  it('marks an endpoint unhealthy after failureThreshold consecutive failures', () => {
    const pool = new ConnectionPool([URL_A, URL_B], { failureThreshold: 2 });

    pool.reportFailure(URL_A);
    // One failure — still healthy
    expect(pool.healthyEndpoints()).toContain(URL_A);

    pool.reportFailure(URL_A);
    // Two failures — threshold reached, now unhealthy
    expect(pool.unhealthyEndpoints()).toContain(URL_A);
  });

  it('does not mark an endpoint unhealthy before threshold is reached', () => {
    const pool = new ConnectionPool([URL_A], { failureThreshold: 3 });

    pool.reportFailure(URL_A);
    pool.reportFailure(URL_A);
    expect(pool.healthyEndpoints()).toContain(URL_A);
  });

  it('resets failure count on reportSuccess, so threshold restarts', () => {
    const pool = new ConnectionPool([URL_A], { failureThreshold: 3 });

    pool.reportFailure(URL_A);
    pool.reportFailure(URL_A);
    pool.reportSuccess(URL_A); // reset

    pool.reportFailure(URL_A);
    pool.reportFailure(URL_A);
    // Only 2 failures since reset — still healthy
    expect(pool.healthyEndpoints()).toContain(URL_A);
  });

  it('ignores reportFailure / reportSuccess for unknown URLs', () => {
    const pool = new ConnectionPool([URL_A]);
    // Should not throw
    expect(() => pool.reportFailure('https://unknown.example.com')).not.toThrow();
    expect(() => pool.reportSuccess('https://unknown.example.com')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Failover — skipping unhealthy endpoints
// ---------------------------------------------------------------------------

describe('failover — skipping unhealthy endpoints', () => {
  it('skips an unhealthy endpoint and uses the next healthy one', () => {
    const pool = new ConnectionPool([URL_A, URL_B], { failureThreshold: 1 });

    pool.reportFailure(URL_A); // URL_A is now unhealthy

    // Both calls should go to URL_B (the only healthy one)
    expect(pool.getEndpoint()).toBe(URL_B);
    expect(pool.getEndpoint()).toBe(URL_B);
  });

  it('falls back to the remaining endpoint when first is unhealthy', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C], { failureThreshold: 1 });

    pool.reportFailure(URL_A); // A is unhealthy

    const endpoint = pool.getEndpoint();
    expect([URL_B, URL_C]).toContain(endpoint);
  });

  it('throws PoolExhaustedError when all endpoints are unhealthy', () => {
    const pool = new ConnectionPool([URL_A, URL_B], { failureThreshold: 1 });

    pool.reportFailure(URL_A);
    pool.reportFailure(URL_B);

    expect(() => pool.getEndpoint()).toThrow(PoolExhaustedError);
  });

  it('PoolExhaustedError message is descriptive', () => {
    const pool = new ConnectionPool([URL_A], { failureThreshold: 1 });
    pool.reportFailure(URL_A);

    expect(() => pool.getEndpoint()).toThrow('all endpoints are unhealthy');
  });

  it('returns healthy endpoints list that excludes failed ones', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C], { failureThreshold: 1 });
    pool.reportFailure(URL_B);

    const healthy = pool.healthyEndpoints();
    expect(healthy).toContain(URL_A);
    expect(healthy).toContain(URL_C);
    expect(healthy).not.toContain(URL_B);
  });

  it('returns unhealthy endpoints list that includes only failed ones', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C], { failureThreshold: 1 });
    pool.reportFailure(URL_A);
    pool.reportFailure(URL_C);

    const unhealthy = pool.unhealthyEndpoints();
    expect(unhealthy).toContain(URL_A);
    expect(unhealthy).toContain(URL_C);
    expect(unhealthy).not.toContain(URL_B);
  });
});

// ---------------------------------------------------------------------------
// Recovery — time-based auto-recovery
// ---------------------------------------------------------------------------

describe('recovery after cooldown', () => {
  it('auto-recovers an unhealthy endpoint after recoveryTimeMs', () => {
    const pool = new ConnectionPool([URL_A, URL_B], {
      failureThreshold: 1,
      recoveryTimeMs: RECOVERY_MS,
    });

    const t0 = 1_000_000;
    pool.reportFailure(URL_A, t0);

    // Before recovery window — still unhealthy
    expect(pool.unhealthyEndpoints(t0 + RECOVERY_MS - 1)).toContain(URL_A);

    // At exactly recoveryTimeMs — now healthy again
    expect(pool.healthyEndpoints(t0 + RECOVERY_MS)).toContain(URL_A);
  });

  it('auto-recovered endpoint is returned by getEndpoint again', () => {
    const pool = new ConnectionPool([URL_A], {
      failureThreshold: 1,
      recoveryTimeMs: 1000,
    });

    const t0 = 5000;
    pool.reportFailure(URL_A, t0);

    // Exhausted before recovery
    expect(() => pool.getEndpoint(t0 + 500)).toThrow(PoolExhaustedError);

    // After recovery window it should work again
    expect(pool.getEndpoint(t0 + 1000)).toBe(URL_A);
  });

  it('markHealthy immediately restores an unhealthy endpoint', () => {
    const pool = new ConnectionPool([URL_A, URL_B], { failureThreshold: 1 });

    pool.reportFailure(URL_A);
    expect(pool.unhealthyEndpoints()).toContain(URL_A);

    pool.markHealthy(URL_A);
    expect(pool.healthyEndpoints()).toContain(URL_A);
  });

  it('multiple unhealthy endpoints all recover independently after their own cooldown', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C], {
      failureThreshold: 1,
      recoveryTimeMs: 1000,
    });

    const t0 = 10_000;
    pool.reportFailure(URL_A, t0);
    pool.reportFailure(URL_B, t0 + 200); // failed 200ms later

    // At t0 + 1000: A has recovered, B has not yet
    expect(pool.healthyEndpoints(t0 + 1000)).toContain(URL_A);
    expect(pool.unhealthyEndpoints(t0 + 1000)).toContain(URL_B);

    // At t0 + 1200: both recovered
    expect(pool.healthyEndpoints(t0 + 1200)).toContain(URL_A);
    expect(pool.healthyEndpoints(t0 + 1200)).toContain(URL_B);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('continues round-robin correctly after skipping an unhealthy endpoint', () => {
    const pool = new ConnectionPool([URL_A, URL_B, URL_C], { failureThreshold: 1 });
    pool.reportFailure(URL_B); // B is unhealthy

    // With B out, the round-robin should return A and C in order
    const results = [pool.getEndpoint(), pool.getEndpoint(), pool.getEndpoint()];

    // None of the returned endpoints should be B
    expect(results).not.toContain(URL_B);
    // A and C should appear
    expect(results).toContain(URL_A);
    expect(results).toContain(URL_C);
  });

  it('handles a pool of size 1 exhausting and recovering correctly', () => {
    const pool = new ConnectionPool([URL_A], {
      failureThreshold: 2,
      recoveryTimeMs: 500,
    });

    const t0 = 0;
    pool.reportFailure(URL_A, t0);
    pool.reportFailure(URL_A, t0); // second failure marks unhealthy

    expect(() => pool.getEndpoint(t0)).toThrow(PoolExhaustedError);

    // markHealthy restores it immediately
    pool.markHealthy(URL_A);
    expect(pool.getEndpoint(t0)).toBe(URL_A);
  });

  it('ignores markHealthy for unknown URLs', () => {
    const pool = new ConnectionPool([URL_A]);
    expect(() => pool.markHealthy('https://unknown.example.com')).not.toThrow();
  });
});
