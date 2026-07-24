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

import {
  SorobanRpc,
  Contract,
  xdr,
  StrKey,
  TransactionBuilder,
  Address,
  nativeToScVal,
} from '@stellar/stellar-sdk';

import { NETWORK_CONFIGS, TESTNET_NETWORK } from '@/config';
import { Network } from '@/types/common';
import { sleep } from '@/utils/retry';

/** Default RPC health-probe timeout in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 5_000;

/** Default number of samples to collect for latency percentiles. */
const DEFAULT_LATENCY_SAMPLES = 5;

/** Maximum age (ms) before a cached `getRPCLatency` percentile window is stale. */
const LATENCY_WINDOW_TTL_MS = 30_000;

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
  /** True when the contract instance entry is present in the ledger state. */
  isDeployed: boolean;
  /** True when the contract responds to a read-only simulation. */
  isOperational: boolean;
  /** Number of ledgers remaining before the contract instance TTL expires. */
  ttlRemaining: number;
  /** Last ledger sequence known to have touched the contract instance. */
  lastActivity: number;
  /** Legacy alias for `isDeployed`. */
  deployed?: boolean;
  /** Legacy alias for `ttlRemaining > 0`. */
  ttlValid?: boolean;
  /** Legacy alias for the internal live-until ledger sequence. */
  liveUntilLedger?: number;
  /** Legacy alias for TTL remaining in ledger counts. */
  remainingLedgers?: number;
  /** Error message when the check failed; `null` when healthy. */
  error?: string | null;
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
 * Determine whether an error represents a network-level or timeout failure
 * (as opposed to a contract-logic error, which may be retryable).
 */
function isProbeFailure(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('abort') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('dns') ||
      msg.includes('failed to fetch') ||
      msg.includes('socket')
    );
  }
  return err instanceof TypeError;
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
    const health = await Promise.race([
      server.getHealth(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('health probe timeout')), timeoutMs),
      ),
    ]);
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
 * @param url       - Full URL of the Soroban RPC endpoint to probe.
 * @param samples   - Number of sequential samples to collect. Defaults to 5.
 * @param timeoutMs - Per-sample timeout in ms. Defaults to 4 000.
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
): Promise<LatencyStats> {
  if (!url || typeof url !== 'string') {
    return { meanMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN, errorRate: 1, sampleCount: 0 };
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
      await Promise.race([
        server.getLatestLedger(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('latency probe timeout')), timeoutMs),
        ),
      ]);
      latencies.push(Date.now() - start);
    } catch {
      failures++;
    }
  }

  if (latencies.length === 0) {
    return {
      meanMs: NaN,
      p50Ms: NaN,
      p95Ms: NaN,
      p99Ms: NaN,
      errorRate: 1,
      sampleCount: samples,
    };
  }

  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((acc, v) => acc + v, 0);
  const meanMs = sum / latencies.length;
  const p50Ms = percentile(latencies, 50);
  const p95Ms = percentile(latencies, 95);
  const p99Ms = percentile(latencies, 99);
  const errorRate = failures / samples;

  return { meanMs, p50Ms, p95Ms, p99Ms, errorRate, sampleCount: samples };
}

/**
 * Check whether a Soroban contract is deployed and still within its TTL.
 *
 * When `contractId` is omitted, the SDK resolves the default Factory and
 * Router contracts from the configured network defaults and returns an array
 * of status objects for each of them. When a legacy `(url, contractId)`
 * pair is supplied, the function preserves the previous behaviour while
 * adding a simulation-backed operational check.
 *
 * @param contractAddressOrUrl - Optional contract ID, or the legacy RPC URL.
 * @param maybeContractId      - Optional legacy contract ID when using the old API.
 * @returns A single `ContractStatus` or an array of statuses when checking defaults.
 */
export async function getContractStatus(
  contractAddressOrUrl?: string,
  maybeContractId?: string,
): Promise<ContractStatus | ContractStatus[]> {
  if (typeof maybeContractId === 'string') {
    return probeContractStatusAtUrl(contractAddressOrUrl ?? '', maybeContractId);
  }

  if (typeof contractAddressOrUrl === 'string') {
    const status = await probeContractStatusAtUrl(
      getDefaultRpcUrl(),
      contractAddressOrUrl,
    );
    return status;
  }

  const defaultTargets = getDefaultHealthCheckTargets();
  if (defaultTargets.length === 0) {
    return [];
  }

  return Promise.all(
    defaultTargets.map((target) =>
      probeContractStatusAtUrl(target.rpcUrl, target.contractAddress, target.kind),
    ),
  );
}

function getDefaultHealthCheckTargets(): Array<{ rpcUrl: string; contractAddress: string; kind: 'factory' | 'router' | 'custom' }> {
  const rpcUrl = getDefaultRpcUrl();
  const factoryAddress = NETWORK_CONFIGS[Network.TESTNET].factoryAddress || TESTNET_NETWORK.factoryAddress;
  const routerAddress = NETWORK_CONFIGS[Network.TESTNET].routerAddress || TESTNET_NETWORK.routerAddress;

  const targets: Array<{ rpcUrl: string; contractAddress: string; kind: 'factory' | 'router' | 'custom' }> = [];
  if (factoryAddress) targets.push({ rpcUrl, contractAddress: factoryAddress, kind: 'factory' });
  if (routerAddress) targets.push({ rpcUrl, contractAddress: routerAddress, kind: 'router' });
  return targets;
}

