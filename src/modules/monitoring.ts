import { CoralSwapClient } from "@/client";
import { estimateUsdValue } from "@/utils/redstone";
import { ProtocolMetrics, PoolMetrics, MonitoringCacheEntry } from "@/types/monitoring";

/** Default cache TTL in milliseconds (60 seconds). */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Protocol-level monitoring module.
 *
 * Provides a single entry point for fetching key protocol metrics —
 * TVL, 24 h trading volume, active pool count, unique users, and swap
 * count — without forcing callers to make dozens of individual RPC
 * requests. All USD values use RedStone price feeds and are expressed
 * as bigint × 10^8 (same scale used throughout the SDK).
 *
 * Results are cached for 60 seconds by default to avoid redundant RPC
 * calls on dashboards or monitors that refresh frequently.
 *
 * @example
 * ```ts
 * const monitoring = new MonitoringModule(client);
 *
 * const metrics = await monitoring.getProtocolMetrics(prices);
 * console.log('TVL:', metrics.tvlUSD);
 * console.log('Active pools:', metrics.activePools);
 *
 * const pool = await monitoring.getPoolMetrics('CPAIR...', prices);
 * console.log('Pool TVL:', pool.tvlUSD);
 * ```
 */
export class MonitoringModule {
  private readonly client: CoralSwapClient;
  private readonly cacheTtlMs: number;

  /** Cache for protocol-wide metrics. */
  private protocolCache: MonitoringCacheEntry<ProtocolMetrics> | null = null;

  /** Per-pair cache keyed by pair address. */
  private poolCache: Map<string, MonitoringCacheEntry<PoolMetrics>> = new Map();

