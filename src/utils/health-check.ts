/**
 * RPC endpoint health and latency monitoring.
 *
 * SDK users connecting to public Soroban RPC endpoints need to verify
 * endpoint health and latency before sending critical transactions --
 * an unhealthy or stale RPC can cause transaction failures.
 *
 * A single `getLatestLedger` call is used as the probe: it round-trips
 * the network (giving us `latencyMs`), returns the current ledger
 * sequence (`blockHeight`, used to detect stale/lagging nodes), and the
 * protocol version the node is running -- all in one request.
 */

import { rpc } from '@stellar/stellar-sdk';
import { TESTNET_NETWORK } from '@/config';
import { RpcError } from '@/errors';

/** Default RPC health-probe timeout in milliseconds. */
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Result of a single RPC endpoint health probe.
 */
export interface RPCHealth {
  /** True when the endpoint responded within the timeout. */
  isHealthy: boolean;
  /** Round-trip time in milliseconds. `-1` when the probe failed or timed out. */
  latencyMs: number;
  /** Latest ledger sequence reported by the endpoint. `0` when unknown. */
  blockHeight: number;
  /** Protocol version reported by the endpoint. `'unknown'` when unavailable. */
  version: string;
}

/**
 * Probe a single Soroban RPC endpoint for health and latency.
 *
 * The endpoint is marked unhealthy if it fails to respond, throws, or
 * does not answer within `timeoutMs` (default 5 seconds).
 *
 * @param rpcUrl - RPC endpoint URL to probe. Defaults to the public testnet RPC.
 * @param timeoutMs - Maximum time in ms to wait for a response. Defaults to 5 000.
 * @returns An {@link RPCHealth} describing the endpoint's health, latency, block height, and version.
 *
 * @example
 * const health = await checkRPCHealth('https://soroban-testnet.stellar.org');
 * if (!health.isHealthy) console.warn('RPC endpoint is unhealthy');
 */
export async function checkRPCHealth(
  rpcUrl: string = TESTNET_NETWORK.rpcUrl,
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
): Promise<RPCHealth> {
  if (!rpcUrl) {
    return { isHealthy: false, latencyMs: -1, blockHeight: 0, version: 'unknown' };
  }

  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

    const ledger = await Promise.race([
      server.getLatestLedger(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC health probe timed out')), timeoutMs);
      }),
    ]);

    return {
      isHealthy: true,
      latencyMs: Date.now() - start,
      blockHeight: ledger.sequence,
      version: ledger.protocolVersion,
    };
  } catch {
    return { isHealthy: false, latencyMs: -1, blockHeight: 0, version: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a batch of RPC endpoints for health and latency in parallel.
 *
 * @param urls - RPC endpoint URLs to probe.
 * @returns An array of {@link RPCHealth}, one per input URL, in the same order.
 *
 * @example
 * const results = await checkAllEndpoints([
 *   'https://soroban-testnet.stellar.org',
 *   'https://soroban.stellar.org',
 * ]);
 */
export async function checkAllEndpoints(urls: string[]): Promise<RPCHealth[]> {
  return Promise.all(urls.map((url) => checkRPCHealth(url)));
}

/**
 * Return the lowest-latency healthy endpoint among the given URLs.
 *
 * Unhealthy endpoints (unresponsive, timed out, or errored) are excluded
 * from selection entirely, regardless of latency.
 *
 * @param urls - RPC endpoint URLs to choose from.
 * @throws {RpcError} If `urls` is empty or none of the endpoints are healthy.
 * @returns The URL of the lowest-latency healthy endpoint.
 *
 * @example
 * const best = await getBestEndpoint([
 *   'https://rpc-a.example.com',
 *   'https://rpc-b.example.com',
 * ]);
 */
export async function getBestEndpoint(urls: string[]): Promise<string> {
  if (!urls || urls.length === 0) {
    throw new RpcError('getBestEndpoint requires at least one URL');
  }

  const results = await checkAllEndpoints(urls);

  let bestUrl: string | null = null;
  let bestLatency = Infinity;

  for (let i = 0; i < urls.length; i++) {
    const health = results[i];
    if (health.isHealthy && health.latencyMs < bestLatency) {
      bestUrl = urls[i];
      bestLatency = health.latencyMs;
    }
  }

  if (!bestUrl) {
    throw new RpcError('No healthy RPC endpoint available among the provided URLs', { urls });
  }

  return bestUrl;
}
