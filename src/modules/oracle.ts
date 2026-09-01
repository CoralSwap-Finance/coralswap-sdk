import { CoralSwapClient } from "@/client";
import { PRECISION } from "@/config";
import { ValidationError, InsufficientLiquidityError } from "@/errors";

/**
 * Minimum time window (in seconds) for TWAP to resist single-block manipulation.
 * A TWAP computed over a shorter window is not manipulation-resistant and should
 * be rejected or flagged.
 */
export const MIN_TWAP_WINDOW_SECONDS = 300; // 5 minutes

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
 *
 * ## TWAP Consumer Audit (2026-07)
 *
 * A systematic audit was performed to identify every module that imports
 * and relies on OracleModule's {@link computeTWAP} or {@link getTWAP} for
 * price-sensitive decisions. This audit was driven by issue #512.
 *
 * ### Findings
 *
 * | Module        | Uses OracleModule TWAP? | Notes |
 * |---------------|------------------------|-------|
 * | `limit-orders.ts` | **No** | Interacts directly with the on-chain limit-orders contract. No TWAP dependency. |
 * | `stop-loss.ts`    | **No** | Uses a separate RedStone oracle contract for trigger prices. |
 * | `alerts.ts`       | **No** | Monitors raw reserves and user-defined thresholds. |
 * | `swap.ts`         | **No** | Optional RedStone price guard via `verifyRedStonePayload` utility. |
 * | `order-book.ts`   | **No** | Uses mock/static data; no TWAP calls. |
 * | `dca.ts`          | **No** | No TWAP dependency. |
 * | `price-feed.ts`   | **No** | Mentions OracleModule only in a TSDoc example comment. |
 * | `oracle.ts`       | **Self** | Defines and tests its own computeTWAP/getTWAP. |
 *
 * **Conclusion:** No production module currently consumes OracleModule's TWAP
 * for price-sensitive decisions. The minimum-window enforcement added in the
 * companion oracle-hardening fix is sufficient for this module; no additional
 * per-consumer guards are needed at this time.
 */