  /**
   * @param client     - The CoralSwapClient instance.
   * @param cacheTtlMs - Cache time-to-live in milliseconds. Defaults to 60 000 (60 s).
   */
  constructor(
    client: CoralSwapClient,
    cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
  ) {
    this.client = client;
    this.cacheTtlMs = cacheTtlMs;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch aggregate protocol metrics in a single call.
   *
   * On the first call (or after the TTL has expired) the module queries
   * the factory for all pair addresses, reads each pair's reserves and
   * fee, and sums up the values. Subsequent calls within the TTL window
   * return the cached result immediately, without any RPC traffic.
   *
   * @param prices     - RedStone price map (symbol → USD × 10^8 as bigint).
   *                     When a token's symbol is unknown, its reserve value
   *                     is excluded from the TVL rather than throwing.
   * @param tokenSymbols - Optional mapping of token contract address to its
   *                     RedStone feed symbol (e.g. `{ 'CXLM...': 'XLM' }`).
   *                     Used to look up prices for reserve tokens.
   * @param bypassCache  - Set to `true` to skip the local cache and force a
   *                     fresh RPC read. Defaults to `false`.
   * @returns Aggregate {@link ProtocolMetrics} for the whole protocol.
   *
   * @example
   * ```ts
   * const prices = { XLM: 12_00000000n, USDC: 100_000_000n };
   * const metrics = await monitoring.getProtocolMetrics(prices);
   * ```
   */
  async getProtocolMetrics(
    prices: Record<string, bigint>,
    tokenSymbols: Record<string, string> = {},
    bypassCache = false,
  ): Promise<ProtocolMetrics> {
    if (!bypassCache && this.protocolCache) {
      if (Date.now() < this.protocolCache.expiresAt) {
        return this.protocolCache.value;
      }
    }

    const allPairs = await this.client.factory.getAllPairs();
    const activePools = allPairs.length;

    // Fetch per-pair data in parallel — each pair is independently queryable.
    const pairDataResults = await Promise.allSettled(
      allPairs.map((pairAddress) =>
        this._fetchPairData(pairAddress, prices, tokenSymbols),
      ),
    );

    let tvlUSD = 0n;

    for (const result of pairDataResults) {
      if (result.status === "fulfilled") {
        tvlUSD += result.value.tvlUSD;
      }
      // Silently skip pairs that fail to load — a single broken pair should
      // not block the entire metrics fetch.
    }

    const fetchedAt = Math.floor(Date.now() / 1000);

    const metrics: ProtocolMetrics = {
      tvlUSD,
      // Volume and user metrics require event indexing which is not yet
      // available via direct RPC. Return zero values as per the spec so
      // callers can handle the unavailability gracefully.
      volume24hUSD: 0n,
      activePools,
      uniqueUsers24h: 0,
      totalSwaps24h: 0,
      avgSwapSizeUSD: 0n,
      fetchedAt,
    };

    this.protocolCache = {
      value: metrics,
      expiresAt: Date.now() + this.cacheTtlMs,
    };

    return metrics;
  }

  /**
   * Fetch detailed metrics for a single liquidity pool.
   *
   * The result is cached per pair address for the configured TTL. A
   * subsequent call for the same pair within the TTL returns the cached
   * value without any RPC traffic.
   *
   * @param pairAddress  - Soroban contract address of the pair.
   * @param prices       - RedStone price map (symbol → USD × 10^8 as bigint).
   * @param tokenSymbols - Optional mapping of token address to its RedStone
   *                     feed symbol.
   * @param bypassCache  - Set to `true` to force a fresh RPC read.
   * @returns {@link PoolMetrics} for the requested pair.
   *
   * @example
   * ```ts
   * const prices = { XLM: 12_00000000n, USDC: 100_000_000n };
   * const pool = await monitoring.getPoolMetrics('CPAIR...', prices);
   * console.log('Pool TVL:', pool.tvlUSD);
   * ```
   */
  async getPoolMetrics(
    pairAddress: string,
    prices: Record<string, bigint>,
    tokenSymbols: Record<string, string> = {},
    bypassCache = false,
  ): Promise<PoolMetrics> {
    if (!bypassCache) {
      const cached = this.poolCache.get(pairAddress);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
      }
    }

    const pair = this.client.pair(pairAddress);

    const [tokens, reserves, feeBps, lpTokenAddress] = await Promise.all([
      pair.getTokens(),
      pair.getReserves(),
      pair.getDynamicFee(),
      pair.getLPTokenAddress(),
    ]);

    const lpToken = this.client.lpToken(lpTokenAddress);
    const totalLPSupply = await lpToken.totalSupply();

    const tvlUSD = this._computePairTVL(
      tokens.token0,
      tokens.token1,
      reserves.reserve0,
      reserves.reserve1,
      prices,
      tokenSymbols,
    );

    const fetchedAt = Math.floor(Date.now() / 1000);

    const metrics: PoolMetrics = {
      pairAddress,
      token0: tokens.token0,
      token1: tokens.token1,
      reserve0: reserves.reserve0,
      reserve1: reserves.reserve1,
      tvlUSD,
      feeBps,
      totalLPSupply,
      fetchedAt,
    };

    this.poolCache.set(pairAddress, {
      value: metrics,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return metrics;
  }

  /**
   * Invalidate the protocol-level metrics cache.
   *
   * The next call to `getProtocolMetrics()` will perform a fresh RPC read.
   */
  invalidateProtocolCache(): void {
    this.protocolCache = null;
  }

  /**
   * Invalidate the pool metrics cache for a specific pair, or for all pairs
   * when called without arguments.
   *
   * @param pairAddress - Optional pair address to invalidate. When omitted,
   *                      all per-pool entries are cleared.
   */
  invalidatePoolCache(pairAddress?: string): void {
    if (pairAddress === undefined) {
      this.poolCache.clear();
    } else {
      this.poolCache.delete(pairAddress);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the data needed to compute TVL for a single pair.
   *
   * @internal
   */
  private async _fetchPairData(
    pairAddress: string,
    prices: Record<string, bigint>,
    tokenSymbols: Record<string, string>,
  ): Promise<{ tvlUSD: bigint }> {
    const pair = this.client.pair(pairAddress);
    const [tokens, reserves] = await Promise.all([
      pair.getTokens(),
      pair.getReserves(),
    ]);

    const tvlUSD = this._computePairTVL(
      tokens.token0,
      tokens.token1,
      reserves.reserve0,
      reserves.reserve1,
      prices,
      tokenSymbols,
    );

    return { tvlUSD };
  }

  /**
   * Compute the USD TVL for a pair from its reserves and a price map.
   *
   * Uses {@link estimateUsdValue} from the RedStone utility to convert
   * each reserve to USD × 10^8.  Tokens with no known price feed are
   * treated as zero contribution rather than throwing.
   *
   * @internal
   */
  private _computePairTVL(
    token0: string,
    token1: string,
    reserve0: bigint,
    reserve1: bigint,
    prices: Record<string, bigint>,
    tokenSymbols: Record<string, string>,
  ): bigint {
    const sym0 = tokenSymbols[token0];
    const sym1 = tokenSymbols[token1];

    const usd0 =
      sym0 !== undefined
        ? (estimateUsdValue(reserve0, sym0, prices) ?? 0n)
        : 0n;

    const usd1 =
      sym1 !== undefined
        ? (estimateUsdValue(reserve1, sym1, prices) ?? 0n)
        : 0n;

    return usd0 + usd1;
  }
}
