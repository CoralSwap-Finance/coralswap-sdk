/** Rolling window for system-level metric queries. */
export type MonitoringPeriod = '24h' | '7d' | '30d';

/** Aggregated protocol metrics for a requested monitoring period. */
export interface SystemMetrics {
  period: MonitoringPeriod;
  healthy: boolean;
  poolCount: number;
  activePairCount: number;
  totalTVLUSD: number;
  volume24hUSD: number;
  fees24hUSD: number;
  rpcLatencyMs: number;
  timestamp: string;
}

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

/**
 * Protocol-wide dashboard metrics, aggregated across all pools.
 *
 * USD values are derived from on-chain spot prices anchored to caller-supplied
 * stablecoin addresses (the same convention used by TreasuryModule/PortfolioModule),
 * not RedStone -- see MonitoringModule's class doc for why.
 */
export interface ProtocolMetrics {
  /** Total value locked across all pools, in USD. */
  tvlUSD: number;
  /** Total swap volume across all pools over the trailing ~24h window, in USD. */
  volume24hUSD: number;
  /** Number of pools with non-zero reserves on both sides. */
  activePools: number;
  /** Count of distinct sender addresses that swapped in the trailing ~24h window. */
  uniqueUsers24h: number;
  /** Count of swap events across all pools in the trailing ~24h window. */
  totalSwaps24h: number;
  /** Average USD size per swap over the trailing ~24h window. */
  avgSwapSizeUSD: number;
  /** Unix ms timestamp when this snapshot was computed. */
  computedAt: number;
}

/**
 * Detailed metrics for a single pool.
 */
export interface PoolMetrics {
  /** Pair contract address. */
  pairAddress: string;
  /** Total value locked in this pool, in USD. */
  tvlUSD: number;
  /** Swap volume in this pool over the trailing ~24h window, in USD. */
  volume24hUSD: number;
  /** Count of swap events in this pool over the trailing ~24h window. */
  totalSwaps24h: number;
  /** Count of distinct senders that swapped in this pool over the trailing ~24h window. */
  uniqueUsers24h: number;
  /** Average USD size per swap in this pool over the trailing ~24h window. */
  avgSwapSizeUSD: number;
  /** Token 0 reserve (smallest unit). */
  reserve0: bigint;
  /** Token 1 reserve (smallest unit). */
  reserve1: bigint;
  /** Current dynamic fee, in basis points. */
  feeBps: number;
  /** Unix ms timestamp when this snapshot was computed. */
  computedAt: number;
}
