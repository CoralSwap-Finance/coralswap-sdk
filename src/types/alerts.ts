export type AlertDirection = 'above' | 'below';

export type AlertStatus = 'active' | 'triggered' | 'cleared';

export type AlertType = 'price' | 'il' | 'health' | 'volume';

export interface AlertConfig {
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
  status: AlertStatus;
  triggered: boolean;
}

export interface ILAlert {
  id: string;
  type: 'il';
  config: ILAlertConfig;
  currentILBps: number;
  currentPrice: bigint;
  status: AlertStatus;
  triggered: boolean;
}

export interface HealthAlert {
  id: string;
  type: 'health';
  config: HealthAlertConfig;
  currentHealthScore: number;
  status: AlertStatus;
  triggered: boolean;
}

export interface VolumeAlert {
  id: string;
  type: 'volume';
  config: VolumeAlertConfig;
  currentVolume: bigint;
  status: AlertStatus;
  triggered: boolean;
}

export type Alert = PriceAlert | ILAlert | HealthAlert | VolumeAlert;
