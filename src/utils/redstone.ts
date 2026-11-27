import { MissingPriceFeedError, PriceDeviationError, StaleOracleError } from "../errors";
import { PriceGuardConfig, RedStonePayload } from "../types/swap";

/** Default price guard configuration. */
export const DEFAULT_PRICE_GUARD_CONFIG: PriceGuardConfig = {
  minGuardedAmountUsd: 100_000_000_00n, // $100 USD (× 10^8)
  maxDeviationBps: 200, // 2%
  maxPayloadAgeMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Outcome of a price guard evaluation.
 *
 * The guard either ran and passed (`guardSkipped: false`) or could not evaluate the
 * amounts and said so explicitly (`guardSkipped: true`). It never returns without
 * stating which of the two happened, so a caller cannot mistake a skipped guard for
 * a verified one.
 */
export interface PriceGuardResult {
  /**
   * True when the guard was not evaluated because the amounts were degenerate
   * (zero or negative), so no deviation could be computed.
   *
   * A skipped guard is not a failed one: callers that require a guard for large
   * swaps should treat this as "no oracle evidence available" rather than "safe".
   */
  guardSkipped: boolean;
  /**
   * Deviation in basis points between the execution price and the oracle price.
   * Absent when `guardSkipped` is true.
   */
  deviationBps?: number;
}

/**
 * Verify a RedStone payload is fresh and that the execution price does not
 * deviate beyond the configured threshold from the oracle price.
 *
 * Feed availability is checked before the amount check, so a payload missing a
 * required symbol always reports `MissingPriceFeedError` rather than being
 * masked by a degenerate-amount skip.
 *
 * @param payload - The RedStone signed price payload.
 * @param tokenInSymbol - Feed symbol for the input token (e.g. "XLM").
 * @param tokenOutSymbol - Feed symbol for the output token (e.g. "USDC").
 * @param amountIn - Actual input amount (in token's smallest unit, 7 decimals).
 * @param amountOut - Actual output amount (in token's smallest unit, 7 decimals).
 * @param config - Price guard configuration.
 * @returns The guard outcome, with `guardSkipped` set when the amounts were degenerate.
 * @throws {StaleOracleError} If the payload is older than `config.maxPayloadAgeMs`.
 * @throws {MissingPriceFeedError} If a required feed symbol is absent from the payload.
 * @throws {PriceDeviationError} If the execution price deviates beyond `config.maxDeviationBps`.
 */
export function verifyRedStonePayload(
  payload: RedStonePayload,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: bigint,
  amountOut: bigint,
  config: PriceGuardConfig,
): PriceGuardResult {
  const now = Date.now();
  if (now - payload.timestampMs > config.maxPayloadAgeMs) {
    throw new StaleOracleError(tokenInSymbol, payload.timestampMs, config.maxPayloadAgeMs);
  }

  const priceIn = payload.prices[tokenInSymbol.toUpperCase()];
  const priceOut = payload.prices[tokenOutSymbol.toUpperCase()];

  // Check feed availability first: a missing symbol is the security-relevant
  // failure and must not be masked by the degenerate-amount skip below.
  if (priceIn === undefined || priceOut === undefined) {
    throw new MissingPriceFeedError(priceIn === undefined ? tokenInSymbol : tokenOutSymbol);
  }
  if (priceIn <= 0n || priceOut <= 0n) {
    throw new MissingPriceFeedError(priceIn <= 0n ? tokenInSymbol : tokenOutSymbol);
  }

  // Degenerate amounts cannot produce a meaningful ratio, so there is nothing to
  // compare. Report that explicitly instead of returning quietly, which is what
  // previously let callers believe a guard had run.
  if (amountIn <= 0n || amountOut <= 0n) {
    return { guardSkipped: true };
  }

  // Oracle price ratio: how many tokenOut units per tokenIn unit
  // Both prices are USD × 10^8; amounts use 7 decimals (Soroban standard).
  //
  // oracleRatio    = priceIn / priceOut   (tokenOut per tokenIn, in USD terms)
  // executionRatio = amountOut / amountIn (tokenOut per tokenIn, in token units)
  //
  // deviation = |executionRatio / oracleRatio - 1|
  //           = |(amountOut * priceOut) / (amountIn * priceIn) - 1|
  //
  // To avoid floating point, scale by SCALE:
  //   executionScaled = (amountOut * priceOut * SCALE) / (amountIn * priceIn)
  //   deviationBps    = |executionScaled - SCALE| * 10000 / SCALE

  const SCALE = 100_000_000n; // 10^8
  const BPS = 10_000n;

  const executionNum = amountOut * priceOut * SCALE;
  const executionDen = amountIn * priceIn;

  const executionScaled = executionNum / executionDen;

  const diff =
    executionScaled > SCALE
      ? executionScaled - SCALE
      : SCALE - executionScaled;

  const deviationBps = Number((diff * BPS) / SCALE);

  if (deviationBps > config.maxDeviationBps) {
    throw new PriceDeviationError(
      deviationBps,
      0, // oracle reference is 0 deviation
      config.maxDeviationBps,
    );
  }

  return { guardSkipped: false, deviationBps };
}

/**
 * Estimate the USD value of a swap's input amount.
 *
 * @param amountIn - Input amount in token's smallest unit (7 decimals).
 * @param tokenInSymbol - Feed symbol for the input token.
 * @param prices - Price map from the RedStone payload (USD × 10^8).
 * @returns USD value × 10^8, or null if the price is unavailable.
 */
export function estimateUsdValue(
  amountIn: bigint,
  tokenInSymbol: string,
  prices: Record<string, bigint>,
): bigint | null {
  const price = prices[tokenInSymbol.toUpperCase()];
  if (price === undefined) return null;
  // amountIn has 7 decimals; price is USD × 10^8
  // usdValue (× 10^8) = amountIn * price / 10^7
  return (amountIn * price) / 10_000_000n;
}
