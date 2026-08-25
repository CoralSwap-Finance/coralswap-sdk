import { CoralSwapClient } from '@/client';
import { PairInfo } from '@/types/pool';
import { sortTokens } from '@/utils/addresses';
import { ValidationError, PairNotFoundError } from '@/errors';
import { SorobanRpc } from '@stellar/stellar-sdk';

/** Default cache TTL in milliseconds (60 seconds). */
const DEFAULT_CACHE_TTL_MS = 60_000;

/** Default polling interval for watchPool in milliseconds (5 seconds). */
const DEFAULT_WATCH_INTERVAL_MS = 5_000;

/** Maximum ledger window for getEvents queries in watchPool. */
const WATCH_LEDGER_WINDOW = 100;

/**
 * A single pool event received by watchPool().
 */
export interface PoolEvent {
  type: 'swap' | 'mint' | 'burn';
  pairAddress: string;
  ledger: number;
  txHash: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Callback invoked when watchPool() detects a new pool event.
 */
export type PoolEventCallback = (event: PoolEvent) => void;

/**
 * A single entry in the pair-address cache.
 * Stores the resolved address (or null) together with the wall-clock
 * expiry so that stale data is automatically re-fetched.
 */
interface CacheEntry {
    /** Resolved pair address, or null when the pair does not exist. */
    address: string | null;
    /** Absolute timestamp (ms since epoch) after which this entry is stale. */
    expiresAt: number;
}

/**
 * Options for getPairAddress lookups.
 */
export interface GetPairOptions {
    /** Skip the local cache and query the contract directly. Defaults to false. */
    bypassCache?: boolean;
}

/**
 * Module for interacting with the CoralSwap Factory contract.
 *
 * Provides a TTL-based caching layer for pair addresses to minimize RPC
 * traffic, plus a batched `getPairInfo()` that returns reserves, fee, and
 * total supply in a single parallel multicall.
 *
 * Cache TTL defaults to 60 seconds and is configurable at construction time.
 *
 * ## Contract-address trust boundary audit (issue #514)
 *
 * A security audit was performed across all 26+ modules to identify where a
 * `pairAddress` / `contractAddress` parameter could be used in a write-path
 * operation without verification that the address is a real, registered
 * CoralSwap pool.
 *
 * ### Where registry verification is applied
 *
 * | Module | pairAddress parameter | Registry check |
 * |--------|----------------------|----------------|
 * | `swap.ts` | `simulateSwap()`, `getDirectQuote()`, `computeHops()` | Yes — resolves via `client.getPairAddress()` which calls the factory. |
 * | `liquidity.ts` | `getAddLiquidityQuote()`, `getPosition()` | Yes — resolves via `client.getPairAddress()`. |
 * | `limit-orders.ts` | `placeLimitOrder()` | Yes — validates against `client.getPairAddress()` on-chain. |
 * | `flash-loan.ts` | `estimateFee()`, `execute()`, `getConfig()` | No — accepts pairAddress directly. See note below. |
 * | `fees.ts` | `getCurrentFee()`, `getFeeState()` | No — accepts pairAddress directly. These are read-only queries. |
 * | `alerts.ts` | Alert configs | No — reads only, no direct pair interaction. |
 * | `monitoring.ts` | `getPoolHealth()` | No — read-only health check. |
 * | `oracle.ts` | `observe()`, `getTWAP()`, `getSpotPrice()` | No — reads cumulative prices (read-only). |
 *
 * ### Notes
 * - **Read-only queries** (fees, monitoring, oracle observations) are lower-risk because
 *   an attacker cannot drain funds through a read call. These modules accept any valid
 *   Stellar address and return data; callers should verify the address themselves if
 *   integrating with a write path.
 * - **Flash loans** are a write operation but inherently involve the caller deploying
 *   their own flash receiver contract. The pair address is passed as part of a broader
 *   composed transaction; callers should call `factory.verifyPairAddress()` before
 *   submitting if the pair address comes from an untrusted source.
 * - **External contracts** (Blend, Squid) are out of scope — they are not CoralSwap
 *   pairs and therefore cannot be verified against the CoralSwap factory registry.
 *
 * Use {@link verifyPairAddress} wherever your code receives a `pairAddress` from an
 * untrusted source.
 */
export class FactoryModule {
    private client: CoralSwapClient;
    private cache: Map<string, CacheEntry> = new Map();
    private cacheTtlMs: number;

    /**
     * @param client - The CoralSwapClient instance.
     * @param cacheTtlMs - Cache time-to-live in milliseconds. Defaults to 60 000 (60 s).
     */
    constructor(client: CoralSwapClient, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
        this.client = client;
        this.cacheTtlMs = cacheTtlMs;
    }

