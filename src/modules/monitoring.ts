/**
 * Monitoring module — collect, query, and dashboard CoralSwap protocol metrics.
 *
 * Provides both high-level protocol health checks (pool metrics, system health,
 * protocol summaries) and low-level metric registration/collection with
 * dashboards for real-time monitoring.
 *
 * @module monitoring
 */

import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import {
  MetricConfig,
  MetricInstance,
  MetricDataPoint,
  MetricCategory,
  MetricGranularity,
  MetricQueryOptions,
  MonitoringDashboard,
  SystemMetrics,
  SystemMetricsPeriod,
  MetricChange,
  PoolTvlChange,
} from '@/types/monitoring';
import { ValidationError } from '@/errors';
import { validateAddress } from '@/utils/validation';

/** ~1 day of Soroban ledgers (5s/ledger). */
const LEDGERS_PER_DAY = 17_280;

/**
 * Base64-encoded XDR `ScVal` symbols for Soroban `getEvents` topic filters.
 * Raw strings like `'sync'` / `'swap'` are rejected by real RPC servers.
 */
const TOPIC_SYNC = xdr.ScVal.scvSymbol('sync').toXDR('base64');
const TOPIC_SWAP = xdr.ScVal.scvSymbol('swap').toXDR('base64');

/**
 * Optional construction knobs for {@link MonitoringModule}.
 */
