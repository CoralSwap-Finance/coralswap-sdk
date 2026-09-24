/**
 * Monitoring module — collect, query, and dashboard CoralSwap protocol metrics.
 *
 * Provides both high-level protocol health checks (pool metrics, system health,
 * protocol summaries) and low-level metric registration/collection with
 * dashboards for real-time monitoring.
 *
 * @module monitoring
 */

import { CoralSwapClient } from '@/client';
import {
  MetricConfig,
  MetricInstance,
  MetricDataPoint,
  MetricCategory,
  MetricGranularity,
  MetricQueryOptions,
  MonitoringDashboard,
  ProtocolMetrics,
  PoolMetrics,
  SystemMetrics,
  SystemMetricsPeriod,
  MetricChange,
  PoolTvlChange,
} from '@/types/monitoring';
import { SyncEvent, SwapEvent } from '@/types/events';
import { ValidationError } from '@/errors';
import { validateAddress } from '@/utils/validation';
import { LEDGER_CLOSE_INTERVAL_SECONDS } from '@/utils/ledger';
import { TypedEventCursor, MIN_START_LEDGER } from '@/utils/event-cursor';
import { TreasuryModule, TreasuryModuleOptions } from '@/modules/treasury';
import { SwapModule } from '@/modules/swap';

const STROOP = 1e7;
/** Cache TTL for getProtocolMetrics()/getPoolMetrics(), per acceptance criteria. */
const METRICS_CACHE_TTL_MS = 60_000;
/** Approximate ledger count for a 24h window, derived from the shared ledger close interval. */
const LEDGERS_PER_DAY = 86_400 / LEDGER_CLOSE_INTERVAL_SECONDS;
/**
 * Max swap events fetched per 24h-window query. getSwapHistory() reads a single
 * RPC page with no pagination, so pools/protocols with more than this many swaps
 * in 24h will under-count totalSwaps24h/uniqueUsers24h/volume24hUSD.
 */
const HISTORY_QUERY_LIMIT = 1000;
/**
 * Per-request page size for getSystemMetrics() event scans. EventCursor keeps
 * paging while pages come back full, so this bounds request size, not the
 * number of events considered.
 */
const SYSTEM_METRICS_PAGE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Built-in metric definitions
// ---------------------------------------------------------------------------

/**
 * Supported metric data types.
 */
export type MetricType = 'gauge' | 'counter' | 'histogram' | 'summary';

/**
 * Metric definition metadata.
 */
export interface MetricDefinition {
  name: string;
  description: string;
  type: MetricType;
  unit: string;
  labels?: string[];
}

/**
 * A single metric data point.
 */
export interface MetricPoint {
  name: string;
  value: number;
  type: MetricType;
  unit: string;
  timestamp: string;
  labels?: Record<string, string>;
}

/**
 * Pool-level health status.
 */
export interface PoolHealth {
  pairAddress: string;
  operational: boolean;
  tvlUSD: number;
  volume24hUSD: number;
  fees24hUSD: number;
  reserveRatio: number;
  oracleDeviationBps: number;
  lastSwapAt?: number;
  errors: string[];
  warnings: string[];
}

/**
 * System-level health check result.
 */
export interface SystemHealth {
  healthy: boolean;
  rpc: { connected: boolean; latencyMs: number; latestLedger: number; error?: string };
  ledger: { currentLedger: number; lastCheckedAt: string; gapLedgers: number };
  contracts: Array<{ address: string; version?: string; reachable: boolean }>;
  checkedAt: string;
}

/**
 * Parameters for querying custom metrics.
 */
export interface MetricQuery {
  metricPattern: string;
  fromLedger: number;
  toLedger: number;
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count';
  labels?: Record<string, string>;
}

/**
 * Aggregated metric result.
 */
export interface AggregatedMetric {
  name: string;
  aggregation: string;
  value: number;
  unit: string;
  count: number;
  fromLedger: number;
  toLedger: number;
}

/**
 * High-level protocol summary.
 */
export interface ProtocolSummary {
  totalTVLUSD: number;
  volume24hUSD: number;
  fees24hUSD: number;
  poolCount: number;
  activePairCount: number;
  totalLPHolders: number;
  timestamp: string;
}