    /**
     * Resolve a pair contract address for two tokens.
     *
     * Checks the local TTL cache first. A cached entry is considered valid
     * until its `expiresAt` timestamp passes. Expired or absent entries
     * trigger a fresh on-chain lookup whose result is then cached.
     *
     * @param tokenA - First token address.
     * @param tokenB - Second token address.
     * @param options - Lookup options.
     * @returns The pair address, or null if the pair does not exist.
     */
    async getPairAddress(
        tokenA: string,
        tokenB: string,
        options: GetPairOptions = {},
    ): Promise<string | null> {
        const [t0, t1] = sortTokens(tokenA, tokenB);
        const cacheKey = `${t0}:${t1}`;

        if (!options.bypassCache) {
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() < cached.expiresAt) {
                return cached.address;
            }
        }

        const pairAddress = await this.client.factory.getPair(t0, t1);
        this.cache.set(cacheKey, {
            address: pairAddress,
            expiresAt: Date.now() + this.cacheTtlMs,
        });

        return pairAddress;
    }

    /**
     * Fetch batched pair metadata in a single parallel multicall.
     *
     * Resolves the pair address (from cache or on-chain), then concurrently
     * fetches reserves, dynamic fee, LP token address, and total LP supply —
     * returning all five fields in one `PairInfo` object.
     *
     * The pair address itself is cached with the standard TTL. Reserve/fee/
     * supply values are always fetched fresh (they change with every swap).
     *
     * @param tokenA - First token address.
     * @param tokenB - Second token address.
     * @returns A {@link PairInfo} containing address, reserveA, reserveB,
     *   feeBps, and totalSupply.
     * @throws {PairNotFoundError} If no pair exists for the given tokens.
     *
     * @example
     * const info = await factory.getPairInfo('CDLZ...', 'CBQH...');
     * console.log(info.reserveA, info.reserveB, info.feeBps, info.totalSupply);
     */
    async getPairInfo(tokenA: string, tokenB: string): Promise<PairInfo> {
        const [t0, t1] = sortTokens(tokenA, tokenB);

        const pairAddress = await this.getPairAddress(t0, t1);
        if (!pairAddress) {
            throw new PairNotFoundError(tokenA, tokenB);
        }

        const pair = this.client.pair(pairAddress);

        // Parallel multicall: reserves + fee + LP address fetched concurrently
        const [reserves, feeBps, lpTokenAddress] = await Promise.all([
            pair.getReserves(),
            pair.getDynamicFee(),
            pair.getLPTokenAddress(),
        ]);

        // Fetch total LP supply via the LP token contract
        const lpToken = this.client.lpToken(lpTokenAddress);
        const totalSupply = await lpToken.totalSupply();

        // Map reserves back to caller's token ordering (tokenA → reserveA)
        const isToken0A = t0 === tokenA;
        const reserveA = isToken0A ? reserves.reserve0 : reserves.reserve1;
        const reserveB = isToken0A ? reserves.reserve1 : reserves.reserve0;

        return {
            address: pairAddress,
            reserveA,
            reserveB,
            feeBps,
            totalSupply,
        };
    }

    /**
     * Verify that a pair address is a registered CoralSwap pool.
     *
     * Queries the on-chain factory's `getAllPairs()` and checks whether
     * `pairAddress` appears in the returned list. This confirms the
     * address points to a real CoralSwap-deployed pair, not an
     * attacker-controlled contract with a valid-looking address.
     *
     * **Security note:** This is a trust-boundary check for write-path
     * operations. A caller (or UI fed a bad address by a phishing link)
     * could pass an address that merely looks valid but points at a
     * malicious contract. Use this check whenever your code receives a
     * `pairAddress` from an untrusted source.
     *
     * This method performs one RPC call (`getAllPairs`) and then an
     * O(n) scan of the result. For frequent checks consider caching
     * the pair list at the application layer.
     *
     * @param pairAddress - The pair contract address to verify.
     * @returns `true` if the address is a registered CoralSwap pair.
     * @throws {ValidationError} If `pairAddress` is not a valid Stellar address.
     *
     * @example
     * ```ts
     * const factory = client.factoryModule();
     * const isRegistered = await factory.verifyPairAddress(pairAddress);
     * if (!isRegistered) {
     *   throw new Error('Address is not a registered CoralSwap pool');
     * }
     * ```
     */
    async verifyPairAddress(pairAddress: string): Promise<boolean> {
        if (!pairAddress || pairAddress.trim().length === 0) {
            throw new ValidationError('pairAddress must not be empty');
        }
        const allPairs = await this.client.factory.getAllPairs();
        return allPairs.some((addr) => addr === pairAddress);
    }

