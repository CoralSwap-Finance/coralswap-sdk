import { CoralSwapClient } from '@/client';
import {
  Alert,
  PriceAlertConfig,
  ILAlertConfig,
  AlertStatus,
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

export class AlertModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  async checkPriceAlert(
    config: PriceAlertConfig,
    id: string,
  ): Promise<Alert> {
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
  ): Promise<Alert> {
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
