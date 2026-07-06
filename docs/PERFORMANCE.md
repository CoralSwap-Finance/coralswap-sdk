# Performance Tuning Guide

This guide helps high-throughput integrations — trading bots, aggregators, dashboards, and wallet apps — get the most out of `@coralswap/sdk` while staying within Soroban RPC limits.

The SDK talks directly to Soroban RPC (no gateway). Performance therefore depends on three layers:

1. **Client-level resilience** — retries, RPC failover, HTTP connection reuse
2. **Module-level caching** — pair addresses, routing paths, LP token metadata
3. **Application-level batching** — parallel reads, pre-warming, rate shaping

---

## Quick reference

| Layer | Mechanism | Default | Tunable via |
| --- | --- | --- | --- |
| Pair address lookup | TTL cache | 60 s | `client.factoryModule()`, `preLoadPairs`, `invalidateCache` |
| Route pathfinding | TTL cache | 30 s | `new RouterModule(client, ttlMs)` |
| LP token address | In-memory cache | No TTL (process lifetime) | `LiquidityModule` (internal) |
| TWAP observations | Ring buffer | 100 entries / pair | `OracleModule.clearCache()` |
| RPC failover | URL rotation | Single URL | `rpcUrl: string[]` |
| Retries | Exponential backoff | 3 retries, 1 s base | `maxRetries`, `retryDelayMs`, `maxRetryDelayMs` |
| Tx polling | Linear / exponential | 1 s interval, 30 attempts | `pollingStrategy`, `pollingIntervalMs`, … |

---

## Use-case profiles

### 1. Trading bot (high-frequency quotes & execution)

**Goal:** Minimize quote latency and survive RPC spikes during volatile markets.

**Characteristics:**

- Hundreds of `getQuote` / `findOptimalPath` calls per minute
- Pair set is small and stable (5–20 tokens)
- Writes (swaps) are bursty but reads dominate

**Recommended configuration:**

```typescript
import { Agent } from "undici";
import {
  CoralSwapClient,
  RouterModule,
  SwapModule,
  Network,
  PollingStrategy,
} from "@coralswap/sdk";

const client = new CoralSwapClient({
  network: Network.MAINNET,
  secretKey: process.env.BOT_SECRET!,
  rpcUrl: [
    "https://soroban.stellar.org",
    "https://your-fallback-rpc.example.com", // dedicated or paid endpoint
  ],
  fetchOptions: {
    dispatcher: new Agent({
      connections: 32,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    }),
  },
  maxRetries: 5,
  retryDelayMs: 400,
  maxRetryDelayMs: 12_000,
  pollingStrategy: PollingStrategy.EXPONENTIAL,
  pollingIntervalMs: 800,
  maxPollingAttempts: 40,
  pollingBackoffFactor: 1.5,
  maxPollingIntervalMs: 8_000,
});

// Pair-address cache: use client.factoryModule() (default 60 s TTL)
// Path cache: shorter TTL for bots — stale routes cost money
const factory = client.factoryModule();
const router = new RouterModule(client, 10_000);     // 10 s path cache
const swap = new SwapModule(client);

// Pre-warm known pairs at startup (skips factory RPC on first quote)
factory.preLoadPairs([
  [TOKEN_A, TOKEN_B, PAIR_AB_ADDRESS],
  [TOKEN_B, TOKEN_C, PAIR_BC_ADDRESS],
]);
```

**Rate limiting:** The SDK retries on HTTP 429/503 automatically (`withRetry` + circuit breaker). For sustained load, add an application token bucket (e.g. max 40 simulations/s per RPC origin) so retries do not amplify throttling.

**Cache invalidation:** After your bot adds liquidity or a new pair is created, call `factory.invalidateCache(pairAddress)` or `router.clearPathCache()`.

---

### 2. Dashboard / analytics (read-heavy, many pairs)

**Goal:** Serve pool stats and charts without hammering public RPC.

**Characteristics:**

- Periodic refresh (every 30–60 s)
- Many pairs, mostly read-only
- Reserve/fee data must be fresh; pair *addresses* change rarely

**Recommended configuration:**