const MAX_METRICS = 100;
const MAX_DATA_POINTS = 1000;
const DEFAULT_GRANULARITY: MetricGranularity = '1h';

/**
 * Protocol monitoring and health check module.
 *
 * Provides methods to query pool-level and system-level metrics,
 * perform health checks, compute aggregated statistics for
 * dashboards and alerting pipelines, and register/collect
 * custom metrics.
 *
 * @example
 * ```ts
 * const monitor = new MonitoringModule(client);
 *
 * // Protocol-level health
 * const summary = await monitor.getProtocolSummary();
 * const health = await monitor.checkSystemHealth();
 * const kpis = await monitor.getSystemMetrics('7d');
 * const poolHealth = await monitor.getPoolHealth('CA3D...');
 *
 * // Dashboard aggregator (cached for 60s)
 * const metrics = await monitor.getProtocolMetrics();
 * const poolMetrics = await monitor.getPoolMetrics('CA3D...');
 *
 * // Custom metric collection
 * const id = await monitor.registerMetric({
 *   name: 'CORAL-USDC TVL', category: 'liquidity',
 *   targetAddress: 'C...', granularity: '1h',
 * });
 * await monitor.collect(id);
 * const dashboard = await monitor.getDashboard();
 * ```
 *
 * ### Not a price oracle
 *
 * **All USD values, spot prices, and TVL figures returned by this module are
 * derived from on-chain reserve ratios using static stablecoin anchor prices
 * supplied by the caller. They are NOT attested oracle prices and must not
 * be used as the sole reference for settlement, liquidation, or pricing
 * decisions.** RedStone integration (see `utils/redstone.ts`) provides signed
 * per-swap price *guards*, but the monitoring module does not consume RedStone
 * feeds and offers no manipulation-resistant price stream. For reliable,
 * signed price data, use the TWAP Oracle (`src/modules/oracle.ts`) or a
 * dedicated oracle provider.
 *
 * ### USD pricing note
 * `getProtocolMetrics()`/`getPoolMetrics()`/`getSystemMetrics()` price reserves and swap volume in
 * USD using the same stablecoin-anchored spot pricing as
 * {@link TreasuryModule}/`PortfolioModule` (reserve ratios against
 * caller-supplied `stableAddresses`), not RedStone. RedStone in this SDK is a
 * per-swap price *guard* that requires the caller to supply a signed
 * `RedStonePayload` keyed by feed symbol (see `utils/redstone.ts`); it isn't a
 * queryable price source the SDK can call on its own, and it has no built-in
 * mapping from arbitrary token addresses to feed symbols. Pass
 * `stableAddresses` in the constructor options to enable USD valuations;
 * without at least one, all USD fields are 0.
 */
export class MonitoringModule {
  private readonly client: CoralSwapClient;
  private readonly metrics: Map<string, MetricInstance> = new Map();
  private readonly pricing: TreasuryModule;
  private readonly swap: SwapModule;
  private readonly cache: Map<string, { value: unknown; expiresAt: number }> = new Map();

  constructor(client: CoralSwapClient, options: TreasuryModuleOptions = {}) {
    this.client = client;
    this.pricing = new TreasuryModule(client, options);
    this.swap = new SwapModule(client);
  }

