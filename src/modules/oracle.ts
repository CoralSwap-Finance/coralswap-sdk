import { CoralSwapClient } from '../client';
import { PRECISION } from '../config';

/**
 * TWAP Oracle data point from cumulative price accumulators.
 */
export interface TWAPObservation {
  price0CumulativeLast: bigint;
  price1CumulativeLast: bigint;
  blockTimestampLast: number;
}

/**
 * Computed TWAP price over a time window.
 */
export interface TWAPResult {
  pairAddress: string;
  token0: string;
  token1: string;
  price0TWAP: bigint;
  price1TWAP: bigint;
  timeWindow: number;
  startObservation: TWAPObservation;
  endObservation: TWAPObservation;
}

/**
 * Oracle module -- TWAP price feeds from CoralSwap pairs.
 *
 * Reads cumulative price accumulators from pair contracts to compute
 * Time-Weighted Average Prices. Useful for DeFi integrations that
 * need manipulation-resistant price feeds.
 */
export class OracleModule {
  private client: CoralSwapClient;
  private observationCache: Map<string, TWAPObservation[]> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Read the current cumulative price observation from a pair.
   */
  async observe(pairAddress: string): Promise<TWAPObservation> {
    const pair = this.client.pair(pairAddress);
    const prices = await pair.getCumulativePrices();

    const observation: TWAPObservation = {
      price0CumulativeLast: prices.price0CumulativeLast,
      price1CumulativeLast: prices.price1CumulativeLast,
      blockTimestampLast: prices.blockTimestampLast,
    };

    // Cache observation for TWAP calculation
    const key = pairAddress;
    const existing = this.observationCache.get(key) ?? [];
    existing.push(observation);
    // Keep only last 100 observations
    if (existing.length > 100) {
      existing.splice(0, existing.length - 100);
    }
    this.observationCache.set(key, existing);

    return observation;
  }

  /**
   * Compute TWAP between two observations.
   *
   * Requires at least two observations separated by time. Call observe()
   * at different times to collect data, then compute the TWAP.
   */
  computeTWAP(
    startObs: TWAPObservation,
    endObs: TWAPObservation,
  ): { price0TWAP: bigint; price1TWAP: bigint; timeWindow: number } {
    const timeElapsed = endObs.blockTimestampLast - startObs.blockTimestampLast;

    if (timeElapsed <= 0) {
      throw new Error('End observation must be after start observation');
    }

    const price0TWAP =
      (endObs.price0CumulativeLast - startObs.price0CumulativeLast) /
      BigInt(timeElapsed);

    const price1TWAP =
      (endObs.price1CumulativeLast - startObs.price1CumulativeLast) /
      BigInt(timeElapsed);

    return { price0TWAP, price1TWAP, timeWindow: timeElapsed };
  }

  /**
   * Get the TWAP for a pair using cached observations.
   *
   * If insufficient observations exist, takes a new one and throws
   * if still insufficient (caller must wait and retry).
   */
  async getTWAP(pairAddress: string): Promise<TWAPResult | null> {
    // Take a fresh observation
    await this.observe(pairAddress);

    const observations = this.observationCache.get(pairAddress);
    if (!observations || observations.length < 2) {
      return null; // Need at least 2 observations
    }

    const startObs = observations[0];
    const endObs = observations[observations.length - 1];

    if (endObs.blockTimestampLast <= startObs.blockTimestampLast) {
      return null;
    }

    const pair = this.client.pair(pairAddress);
    const tokens = await pair.getTokens();
    const { price0TWAP, price1TWAP, timeWindow } = this.computeTWAP(startObs, endObs);

    return {
      pairAddress,
      token0: tokens.token0,
      token1: tokens.token1,
      price0TWAP,
      price1TWAP,
      timeWindow,
      startObservation: startObs,
      endObservation: endObs,
    };
  }

  /**
   * Get the current spot price from reserves (not TWAP).
   */
  async getSpotPrice(pairAddress: string): Promise<{
    price0Per1: bigint;
    price1Per0: bigint;
  }> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new Error('Pool has no liquidity');
    }

    return {
      price0Per1: (reserve0 * PRECISION.PRICE_SCALE) / reserve1,
      price1Per0: (reserve1 * PRECISION.PRICE_SCALE) / reserve0,
    };
  }

  /**
   * Clear cached observations for a pair or all pairs.
   */
  clearCache(pairAddress?: string): void {
    if (pairAddress) {
      this.observationCache.delete(pairAddress);
    } else {
      this.observationCache.clear();
    }
  }

  /**
   * Get cached observation count for a pair.
   */
  getObservationCount(pairAddress: string): number {
    return this.observationCache.get(pairAddress)?.length ?? 0;
  }
}