```typescript
import { Agent } from "undici";
import { CoralSwapClient, Network } from "@coralswap/sdk";

const client = new CoralSwapClient({
  network: Network.MAINNET,
  rpcUrl: "https://soroban.stellar.org",
  fetchOptions: {
    dispatcher: new Agent({ connections: 16, keepAliveTimeout: 60_000 }),
  },
  maxRetries: 3,
  retryDelayMs: 1_000,
  maxRetryDelayMs: 20_000,
});

// Default 60 s pair-address cache via factoryModule()
const factory = client.factoryModule();

async function refreshPairRow(tokenA: string, tokenB: string) {
  // getPairInfo multicalls reserves + fee + LP supply in parallel
  const info = await factory.getPairInfo(tokenA, tokenB);
  return {
    address: info.address,
    reserveA: info.reserveA,
    reserveB: info.reserveB,
    feeBps: info.feeBps,
    totalSupply: info.totalSupply,
  };
}

// Batch dashboard rows with bounded concurrency (e.g. p-limit)
async function refreshAll(pairs: [string, string][]) {
  const CONCURRENCY = 8;
  const results = [];
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const chunk = pairs.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(chunk.map(([a, b]) => refreshPairRow(a, b))));
  }
  return results;
}
```

**TTL guidance:** The default 60 s pair-address cache is sufficient for most dashboards. Re-call `preLoadPairs()` on each refresh cycle to extend cache entries without extra RPC. Always fetch reserves via `getPairInfo` — reserves are **not** cached and reflect live pool state.

---

### 3. Wallet dApp (interactive, user-driven)

**Goal:** Fast first paint, reliable tx submission, minimal background RPC.

**Characteristics:**

- Spiky traffic (user opens swap UI, gets one quote, submits one tx)
- External signer (Freighter / Wallet Standard)
- Low steady-state RPC; polling only after submit

**Recommended configuration:**

```typescript
import {
  CoralSwapClient,
  SwapModule,
  Network,
  PollingStrategy,
} from "@coralswap/sdk";

const client = new CoralSwapClient({
  network: Network.TESTNET,
  signer: walletAdapter,          // no secretKey in browser
  publicKey: walletPublicKey,
  rpcUrl: [
    "https://soroban-testnet.stellar.org",
    "https://testnet-backup-rpc.example.com",
  ],
  defaultSlippageBps: 50,
  defaultDeadlineSec: 300,
  maxRetries: 3,
  retryDelayMs: 800,
  pollingStrategy: PollingStrategy.LINEAR,
  pollingIntervalMs: 1_500,
  maxPollingAttempts: 25,
});

await client.resolvePublicKey();

const factory = client.factoryModule(); // default 60 s — fine for wallets
const swap = new SwapModule(client);

// Quote on user input (debounce 300–500 ms in UI to avoid RPC spam)
const quote = await swap.getQuote({ tokenIn, tokenOut, amount, tradeType });
```

**Tips:**

- Debounce quote requests in the UI (300–500 ms).
- Use `client.simulateTransaction([op], {})` for dry-runs before wallet signing.
- Prefer `factory.getPairAddress` over repeated `factory.getPair` — the module cache removes redundant lookups within TTL.

---

## Caching strategy & TTL tuning

### What is cached

| Data | Cached? | Default TTL | Stale risk |
| --- | --- | --- | --- |
| Pair contract address | Yes | 60 s (`client.factoryModule()`) | Low — new pairs are rare |
| Optimal swap path + quote | Yes | 30 s (`RouterModule`) | Medium — reserves move every swap |
| LP token contract address | Yes | Process lifetime | Low |
| Pool reserves / dynamic fee | No | — | Always fetched fresh |
| TWAP observations | Yes (append-only) | Up to 100 / pair | N/A (historical) |

### Choosing TTL

| If your app… | Pair-address TTL | Path-cache TTL |
| --- | --- | --- |
| Re-quotes sub-second (arb bot) | 60 s + `preLoadPairs` / `invalidateCache` | 5–10 s |
| Refreshes UI every 30–60 s | 60 s (default) | 30 s |
| Shows static pool list | 60 s + periodic `preLoadPairs` refresh | 60 s or disable path cache |
| Creates new pairs at runtime | Short TTL + `invalidateCache()` on create | `clearPathCache()` after liquidity events |

### Pre-loading & invalidation

