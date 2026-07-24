export type MetricCategory =
  | 'liquidity'
  | 'volume'
  | 'fees'
  | 'gas'
  | 'price'
  | 'pairs';

export type MetricGranularity = '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

export interface MetricDataPoint {
  timestamp: number;
  value: number;
}

export interface MetricConfig {
  name: string;
  category: MetricCategory;
  targetAddress: string;
  tokenAddress?: string;
  granularity: MetricGranularity;
  enabled?: boolean;
  alertUpperBound?: number;
  alertLowerBound?: number;
}

export interface MetricInstance {
  id: string;
  config: MetricConfig;
  recentData: MetricDataPoint[];
  currentValue?: number;
  inBreach: boolean;
  createdAt: number;
}

export interface MonitoringDashboard {
  categories: Partial<Record<MetricCategory, MetricInstance[]>>;
  totalMetrics: number;
  metricsInBreach: number;
  totalLiquidityUSD: number;
  volume24hUSD: number;
  fees24hUSD: number;
  averageGasStroops: number;
}

export interface MetricQueryOptions {
  metricId: string;
  fromTimestamp: number;
  toTimestamp: number;
  granularity?: MetricGranularity;
  limit?: number;
}

/** Lookback window for {@link SystemMetrics}. */
export type SystemMetricsPeriod = '24h' | '7d' | '30d';

/**
 * Absolute and percentage change between two samples.
 *
 * When the previous value is `0` and the current value is nonzero,
 * `percentage` is `100` (zero-to-nonzero transition). When both are `0`,
 * `percentage` is `0`.
 */
export interface MetricChange {
  /** Absolute delta: current − previous */
  absolute: number;
  /** Percentage delta relative to previous (see zero-to-nonzero rules above) */
  percentage: number;
}

/**
 * Per-pool TVL movement used for top-growing / top-declining rankings.
 */
export interface PoolTvlChange {
  /** Pair contract address */
  pairAddress: string;
  /** TVL change over the requested period */
  tvlChange: MetricChange;
  /** Current pool TVL in USD */
  currentTvlUSD: number;
  /** Estimated TVL in USD at the start of the period */
  previousTvlUSD: number;
}

/**
 * High-level protocol KPIs for operators and governance.
 */
export interface SystemMetrics {
  /** Protocol-wide TVL change over the period */
  tvlChange: MetricChange;
  /** Aggregate swap volume change over the period */
  volumeChange: MetricChange;
  /** Unique swapper count change over the period */
  userGrowth: MetricChange;
  /** Fee revenue collected during the current period, in USD */
  revenueUSD: number;
  /** Pool with the largest TVL increase; `null` when unavailable */
  topGrowingPool: PoolTvlChange | null;
  /** Pool with the largest TVL decrease; `null` when unavailable */
  topDecliningPool: PoolTvlChange | null;
}
