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
} from '@/types/monitoring';
import { ValidationError } from '@/errors';
import { validateAddress } from '@/utils/validation';

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

  constructor(client: CoralSwapClient) {
    this.client = client;
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