    /**
     * Invalidate cached data for a specific pair or for all pairs.
     *
     * - Called with a pair address: removes any cache entry whose stored
     *   address matches the given pair address.
     * - Called with no argument: clears the entire cache.
     *
     * Use this after creating a new pair, or when you know that on-chain
     * state has changed and you need fresh data on the next lookup.
     *
     * @param pairAddress - Optional pair contract address to invalidate.
     *   When omitted, all cached entries are cleared.
     *
     * @example
     * // Invalidate one pair
     * factory.invalidateCache('CPAIR...');
     *
     * // Clear entire cache
     * factory.invalidateCache();
     */
    invalidateCache(pairAddress?: string): void {
        if (pairAddress === undefined) {
            this.cache.clear();
            return;
        }

        // Walk the cache and remove any entry whose resolved address matches
        for (const [key, entry] of this.cache.entries()) {
            if (entry.address === pairAddress) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Pre-load the cache with known token pairs and their contract addresses.
     *
     * Useful for performance optimization when an application already knows
     * common pairs from a token list or local storage. Pre-loaded entries
     * are given a fresh TTL from the moment of insertion.
     *
     * @param pairs - Array of token pairs `[tokenA, tokenB, pairAddress]`.
     */
    preLoadPairs(pairs: Array<[string, string, string]>): void {
        for (const [a, b, addr] of pairs) {
            const [t0, t1] = sortTokens(a, b);
            this.cache.set(`${t0}:${t1}`, {
                address: addr,
                expiresAt: Date.now() + this.cacheTtlMs,
            });
        }
    }

    /**
     * Clear all cached pair addresses.
     *
     * Equivalent to `invalidateCache()` with no argument. Retained for
     * backward compatibility (called by `CoralSwapClient.setNetwork()`).
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Poll a pair contract for swap/mint/burn events and invoke a callback.
     *
     * Uses Soroban RPC `getEvents` to poll for new events from the given pair
     * contract at a regular interval. The callback is invoked for each new event
     * detected since the previous poll. Returns an unsubscribe function that
     * stops polling and cleans up the timer.
     *
     * The first poll fetches events from the current ledger minus a window of
     * {@link WATCH_LEDGER_WINDOW} ledgers. Subsequent polls track the highest
     * seen ledger to avoid re-emitting old events.
     *
     * @param pairAddress - The pair contract address to watch.
     * @param callback - Function called for each new pool event detected.
     * @param intervalMs - Polling interval in milliseconds (default 5000).
     * @returns An unsubscribe function that stops polling. Idempotent.
     * @throws {ValidationError} If `pairAddress` is empty or `callback` is not a function.
     */
    watchPool(
        pairAddress: string,
        callback: PoolEventCallback,
        intervalMs?: number,
    ): () => void {
        if (!pairAddress || pairAddress.trim().length === 0) {
            throw new ValidationError('pairAddress must not be empty');
        }
        if (typeof callback !== 'function') {
            throw new ValidationError('callback must be a function');
        }
        const interval = intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
        let active = true;
        let lastSeenLedger = 0;

        const poll = async () => {
            if (!active) return;
            try {
                const currentLedger = await this.client.getCurrentLedger();
                const startLedger = lastSeenLedger > 0
                    ? lastSeenLedger + 1
                    : Math.max(0, currentLedger - WATCH_LEDGER_WINDOW);

                if (startLedger > currentLedger) return;

                const request: SorobanRpc.Server.GetEventsRequest = {
                    startLedger,
                    filters: [
                        {
                            type: 'contract',
                            contractIds: [pairAddress],
                            topics: [
                                ['swap'],
                                ['mint'],
                                ['burn'],
                            ],
                        },
                    ],
                    limit: 200,
                };

                const response = await this.client.server.getEvents(request);
                if (!active) return;
                if (!response || !Array.isArray(response.events)) return;

                for (const ev of response.events) {
                    if (ev.ledger > currentLedger) continue;
                    if (ev.ledger > lastSeenLedger) {
                        lastSeenLedger = ev.ledger;
                    }

                    const topicName = ev.topic?.[0]
                        ? decodeScValString(ev.topic[0])
                        : '';
                    if (topicName !== 'swap' && topicName !== 'mint' && topicName !== 'burn') continue;

                    const timestamp = ev.ledgerClosedAt
                        ? Math.floor(new Date(ev.ledgerClosedAt).getTime() / 1000)
                        : Math.floor(Date.now() / 1000);

                    const event: PoolEvent = {
                        type: topicName as PoolEvent['type'],
                        pairAddress: ev.contractId?.toString() ?? pairAddress,
                        ledger: ev.ledger,
                        txHash: ev.txHash ?? '',
                        timestamp,
                        data: ev.value ? { raw: ev.value } : {},
                    };

                    callback(event);
                }
            } catch {
                // Silently catch polling errors
            }
        };

        poll();
        const timer = setInterval(poll, interval);

        return () => {
            active = false;
            clearInterval(timer);
        };
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeScValString(val: any): string {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val.sym === 'function') return val.sym().toString();
    if (typeof val.str === 'function') return val.str().toString();
    return val.toString();
}
