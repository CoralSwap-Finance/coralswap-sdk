import { CoralSwapClient } from '@/client';
import {
  Alert,
  AlertConfig,
  AlertDirection,
  AlertStatus,
  PriceAlertConfig,
  ILAlertConfig,
  HealthAlertConfig,
  VolumeAlertConfig,
  PriceAlert,
  ILAlert,
  HealthAlert,
  VolumeAlert,
} from '@/types/alerts';
import { ValidationError, InsufficientLiquidityError } from '@/errors';
import {
  validateAddress,
  validateDistinctTokens,
  validatePositiveAmount,
} from '@/utils/validation';

const PRICE_SCALE = 1_000_000_000_000_000_000n;
const PRICE_SCALE_SQRT = 1_000_000_000n;
const BPS = 10_000n;

interface StoredAlert {
  id: string;
  config: AlertConfig;
  referencePrice?: bigint;
  createdAt: number;
}

export class AlertModule {
  private client: CoralSwapClient;
  private alerts: Map<string, StoredAlert> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  async createAlert(config: AlertConfig): Promise<string> {
    this.validateAlertConfig(config);
    const id = generateId();
    this.alerts.set(id, { id, config, createdAt: Date.now() });
    return id;
  }

  async checkAlerts(address: string): Promise<Alert[]> {
    const results: Alert[] = [];
    const targetAlerts = Array.from(this.alerts.values())
      .filter(a => a.config.target === address);

    for (const stored of targetAlerts) {
      const alert = await this.checkStoredAlert(stored);
      results.push(alert);
    }

    return results;
  }

  deleteAlert(alertId: string): void {
    if (!this.alerts.has(alertId)) {
      throw new ValidationError(`Alert not found: ${alertId}`);
    }
    this.alerts.delete(alertId);
  }

  async checkPriceAlert(
    config: PriceAlertConfig,
    id: string,
  ): Promise<PriceAlert> {
    validateAddress(config.tokenIn, 'tokenIn');
    validateAddress(config.tokenOut, 'tokenOut');
    validateAddress(config.pairAddress, 'pairAddress');
    validateDistinctTokens(config.tokenIn, config.tokenOut);
    validatePositiveAmount(config.thresholdPrice, 'thresholdPrice');
    this.validateDirection(config.direction);

    const currentPrice = await this.getPoolPrice(
      config.pairAddress,
      config.tokenIn,
      config.tokenOut,
    );

    const triggered = config.direction === 'above'
      ? currentPrice >= config.thresholdPrice
      : currentPrice <= config.thresholdPrice;
    const status: AlertStatus = triggered ? 'triggered' : 'active';

    return { id, type: 'price', config, currentPrice, status, triggered };
  }

