/**
 * Fixed-point helpers for limit-order prices (#885).
 *
 * A price is `tokenOut` human units per `tokenIn` human unit. It is stored as
 * a signed fixed-point integer scaled by {@link PRICE_SCALE} (1e9, nine
 * decimal places). Using an integer instead of a JS `number` avoids exponent
 * notation for small prices and avoids binary-float artefacts such as
 * `0.1 + 0.2 === 0.30000000000000004`.
 *
 * Token decimals are intentionally not baked into the price: the ratio is in
 * human units, so callers convert their base-unit amounts with the tokens'
 * own decimals before comparing them with a limit bound.
 */

/** Fixed-point scale: prices have nine decimal places. */
export const PRICE_SCALE = 1_000_000_000n;

/** Number of decimal places implied by {@link PRICE_SCALE}. */
export const PRICE_DECIMALS = 9;

/** Upper bound accepted for a price, in human units. */
export const MAX_TARGET_PRICE = 1_000_000;

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a plain decimal string into a fixed-point price.
 *
 * Exponent notation is rejected: callers that need a very small or very large
 * price must provide the fixed-point bigint (or a plain decimal string) so
 * that the encoded value is deterministic. Fractional digits beyond nine are
 * rounded half-up, explicitly, rather than inheriting float noise.
 *
 * @param value - Plain decimal such as `"0.0000005"` or `"1.25"`.
 * @returns The price multiplied by {@link PRICE_SCALE}.
 * @throws Error if the input is not a plain, non-exponent decimal.
 */
export function parsePriceDecimal(value: string): bigint {
  const text = value.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new Error('price must be a plain decimal without exponent notation');
  }

  const whole = BigInt(match[1]);
  const fraction = match[2] ?? '';
  const kept = (fraction + '0'.repeat(PRICE_DECIMALS)).slice(0, PRICE_DECIMALS);
  let scaled = whole * PRICE_SCALE + BigInt(kept || '0');

  // Round half-up using the first discarded digit (explicit, not float-based).
  const discarded = fraction.slice(PRICE_DECIMALS);
  if (discarded.length > 0 && Number(discarded[0]) >= 5) {
    scaled += 1n;
  }
  return scaled;
}

/**
 * Format a fixed-point price as an exact decimal string.
 *
 * The result never uses exponent notation, so small prices such as 0.0000005
 * survive a round trip through string-based tools and older contract paths.
 *
 * @param scaled - Price scaled by {@link PRICE_SCALE}.
 * @returns Exact decimal representation with trailing zeros removed.
 */
export function formatPrice(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / PRICE_SCALE;
  const fraction = (absolute % PRICE_SCALE)
    .toString()
    .padStart(PRICE_DECIMALS, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Convert a fixed-point price to a `number` for display only.
 *
 * Use {@link formatPrice} when an exact string is needed; this helper may
 * lose precision for very large values and must never be used as the source
 * of an on-chain bound.
 *
 * @param scaled - Price scaled by {@link PRICE_SCALE}.
 * @returns Approximate human-readable price.
 */
export function priceToNumber(scaled: bigint): number {
  return Number(scaled) / Number(PRICE_SCALE);
}

/**
 * Normalise a caller-supplied limit price to fixed-point bigint.
 *
 * `bigint` is the canonical form: it is already scaled by {@link PRICE_SCALE}.
 * The `number` overload is deprecated and exists only for existing callers;
 * it converts via the number's decimal representation with explicit rounding
 * and rejects exponent notation, which cannot be trusted as an exact bound.
 *
 * @param value - Scaled bigint, or a legacy JS number in human units.
 * @returns The exact scaled price.
 * @throws Error with the SDK validation message for an invalid price.
 */
export function encodeTargetPrice(value: bigint | number): bigint {
  let scaled: bigint;
  if (typeof value === 'bigint') {
    scaled = value;
  } else {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TARGET_PRICE) {
      throw new Error('targetPrice must be positive');
    }
    const asString = String(value);
    if (/[eE]/.test(asString)) {
      throw new Error('targetPrice number uses exponent notation; pass a fixed-point bigint instead');
    }
    scaled = parsePriceDecimal(asString);
  }

  if (scaled <= 0n) {
    throw new Error('targetPrice must be positive');
  }
  const maximum = BigInt(MAX_TARGET_PRICE) * PRICE_SCALE;
  if (scaled > maximum) {
    throw new Error('targetPrice exceeds maximum allowed range (1,000,000)');
  }
  return scaled;
}
