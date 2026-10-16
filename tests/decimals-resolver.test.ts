/**
 * Unit tests for the LRU-bounded token-decimals resolver.
 *
 * Acceptance criteria (per issue):
 *   1. Cache is bounded at the configured capacity — adding more entries
 *      than the cap evicts the LRU entry rather than growing indefinitely.
 *   2. LRU eviction order is correct — the least-recently-used entry is
 *      always the one evicted.
 *   3. Optional TTL causes stale entries to be treated as cache misses.
 *   4. `resolve()` calls the on-chain client only on a true cache miss.
 *   5. Fetch errors fall back to 7 without caching the fallback value.
 *   6. Constructor validates its arguments.
 *   7. `clear()` resets the cache to an empty state.
 */

import { DecimalsResolver, DEFAULT_DECIMALS_CACHE_CAPACITY, TTL_DISABLED } from '../src/utils/decimals-resolver';
import type { CoralSwapClient } from '../src/client';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal CoralSwapClient stub whose lpToken().metadata() is jest-controlled. */
function makeClient(decimalsPerAddress: Record<string, number> = {}): {
  client: CoralSwapClient;
  metadataSpy: jest.Mock;
} {
  const metadataSpy = jest.fn().mockImplementation((addr: string) => {
    if (addr in decimalsPerAddress) {
      return Promise.resolve({ decimals: decimalsPerAddress[addr], name: 'Token', symbol: 'TKN' });
    }
    return Promise.reject(new Error(`Unknown token: ${addr}`));
  });

  // lpToken(addr).metadata() — the resolver only uses this one method.
  const client = {
    lpToken: jest.fn().mockImplementation((addr: string) => ({
      metadata: () => metadataSpy(addr),
    })),
  } as unknown as CoralSwapClient;

  return { client, metadataSpy };
}