export interface MonitoringModuleOptions {
  /**
   * Addresses of tokens treated as $1 USD stablecoins.
   * Anchors USD valuations for TVL, volume, and revenue.
   */
  stableAddresses?: string[];
}

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
 * // Custom metric collection
 * const id = await monitor.registerMetric({
 *   name: 'CORAL-USDC TVL', category: 'liquidity',
 *   targetAddress: 'C...', granularity: '1h',
 * });
 * await monitor.collect(id);
 * const dashboard = await monitor.getDashboard();
 * ```
 */
export class MonitoringModule {
  private readonly client: CoralSwapClient;
  private readonly metrics: Map<string, MetricInstance> = new Map();
  private readonly stableSet: Set<string>;

  constructor(client: CoralSwapClient, options: MonitoringModuleOptions = {}) {
    this.client = client;
    this.stableSet = new Set(options.stableAddresses ?? []);
  }

  // -----------------------------------------------------------------------
  // Pool metrics (protocol health)
  // -----------------------------------------------------------------------

  async getPoolHealth(pairAddress: string): Promise<PoolHealth> {
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
      return Promise.all(pairs.map((p) => this.getPoolHealth(p)));
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
  // System metrics (growth KPIs)
  // -----------------------------------------------------------------------

  /**
   * High-level protocol KPIs for operators and governance.
   *
   * Compares the requested lookback window against the immediately preceding
   * window of equal length for TVL, volume, and unique users. Fee revenue is
   * reported for the current window only.
   *
   * **RPC event retention:** the previous window starts at
   * `currentLedger - 2 * periodLedgers` (~2 days for `'24h'`, ~14 days for
   * `'7d'`, ~60 days for `'30d'`). Public Soroban RPC providers often retain
   * only a few days of events; if `startLedger` falls outside that window the
   * request fails (or returns empty) and previous-period metrics degrade to
   * zero (false 100% zero-to-nonzero growth). Prefer an archival/long-retention
   * RPC when using `'7d'` or `'30d'`.
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
      throw new ValidationError(`Invalid system metrics period: ${period}`);
    }

    const empty: SystemMetrics = {
      tvlChange: { absolute: 0, percentage: 0 },
      volumeChange: { absolute: 0, percentage: 0 },
      userGrowth: { absolute: 0, percentage: 0 },
      revenueUSD: 0,
      topGrowingPool: null,
      topDecliningPool: null,
    };

    let allPairs: string[];
    try {
      allPairs = await this.client.factory.getAllPairs();
    } catch {
      return empty;
    }

    if (allPairs.length === 0) {
      return empty;
    }

    const periodLedgers = this.periodToLedgers(period);
    const currentLedger = await this.client.getCurrentLedger();
    const currentStart = Math.max(0, currentLedger - periodLedgers);
    // Previous window is the equal-length interval immediately before the
    // current window. Requires RPC event retention covering ~2× the period
    // (see getSystemMetrics JSDoc).
    const previousStart = Math.max(0, currentLedger - periodLedgers * 2);
    const previousEnd = currentStart;

    const priceMap = await this.buildPriceMap(allPairs);

    const poolChanges: PoolTvlChange[] = [];
    let currentTvlTotal = 0;
    let previousTvlTotal = 0;

    let currentVolume = 0;
    let previousVolume = 0;
    let currentRevenue = 0;
    const currentUsers = new Set<string>();
    const previousUsers = new Set<string>();

    for (const pairAddress of allPairs) {
      const { currentTvlUSD, previousTvlUSD } = await this.fetchPoolTvlWindow(
        pairAddress,
        priceMap,
        previousStart,
        previousEnd,
      );

      currentTvlTotal += currentTvlUSD;
      previousTvlTotal += previousTvlUSD;

      poolChanges.push({
        pairAddress,
        currentTvlUSD,
        previousTvlUSD,
        tvlChange: computeMetricChange(currentTvlUSD, previousTvlUSD),
      });

      const activity = await this.fetchPoolSwapActivity(
        pairAddress,
        priceMap,
        previousStart,
        currentLedger,
        currentStart,
      );

      currentVolume += activity.currentVolumeUSD;
      previousVolume += activity.previousVolumeUSD;
      currentRevenue += activity.currentRevenueUSD;
      for (const u of activity.currentUsers) currentUsers.add(u);
      for (const u of activity.previousUsers) previousUsers.add(u);
    }

    const { topGrowingPool, topDecliningPool } = pickTopPools(poolChanges);

    return {
      tvlChange: computeMetricChange(currentTvlTotal, previousTvlTotal),
      volumeChange: computeMetricChange(currentVolume, previousVolume),
      userGrowth: computeMetricChange(currentUsers.size, previousUsers.size),
      revenueUSD: currentRevenue,
      topGrowingPool,
      topDecliningPool,
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

  private periodToLedgers(period: SystemMetricsPeriod): number {
    if (period === '7d') return LEDGERS_PER_DAY * 7;
    if (period === '30d') return LEDGERS_PER_DAY * 30;
    return LEDGERS_PER_DAY;
  }

  private async buildPriceMap(allPairs: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    for (const addr of this.stableSet) {
      prices.set(addr, 1.0);
    }
    if (this.stableSet.size === 0) return prices;

    for (const pairAddress of allPairs) {
      try {
        const pair = this.client.pair(pairAddress);
        const [{ token0, token1 }, { reserve0, reserve1 }] = await Promise.all([
          pair.getTokens(),
          pair.getReserves(),
        ]);
        if (reserve0 === 0n || reserve1 === 0n) continue;
        if (this.stableSet.has(token0) && !prices.has(token1)) {
          prices.set(token1, Number(reserve0) / Number(reserve1));
        } else if (this.stableSet.has(token1) && !prices.has(token0)) {
          prices.set(token0, Number(reserve1) / Number(reserve0));
        }
      } catch {
        continue;
      }
    }
    return prices;
  }

  private reservesToTvlUSD(
    reserve0: bigint,
    reserve1: bigint,
    token0: string,
    token1: string,
    priceMap: Map<string, number>,
  ): number {
    const price0 = priceMap.get(token0) ?? 0;
    const price1 = priceMap.get(token1) ?? 0;
    return (Number(reserve0) / 1e7) * price0 + (Number(reserve1) / 1e7) * price1;
  }

  private async fetchPoolTvlWindow(
    pairAddress: string,
    priceMap: Map<string, number>,
    previousStart: number,
    previousEnd: number,
  ): Promise<{ currentTvlUSD: number; previousTvlUSD: number }> {
    try {
      const pair = this.client.pair(pairAddress);
      const [{ reserve0, reserve1 }, { token0, token1 }] = await Promise.all([
        pair.getReserves(),
        pair.getTokens(),
      ]);
      const currentTvlUSD = this.reservesToTvlUSD(reserve0, reserve1, token0, token1, priceMap);

      const previousReserves = await this.fetchPreviousReserves(
        pairAddress,
        previousStart,
        previousEnd,
      );
      const previousTvlUSD = previousReserves
        ? this.reservesToTvlUSD(
            previousReserves.reserve0,
            previousReserves.reserve1,
            token0,
            token1,
            priceMap,
          )
        : 0;

      return { currentTvlUSD, previousTvlUSD };
    } catch {
      return { currentTvlUSD: 0, previousTvlUSD: 0 };
    }
  }

  private async fetchPreviousReserves(
    pairAddress: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
    try {
      const request: SorobanRpc.Server.GetEventsRequest = {
        startLedger: fromLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [pairAddress],
            topics: [[TOPIC_SYNC]],
          },
        ],
        limit: 10000,
      };
      const response = await this.client.server.getEvents(request);
      if (!Array.isArray(response?.events) || response.events.length === 0) {
        return null;
      }

      let best: { ledger: number; reserve0: bigint; reserve1: bigint } | null = null;
      for (const event of response.events) {
        if (event.ledger > toLedger) continue;
        const parsed = parseSyncEvent(event);
        if (!parsed) continue;
        if (!best || event.ledger >= best.ledger) {
          best = { ledger: event.ledger, ...parsed };
        }
      }
      return best ? { reserve0: best.reserve0, reserve1: best.reserve1 } : null;
    } catch {
      return null;
    }
  }

  private async fetchPoolSwapActivity(
    pairAddress: string,
    priceMap: Map<string, number>,
    fromLedger: number,
    toLedger: number,
    currentStart: number,
  ): Promise<{
    currentVolumeUSD: number;
    previousVolumeUSD: number;
    currentRevenueUSD: number;
    currentUsers: Set<string>;
    previousUsers: Set<string>;
  }> {
    const empty = {
      currentVolumeUSD: 0,
      previousVolumeUSD: 0,
      currentRevenueUSD: 0,
      currentUsers: new Set<string>(),
      previousUsers: new Set<string>(),
    };

    try {
      const request: SorobanRpc.Server.GetEventsRequest = {
        startLedger: fromLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [pairAddress],
            topics: [[TOPIC_SWAP]],
          },
        ],
        limit: 10000,
      };
      const response = await this.client.server.getEvents(request);
      if (!Array.isArray(response?.events) || response.events.length === 0) {
        return empty;
      }

      let currentVolumeUSD = 0;
      let previousVolumeUSD = 0;
      let currentRevenueUSD = 0;
      const currentUsers = new Set<string>();
      const previousUsers = new Set<string>();

      for (const event of response.events) {
        if (event.ledger > toLedger) continue;
        const parsed = parseSwapEvent(event);
        if (!parsed) continue;

        const priceUSD = priceMap.get(parsed.tokenIn) ?? 0;
        const volumeUSD = (Number(parsed.amountIn) / 1e7) * priceUSD;
        const feeUSD = (Number(parsed.feeAmount) / 1e7) * priceUSD;

        if (event.ledger >= currentStart) {
          currentVolumeUSD += volumeUSD;
          currentRevenueUSD += feeUSD;
          currentUsers.add(parsed.sender);
        } else {
          previousVolumeUSD += volumeUSD;
          previousUsers.add(parsed.sender);
        }
      }

      return {
        currentVolumeUSD,
        previousVolumeUSD,
        currentRevenueUSD,
        currentUsers,
        previousUsers,
      };
    } catch {
      return empty;
    }
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
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compute absolute + percentage change with correct zero-to-nonzero handling.
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
    if (only.tvlChange.absolute >= 0) {
      return { topGrowingPool: only, topDecliningPool: null };
    }
    return { topGrowingPool: null, topDecliningPool: only };
  }

  const sorted = [...pools].sort((a, b) => b.tvlChange.absolute - a.tvlChange.absolute);
  const topGrowingPool = sorted[0];
  const topDecliningPool = sorted[sorted.length - 1];

  // Guarantee distinct pools even if all changes are equal (already true for length ≥ 2)
  if (topGrowingPool.pairAddress === topDecliningPool.pairAddress) {
    return { topGrowingPool, topDecliningPool: null };
  }

  return { topGrowingPool, topDecliningPool };
}

function parseSyncEvent(rawEvent: unknown): { reserve0: bigint; reserve1: bigint } | null {
  try {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const eventObj = rawEvent as Record<string, unknown>;
    const topics = (eventObj.topic as unknown[]) ?? [];
    const topic0 = topics[0];
    const topicName =
      typeof topic0 === 'string'
        ? topic0
        : topic0 && typeof topic0 === 'object'
          ? (() => {
              const t = topic0 as Record<string, () => { toString(): string }>;
              try {
                return t.sym?.().toString() ?? t.str?.().toString() ?? '';
              } catch {
                return '';
              }
            })()
          : '';
    if (topicName !== 'sync') return null;

    const map = decodeEventMap(eventObj.value);
    if (!map) return null;
    const reserve0 = readI128(map, 'reserve0');
    const reserve1 = readI128(map, 'reserve1');
    if (reserve0 === undefined || reserve1 === undefined) return null;
    return { reserve0, reserve1 };
  } catch {
    return null;
  }
}

function parseSwapEvent(rawEvent: unknown): {
  amountIn: bigint;
  feeAmount: bigint;
  tokenIn: string;
  sender: string;
} | null {
  try {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const eventObj = rawEvent as Record<string, unknown>;
    const topics = (eventObj.topic as unknown[]) ?? [];
    const topic0 = topics[0];
    const topicName =
      typeof topic0 === 'string'
        ? topic0
        : topic0 && typeof topic0 === 'object'
          ? (() => {
              const t = topic0 as Record<string, () => { toString(): string }>;
              try {
                return t.sym?.().toString() ?? t.str?.().toString() ?? '';
              } catch {
                return '';
              }
            })()
          : '';
    if (topicName !== 'swap') return null;

    const map = decodeEventMap(eventObj.value);
    if (!map) return null;

    const amountIn = readI128(map, 'amount_in');
    const feeBps = readU32(map, 'fee_bps');
    const tokenIn = readAddress(map, 'token_in');
    const sender = readAddress(map, 'sender');
    if (amountIn === undefined || feeBps === undefined || !tokenIn || !sender) return null;

    const feeAmount = (amountIn * BigInt(feeBps)) / 10000n;
    return { amountIn, feeAmount, tokenIn, sender };
  } catch {
    return null;
  }
}

function decodeEventMap(value: unknown): Map<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const valueObj = value as Record<string, unknown>;
  const entries: unknown[] =
    typeof valueObj.map === 'function'
      ? (valueObj.map as () => unknown[])()
      : (valueObj._value as unknown[]);
  if (!Array.isArray(entries)) return null;

  const map = new Map<string, unknown>();
  for (const entry of entries as Array<{ key: unknown; val: unknown }>) {
    if (!entry || typeof entry !== 'object') continue;
    const k = entry.key as Record<string, () => { toString(): string }>;
    let key: string | undefined;
    try {
      key = k.sym?.().toString() ?? k.str?.().toString();
    } catch {
      /* skip */
    }
    if (key) map.set(key, entry.val);
  }
  return map;
}

function readAddress(map: Map<string, unknown>, key: string): string | undefined {
  const val = map.get(key);
  if (!val || typeof val !== 'object') return undefined;
  try {
    const v = val as Record<string, unknown>;
    if (typeof v.address === 'function') {
      return (v.address as () => { toString(): string })().toString();
    }
    if (v._value && typeof (v._value as { toString(): string }).toString === 'function') {
      return (v._value as { toString(): string }).toString();
    }
  } catch {
    /* skip */
  }
  return undefined;
}

function readI128(map: Map<string, unknown>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val || typeof val !== 'object') return undefined;
  try {
    const v = val as Record<string, unknown>;
    if (typeof v.i128 === 'function') {
      const parts = (v.i128 as () => {
        hi(): { toString(): string };
        lo(): { toString(): string };
      })();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
  } catch {
    /* skip */
  }
  return undefined;
}

function readU32(map: Map<string, unknown>, key: string): number | undefined {
  const val = map.get(key);
  if (!val || typeof val !== 'object') return undefined;
  try {
    const v = val as Record<string, unknown>;
    if (typeof v.u32 === 'function') return (v.u32 as () => number)();
  } catch {
    /* skip */
  }
  return undefined;
}
