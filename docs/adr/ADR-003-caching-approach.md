# Caching Approach

- **Date**: 2026-06-29
- **Status**: Accepted

## Context

The CoralSwap SDK makes frequent on-chain calls to Soroban contracts for pair lookups, pathfinding, TWAP observations, and LP token addresses. Without caching, every operation would require one or more RPC round-trips, increasing latency and hitting rate limits on public Soroban RPC endpoints.

The data that benefits most from caching falls into three categories:

- **Semi-static references** — pair contract addresses (change rarely, only when a new pair is created).
- **Expensive computation results** — optimal swap paths (require building a token graph from all pairs and simulating multiple routes).
- **Stable addresses** — LP token contract addresses (assigned once at pair creation and never change).

## Decision

Three caching strategies are used across the SDK, each appropriate to the data's volatility:

**1. TTL-based cache** (`FactoryModule`, `RouterModule`)

Entries are stored in an in-memory `Map<string, CacheEntry>` where each entry carries an `expiresAt` wall-clock timestamp. A lookup returns the cached value if `Date.now() < expiresAt`, otherwise it fetches fresh data and replaces the entry.

- `FactoryModule` — caches `(tokenA, tokenB) → pairAddress` mappings with a default TTL of 60 seconds (`DEFAULT_CACHE_TTL_MS = 60_000`, `src/modules/factory.ts:7`). TTL is configurable via the constructor. Also exposes `preLoadPairs()` for seeding known pairs and `bypassCache` per-lookup.
- `RouterModule` — caches `(tokenIn, tokenOut, tradeType, amount) → OptimalPath` with a default TTL of 30 seconds (`DEFAULT_CACHE_TTL_MS = 30_000`, `src/modules/router.ts:17`). Shorter TTL because path optimality depends on current reserves.

**2. Write-once cache** (`LiquidityModule`, `PositionsModule`)

LP token addresses are fetched once and stored indefinitely (`Map<string, string>`). These addresses are immutable after pair creation so no expiry is needed (`src/modules/liquidity.ts:28`, `src/modules/positions.ts:17`).

**3. In-memory observation buffer** (`OracleModule`)

TWAP observations are accumulated per pair in a `Map<string, TWAPObservation[]>` without a TTL. Callers explicitly `clearCache(pairAddress?)` when they want to reset (`src/modules/oracle.ts:37,193-198`).

**Cache invalidation triggers:**

| Trigger | Effect |
|---|---|
| `CoralSwapClient.setNetwork()` | Clears the `FactoryModule` cache and the public key cache (`src/client.ts:322-324`) |
| `FactoryModule.invalidateCache(pairAddress?)` | Removes one pair or the entire pair-address cache |
| `FactoryModule.clearCache()` | Alias for full invalidation |
| `RouterModule.clearPathCache()` | Clears all cached optimal paths |
| `OracleModule.clearCache(pairAddress?)` | Clears observations per pair or all pairs |

## Consequences

### Positive

- **Reduced RPC calls** — repeated pair-address lookups during the same 60-second window hit the in-memory cache instead of the network. For apps that query many tokens (e.g., a portfolio view), this cuts latency dramatically.
- **Better UX** — pathfinding results are cached for 30 seconds, so repeated swap quote requests with the same parameters return instantly.
- **Low-overhead cache miss** — the cost of a cache miss is a single `Date.now()` comparison plus one contract call, so there is no complex bookkeeping.

### Negative

- **Stale data risk** — a new pair created on-chain is invisible to the factory cache for up to 60 seconds. Mitigated by `bypassCache: true` for callers that need immediate consistency, and `invalidateCache()` for explicit busting.
- **No cross-tab or persistence** — all caches are in-memory `Map` instances, so they are lost on page refresh (in browser) or process restart (in Node). Acceptable for an SDK that is typically long-lived within a single session.
- **Unbounded oracle cache** — `OracleModule.observationCache` grows monotonically unless callers call `clearCache()`. A future improvement could cap entries per pair.
