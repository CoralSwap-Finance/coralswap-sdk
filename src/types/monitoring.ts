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

export interface SystemMetrics {
  tvlUSD: number;
  volume24hUSD: number;
  revenue24hUSD: number;
  previousTVLUSD: number;
  previousVolume24hUSD: number;
  previousRevenue24hUSD: number;
  previousWindowTVLUSD: number;
  previousWindowVolumeUSD: number;
  previousWindowRevenueUSD: number;
  timestamp: string;
}