export class OracleModule {
  private client: CoralSwapClient;
  private observationCache: Map<string, TWAPObservation[]> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Read the current cumulative price observation from a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns The current cumulative price observation
   * @example
   * const obs = await client.oracle.observe('C...');
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
   *
   * @param startObs - The earlier observation
   * @param endObs - The later observation
   * @param options - Optional configuration
   * @param options.enforceMinWindow - Whether to enforce minimum window (default: true)
   * @returns An object containing computed TWAP prices
   * @throws {ValidationError} If the end observation time is not after the start observation time
   * @throws {ValidationError} If the time window is below the minimum required for manipulation resistance
   * @example
   * const twap = client.oracle.computeTWAP(obs1, obs2);
   */
  computeTWAP(
    startObs: TWAPObservation,
    endObs: TWAPObservation,
    options: { enforceMinWindow?: boolean } = {},
  ): { price0TWAP: bigint; price1TWAP: bigint; timeWindow: number } {
    const { enforceMinWindow = true } = options;
    const timeElapsed = endObs.blockTimestampLast - startObs.blockTimestampLast;

    if (timeElapsed <= 0) {
      throw new ValidationError(
        "End observation must be after start observation",
        {
          startTimestamp: startObs.blockTimestampLast,
          endTimestamp: endObs.blockTimestampLast,
        },
      );
    }

    if (enforceMinWindow && timeElapsed < MIN_TWAP_WINDOW_SECONDS) {
      throw new ValidationError(
        `TWAP window too short for manipulation resistance (${timeElapsed}s < ${MIN_TWAP_WINDOW_SECONDS}s minimum)`,
        {
          timeElapsed,
          minRequired: MIN_TWAP_WINDOW_SECONDS,
          startTimestamp: startObs.blockTimestampLast,
          endTimestamp: endObs.blockTimestampLast,
        },
      );
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
   * If insufficient observations exist, takes a new one and returns null
   * (caller must wait and retry).
   *
   * @param pairAddress - The address of the pair contract
   * @param options - Optional configuration
   * @param options.enforceMinWindow - Whether to enforce minimum window (default: true)
   * @returns The TWAP result or null if minimum 2 observations aren't met or window is too short
   * @example
   * const twap = await client.oracle.getTWAP('C...');
   */
  async getTWAP(
    pairAddress: string,
    options: { enforceMinWindow?: boolean } = {},
  ): Promise<TWAPResult | null> {
    const { enforceMinWindow = true } = options;

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

    const timeWindow = endObs.blockTimestampLast - startObs.blockTimestampLast;
    if (enforceMinWindow && timeWindow < MIN_TWAP_WINDOW_SECONDS) {
      return null; // Window too short - caller should wait longer
    }

    const pair = this.client.pair(pairAddress);
    const tokens = await pair.getTokens();
    const { price0TWAP, price1TWAP } = this.computeTWAP(
      startObs,
      endObs,
      { enforceMinWindow: false }, // Already checked above
    );

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
   *
   * @param pairAddress - The address of the pair contract
   * @returns Spot price ratios for both tokens
   * @throws {InsufficientLiquidityError} If reserves are zero
   * @example
   * const spot = await client.oracle.getSpotPrice('C...');
   */
  async getSpotPrice(pairAddress: string): Promise<{
    price0Per1: bigint;
    price1Per0: bigint;
  }> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError(pairAddress);
    }

    return {
      price0Per1: (reserve0 * PRECISION.PRICE_SCALE) / reserve1,
      price1Per0: (reserve1 * PRECISION.PRICE_SCALE) / reserve0,
    };
  }

  /**
   * Compute price deviation between TWAP and spot price.
   *
   * This metric compares two independent price sources (oracle TWAP vs pool spot price)
   * to detect potential manipulation or anomalies. Returns the deviation in basis points.
   *
   * @param pairAddress - The address of the pair contract
   * @returns Deviation in basis points for both price directions, or null if TWAP unavailable
   * @throws {InsufficientLiquidityError} If pool has no liquidity
   * @example
   * const deviation = await client.oracle.getPriceDeviation('C...');
   * if (deviation && deviation.price0DeviationBps > 500) {
   *   console.warn('Price deviation exceeds 5%');
   * }
   */
  async getPriceDeviation(pairAddress: string): Promise<{
    price0DeviationBps: number;
    price1DeviationBps: number;
    twapPrice0: bigint;
    twapPrice1: bigint;
    spotPrice0: bigint;
    spotPrice1: bigint;
  } | null> {
    // Get TWAP price (manipulation-resistant)
    const twapResult = await this.getTWAP(pairAddress);
    if (!twapResult) {
      return null; // Not enough data for TWAP yet
    }

    // Get spot price (current reserves)
    const spotPrice = await this.getSpotPrice(pairAddress);

    // Compute deviations in basis points (1 bps = 0.01%)
    const price0DeviationBps = this.computeDeviationBps(
      twapResult.price0TWAP,
      spotPrice.price0Per1,
    );

    const price1DeviationBps = this.computeDeviationBps(
      twapResult.price1TWAP,
      spotPrice.price1Per0,
    );

    return {
      price0DeviationBps,
      price1DeviationBps,
      twapPrice0: twapResult.price0TWAP,
      twapPrice1: twapResult.price1TWAP,
      spotPrice0: spotPrice.price0Per1,
      spotPrice1: spotPrice.price1Per0,
    };
  }

  /**
   * Compute deviation between two prices in basis points.
   *
   * @param referencePrice - The reference price (e.g., TWAP)
   * @param currentPrice - The current price to compare (e.g., spot)
   * @returns Absolute deviation in basis points
   * @private
   */
  private computeDeviationBps(referencePrice: bigint, currentPrice: bigint): number {
    if (referencePrice === 0n) return 0;

    // Calculate absolute deviation: |current - reference| / reference * 10000
    const diff = currentPrice > referencePrice
      ? currentPrice - referencePrice
      : referencePrice - currentPrice;

    const deviationBps = Number((diff * 10_000n) / referencePrice);
    return deviationBps;
  }

  /**
   * Clear cached observations for a pair or all pairs.
   *
   * @param pairAddress - Optional specific pair to clear, clears all if omitted
   * @example
   * client.oracle.clearCache('C...');
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
   *
   * @param pairAddress - The address of the pair contract
   * @returns Number of cached observations
   * @example
   * const count = client.oracle.getObservationCount('C...');
   */
  getObservationCount(pairAddress: string): number {
    return this.observationCache.get(pairAddress)?.length ?? 0;
  }

  /**
   * Return the cached observation history for a pair.
   *
   * @param pairAddress - The address of the pair contract.
   * @returns A cloned array of cached observations.
   */
  getObservationSeries(pairAddress: string): TWAPObservation[] {
    return this.observationCache.get(pairAddress)?.slice() ?? [];
  }
}