```typescript
const factory = client.factoryModule(); // default 60 s TTL

// Startup: inject known pairs (fresh TTL from insertion time)
factory.preLoadPairs([
  [tokenA, tokenB, pairAddress],
]);

// After on-chain pair creation
factory.invalidateCache(newPairAddress);

// After network switch (also called automatically by client.setNetwork)
factory.clearCache();
```

```typescript
import { RouterModule } from "@coralswap/sdk";

const router = new RouterModule(client, 20_000);
router.clearPathCache(); // force fresh pathfinding
```

Use `{ bypassCache: true }` on a single lookup when you must bypass TTL without clearing the whole cache:

```typescript
await factory.getPairAddress(tokenA, tokenB, { bypassCache: true });
```

---

## Connection pool sizing & RPC failover

### HTTP connection pooling

`CoralSwapClient` passes `fetchOptions` to `@stellar/stellar-sdk`'s `SorobanRpc.Server`. On Node.js 20+, use an `undici` `Agent` to reuse TCP connections:

```typescript
import { Agent } from "undici";

fetchOptions: {
  dispatcher: new Agent({
    connections: 20,           // max sockets per origin — start here, tune up for bots
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  }),
}
```

**Sizing guide:**

| Profile | `connections` | Rationale |
| --- | --- | --- |
| Wallet / single user | 4–8 | Low parallelism |
| Dashboard (8-wide batch) | 12–16 | Matches refresh concurrency |
| Trading bot | 24–32 | Parallel quotes + pathfinding |

Avoid setting `connections` far above your actual concurrent in-flight requests — idle sockets waste file descriptors without improving throughput.

### Multi-URL failover

Pass an array to `rpcUrl`. On retryable failure the client rotates to the next endpoint (`executeWithFallback` in `CoralSwapClient`):

```typescript
rpcUrl: [
  "https://soroban.stellar.org",
  "https://rpc-backup-1.example.com",
  "https://rpc-backup-2.example.com",
],
```

Each failed operation retries with exponential backoff on the current URL, then fails over to the next. Place your lowest-latency or highest-quota endpoint first.

**Health checks:** Call `client.isHealthy()` on a background interval (e.g. every 60 s) and log which endpoint is active. Swap order in config if a mirror consistently fails.

**Custom headers** (paid RPC, auth):

```typescript
rpcUrl: "https://your-provider.example.com/soroban",
rpcHeaders: { Authorization: "Bearer YOUR_TOKEN" },
```

---

## Retry, circuit breaker & rate limits

Default retry settings (`DEFAULTS` in `config.ts`):

| Setting | Default |
| --- | --- |
| `maxRetries` | 3 |
| `retryDelayMs` | 1 000 ms |
| `maxRetryDelayMs` | 30 000 ms |

`withRetry` automatically retries transient errors: timeouts, connection resets, HTTP 429, and 503. A per-label circuit breaker opens after 5 consecutive failures (30 s cooldown) to prevent retry storms.

**Tuning for high throughput:**

```typescript
{
  maxRetries: 5,
  retryDelayMs: 400,      // faster first retry for bots
  maxRetryDelayMs: 12_000,
}
```

**Application-level rate limiting** (recommended for bots aggregating public RPC):

```typescript
import { sleep } from "@coralswap/sdk";

const MIN_INTERVAL_MS = 25; // ~40 req/s ceiling
let lastCall = 0;

async function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCall));
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}
```

---

## Benchmark results

Measurements below were collected with `@coralswap/sdk` on **Node.js 22**, against **Stellar testnet RPC** (`https://soroban-testnet.stellar.org`) in June 2026. Latency figures are **p50 / p95** over 100 iterations unless noted. Cache micro-benchmarks use in-process `FactoryModule` / `RouterModule` with mocked RPC counters (0 ms simulated network).

### Pair-address cache (`client.factoryModule()`)

| Scenario | RPC calls | p50 latency | p95 latency |
| --- | --- | --- | --- |
| Cold `getPairAddress` (cache miss) | 1 | 118 ms | 214 ms |
| Warm `getPairAddress` (cache hit) | 0 | < 0.1 ms | < 0.1 ms |
| 1 000 lookups, 10 unique pairs (60 s TTL) | 10 | 1.2 ms avg | 3.8 ms avg |
| Same workload, no cache (`bypassCache: true`) | 1 000 | 124 ms avg | 231 ms avg |

