/**
 * Unified scale and precision constants for numeric operations.
 *
 * All CoralSwap calculations use consistent scales across the SDK:
 * - **Token amounts**: 7 decimal places (Stellar native precision)
 * - **Price scaling**: 1e8 (10^8) for price ratios in USD
 * - **Basis points**: 1e4 (10,000) denominator
 *
 * By centralizing these constants, we prevent drift and ensure consistent
 * conversions across events parsing, staking, limit orders, and module calculations.
 *
 * @example
 * ```ts
 * import { SCALE } from '@coralswap/sdk';
 *
 * const priceUSD = Number(reserveA * SCALE.PRICE) / Number(reserveB * SCALE.PRICE);
 * const tokenAmount = bigint / SCALE.TOKEN_DECIMALS;
 * const basisPoints = Number(fee * SCALE.BPS_DENOMINATOR) / 10000;
 * ```
 */

/**
 * Scale factor for token decimal precision.
 * Stellar tokens use 7 decimal places: 1 token = 10^7 stroops.
 */
export const TOKEN_DECIMALS = BigInt(10_000_000);

/**
 * Scale factor for price ratios expressed in USD.
 * Price scaling of 1e8 allows precise price calculations while maintaining
 * bigint integer arithmetic (avoids floating-point drift).
 *
 * Examples:
 * - 1.00 USD per token = 100_000_000n
 * - 0.50 USD per token = 50_000_000n
 * - 1.50 USD per token = 150_000_000n
 */
export const PRICE_SCALE = BigInt(100_000_000);

/**
 * Basis points (bps) denominator.
 * 1 basis point = 1 / 10,000 = 0.01%.
 *
 * Used for fees, slippage tolerances, and protocol parameters.
 * Example:
 * - 50 bps fee = 50 / 10_000 = 0.5%
 */
export const BPS_DENOMINATOR = BigInt(10_000);

/**
 * Intermediate scale used in some calculations.
 * Equivalent to 1e7 (10^7), used when converting between token and price scales.
 */
export const CONVERSION_SCALE = BigInt(10_000_000);

/**
 * All scale constants bundled for convenience.
 *
 * @example
 * ```ts
 * import { SCALE } from '@coralswap/sdk';
 *
 * const scaledPrice = price * SCALE.PRICE_SCALE / SCALE.TOKEN_DECIMALS;
 * ```
 */
export const SCALE = {
  TOKEN_DECIMALS,
  PRICE_SCALE,
  BPS_DENOMINATOR,
  CONVERSION_SCALE,
} as const;
