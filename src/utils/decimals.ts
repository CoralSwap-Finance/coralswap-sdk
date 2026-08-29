import { CoralSwapClient } from "@/client";

/**
 * A lightweight LRU cache for storing token decimal metadata.
 * Limits the number of cached tokens to prevent unbounded memory growth.
 */
class LRUDecimalsCache {
  private cache = new Map<string, number>();
  private readonly maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  get(key: string): number | undefined {
    if (!this.cache.has(key)) return undefined;
    // Move to end to mark as recently used
    const val = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key: string, value: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Global shared decimals resolver.
 * Maintains an LRU cache to reduce redundant RPC calls for token metadata.
 */
export class TokenDecimalsResolver {
  private cache: LRUDecimalsCache;
  private readonly defaultDecimals: number;

  /**
   * @param maxCacheSize Maximum number of token decimal values to store (default 500)
   * @param defaultDecimals Fallback decimals if RPC fails (default 7 for Soroban native)
   */
  constructor(maxCacheSize: number = 500, defaultDecimals: number = 7) {
    this.cache = new LRUDecimalsCache(maxCacheSize);
    this.defaultDecimals = defaultDecimals;
  }

  /**
   * Resolve decimals for a given token address.
   * Fetches from on-chain metadata if not cached.
   *
   * @param client The CoralSwap client to use for RPC calls
   * @param tokenAddress The contract address of the token
   * @returns The token's decimals or the fallback default if the fetch fails
   */
  async resolveDecimals(client: CoralSwapClient, tokenAddress: string): Promise<number> {
    const cached = this.cache.get(tokenAddress);
    if (cached !== undefined) return cached;

    try {
      const meta = await client.lpToken(tokenAddress).metadata();
      const decimals = meta.decimals;
      this.cache.set(tokenAddress, decimals);
      return decimals;
    } catch {
      // Fallback to default if network request fails or contract has no metadata
      return this.defaultDecimals;
    }
  }

  /**
   * Resolve multiple decimals concurrently.
   *
   * @param client The CoralSwap client
   * @param tokenAddresses Array of token addresses
   * @returns A map of token addresses to their decimals
   */
  async resolveMultiple(client: CoralSwapClient, tokenAddresses: string[]): Promise<Map<string, number>> {
    const unique = Array.from(new Set(tokenAddresses));
    const map = new Map<string, number>();

    await Promise.all(
      unique.map(async (token) => {
        const dec = await this.resolveDecimals(client, token);
        map.set(token, dec);
      })
    );

    return map;
  }

  /**
   * Clear the decimals cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Shared singleton instance for SDK-wide use.
 */
export const defaultDecimalsResolver = new TokenDecimalsResolver();