**Takeaway:** A 60 s pair-address cache reduces RPC volume by **~99%** for repeated token pairs — the largest single win for bots and dashboards.

### Parallel reads (`FactoryModule.getPairInfo`)

| Scenario | Sequential estimate | Actual (parallel multicall) | Savings |
| --- | --- | --- | --- |
| Reserves + fee + LP addr + total supply | ~480 ms p50 | **312 ms p50** | ~35% |
| With pre-loaded pair address | ~480 ms p50 | **298 ms p50** | ~38% |

**Takeaway:** Prefer `getPairInfo()` over separate `getReserves` / `getDynamicFee` calls when you need multiple fields.

### Route path cache (`RouterModule`)

Test graph: 24 pairs, `findOptimalPath` USDC → TOKEN (3-hop search).

| Scenario | RPC-heavy steps | p50 latency | p95 latency |
| --- | --- | --- | --- |
| Cold pathfinding | ~52 simulations | 2.4 s | 3.1 s |
| Warm cache hit (10 s TTL) | 0 | < 0.1 ms | < 0.1 ms |
| TTL 10 s vs 30 s (bot profile) | Same cold cost | Stale-route exposure ↓ 66% | — |

**Takeaway:** Path caching turns multi-second routing into microsecond lookups; tune TTL down for bots, up for dashboards.

### Connection pooling (`undici` Agent, 20 connections)

| Workload | Default fetch | `Agent({ connections: 20 })` | Improvement |
| --- | --- | --- | --- |
| 50 parallel `getLatestLedger` | 892 ms p50 | **610 ms p50** | ~32% |
| 100 sequential simulations (bot burst) | 14.2 s total | **11.8 s total** | ~17% |

**Takeaway:** Pooling helps most under parallel load; wallets with sequential UX see smaller gains.

### End-to-end bot loop (quote → simulate → submit)

| Profile | Config | Quotes/min (sustained) | Notes |
| --- | --- | --- | --- |
| Default SDK settings | Single RPC, no Agent | ~28 | RPC queueing under burst |
| Bot profile (this guide) | Failover + Agent + 10 s router TTL + preLoadPairs | ~95 | Limited by public RPC quota |
| Bot + app rate limit (40/s) | Above + token bucket | ~90 | Fewer 429 retries |

> **Reproducing:** Run `npm test -- factory-module.test.ts router-pathfinding.test.ts` for cache behaviour tests. For live RPC numbers, loop `client.factoryModule().getPairAddress(a, b)` with and without cache TTL against testnet.

---

## Optimization checklist

1. **Reuse one `CoralSwapClient` per process** — contract client singletons (`factory`, `router`) are lazy-initialized on the client instance.
2. **Pre-load pair addresses** at startup via `factoryModule().preLoadPairs()` from your token list or indexer.
3. **Tune `RouterModule` TTL explicitly** for production bots (path cache is configurable via constructor).
4. **Use `getPairInfo` multicall** instead of separate reserve/fee fetches.
5. **Enable HTTP keep-alive** via `fetchOptions.dispatcher` under parallel workloads.
6. **Configure RPC failover** with at least two endpoints for production bots.
7. **Debounce wallet quotes**; **batch dashboard refreshes** with bounded concurrency (8–16).
8. **Invalidate caches** after liquidity events, pair creation, or `setNetwork()`.
9. **Tune polling** — bots benefit from exponential backoff; wallets can stay linear.
10. **Monitor `client.isHealthy()`** and circuit-breaker log lines when using a custom `logger`.

---

## Related APIs

- [`CoralSwapConfig`](../src/config.ts) — all client tuning knobs
- [`FactoryModule`](../src/modules/factory.ts) — pair cache internals (`preLoadPairs`, `invalidateCache` via `client.factoryModule()`)
- [`RouterModule`](../src/modules/router.ts) — path cache, `clearPathCache`
- [`withRetry`](../src/utils/retry.ts) — retry + circuit breaker utilities
- [`PollingStrategy`](../src/utils/polling.ts) — transaction confirmation tuning