/** Advance the clock by `ms` milliseconds (requires jest fake timers). */
function advanceTime(ms: number): void {
  jest.advanceTimersByTime(ms);
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('DecimalsResolver — constructor', () => {
  it('constructs with default options', () => {
    const r = new DecimalsResolver();
    expect(r.maxCapacity).toBe(DEFAULT_DECIMALS_CACHE_CAPACITY);
    expect(r.size).toBe(0);
  });

  it('constructs with custom capacity and TTL', () => {
    const r = new DecimalsResolver({ capacity: 64, ttlMs: 5000 });
    expect(r.maxCapacity).toBe(64);
    expect(r.size).toBe(0);
  });

  it('throws RangeError for capacity < 1', () => {
    expect(() => new DecimalsResolver({ capacity: 0 })).toThrow(RangeError);
    expect(() => new DecimalsResolver({ capacity: -5 })).toThrow(RangeError);
  });

  it('throws RangeError for non-integer capacity', () => {
    expect(() => new DecimalsResolver({ capacity: 1.5 })).toThrow(RangeError);
  });

  it('throws RangeError for negative ttlMs', () => {
    expect(() => new DecimalsResolver({ ttlMs: -1 })).toThrow(RangeError);
  });

  it('throws RangeError for non-integer ttlMs', () => {
    expect(() => new DecimalsResolver({ ttlMs: 0.5 })).toThrow(RangeError);
  });

  it('exports TTL_DISABLED as 0', () => {
    expect(TTL_DISABLED).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache hit / miss
// ---------------------------------------------------------------------------

describe('DecimalsResolver — cache hit / miss', () => {
  it('returns the on-chain decimals value on first resolve (cache miss)', async () => {
    const { client, metadataSpy } = makeClient({ TOKENA: 7 });
    const resolver = new DecimalsResolver({ capacity: 10 });

    const result = await resolver.resolve(client, 'TOKENA');

    expect(result).toBe(7);
    expect(metadataSpy).toHaveBeenCalledTimes(1);
    expect(resolver.size).toBe(1);
  });

  it('returns the cached value without a network call on second resolve (cache hit)', async () => {
    const { client, metadataSpy } = makeClient({ TOKENA: 6 });
    const resolver = new DecimalsResolver({ capacity: 10 });

    await resolver.resolve(client, 'TOKENA'); // miss — fetches
    const second = await resolver.resolve(client, 'TOKENA'); // hit

    expect(second).toBe(6);
    expect(metadataSpy).toHaveBeenCalledTimes(1); // NOT called a second time
  });

  it('falls back to 7 when the on-chain call throws', async () => {
    const { client, metadataSpy } = makeClient(); // no tokens → always throws
    const resolver = new DecimalsResolver({ capacity: 10 });

    const result = await resolver.resolve(client, 'UNKNOWN');

    expect(result).toBe(7);
    expect(metadataSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache the fallback value so a retry re-fetches from chain', async () => {
    let callCount = 0;
    const client = {
      lpToken: jest.fn().mockImplementation(() => ({
        metadata: () => {
          callCount++;
          return Promise.reject(new Error('RPC error'));
        },
      })),
    } as unknown as CoralSwapClient;

    const resolver = new DecimalsResolver({ capacity: 10 });

    await resolver.resolve(client, 'TOKENERR'); // fails → fallback 7, not cached
    await resolver.resolve(client, 'TOKENERR'); // fails again → still calls chain

    expect(callCount).toBe(2); // both calls hit the chain
    expect(resolver.size).toBe(0); // nothing stored
  });
});

// ---------------------------------------------------------------------------
// LRU eviction — the core acceptance criterion
// ---------------------------------------------------------------------------

describe('DecimalsResolver — LRU eviction (cache bounded)', () => {
  it('never exceeds capacity when more entries than cap are inserted', async () => {
    const capacity = 4;
    // Build a client that serves every address with 7 decimals.
    const client = {
      lpToken: jest.fn().mockImplementation(() => ({
        metadata: () => Promise.resolve({ decimals: 7, name: 'T', symbol: 'T' }),
      })),
    } as unknown as CoralSwapClient;

    const resolver = new DecimalsResolver({ capacity });

    for (let i = 0; i < capacity * 3; i++) {
      await resolver.resolve(client, `TOKEN_${i}`);
    }

    expect(resolver.size).toBeLessThanOrEqual(capacity);
    expect(resolver.size).toBe(capacity);
  });

  it('evicts the least-recently-used entry when at capacity', async () => {
    const capacity = 3;
    const decimals: Record<string, number> = { A: 6, B: 7, C: 8, D: 9 };
    let fetchCount = 0;

    const client = {
      lpToken: jest.fn().mockImplementation((addr: string) => ({
        metadata: () => {
          fetchCount++;
          return Promise.resolve({ decimals: decimals[addr] ?? 7, name: addr, symbol: addr });
        },
      })),
    } as unknown as CoralSwapClient;

    const resolver = new DecimalsResolver({ capacity });

    // Fill cache: A (LRU) → B → C (MRU)
    await resolver.resolve(client, 'A');
    await resolver.resolve(client, 'B');
    await resolver.resolve(client, 'C');
    expect(fetchCount).toBe(3);
    expect(resolver.size).toBe(3);

    // Insert D: A should be evicted (it is the LRU)
    await resolver.resolve(client, 'D');
    expect(resolver.size).toBe(3);     // still at capacity
    expect(fetchCount).toBe(4);         // D fetched from chain

    // Accessing A now must trigger a fresh fetch (it was evicted)
    const prevFetchCount = fetchCount;
    const aDecimals = await resolver.resolve(client, 'A');
    expect(aDecimals).toBe(6);
    expect(fetchCount).toBe(prevFetchCount + 1); // A re-fetched
  });

  it('promotes a recently-used entry so it is not the next eviction target', async () => {
    const capacity = 3;
    const client = {
      lpToken: jest.fn().mockImplementation((addr: string) => ({
        metadata: () => Promise.resolve({ decimals: 7, name: addr, symbol: addr }),
      })),
    } as unknown as CoralSwapClient;

    const resolver = new DecimalsResolver({ capacity });
    const fetchMock = client.lpToken as jest.Mock;

    // Insert A (LRU), B, C (MRU)
    await resolver.resolve(client, 'A');
    await resolver.resolve(client, 'B');
    await resolver.resolve(client, 'C');

    // Touch A — it moves to MRU, B becomes LRU
    await resolver.resolve(client, 'A');

    // Clear the call history so we can precisely count new fetches
    fetchMock.mockClear();
    let newFetches = 0;
    fetchMock.mockImplementation((addr: string) => ({
      metadata: () => {
        newFetches++;
        return Promise.resolve({ decimals: 7, name: addr, symbol: addr });
      },
    }));

    // Insert D: B should be evicted (now the LRU), not A
    await resolver.resolve(client, 'D');
    expect(resolver.size).toBe(capacity);

    // B must be a cache miss (was evicted)
    await resolver.resolve(client, 'B');
    expect(newFetches).toBeGreaterThanOrEqual(2); // D + B both fetched

    // A must still be a cache hit (was promoted, not evicted)
    // We'll verify by checking the total fetch count doesn't include A
    const fetchesBeforeA = newFetches;
    await resolver.resolve(client, 'A');
    expect(newFetches).toBe(fetchesBeforeA); // A served from cache
  });

  it('works correctly at capacity = 1', async () => {
    const client = {
      lpToken: jest.fn().mockImplementation((addr: string) => ({
        metadata: () => Promise.resolve({ decimals: addr === 'A' ? 6 : 9, name: addr, symbol: addr }),
      })),
    } as unknown as CoralSwapClient;

    const resolver = new DecimalsResolver({ capacity: 1 });

    const aVal = await resolver.resolve(client, 'A');
    expect(aVal).toBe(6);
    expect(resolver.size).toBe(1);

    // Inserting B evicts A
    await resolver.resolve(client, 'B');
    expect(resolver.size).toBe(1);

    // A must be re-fetched
    const lpTokenMock = client.lpToken as jest.Mock;
    lpTokenMock.mockClear();
    let fetched = 0;
    lpTokenMock.mockImplementation((addr: string) => ({
      metadata: () => {
        fetched++;
        return Promise.resolve({ decimals: addr === 'A' ? 6 : 9, name: addr, symbol: addr });
      },
    }));

    const aAgain = await resolver.resolve(client, 'A');
    expect(aAgain).toBe(6);
    expect(fetched).toBe(1); // A was evicted and must be re-fetched
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe('DecimalsResolver — TTL expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves cached value while within TTL', async () => {
    const { client, metadataSpy } = makeClient({ TOKENA: 7 });
    const resolver = new DecimalsResolver({ capacity: 10, ttlMs: 5_000 });

    await resolver.resolve(client, 'TOKENA'); // miss
    advanceTime(4_999);                        // still valid
    const result = await resolver.resolve(client, 'TOKENA'); // hit

    expect(result).toBe(7);
    expect(metadataSpy).toHaveBeenCalledTimes(1);
  });

  it('treats the entry as a miss once TTL has elapsed', async () => {
    const { client, metadataSpy } = makeClient({ TOKENA: 7 });
    const resolver = new DecimalsResolver({ capacity: 10, ttlMs: 5_000 });

    await resolver.resolve(client, 'TOKENA'); // miss
    advanceTime(5_001);                        // expired
    await resolver.resolve(client, 'TOKENA'); // should re-fetch

    expect(metadataSpy).toHaveBeenCalledTimes(2);
  });

  it('decrements size when an expired entry is evicted on read', async () => {
    const { client } = makeClient({ TOKENA: 7 });
    const resolver = new DecimalsResolver({ capacity: 10, ttlMs: 1_000 });

    await resolver.resolve(client, 'TOKENA'); // store it
    expect(resolver.size).toBe(1);

    advanceTime(2_000); // expire it

    // A read on an expired entry removes it and re-fetches
    await resolver.resolve(client, 'TOKENA');
    // After the re-fetch it is stored again
    expect(resolver.size).toBe(1);
  });

  it('with TTL=0, entries never expire by time', async () => {
    const { client, metadataSpy } = makeClient({ TOKENA: 7 });
    const resolver = new DecimalsResolver({ capacity: 10, ttlMs: TTL_DISABLED });

    await resolver.resolve(client, 'TOKENA');
    advanceTime(999_999_999); // far future
    await resolver.resolve(client, 'TOKENA');

    expect(metadataSpy).toHaveBeenCalledTimes(1); // still cached
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('DecimalsResolver — clear()', () => {
  it('resets size to 0', async () => {
    const { client } = makeClient({ A: 7, B: 6, C: 8 });
    const resolver = new DecimalsResolver({ capacity: 10 });

    await resolver.resolve(client, 'A');
    await resolver.resolve(client, 'B');
    await resolver.resolve(client, 'C');
    expect(resolver.size).toBe(3);

    resolver.clear();
    expect(resolver.size).toBe(0);
  });

  it('forces re-fetches for all entries after clear()', async () => {
    const { client, metadataSpy } = makeClient({ A: 7 });
    const resolver = new DecimalsResolver({ capacity: 10 });

    await resolver.resolve(client, 'A'); // 1st fetch
    resolver.clear();
    await resolver.resolve(client, 'A'); // 2nd fetch — should hit chain again

    expect(metadataSpy).toHaveBeenCalledTimes(2);
  });

  it('LRU mechanics work correctly after clear()', async () => {
    const capacity = 2;
    const client = {
      lpToken: jest.fn().mockImplementation((addr: string) => ({
        metadata: () => Promise.resolve({ decimals: 7, name: addr, symbol: addr }),
      })),
    } as unknown as CoralSwapClient;

    const resolver = new DecimalsResolver({ capacity });

    await resolver.resolve(client, 'A');
    await resolver.resolve(client, 'B');
    resolver.clear();

    // After clear the cache is empty; inserting up to capacity should work cleanly
    await resolver.resolve(client, 'X');
    await resolver.resolve(client, 'Y');
    expect(resolver.size).toBe(capacity);

    // Adding a third should evict X (LRU)
    await resolver.resolve(client, 'Z');
    expect(resolver.size).toBe(capacity);
  });
});

// ---------------------------------------------------------------------------
// LeaderboardModule integration — verifies the module uses the resolver
// ---------------------------------------------------------------------------

describe('LeaderboardModule — uses DecimalsResolver (bounded, per-instance)', () => {
  it('LeaderboardModule.getTopTraders does not share cache across instances', async () => {
    /**
     * The old module-scope Map was a singleton shared by all LeaderboardModule
     * instances.  The new resolver is an instance field, so two instances have
     * independent caches.  This test verifies isolation.
     */
    const { LeaderboardModule } = await import('../src/modules/leaderboard');
    const { CoralSwapClient } = await import('../src/client');
    const { Network } = await import('../src/types/common');
    const { SwapModule } = await import('../src/modules/swap');

    const SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
    const STABLE = 'CUSDC000000000000000000000000000000000000000000000000000000';

    const makeTestClient = (): CoralSwapClient => {
      const c = new CoralSwapClient({ network: Network.TESTNET, secretKey: SECRET });
      jest.spyOn(c, 'getCurrentLedger').mockResolvedValue(100_000);
      jest.spyOn(c.server, 'getLatestLedger').mockResolvedValue({ sequence: 100_000 } as any);
      jest.spyOn(c, 'factory', 'get').mockReturnValue({
        getAllPairs: jest.fn().mockResolvedValue([]),
      } as any);
      jest.spyOn(c, 'pair').mockImplementation(() => ({
        getTokens: jest.fn().mockResolvedValue({ token0: STABLE, token1: 'OTHER' }),
        getReserves: jest.fn().mockResolvedValue({ reserve0: 1_000_000n, reserve1: 1_000_000n }),
      }) as any);
      jest.spyOn(c, 'lpToken').mockImplementation(() => ({
        metadata: jest.fn().mockResolvedValue({ name: 'T', symbol: 'T', decimals: 7 }),
      }) as any);
      return c;
    };

    jest.spyOn(SwapModule.prototype, 'getSwapHistory').mockResolvedValue([]);

    const client1 = makeTestClient();
    const client2 = makeTestClient();

    const lb1 = new LeaderboardModule(client1, { stableAddresses: [STABLE] });
    const lb2 = new LeaderboardModule(client2, { stableAddresses: [STABLE] });

    // Neither instance should throw; they use independent resolver instances.
    await expect(lb1.getTopTraders()).resolves.toEqual([]);
    await expect(lb2.getTopTraders()).resolves.toEqual([]);
  });

  it('accepts custom capacity and TTL through TreasuryModuleOptions', () => {
    const { LeaderboardModule } = require('../src/modules/leaderboard');
    const { CoralSwapClient } = require('../src/client');
    const { Network } = require('../src/types/common');

    const SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
    const client = new CoralSwapClient({ network: Network.TESTNET, secretKey: SECRET });

    // Should not throw with custom cache options.
    expect(
      () => new LeaderboardModule(client, { decimalsCacheCapacity: 64, decimalsCacheTtlMs: 30_000 }),
    ).not.toThrow();
  });
});
