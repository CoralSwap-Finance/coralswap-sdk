export type AlertCondition =
  | 'price_above'
  | 'price_below'
  | 'volume_above'
  | 'liquidity_below'
  | 'gas_above'
  | 'reserve_change';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertStatus = 'active' | 'paused' | 'fired' | 'acknowledged' | 'resolved' | 'archived';

export type AlertFrequency = 'once' | 'always' | 'interval';

export interface AlertConfig {
  name: string;
  description?: string;
  condition: AlertCondition;
  threshold: bigint;
  severity: AlertSeverity;
  frequency?: AlertFrequency;
  cooldownSeconds?: number;
  monitoredAddresses: string[];
  enabled?: boolean;
}

export interface AlertInstance {
  id: string;
  config: AlertConfig;
  status: AlertStatus;
  currentValue?: bigint;
  lastEvaluatedAt?: number;
  lastFiredAt?: number;
  fireCount: number;
  lastMessage?: string;
}

export interface AlertSummary {
  total: number;
  bySeverity: Record<AlertSeverity, number>;
  byStatus: Record<AlertStatus, number>;
  firedLast24h: number;
}

export type AlertStatusLegacy = 'active' | 'paused' | 'fired' | 'acknowledged' | 'resolved' | 'archived';

export interface AlertConfigLegacy {
  name: string;
  description?: string;
  condition: AlertCondition;
  threshold: bigint;
  severity: AlertSeverity;
  frequency?: AlertFrequency;
  cooldownSeconds?: number;
  monitoredAddresses: string[];
  enabled?: boolean;
}

export interface AlertInstanceLegacy {
  id: string;
  config: AlertConfigLegacy;
  status: AlertStatusLegacy;
  currentValue?: bigint;
  lastEvaluatedAt?: number;
  lastFiredAt?: number;
  fireCount: number;
  lastMessage?: string;
}

export interface AlertSummaryLegacy {
  total: number;
  bySeverity: Record<AlertSeverity, number>;
  byStatus: Record<AlertStatusLegacy, number>;
  firedLast24h: number;
}

export type AlertDirection = 'above' | 'below';

export type AlertStatusV2 = 'active' | 'triggered' | 'cleared';

export type AlertType = 'price' | 'il' | 'health' | 'volume';

export interface AlertConfigV2 {
  type: AlertType;
  target: string;
  threshold: number;
  direction: AlertDirection;
}

export interface PriceAlertConfig {
  tokenIn: string;
  tokenOut: string;
  pairAddress: string;
  thresholdPrice: bigint;
  direction: AlertDirection;
}

export interface ILAlertConfig {
  pairAddress: string;
  tokenA: string;
  tokenB: string;
  referencePrice: bigint;
  maxImpermanentLossBps: number;
}

export interface HealthAlertConfig {
  pairAddress: string;
}

export interface VolumeAlertConfig {
  pairAddress: string;
}

export interface PriceAlert {
  id: string;
  type: 'price';
  config: PriceAlertConfig;
  currentPrice: bigint;
  status: AlertStatusV2;
  triggered: boolean;
}

export interface ILAlert {
  id: string;
  type: 'il';
  config: ILAlertConfig;
  currentILBps: number;
  currentPrice: bigint;
  status: AlertStatusV2;
  triggered: boolean;
}

export interface HealthAlert {
  id: string;
  type: 'health';
  config: HealthAlertConfig;
  currentHealthScore: number;
  status: AlertStatusV2;
  triggered: boolean;
}

export interface VolumeAlert {
  id: string;
  type: 'volume';
  config: VolumeAlertConfig;
  currentVolume: bigint;
  status: AlertStatusV2;
  triggered: boolean;
}

export type Alert = PriceAlert | ILAlert | HealthAlert | VolumeAlert;
