import { CoralSwapClient } from '@/client';
import { sortTokens } from '@/utils/addresses';

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
 * Implements a caching layer for pair addresses to minimize RPC traffic
 * and improve performance across the SDK.
 */
export class FactoryModule {
    private client: CoralSwapClient;
    private cache: Map<string, string | null> = new Map();

    constructor(client: CoralSwapClient) {
        this.client = client;
    }

    /**
     * Resolve a pair contract address for two tokens.
     *
     * Checks the local cache first before querying the on-chain Factory contract.
     * Resulting addresses are cached for the lifetime of the client or until
     * the network is switched.
     *
     * @param tokenA - First token address.
     * @param tokenB - Second token address.
     * @param options - Lookup options.
     * @returns The pair address, or null if it doesn't exist.
     */
    async getPairAddress(
        tokenA: string,
        tokenB: string,
        options: GetPairOptions = {},
    ): Promise<string | null> {
        const [t0, t1] = sortTokens(tokenA, tokenB);
        const cacheKey = `${t0}:${t1}`;

        if (!options.bypassCache && this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey) ?? null;
        }

        const pairAddress = await this.client.factory.getPair(t0, t1);
        this.cache.set(cacheKey, pairAddress);

        return pairAddress;
    }

    /**
     * Pre-load the cache with known token pairs and their contract addresses.
     *
     * Useful for performance optimization when an application already knows
     * common pairs from a token list or local storage.
     *
     * @param pairs - Array of tokens pairs [tokenA, tokenB, pairAddress].
     */
    preLoadPairs(pairs: Array<[string, string, string]>): void {
        for (const [a, b, addr] of pairs) {
            const [t0, t1] = sortTokens(a, b);
            this.cache.set(`${t0}:${t1}`, addr);
        }
    }

    /**
     * Clear all cached pair addresses.
     */
    clearCache(): void {
        this.cache.clear();
    }
}
