import { ValidationError } from "@/errors";

/**
 * Scale factor for limit order prices.
 * 
 * Prices are stored as fixed-point integers scaled by this factor.
 * This allows precise representation of decimal prices without float artifacts.
 * 
 * Scale of 1e9 provides 9 decimal places of precision, which is sufficient
 * for token prices while fitting comfortably in i128.
 */
export const PRICE_SCALE = 1_000_000_000n;

/**
 * Maximum allowed price (1,000,000 * PRICE_SCALE).
 */
const MAX_PRICE_SCALED = 1_000_000n * PRICE_SCALE;

/**
 * Minimum allowed price (must be positive).
 */
const MIN_PRICE_SCALED = 1n;

/**
 * Encode a decimal price string to a scaled fixed-point bigint.
 * 
 * @param priceStr - Price as a decimal string (e.g., "1.5", "0.0000005")
 * @returns Scaled price as bigint
 * @throws {ValidationError} If price format is invalid or out of range
 * 
 * @example
 * ```ts
 * encodePrice("1.5") // => 1500000000n
 * encodePrice("0.0000005") // => 500n
 * ```
 */
export function encodePrice(priceStr: string): bigint {
  const trimmed = priceStr.trim();
  
  if (trimmed === "" || trimmed === "0" || trimmed === "0.0") {
    throw new ValidationError("Price must be positive", { price: priceStr });
  }
  
  // Check for exponential notation which we don't support
  if (/[eE]/.test(trimmed)) {
    throw new ValidationError(
      "Price must not use exponential notation (e.g., '1e-6'). Use decimal format instead (e.g., '0.000001')",
      { price: priceStr }
    );
  }
  
  // Validate format: optional sign, digits, optional decimal point and more digits
  if (!/^[+]?\d+(\.\d+)?$/.test(trimmed)) {
    throw new ValidationError(
      "Invalid price format. Expected decimal number (e.g., '1.5', '0.001')",
      { price: priceStr }
    );
  }
  
  const parts = trimmed.split(".");
  const whole = BigInt(parts[0] ?? "0");
  let frac = parts[1] ?? "";
  
  // Scale the fractional part
  const scaleStr = PRICE_SCALE.toString();
  const scaleDecimals = scaleStr.length - 1; // 9 for PRICE_SCALE = 1e9
  
  if (frac.length > scaleDecimals) {
    // Truncate excess precision
    frac = frac.substring(0, scaleDecimals);
  } else {
    // Pad to scale decimals
    frac = frac.padEnd(scaleDecimals, "0");
  }
  
  const scaled = whole * PRICE_SCALE + BigInt(frac);
  
  if (scaled < MIN_PRICE_SCALED) {
    throw new ValidationError("Price must be positive", { price: priceStr, scaled });
  }
  
  if (scaled > MAX_PRICE_SCALED) {
    throw new ValidationError(
      `Price ${priceStr} exceeds maximum allowed (1,000,000)`,
      { price: priceStr, scaled, max: MAX_PRICE_SCALED }
    );
  }
  
  return scaled;
}

/**
 * Decode a scaled fixed-point bigint to a decimal price string.
 * 
 * @param scaled - Scaled price as bigint
 * @returns Price as decimal string
 * 
 * @example
 * ```ts
 * decodePrice(1500000000n) // => "1.500000000"
 * decodePrice(500n) // => "0.000000500"
 * ```
 */
export function decodePrice(scaled: bigint): string {
  if (scaled < 0n) {
    throw new ValidationError("Price cannot be negative", { scaled });
  }
  
  const whole = scaled / PRICE_SCALE;
  const frac = scaled % PRICE_SCALE;
  
  const scaleStr = PRICE_SCALE.toString();
  const scaleDecimals = scaleStr.length - 1;
  const fracStr = frac.toString().padStart(scaleDecimals, "0");
  
  return `${whole}.${fracStr}`;
}

/**
 * Convert a legacy float targetPrice to scaled bigint with explicit rounding.
 * 
 * @deprecated Use string-based encodePrice instead to avoid float precision issues
 * @param price - Price as a float number
 * @returns Scaled price as bigint
 * @throws {ValidationError} If price is out of range or non-finite
 */
export function encodePriceFromFloat(price: number): bigint {
  if (!Number.isFinite(price)) {
    throw new ValidationError("Price must be a finite number", { price });
  }
  
  if (price <= 0) {
    throw new ValidationError("Price must be positive", { price });
  }
  
  if (price > 1_000_000) {
    throw new ValidationError("Price exceeds maximum allowed (1,000,000)", { price });
  }
  
  // Convert to string with sufficient precision, then use encodePrice
  // This avoids direct float multiplication which can introduce artifacts
  const priceStr = price.toFixed(9);
  return encodePrice(priceStr);
}

/**
 * Decode price to float for display.
 * 
 * @param scaled - Scaled price as bigint  
 * @returns Price as number
 */
export function decodePriceToFloat(scaled: bigint): number {
  return Number(scaled) / Number(PRICE_SCALE);
}
