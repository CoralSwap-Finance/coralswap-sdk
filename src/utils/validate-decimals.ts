import { InvalidTokenMetadataError } from "@/errors";

/**
 * Maximum valid token decimals.
 * 
 * This is the highest decimal precision that can be safely represented
 * with i128 (38 digits) without overflow in amount calculations.
 */
export const MAX_TOKEN_DECIMALS = 38;

/**
 * Minimum valid token decimals (must be non-negative).
 */
export const MIN_TOKEN_DECIMALS = 0;

/**
 * Validates that a decimals value is within the safe range.
 * 
 * @param decimals - The decimals value to validate
 * @param tokenAddress - Optional token address for error context
 * @throws {InvalidTokenMetadataError} If decimals is out of range
 * @returns The validated decimals value
 */
export function validateTokenDecimals(
  decimals: number,
  tokenAddress?: string
): number {
  if (!Number.isInteger(decimals)) {
    throw new InvalidTokenMetadataError(
      `Token decimals must be an integer, got ${decimals}`,
      { decimals, tokenAddress }
    );
  }
  
  if (decimals < MIN_TOKEN_DECIMALS || decimals > MAX_TOKEN_DECIMALS) {
    throw new InvalidTokenMetadataError(
      `Token decimals ${decimals} is out of valid range (${MIN_TOKEN_DECIMALS}-${MAX_TOKEN_DECIMALS})`,
      { decimals, tokenAddress, min: MIN_TOKEN_DECIMALS, max: MAX_TOKEN_DECIMALS }
    );
  }
  
  return decimals;
}

/**
 * Result of a decimals resolution that may have fallen back.
 */
export interface DecimalsResult {
  /** The resolved decimals value */
  decimals: number;
  /** Source of the decimals value */
  source: 'contract' | 'fallback';
}