function getDefaultRpcUrl(): string {
  return NETWORK_CONFIGS[Network.TESTNET].rpcUrl || TESTNET_NETWORK.rpcUrl;
}

async function probeContractStatusAtUrl(
  url: string,
  contractId: string,
  kind: 'factory' | 'router' | 'custom' = 'custom',
): Promise<ContractStatus> {
  if (!url || typeof url !== 'string') {
    return newContractStatus(false, false, 0, 0, 'Invalid RPC URL');
  }

  let server: SorobanRpc.Server;
  try {
    server = makeServer(url);
  } catch (err) {
    return newContractStatus(false, false, 0, 0, err instanceof Error ? err.message : 'Failed to construct RPC server');
  }

  try {
    const contract = new Contract(contractId);
    const rawContractId = StrKey.decodeContract(contractId);
    const key = xdr.ScVal.scvBytes(Buffer.from(rawContractId));

    const response = await Promise.race([
      server.getContractData(contract, key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('contract status probe timeout')), 8_000),
      ),
    ]);

    const entry = response as { liveUntilLedgerSeq?: number; latestLedger?: number; lastModifiedLedgerSeq?: number };
    const liveUntilLedger = entry.liveUntilLedgerSeq ?? 0;
    const latestLedger = entry.latestLedger ?? 0;
    const lastActivity = entry.lastModifiedLedgerSeq ?? latestLedger;

    if (!entry || liveUntilLedger <= 0) {
      return newContractStatus(false, false, 0, 0, 'Contract ledger entry not found');
    }

    const ttlRemaining = latestLedger > 0 ? liveUntilLedger - latestLedger : 0;
    const isOperational = await simulateReadOnlyContract(server, contractId, kind);

    return {
      ...newContractStatus(true, isOperational, ttlRemaining, lastActivity, null),
      deployed: true,
      ttlValid: ttlRemaining > 0,
      liveUntilLedger,
      remainingLedgers: ttlRemaining,
    };
  } catch (err) {
    const isMissing = err instanceof Error && (
      msgIncludes(err.message, 'not found') ||
      msgIncludes(err.message, 'does not exist') ||
      msgIncludes(err.message, 'missing')
    );
    if (isMissing) {
      return newContractStatus(false, false, 0, 0, 'Contract not deployed');
    }
    return newContractStatus(false, false, 0, 0, err instanceof Error ? err.message : 'Unknown error');
  }
}

function newContractStatus(
  isDeployed: boolean,
  isOperational: boolean,
  ttlRemaining: number,
  lastActivity: number,
  error: string | null,
): ContractStatus {
  return {
    isDeployed,
    isOperational,
    ttlRemaining,
    lastActivity,
    deployed: isDeployed,
    ttlValid: ttlRemaining > 0,
    liveUntilLedger: lastActivity,
    remainingLedgers: ttlRemaining,
    error,
  };
}

async function simulateReadOnlyContract(
  server: SorobanRpc.Server,
  contractAddress: string,
  kind: 'factory' | 'router' | 'custom',
): Promise<boolean> {
  try {
    const contract = new Contract(contractAddress);
    const account = await server.getAccount(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: TESTNET_NETWORK.networkPassphrase,
    });

    if (kind === 'router') {
      tx.addOperation(
        contract.call(
          'get_dynamic_fee',
          nativeToScVal(Address.fromString('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'), { type: 'address' }),
          nativeToScVal(Address.fromString('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'), { type: 'address' }),
        ),
      );
    } else {
      tx.addOperation(contract.call('get_protocol_version'));
    }

    const builtTx = tx.setTimeout(30).build();
    const sim = await Promise.race([
      server.simulateTransaction(builtTx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('contract simulation timeout')), 8_000),
      ),
    ]);

    return SorobanRpc.Api.isSimulationSuccess(sim);
  } catch {
    return false;
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
      const server = makeServer(url);
      const failuresBefore = 0;
      const latencySamples: number[] = [];
      let failures = 0;

      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        try {
          await Promise.race([
            server.getLatestLedger(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('score probe timeout')), 3_000),
            ),
          ]);
          latencySamples.push(Date.now() - start);
        } catch {
          failures++;
        }
      }

      const errRate = failures / 3;
      const avgLatency =
        latencySamples.length > 0
          ? latencySamples.reduce((acc, v) => acc + v, 0) / latencySamples.length
          : health.latencyMs;

      // Penalise endpoints with partial errors
      score = avgLatency * (1 + errRate * 10);
      void failuresBefore;
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
  getContractStatus(contractAddressOrUrl?: string, maybeContractId?: string): Promise<ContractStatus | ContractStatus[]> {
    return getContractStatus(contractAddressOrUrl, maybeContractId);
  }

  /**
   * Rank RPC endpoints by health + latency and return the best.
   * @see {@link getBestEndpoint}
   */
  getBestEndpoint(urls: string[]): Promise<string | null> {
    return getBestEndpoint(urls);
  }
}

/** Internal test helper — resets any cached latency windows. */
export function __resetLatencyCache(): void {
  void LATENCY_WINDOW_TTL_MS;
  // Hook for future cached-window logic.
}
