/**
 * Health check utilities for CoralSwap RPC endpoints and on-chain contracts.
 *
 * Health checks drive routing decisions — which RPC endpoint to use and whether
 * it is safe to proceed with a transaction.  False positives could send
 * transactions to dead endpoints, so every probe must be conservative:
 * a probe is only considered successful when the RPC responds to a real
 * request within the configured timeout.
 *
 * The module exposes four stateless probe functions:
 *  - `checkRPCHealth`      — verify an RPC endpoint responds to `getHealth`
 *  - `getRPCLatency`       — measure endpoint latency with percentile math
 *  - `getContractStatus`   — verify a Soroban contract is deployed & live
 *  - `getBestEndpoint`     — rank endpoints by latency + error rate
 */

import { SorobanRpc, Contract, xdr, StrKey } from '@stellar/stellar-sdk';

/** Default RPC health-probe timeout in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 5_000;

/** Default number of samples to collect for latency percentiles. */
const DEFAULT_LATENCY_SAMPLES = 5;

/** Maximum age (ms) before a cached `getRPCLatency` percentile window is stale. */
const LATENCY_WINDOW_TTL_MS = 30_000;

/** Samples/timeout used for the latency probe inside `getBestEndpoint`. */
const ENDPOINT_SCORE_SAMPLES = 3;
const ENDPOINT_SCORE_TIMEOUT_MS = 3_000;

/**
 * A percentile window recorded for one endpoint.
 *
 * Windows are keyed by endpoint *and* sample count, because a 3-sample window
 * is not interchangeable with a 10-sample one.
 */
interface LatencyCacheEntry {
  stats: LatencyStats;
  /** Wall-clock time (ms) at which the window was recorded. */
  recordedAt: number;
}

const latencyWindowCache = new Map<string, LatencyCacheEntry>();

function latencyCacheKey(url: string, samples: number): string {
  return `${url}|${samples}`;
}

/**
 * Drop every window older than {@link LATENCY_WINDOW_TTL_MS}.
 *
 * Called on every cache access so stale samples cannot accumulate for
 * endpoints that are never probed again.
 *
 * @param now - Current wall-clock time in ms. Injectable for tests.
 * @returns The number of entries evicted.
 */
