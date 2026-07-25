import { PriceDeviationError, StaleOracleError } from "../errors";
import { PriceGuardConfig, RedStonePayload } from "../types/swap";

/** Default price guard configuration. */
export const DEFAULT_PRICE_GUARD_CONFIG: PriceGuardConfig = {
  minGuardedAmountUsd: 100_000_000_00n, // $100 USD (× 10^8)
  maxDeviationBps: 200, // 2%
  maxPayloadAgeMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Verify a RedStone payload is fresh and that the execution price does not
 * deviate beyond the configured threshold from the oracle price.
 *
 * @param payload - The RedStone signed price payload.
 * @param tokenInSymbol - Feed symbol for the input token (e.g. "XLM").
 * @param tokenOutSymbol - Feed symbol for the output token (e.g. "USDC").
 * @param amountIn - Actual input amount (in token's smallest unit, 7 decimals).
 * @param amountOut - Actual output amount (in token's smallest unit, 7 decimals).
 * @param config - Price guard configuration.
 * @throws {StaleOracleError} If the payload is older than `config.maxPayloadAgeMs`.
 * @throws {PriceDeviationError} If the execution price deviates beyond `config.maxDeviationBps`.
 */
export function verifyRedStonePayload(
  payload: RedStonePayload,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: bigint,
  amountOut: bigint,
  config: PriceGuardConfig,
): void {
  const now = Date.now();
  if (now - payload.timestampMs > config.maxPayloadAgeMs) {
    throw new StaleOracleError(tokenInSymbol, payload.timestampMs, config.maxPayloadAgeMs);
  }



  const priceIn = payload.prices[tokenInSymbol.toUpperCase()];
  const priceOut = payload.prices[tokenOutSymbol.toUpperCase()];

  if (priceIn === undefined || priceOut === undefined) {
    // Cannot verify without both prices — skip guard (conservative: allow)
    return;
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

  if (executionDen === 0n) return; // degenerate — skip

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
