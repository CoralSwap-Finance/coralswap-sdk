/**
 * Price feed module â€” oracle price comparison helpers.
 *
 * Provides a standardised way to check an execution price against
 * an oracle price feed before submitting a swap, preventing
 * unfavourable execution.
 *
 * @example
 * ```ts
 * const feed: PriceFeed = { getPrice: async () => 1000 };
 * const result = await getPriceDeviation(1001, feed);
 * // { deviationBps: 10, isWithinBounds: true, oraclePrice: 1000 }
 * ```
 */

/**
 * A price feed that supplies an oracle price.
 *
 * Implementations can wrap on-chain TWAP oracles (e.g. OracleModule),
 * off-chain oracles (Pyth, Band), or a hard-coded reference price
 * for testing.
 */
export interface PriceFeed {
  /** Return the current oracle price as a decimal number. */
  getPrice(): Promise<number>;
}

/**
 * Result of comparing an execution price against an oracle price feed.
 */
export interface DeviationResult {
  /**
   * Absolute deviation in basis points (1 bps = 0.01 %).
   *
   * Formula: `round(|executionPrice - oraclePrice| / oraclePrice * 10000)`
   */
  deviationBps: number;

  /** Whether the deviation is within the configured tolerance. */
  isWithinBounds: boolean;

  /** The oracle price that was used as the reference. */
  oraclePrice: number;
}

const DEFAULT_MAX_DEVIATION_BPS = 50;

/**
 * Compare an execution price against an oracle price feed.
 *
 * @param executionPrice - The price the swap would execute at.
 * @param priceFeed      - An async oracle price provider.
 * @param maxDeviationBps - Maximum allowed deviation in basis points (default 50 = 0.5 %).
 * @returns A `DeviationResult` describing the deviation and whether it is acceptable.
 *
 * @example
 * ```ts
 * const oracle: PriceFeed = { getPrice: async () => 500_000 };
 * const result = await getPriceDeviation(498_000, oracle);
 * console.log(result.deviationBps);       // 4
 * console.log(result.isWithinBounds);     // true
 * ```
 */
export async function getPriceDeviation(
  executionPrice: number,
  priceFeed: PriceFeed,
  maxDeviationBps: number = DEFAULT_MAX_DEVIATION_BPS,
): Promise<DeviationResult> {
  const oraclePrice = await priceFeed.getPrice();

  if (oraclePrice === 0) {
    return {
      deviationBps: 0,
      isWithinBounds: true,
      oraclePrice,
    };
  }

  const diff = Math.abs(executionPrice - oraclePrice);
  const deviationBps = Math.round((diff / oraclePrice) * 10000);
  const isWithinBounds = deviationBps <= maxDeviationBps;

  return { deviationBps, isWithinBounds, oraclePrice };
}