function evictStaleLatencyWindows(now: number = Date.now()): number {
  let evicted = 0;
  for (const [key, entry] of latencyWindowCache) {
    if (now - entry.recordedAt >= LATENCY_WINDOW_TTL_MS) {
      latencyWindowCache.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Result of a single RPC health probe.
 */
export interface RPCHealthResult {
  /** True when the endpoint responded to `getHealth` within the timeout. */
  healthy: boolean;
  /** Status string returned by the RPC (`"healthy"`, `"degraded"`, etc.). */
  status: string;
  /** Round-trip time in milliseconds. `-1` when the probe failed. */
  latencyMs: number;
  /** Error message when the probe failed; `null` when healthy. */
  error: string | null;
}

/**
 * Result of a latency percentile measurement session.
 */
export interface LatencyStats {
  /** Arithmetic mean latency in milliseconds. */
  meanMs: number;
  /** Median latency (50th percentile). */
  p50Ms: number;
  /** 95th percentile latency — the tail that matters for UX. */
  p95Ms: number;
  /** 99th percentile latency. */
  p99Ms: number;
  /** Fraction of samples that failed (0 = none, 1 = all). */
  errorRate: number;
  /** Number of samples collected. */
  sampleCount: number;
}

/**
 * Result of a contract deployment/status check.
 */
export interface ContractStatus {
  /** True when the contract exists on-chain and responded to a ledger read. */
  deployed: boolean;
  /** True when the contract's TTL has not yet expired. */
  ttlValid: boolean;
  /** Latest ledger at entry is live. 0 when unknown. */
  liveUntilLedger: number;
  /** Number of ledgers remaining until expiry; -1 when not determinable. */
  remainingLedgers: number;
  /** Error message when the check failed; `null` on success. */
  error: string | null;
}

/**
 * Endpoint ranking entry returned from `getBestEndpoint`.
 */
export interface EndpointScore {
  /** The endpoint URL. */
  url: string;
  /** Health probe result. */
  health: RPCHealthResult;
  /** Computed rank score (lower = better). */
  score: number;
}

/**
 * Create a SorobanRpc.Server bound to the given URL with a fixed timeout.
 *
 * We cannot set `AbortSignal` directly on the server in older SDK versions,
 * so the timeout is enforced at the probe-call layer via `Promise.race`.
 */
function makeServer(url: string): SorobanRpc.Server {
  return new SorobanRpc.Server(url, { allowHttp: url.startsWith('http://') });
}

/**
 * Race a probe promise against a timeout, rejecting with `timeoutMessage`
 * if `timeoutMs` elapses first.
 *
 * Always clears the timeout timer once the race settles, regardless of
 * which side wins — an uncleared `setTimeout` in the losing branch keeps
 * the event loop (and any test worker) alive until it naturally fires.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Probe a single RPC endpoint for basic health.
 *
 * Returns an {@link RPCHealthResult} indicating whether the endpoint is
 * healthy, the reported status string, and the measured round-trip time.
 *
 * @param url        - Full URL of the Soroban RPC endpoint to probe.
 * @param timeoutMs  - Maximum time in ms to wait for a response. Defaults to 5 000.
 * @returns RPCHealthResult with health status and latency.
 *
 * @example
 * const result = await checkRPCHealth('https://soroban-testnet.stellar.org');
 * if (!result.healthy) console.warn('Endpoint is down:', result.error);
 */
export async function checkRPCHealth(
  url: string,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<RPCHealthResult> {
  if (!url || typeof url !== 'string') {
    return { healthy: false, status: 'unknown', latencyMs: -1, error: 'Invalid RPC URL' };
  }

  let server: SorobanRpc.Server;
  try {
    server = makeServer(url);
  } catch (err) {
    return {
      healthy: false,
      status: 'unknown',
      latencyMs: -1,
      error: err instanceof Error ? err.message : 'Failed to construct RPC server',
    };
  }

  const start = Date.now();
  try {
    const health = await raceWithTimeout(server.getHealth(), timeoutMs, 'health probe timeout');
    const latencyMs = Date.now() - start;
    const status = (health as { status?: string }).status ?? 'unknown';
    return {
      healthy: status === 'healthy' || status === 'degraded',
      status,
      latencyMs,
      error: null,
    };
  } catch (err) {
    return {
      healthy: false,
      status: 'unreachable',
      latencyMs: -1,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Compute the p-th percentile of a *sorted* numeric dataset using
 * linear interpolation between adjacent values (the standard
 * "exclusive" method used by numpy/R).
 *
 * @param sorted   - Pre-sorted array of numbers (ascending).
 * @param p        - Percentile to compute, in [0, 100].
 * @returns The interpolated percentile value.
 *
 * @example
 * percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95) === 95
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];

  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Probe an RPC endpoint multiple times and compute latency statistics.
 *
 * Collects `samples` round-trips to `getLatestLedger` and returns a
 * {@link LatencyStats} with mean, p50/p95/p99 percentiles, and an
 * error rate computed from the failed samples.
 *
 * Results are cached per `(url, samples)` for {@link LATENCY_WINDOW_TTL_MS};
 * a window older than the TTL is evicted and re-measured on the next call, so
 * ranking decisions never run on indefinitely-retained samples. Pass
 * `options.fresh` to bypass the cached window and force a new measurement.
 *
 * @param url       - Full URL of the Soroban RPC endpoint to probe.
 * @param samples   - Number of sequential samples to collect. Defaults to 5.
 * @param timeoutMs - Per-sample timeout in ms. Defaults to 4 000.
 * @param options   - `fresh` forces a re-probe; `cache: false` also skips storing.
 * @returns LatencyStats with percentile breakdown and error rate.
 *
 * @example
 * const stats = await getRPCLatency('https://soroban-testnet.stellar.org', 10);
 * if (stats.p95Ms > 500) console.warn('Slow endpoint:', stats.p95Ms);
 */
export async function getRPCLatency(
  url: string,
  samples: number = DEFAULT_LATENCY_SAMPLES,
  timeoutMs: number = 4_000,
  options: { fresh?: boolean; cache?: boolean } = {},
): Promise<LatencyStats> {
  if (!url || typeof url !== 'string') {
    return { meanMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN, errorRate: 1, sampleCount: 0 };
  }

  // Sweep expired windows before every read so nothing is retained past its TTL.
  const now = Date.now();
  evictStaleLatencyWindows(now);

  const cacheKey = latencyCacheKey(url, samples);
  const useCache = options.cache !== false;
  if (useCache && !options.fresh) {
    const cached = latencyWindowCache.get(cacheKey);
    if (cached) return { ...cached.stats };
  }

  let server: SorobanRpc.Server;
  try {
    server = makeServer(url);
  } catch {
    return { meanMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN, errorRate: 1, sampleCount: 0 };
  }

  const latencies: number[] = [];
  let failures = 0;

  for (let i = 0; i < samples; i++) {
    const start = Date.now();
    try {
      await raceWithTimeout(server.getLatestLedger(), timeoutMs, 'latency probe timeout');
      latencies.push(Date.now() - start);
    } catch {
      failures++;
    }
  }

  const stats: LatencyStats =
    latencies.length === 0
      ? {
          meanMs: NaN,
          p50Ms: NaN,
          p95Ms: NaN,
          p99Ms: NaN,
          errorRate: 1,
          sampleCount: samples,
        }
      : (() => {
          latencies.sort((a, b) => a - b);
          const sum = latencies.reduce((acc, v) => acc + v, 0);
          return {
            meanMs: sum / latencies.length,
            p50Ms: percentile(latencies, 50),
            p95Ms: percentile(latencies, 95),
            p99Ms: percentile(latencies, 99),
            errorRate: failures / samples,
            sampleCount: samples,
          };
        })();

  if (useCache) {
    // Record the measurement time, not the read time, so the TTL measures the
    // age of the samples themselves.
    latencyWindowCache.set(cacheKey, { stats, recordedAt: Date.now() });
  }

  return { ...stats };
}

/**
 * Check whether a Soroban contract is deployed and still within its TTL.
 *
 * Uses the Stellar RPC `getContractData` with a ledger-key read for the
 * contract instance.  This is cheaper than a full simulation and relies
 * on the ledger entry being present in the live state.
 *
 * The TTL check reports false if the entry's `liveUntilLedger` is past
 * the current ledger, meaning the contract will expire soon unless bumped.
 *
 * @param url        - The Soroban RPC endpoint URL.
 * @param contractId - The Stellar contract address (C...).
 * @returns ContractStatus with deployment status and TTL information.
 *
 * @example
 * const status = await getContractStatus(
 *   'https://soroban-testnet.stellar.org',
 *   'CA3J7GYCCX7NVPY...',
 * );
 * if (!status.deployed) console.error('Contract is not deployed');
 */
export async function getContractStatus(
  url: string,
  contractId: string,
): Promise<ContractStatus> {
  if (!url || typeof url !== 'string') {
    return {
      deployed: false,
      ttlValid: false,
      liveUntilLedger: 0,
      remainingLedgers: -1,
      error: 'Invalid RPC URL',
    };
  }

  let server: SorobanRpc.Server;
  try {
    server = makeServer(url);
  } catch (err) {
    return {
      deployed: false,
      ttlValid: false,
      liveUntilLedger: 0,
      remainingLedgers: -1,
      error: err instanceof Error ? err.message : 'Failed to construct RPC server',
    };
  }

  try {
    const contract = new Contract(contractId);
    const rawContractId = StrKey.decodeContract(contractId);
    // Wrap the raw 32-byte contract hash in an ScVal Bytes for the instance key.
    const key = xdr.ScVal.scvBytes(Buffer.from(rawContractId));

    const response = await raceWithTimeout(
      server.getContractData(contract, key),
      8_000,
      'contract status probe timeout',
    );

    const entry = response as any;
    const result = response as any;

    if (!result || !('liveUntilLedgerSeq' in result) || (result.liveUntilLedgerSeq as number) <= 0) {
      return {
        deployed: false,
        ttlValid: false,
        liveUntilLedger: 0,
        remainingLedgers: -1,
        error: 'Contract ledger entry not found',
      };
    }

    const liveUntilLedger = (result.liveUntilLedgerSeq as number) ?? 0;
    const currentLedger = entry.latestLedger ?? 0;
    const remainingLedgers =
      currentLedger > 0 ? liveUntilLedger - currentLedger : -1;
    const ttlValid = liveUntilLedger > currentLedger;

    return {
      deployed: true,
      ttlValid,
      liveUntilLedger,
      remainingLedgers,
      error: null,
    };
  } catch (err) {
    const isMissing = err instanceof Error && (
      msgIncludes(err.message, 'not found') ||
      msgIncludes(err.message, 'does not exist') ||
      msgIncludes(err.message, 'missing')
    );
    if (isMissing) {
      return {
        deployed: false,
        ttlValid: false,
        liveUntilLedger: 0,
        remainingLedgers: -1,
        error: 'Contract not deployed',
      };
    }
    return {
      deployed: false,
      ttlValid: false,
      liveUntilLedger: 0,
      remainingLedgers: -1,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

function msgIncludes(msg: string, fragment: string): boolean {
  return msg.toLowerCase().includes(fragment);
}

/**
 * Rank a list of RPC endpoints by health + error rate and return the best.
 *
 * For each endpoint this probes health once, performs a quick latency sample
 * (`getLatestLedger`) to measure round-trip time, and computes a score:
 *   score = latencyMs * (1 + errorRate * 10)
 *
 * Endpoints that fail the health probe automatically receive a score of
 * `Infinity` so that dead endpoints sort to the end.  When all endpoints
 * are dead, `null` is returned.
 *
 * @param urls - Array of Soroban RPC endpoint URLs.
 * @returns The URL of the best endpoint, or `null` if all are unreachable.
 *
 * @example
 * const best = await getBestEndpoint([
 *   'https://rpc-a.example.com',
 *  -b.example.com',
 * ]);
 * if (!best) throw new Error('No healthy RPC');
 */
export async function getBestEndpoint(urls: string[]): Promise<string | null> {
  if (!urls || urls.length === 0) return null;

  const results: EndpointScore[] = [];

  for (const url of urls) {
    const health = await checkRPCHealth(url, 4_000);
    if (!health.healthy) {
      results.push({ url, health, score: Infinity });
      continue;
    }

    let score = health.latencyMs;
    try {
      // Shares getRPCLatency's TTL-bounded window, so ranking a pool of
      // endpoints repeatedly does not re-probe every one of them each time —
      // while still never scoring on samples older than the TTL.
      const stats = await getRPCLatency(
        url,
        ENDPOINT_SCORE_SAMPLES,
        ENDPOINT_SCORE_TIMEOUT_MS,
      );

      const avgLatency = Number.isFinite(stats.meanMs) ? stats.meanMs : health.latencyMs;

      // Penalise endpoints with partial errors
      score = avgLatency * (1 + stats.errorRate * 10);
    } catch {
      score = health.latencyMs;
    }

    results.push({ url, health, score });
  }

  results.sort((a, b) => a.score - b.score);

  for (const r of results) {
    if (r.health.healthy && Number.isFinite(r.score)) {
      return r.url;
    }
  }

  return null;
}

/**
 * HealthCheckModule — centralised entry point for all CoralSwap health probes.
 *
 * Wraps the standalone probe functions in a class so it can be registered
 * the same way as {@link FactoryModule} in the application container.
 *
 * ```ts
 * import { HealthCheckModule } from '@coralswap/sdk';
 * const module = new HealthCheckModule();
 * const healthy = await module.checkRPCHealth('https://soroban-testnet.stellar.org');
 * ```
 */
export class HealthCheckModule {
  /**
   * Probe a single RPC endpoint for basic health.
   * @see {@link checkRPCHealth}
   */
  checkRPCHealth(url: string, timeoutMs?: number): Promise<RPCHealthResult> {
    return checkRPCHealth(url, timeoutMs);
  }

  /**
   * Probe an endpoint and calculate latency percentile statistics.
   * @see {@link getRPCLatency}
   */
  getRPCLatency(url: string, samples?: number, timeoutMs?: number): Promise<LatencyStats> {
    return getRPCLatency(url, samples, timeoutMs);
  }

  /**
   * Check whether a Soroban contract is deployed and within TTL.
   * @see {@link getContractStatus}
   */
  getContractStatus(url: string, contractId: string): Promise<ContractStatus> {
    return getContractStatus(url, contractId);
  }

  /**
   * Rank RPC endpoints by health + latency and return the best.
   * @see {@link getBestEndpoint}
   */
  getBestEndpoint(urls: string[]): Promise<string | null> {
    return getBestEndpoint(urls);
  }
}

/**
 * Discard every cached latency window.
 *
 * Primarily a test helper, but also useful after a network switch when the
 * previously measured endpoints are no longer relevant.
 *
 * @returns The number of windows discarded.
 */
export function __resetLatencyCache(): number {
  const size = latencyWindowCache.size;
  latencyWindowCache.clear();
  return size;
}

/**
 * Evict only the windows that have outlived {@link LATENCY_WINDOW_TTL_MS}.
 *
 * @param now - Current wall-clock time in ms. Injectable for tests.
 * @returns The number of windows evicted.
 */
export function __evictStaleLatencyWindows(now?: number): number {
  return evictStaleLatencyWindows(now);
}

/** Number of latency windows currently cached. Internal/test introspection. */
export function __latencyCacheSize(): number {
  return latencyWindowCache.size;
}

/** The latency-window TTL in milliseconds. Internal/test introspection. */
export function __latencyWindowTtlMs(): number {
  return LATENCY_WINDOW_TTL_MS;
}