  private getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.value as T;
  }

  private setCached(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + METRICS_CACHE_TTL_MS });
  }

  // -----------------------------------------------------------------------
  // Dashboard aggregator (protocol + per-pool metrics, 60s cache)
  // -----------------------------------------------------------------------

  /**
   * Aggregate key protocol-wide metrics for a dashboard: TVL, 24h volume,
   * active pool count, unique users, swap count, and average swap size.
   *
   * Cached for 60 seconds to avoid redundant RPC calls.
   */
  async getProtocolMetrics(): Promise<ProtocolMetrics> {
    const cached = this.getCached<ProtocolMetrics>('protocol');
    if (cached) return cached;

    const allPairs = await this.client.factory.getAllPairs();
    const priceMap = await this.pricing.getSpotPriceMap(allPairs);

    let tvlUSD = 0;
    let activePools = 0;

    await Promise.all(
      allPairs.map(async (pairAddress) => {
        try {
          const pair = this.client.pair(pairAddress);
          const [{ token0, token1 }, { reserve0, reserve1 }] = await Promise.all([
            pair.getTokens(),
            pair.getReserves(),
          ]);
          if (reserve0 === 0n || reserve1 === 0n) return;
          activePools++;
          const price0 = priceMap.get(token0) ?? 0;
          const price1 = priceMap.get(token1) ?? 0;
          tvlUSD += (Number(reserve0) / STROOP) * price0 + (Number(reserve1) / STROOP) * price1;
        } catch {
          // Skip pools we can't read; don't fail the whole aggregate.
        }
      }),
    );

    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger = Math.max(0, currentLedger - LEDGERS_PER_DAY);
    const events = await this.swap.getSwapHistory({
      fromLedger,
      toLedger: currentLedger,
      limit: HISTORY_QUERY_LIMIT,
    });

    const totalSwaps24h = events.length;
    const uniqueUsers24h = new Set(events.map((e) => e.sender)).size;
    const volume24hUSD = events.reduce((sum, e) => {
      const price = priceMap.get(e.tokenIn) ?? 0;
      return sum + (Number(e.amountIn) / STROOP) * price;
    }, 0);
    const avgSwapSizeUSD = totalSwaps24h > 0 ? volume24hUSD / totalSwaps24h : 0;

    const result: ProtocolMetrics = {
      tvlUSD,
      volume24hUSD,
      activePools,
      uniqueUsers24h,
      totalSwaps24h,
      avgSwapSizeUSD,
      computedAt: Date.now(),
    };
    this.setCached('protocol', result);
    return result;
  }

  /**
   * Detailed metrics for a single pool: TVL, 24h volume, swap count, unique
   * users, average swap size, reserves, and current fee.
   *
   * Cached for 60 seconds to avoid redundant RPC calls.
   */
  async getPoolMetrics(pairAddress: string): Promise<PoolMetrics> {
    validateAddress(pairAddress, 'pairAddress');
    const cacheKey = `pool:${pairAddress}`;
    const cached = this.getCached<PoolMetrics>(cacheKey);
    if (cached) return cached;

    const allPairs = await this.client.factory.getAllPairs();
    const priceMap = await this.pricing.getSpotPriceMap(allPairs);

    const pair = this.client.pair(pairAddress);
    const [{ token0, token1 }, { reserve0, reserve1 }, feeBps] = await Promise.all([
      pair.getTokens(),
      pair.getReserves(),
      pair.getDynamicFee(),
    ]);

    const price0 = priceMap.get(token0) ?? 0;
    const price1 = priceMap.get(token1) ?? 0;
    const tvlUSD = (Number(reserve0) / STROOP) * price0 + (Number(reserve1) / STROOP) * price1;

    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger = Math.max(0, currentLedger - LEDGERS_PER_DAY);
    const events = await this.swap.getSwapHistory({
      pairAddress,
      fromLedger,
      toLedger: currentLedger,
      limit: HISTORY_QUERY_LIMIT,
    });

    const totalSwaps24h = events.length;
    const uniqueUsers24h = new Set(events.map((e) => e.sender)).size;
    const volume24hUSD = events.reduce((sum, e) => {
      const price = priceMap.get(e.tokenIn) ?? 0;
      return sum + (Number(e.amountIn) / STROOP) * price;
    }, 0);
    const avgSwapSizeUSD = totalSwaps24h > 0 ? volume24hUSD / totalSwaps24h : 0;

    const result: PoolMetrics = {
      pairAddress,
      tvlUSD,
      volume24hUSD,
      totalSwaps24h,
      uniqueUsers24h,
      avgSwapSizeUSD,
      reserve0,
      reserve1,
      feeBps,
      computedAt: Date.now(),
    };
    this.setCached(cacheKey, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // System metrics (growth KPIs)
  // -----------------------------------------------------------------------

  /**
   * High-level protocol KPIs for operators and governance.
   *
   * Compares the requested lookback window against the immediately preceding
   * window of equal length for TVL, swap volume, fee revenue, and unique
   * swappers, and ranks the pools whose TVL grew / declined the most.
   *
   * Historical figures come from on-chain `sync` / `swap` events read through
   * the shared {@link TypedEventCursor}, which handles topic encoding,
   * pagination, and decoding — this module never builds `getEvents` filters
   * itself. Previous TVL is valued from each pool's last `sync` event at or
   * before the start of the current window, priced with today's spot map.
   *
   * **RPC event retention:** the previous window starts at
   * `currentLedger - 2 * periodLedgers` (~2 days for `'24h'`, ~14 days for
   * `'7d'`, ~60 days for `'30d'`). Public Soroban RPC providers often retain
   * only a few days of events; outside that range `getEvents` rejects the
   * request, and the error is surfaced rather than silently reported as a
   * zero previous window. Use an archival / long-retention RPC for `'7d'` and
   * `'30d'`.
   *
   * @param period - Lookback window; defaults to `'24h'`.
   * @returns Aggregated {@link SystemMetrics}.
   * @throws {ValidationError} When `period` is not one of `'24h' | '7d' | '30d'`.
   *
   * @example
   * ```ts
   * const metrics = await monitor.getSystemMetrics('7d');
   * console.log(metrics.tvlChange.percentage); // e.g. 12.5
   * ```
   */
  async getSystemMetrics(period: SystemMetricsPeriod = '24h'): Promise<SystemMetrics> {
    if (period !== '24h' && period !== '7d' && period !== '30d') {
      throw new ValidationError(`Invalid system metrics period: ${period}`, {
        field: 'period',
        constraint: "'24h' | '7d' | '30d'",
        actual: period,
      });
    }

    const allPairs = await this.client.factory.getAllPairs();
    if (allPairs.length === 0) {
      return {
        tvlChange: computeMetricChange(0, 0),
        volumeChange: computeMetricChange(0, 0),
        revenueChange: computeMetricChange(0, 0),
        userGrowth: computeMetricChange(0, 0),
        revenueUSD: 0,
        topGrowingPool: null,
        topDecliningPool: null,
      };
    }

    const periodLedgers = periodToLedgers(period);
    const currentLedger = await this.client.getCurrentLedger();
    const currentStart = Math.max(MIN_START_LEDGER, currentLedger - periodLedgers);
    const previousStart = Math.max(MIN_START_LEDGER, currentLedger - periodLedgers * 2);

    const priceMap = await this.pricing.getSpotPriceMap(allPairs);

    const perPool = await Promise.all(
      allPairs.map(async (pairAddress) => {
        const [tvl, activity] = await Promise.all([
          this.fetchPoolTvlWindow(pairAddress, priceMap, previousStart, currentStart),
          this.fetchPoolSwapActivity(pairAddress, priceMap, previousStart, currentStart, currentLedger),
        ]);
        return { pairAddress, tvl, activity };
      }),
    );

    const poolChanges: PoolTvlChange[] = [];
    let currentTvl = 0;
    let previousTvl = 0;
    let currentVolume = 0;
    let previousVolume = 0;
    let currentRevenue = 0;
    let previousRevenue = 0;
    const currentUsers = new Set<string>();
    const previousUsers = new Set<string>();

    for (const { pairAddress, tvl, activity } of perPool) {
      if (tvl) {
        currentTvl += tvl.currentTvlUSD;
        previousTvl += tvl.previousTvlUSD;
        poolChanges.push({
          pairAddress,
          currentTvlUSD: tvl.currentTvlUSD,
          previousTvlUSD: tvl.previousTvlUSD,
          tvlChange: computeMetricChange(tvl.currentTvlUSD, tvl.previousTvlUSD),
        });
      }
      currentVolume += activity.currentVolumeUSD;
      previousVolume += activity.previousVolumeUSD;
      currentRevenue += activity.currentRevenueUSD;
      previousRevenue += activity.previousRevenueUSD;
      for (const u of activity.currentUsers) currentUsers.add(u);
      for (const u of activity.previousUsers) previousUsers.add(u);
    }

    const { topGrowingPool, topDecliningPool } = pickTopPools(poolChanges);

    return {
      tvlChange: computeMetricChange(currentTvl, previousTvl),
      volumeChange: computeMetricChange(currentVolume, previousVolume),
      revenueChange: computeMetricChange(currentRevenue, previousRevenue),
      userGrowth: computeMetricChange(currentUsers.size, previousUsers.size),
      revenueUSD: currentRevenue,
      topGrowingPool,
      topDecliningPool,
    };
  }

  // -----------------------------------------------------------------------
  // Pool metrics (protocol health)
  // -----------------------------------------------------------------------

  async getPoolHealth(pairAddress: string): Promise<PoolHealth> {
    validateAddress(pairAddress, 'pairAddress');
    try {
      const pair = this.client.pair(pairAddress);
      const [reserves] = await Promise.all([
        pair.getReserves(),
        pair.getTokens(),
      ]);
      const { reserve0, reserve1 } = reserves;
      const reserveRatio = reserve1 > 0n ? Number((reserve0 * 10000n) / reserve1) / 10000 : 0;
      return {
        pairAddress,
        operational: true,
        tvlUSD: 0,
        volume24hUSD: 0,
        fees24hUSD: 0,
        reserveRatio,
        oracleDeviationBps: 0,
        errors: [],
        warnings: [],
      };
    } catch {
      return {
        pairAddress,
        operational: false,
        tvlUSD: 0,
        volume24hUSD: 0,
        fees24hUSD: 0,
        reserveRatio: 0,
        oracleDeviationBps: 0,
        errors: ['Failed to fetch pool data'],
        warnings: [],
      };
    }
  }

  async getAllPoolHealth(): Promise<PoolHealth[]> {
    try {
      const pairs = await this.client.factory.getAllPairs();
      return await Promise.all(pairs.map((p) => this.getPoolHealth(p)));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // System health
  // -----------------------------------------------------------------------

  async checkSystemHealth(): Promise<SystemHealth> {
    const start = Date.now();
    let rpcConnected = false;
    let latestLedger = 0;
    let rpcError: string | undefined;

    try {
      latestLedger = await this.client.getCurrentLedger();
      rpcConnected = true;
    } catch (err) {
      rpcError = err instanceof Error ? err.message : 'RPC unreachable';
    }

    return {
      healthy: rpcConnected,
      rpc: { connected: rpcConnected, latencyMs: Date.now() - start, latestLedger, error: rpcError },
      ledger: { currentLedger: latestLedger, lastCheckedAt: new Date().toISOString(), gapLedgers: 0 },
      contracts: [],
      checkedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Protocol summary
  // -----------------------------------------------------------------------

  async getProtocolSummary(): Promise<ProtocolSummary> {
    const allHealth = await this.getAllPoolHealth();
    const active = allHealth.filter((p) => p.operational);
    return {
      totalTVLUSD: active.reduce((s, p) => s + p.tvlUSD, 0),
      volume24hUSD: active.reduce((s, p) => s + p.volume24hUSD, 0),
      fees24hUSD: active.reduce((s, p) => s + p.fees24hUSD, 0),
      poolCount: allHealth.length,
      activePairCount: active.length,
      totalLPHolders: 0,
      timestamp: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Metric queries (protocol-level)
  // -----------------------------------------------------------------------

  async queryMetrics(_query: MetricQuery): Promise<MetricPoint[]> {
    return [];
  }

  async queryAggregatedMetrics(_query: MetricQuery): Promise<AggregatedMetric[]> {
    return [];
  }

  getMetricDefinitions(): MetricDefinition[] {
    return [
      { name: 'pool.tvl_usd', description: 'Total value locked in a pool, denominated in USD.', type: 'gauge', unit: 'USD', labels: ['pair', 'network'] },
      { name: 'pool.volume_24h', description: 'Total swap volume over the trailing 24-hour window.', type: 'counter', unit: 'USD', labels: ['pair', 'network'] },
      { name: 'pool.fees_24h', description: 'Total fee revenue over the trailing 24-hour window.', type: 'counter', unit: 'USD', labels: ['pair', 'network'] },
      { name: 'pool.reserve_ratio', description: 'Ratio of token0 reserves to token1 reserves in the pool.', type: 'gauge', unit: 'ratio', labels: ['pair'] },
      { name: 'pool.price', description: 'Spot price of token0 in terms of token1, derived from reserves.', type: 'gauge', unit: 'USD', labels: ['pair', 'token'] },
      { name: 'system.rpc_latency', description: 'Round-trip latency to the Soroban RPC endpoint.', type: 'gauge', unit: 'ms', labels: ['network', 'endpoint'] },
      { name: 'system.ledger_gap', description: 'Number of ledgers behind the latest known ledger.', type: 'gauge', unit: 'ledgers', labels: ['network'] },
      { name: 'risk.price_deviation', description: 'Deviation of the on-chain spot price from the oracle reference price.', type: 'gauge', unit: 'bps', labels: ['pair'] },
    ];
  }

  // -----------------------------------------------------------------------
  // Metric registration and collection (managed metrics)
  // -----------------------------------------------------------------------

  async registerMetric(config: MetricConfig): Promise<string> {
    if (this.metrics.size >= MAX_METRICS) throw new ValidationError(`Maximum of ${MAX_METRICS} metrics reached`);
    if (!config.name || config.name.trim().length === 0) throw new ValidationError('Metric name must not be empty');
    validateAddress(config.targetAddress, 'targetAddress');
    const id = `metric_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const resolvedConfig: MetricConfig = { ...config, granularity: config.granularity ?? DEFAULT_GRANULARITY, enabled: config.enabled ?? true };
    this.metrics.set(id, { id, config: resolvedConfig, recentData: [], inBreach: false, createdAt: Math.floor(Date.now() / 1000) });
    return id;
  }

  async updateMetric(metricId: string, updates: Partial<MetricConfig>): Promise<void> {
    const existing = this.metrics.get(metricId);
    if (!existing) throw new ValidationError(`Metric not found: ${metricId}`);
    this.metrics.set(metricId, { ...existing, config: { ...existing.config, ...updates } });
  }

  async deleteMetric(metricId: string): Promise<void> {
    if (!this.metrics.has(metricId)) throw new ValidationError(`Metric not found: ${metricId}`);
    this.metrics.delete(metricId);
  }

  async listMetrics(category?: MetricCategory): Promise<MetricInstance[]> {
    const all = Array.from(this.metrics.values());
    return category ? all.filter((m) => m.config.category === category) : all;
  }

  async getMetric(metricId: string): Promise<MetricInstance> {
    const instance = this.metrics.get(metricId);
    if (!instance) throw new ValidationError(`Metric not found: ${metricId}`);
    return instance;
  }

  async collect(metricId: string): Promise<void> {
    const instance = this.metrics.get(metricId);
    if (!instance) throw new ValidationError(`Metric not found: ${metricId}`);
    if (!instance.config.enabled) return;
    const value = await this.fetchMetricValue(instance.config);
    const dataPoint: MetricDataPoint = { timestamp: Math.floor(Date.now() / 1000), value };
    instance.recentData.push(dataPoint);
    instance.currentValue = value;
    if (instance.recentData.length > MAX_DATA_POINTS) instance.recentData = instance.recentData.slice(-MAX_DATA_POINTS);
    instance.inBreach = false;
    if (instance.config.alertUpperBound !== undefined && value > instance.config.alertUpperBound) instance.inBreach = true;
    if (instance.config.alertLowerBound !== undefined && value < instance.config.alertLowerBound) instance.inBreach = true;
    this.metrics.set(metricId, instance);
  }

  async collectAll(): Promise<string[]> {
    const collected: string[] = [];
    for (const [id, instance] of this.metrics) {
      if (!instance.config.enabled) continue;
      try { await this.collect(id); collected.push(id); } catch { continue; }
    }
    return collected;
  }

  async queryMetric(options: MetricQueryOptions): Promise<MetricDataPoint[]> {
    const instance = this.metrics.get(options.metricId);
    if (!instance) throw new ValidationError(`Metric not found: ${options.metricId}`);
    let data = instance.recentData.filter((dp) => dp.timestamp >= options.fromTimestamp && dp.timestamp <= options.toTimestamp);
    const limit = options.limit ?? 1000;
    if (data.length > limit) { const step = Math.ceil(data.length / limit); data = data.filter((_, i) => i % step === 0); }
    return data;
  }

  async getDashboard(): Promise<MonitoringDashboard> {
    const all = Array.from(this.metrics.values());
    const categories: Partial<Record<MetricCategory, MetricInstance[]>> = {};
    let metricsInBreach = 0, totalLiquidityUSD = 0, volume24hUSD = 0, fees24hUSD = 0, totalGas = 0, gasCount = 0;
    for (const instance of all) {
      const cat = instance.config.category;
      if (!categories[cat]) categories[cat] = [];
      categories[cat]!.push(instance);
      if (instance.inBreach) metricsInBreach++;
      if (cat === 'liquidity' && instance.currentValue !== undefined) totalLiquidityUSD += instance.currentValue;
      if (cat === 'volume' && instance.currentValue !== undefined) volume24hUSD += instance.currentValue;
      if (cat === 'fees' && instance.currentValue !== undefined) fees24hUSD += instance.currentValue;
      if (cat === 'gas' && instance.currentValue !== undefined) { totalGas += instance.currentValue; gasCount++; }
    }
    return { categories, totalMetrics: all.length, metricsInBreach, totalLiquidityUSD, volume24hUSD, fees24hUSD, averageGasStroops: gasCount > 0 ? totalGas / gasCount : 0 };
  }

  prune(olderThanSeconds: number = 7_776_000): void {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    for (const [, instance] of this.metrics) {
      instance.recentData = instance.recentData.filter((dp) => dp.timestamp >= cutoff);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers — system metrics
  // -----------------------------------------------------------------------

  /**
   * Current and start-of-window TVL for one pool, or `null` when the pool's
   * live reserves can't be read (skipped, as in {@link getProtocolMetrics}).
   */
  private async fetchPoolTvlWindow(
    pairAddress: string,
    priceMap: Map<string, number>,
    fromLedger: number,
    toLedger: number,
  ): Promise<{ currentTvlUSD: number; previousTvlUSD: number } | null> {
    let reserve0: bigint, reserve1: bigint, token0: string, token1: string;
    try {
      const pair = this.client.pair(pairAddress);
      [{ reserve0, reserve1 }, { token0, token1 }] = await Promise.all([
        pair.getReserves(),
        pair.getTokens(),
      ]);
    } catch {
      return null;
    }

    const previous = await this.fetchPreviousReserves(pairAddress, fromLedger, toLedger);
    return {
      currentTvlUSD: reservesToUSD(reserve0, reserve1, token0, token1, priceMap),
      previousTvlUSD: previous
        ? reservesToUSD(previous.reserve0, previous.reserve1, token0, token1, priceMap)
        : 0,
    };
  }

  /**
   * Reserves from the pool's last `sync` event in `[fromLedger, toLedger]`,
   * or `null` if it emitted none in that range.
   */
  private async fetchPreviousReserves(
    pairAddress: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
    const cursor = new TypedEventCursor(this.client.server, pairAddress, ['sync']);
    const events = await cursor.scan({ fromLedger, toLedger, limit: SYSTEM_METRICS_PAGE_LIMIT });

    let latest: SyncEvent | null = null;
    for (const event of events) {
      // The final page can run past toLedger; getEvents has no end bound.
      if (event.type !== 'sync' || event.ledger > toLedger) continue;
      if (!latest || event.ledger >= latest.ledger) latest = event as SyncEvent;
    }
    return latest ? { reserve0: latest.reserve0, reserve1: latest.reserve1 } : null;
  }

  /**
   * Swap volume, fee revenue, and unique swappers for one pool, split into
   * the previous window `[fromLedger, currentStart)` and the current window
   * `[currentStart, toLedger]`.
   */
  private async fetchPoolSwapActivity(
    pairAddress: string,
    priceMap: Map<string, number>,
    fromLedger: number,
    currentStart: number,
    toLedger: number,
  ): Promise<{
    currentVolumeUSD: number;
    previousVolumeUSD: number;
    currentRevenueUSD: number;
    previousRevenueUSD: number;
    currentUsers: Set<string>;
    previousUsers: Set<string>;
  }> {
    const cursor = new TypedEventCursor(this.client.server, pairAddress, ['swap']);
    const events = await cursor.scan({ fromLedger, toLedger, limit: SYSTEM_METRICS_PAGE_LIMIT });

    const activity = {
      currentVolumeUSD: 0,
      previousVolumeUSD: 0,
      currentRevenueUSD: 0,
      previousRevenueUSD: 0,
      currentUsers: new Set<string>(),
      previousUsers: new Set<string>(),
    };

    for (const event of events) {
      if (event.type !== 'swap' || event.ledger > toLedger) continue;
      const swap = event as SwapEvent;
      const price = priceMap.get(swap.tokenIn) ?? 0;
      const volumeUSD = (Number(swap.amountIn) / STROOP) * price;
      const feeUSD = (Number((swap.amountIn * BigInt(swap.feeBps)) / 10_000n) / STROOP) * price;

      if (swap.ledger >= currentStart) {
        activity.currentVolumeUSD += volumeUSD;
        activity.currentRevenueUSD += feeUSD;
        activity.currentUsers.add(swap.sender);
      } else {
        activity.previousVolumeUSD += volumeUSD;
        activity.previousRevenueUSD += feeUSD;
        activity.previousUsers.add(swap.sender);
      }
    }
    return activity;
  }

  private async fetchMetricValue(config: MetricConfig): Promise<number> {
    switch (config.category) {
      case 'liquidity': return this.fetchLiquidityValue(config.targetAddress);
      case 'volume': return this.fetchVolumeValue(config.targetAddress);
      case 'fees': return this.fetchFeesValue(config.targetAddress);
      case 'gas': return this.fetchGasValue();
      case 'price': return this.fetchPriceValue(config.targetAddress);
      case 'pairs': return this.fetchPairsValue();
      default: return 0;
    }
  }

  private async fetchLiquidityValue(_address: string): Promise<number> {
    try { const r = await this.client.pair(_address).getReserves(); return Number(r.reserve0 + r.reserve1) / 1e7; }
    catch { return 0; }
  }

  private async fetchVolumeValue(_address: string): Promise<number> { return 0; }
  private async fetchFeesValue(_address: string): Promise<number> { return 0; }
  private async fetchGasValue(): Promise<number> { return 0; }

  private async fetchPriceValue(_pairAddress: string): Promise<number> {
    try { const r = await this.client.pair(_pairAddress).getReserves(); return r.reserve0 === 0n ? 0 : Number(r.reserve1) / Number(r.reserve0); }
    catch { return 0; }
  }

  private async fetchPairsValue(): Promise<number> {
    try { return (await this.client.factory.getAllPairs()).length; }
    catch { return 0; }
  }
}

// ---------------------------------------------------------------------------
// System metrics helpers (pure; exported for unit tests)
// ---------------------------------------------------------------------------

function periodToLedgers(period: SystemMetricsPeriod): number {
  if (period === '7d') return LEDGERS_PER_DAY * 7;
  if (period === '30d') return LEDGERS_PER_DAY * 30;
  return LEDGERS_PER_DAY;
}

function reservesToUSD(
  reserve0: bigint,
  reserve1: bigint,
  token0: string,
  token1: string,
  priceMap: Map<string, number>,
): number {
  const price0 = priceMap.get(token0) ?? 0;
  const price1 = priceMap.get(token1) ?? 0;
  return (Number(reserve0) / STROOP) * price0 + (Number(reserve1) / STROOP) * price1;
}

/**
 * Compute absolute + percentage change with explicit zero-baseline handling.
 *
 * - previous = 0, current = 0 → percentage 0
 * - previous = 0, current ≠ 0 → percentage 100
 * - otherwise → ((current − previous) / previous) × 100
 */
export function computeMetricChange(current: number, previous: number): MetricChange {
  const absolute = current - previous;
  if (previous === 0) {
    return { absolute, percentage: current === 0 ? 0 : 100 };
  }
  return { absolute, percentage: (absolute / previous) * 100 };
}

/**
 * Pick distinct top-growing and top-declining pools by absolute TVL change.
 */
export function pickTopPools(pools: PoolTvlChange[]): {
  topGrowingPool: PoolTvlChange | null;
  topDecliningPool: PoolTvlChange | null;
} {
  if (pools.length === 0) {
    return { topGrowingPool: null, topDecliningPool: null };
  }
  if (pools.length === 1) {
    const only = pools[0];
    return only.tvlChange.absolute >= 0
      ? { topGrowingPool: only, topDecliningPool: null }
      : { topGrowingPool: null, topDecliningPool: only };
  }

  const sorted = [...pools].sort((a, b) => b.tvlChange.absolute - a.tvlChange.absolute);
  return { topGrowingPool: sorted[0], topDecliningPool: sorted[sorted.length - 1] };
}