  async checkILAlert(
    config: ILAlertConfig,
    id: string,
  ): Promise<ILAlert> {
    validateAddress(config.tokenA, 'tokenA');
    validateAddress(config.tokenB, 'tokenB');
    validateAddress(config.pairAddress, 'pairAddress');
    validateDistinctTokens(config.tokenA, config.tokenB);
    validatePositiveAmount(config.referencePrice, 'referencePrice');
    this.validateBps(config.maxImpermanentLossBps, 'maxImpermanentLossBps');

    const pair = this.client.pair(config.pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    this.validatePairTokens(tokens, config.tokenA, config.tokenB);

    const isAToken0 = tokens.token0 === config.tokenA;
    const reserveA = isAToken0 ? reserve0 : reserve1;
    const reserveB = isAToken0 ? reserve1 : reserve0;

    if (reserveA === 0n || reserveB === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const currentPrice = (reserveB * PRICE_SCALE) / reserveA;
    const priceRatio = this.computePriceRatio(currentPrice, config.referencePrice);
    const currentILBps = this.computeImpermanentLossBps(priceRatio);

    const triggered = currentILBps >= config.maxImpermanentLossBps;
    const status: AlertStatus = triggered ? 'triggered' : 'active';

    return {
      id,
      type: 'il',
      config,
      currentILBps,
      currentPrice,
      status,
      triggered,
    };
  }

  async checkHealthAlert(
    config: HealthAlertConfig,
    id: string,
  ): Promise<HealthAlert> {
    validateAddress(config.pairAddress, 'pairAddress');

    const pair = this.client.pair(config.pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const currentHealthScore = this.computeHealthScore(reserve0, reserve1);
    const status: AlertStatus = 'active';
    const triggered = false;

    return { id, type: 'health', config, currentHealthScore, status, triggered };
  }

  async checkVolumeAlert(
    config: VolumeAlertConfig,
    id: string,
  ): Promise<VolumeAlert> {
    validateAddress(config.pairAddress, 'pairAddress');

    const pair = this.client.pair(config.pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const currentVolume = reserve0 + reserve1;
    const status: AlertStatus = 'active';
    const triggered = false;

    return { id, type: 'volume', config, currentVolume, status, triggered };
  }

  private async checkStoredAlert(stored: StoredAlert): Promise<Alert> {
    switch (stored.config.type) {
      case 'price':
        return this.checkPriceFromStored(stored);
      case 'il':
        return this.checkILFromStored(stored);
      case 'health':
        return this.checkHealthFromStored(stored);
      case 'volume':
        return this.checkVolumeFromStored(stored);
    }
  }

  private async checkPriceFromStored(stored: StoredAlert): Promise<PriceAlert> {
    const { target, threshold, direction } = stored.config;
    const pair = this.client.pair(target);
    const tokens = await pair.getTokens();

    const priceConfig: PriceAlertConfig = {
      tokenIn: tokens.token0,
      tokenOut: tokens.token1,
      pairAddress: target,
      thresholdPrice: BigInt(Math.round(threshold * 1_000_000_000_000_000)) * 1000n,
      direction,
    };

    return this.checkPriceAlert(priceConfig, stored.id);
  }

  private async checkILFromStored(stored: StoredAlert): Promise<ILAlert> {
    const { target, threshold } = stored.config;
    const pair = this.client.pair(target);
    const tokens = await pair.getTokens();

    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const referencePrice = (reserve1 * PRICE_SCALE) / reserve0;

    const ilConfig: ILAlertConfig = {
      tokenA: tokens.token0,
      tokenB: tokens.token1,
      pairAddress: target,
      referencePrice,
      maxImpermanentLossBps: Math.round(threshold),
    };

    return this.checkILAlert(ilConfig, stored.id);
  }

  private async checkHealthFromStored(stored: StoredAlert): Promise<HealthAlert> {
    const { target } = stored.config;
    const config: HealthAlertConfig = { pairAddress: target };
    return this.checkHealthAlert(config, stored.id);
  }

  private async checkVolumeFromStored(stored: StoredAlert): Promise<VolumeAlert> {
    const { target } = stored.config;
    const config: VolumeAlertConfig = { pairAddress: target };
    return this.checkVolumeAlert(config, stored.id);
  }

  private validateAlertConfig(config: AlertConfig): void {
    validateAddress(config.target, 'target');

    if (config.type === 'il') {
      this.validateBps(config.threshold, 'threshold');
    } else if (config.type === 'health') {
      this.validateBps(config.threshold, 'threshold');
    } else if (config.type === 'price') {
      if (config.threshold <= 0) {
        throw new ValidationError('price threshold must be positive', {
          threshold: config.threshold,
        });
      }
    } else if (config.type === 'volume') {
      if (config.threshold <= 0) {
        throw new ValidationError('volume threshold must be positive', {
          threshold: config.threshold,
        });
      }
    }

    this.validateDirection(config.direction);
  }

  private async getPoolPrice(
    pairAddress: string,
    tokenIn: string,
    tokenOut: string,
  ): Promise<bigint> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const isTokenInToken0 = tokens.token0 === tokenIn;
    this.validatePairTokens(tokens, tokenIn, tokenOut);

    const reserveIn = isTokenInToken0 ? reserve0 : reserve1;
    const reserveOut = isTokenInToken0 ? reserve1 : reserve0;

    return (reserveOut * PRICE_SCALE) / reserveIn;
  }

  private computePriceRatio(
    currentPrice: bigint,
    referencePrice: bigint,
  ): bigint {
    return (currentPrice * PRICE_SCALE) / referencePrice;
  }

  private computeImpermanentLossBps(priceRatio: bigint): number {
    if (priceRatio <= 0n) return 0;

    const sqrtRatio = this.sqrt(priceRatio);
    const numerator = 2n * sqrtRatio * PRICE_SCALE_SQRT * BPS;
    const denominator = PRICE_SCALE + priceRatio;

    if (denominator === 0n) return 0;

    const poolFractionBps = numerator / denominator;
    const lossBps = poolFractionBps >= BPS ? 0 : Number(BPS - poolFractionBps);
    return lossBps;
  }

  private computeHealthScore(reserve0: bigint, reserve1: bigint): number {
    if (reserve0 === 0n || reserve1 === 0n) return 0;

    const smaller = reserve0 < reserve1 ? reserve0 : reserve1;
    const larger = reserve0 < reserve1 ? reserve1 : reserve0;

    return Number((smaller * BPS) / larger);
  }

  private validatePairTokens(
    tokens: { token0: string; token1: string },
    tokenA: string,
    tokenB: string,
  ): void {
    const hasA = tokens.token0 === tokenA || tokens.token1 === tokenA;
    const hasB = tokens.token0 === tokenB || tokens.token1 === tokenB;

    if (!hasA || !hasB) {
      throw new ValidationError('tokens do not match pair tokens', {
        tokenA,
        tokenB,
        token0: tokens.token0,
        token1: tokens.token1,
      });
    }
  }

  private validateDirection(direction: string): void {
    if (direction !== 'above' && direction !== 'below') {
      throw new ValidationError('direction must be above or below', { direction });
    }
  }

  private validateBps(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > Number(BPS)) {
      throw new ValidationError(`${name} must be an integer between 0 and 10000`, {
        [name]: value,
      });
    }
  }

  private sqrt(value: bigint): bigint {
    if (value < 0n) return 0n;
    if (value === 0n) return 0n;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + value / x) / 2n;
    }
    return x;
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
