import { ValidationError } from '../errors';
import { isValidAddress } from './addresses';

/**
 * Shared input validation guards for SDK module methods.
 *
 * All validators throw {@link ValidationError} with a descriptive message
 * on invalid input, allowing callers to catch bad parameters early before
 * they propagate to RPC calls.
 */

/**
 * Validate that a value is a valid Stellar address (G... or C...).
 *
 * @param address - The address string to validate.
 * @param name - Human-readable parameter name for the error message.
 * @throws {ValidationError} If the address is empty or invalid.
 */
export function validateAddress(address: string, name: string): void {
  if (!address || address.trim().length === 0) {
    throw new ValidationError(`${name} must not be empty`);
  }
  if (!isValidAddress(address)) {
    throw new ValidationError(`${name} is not a valid Stellar address: ${address}`, {
      address,
    });
  }
}

/**
 * Validate that a bigint amount is strictly positive (> 0n).
 *
 * @param amount - The amount to validate.
 * @param name - Human-readable parameter name for the error message.
 * @throws {ValidationError} If the amount is zero or negative.
 */
export function validatePositiveAmount(amount: bigint, name: string): void {
  if (amount <= 0n) {
    throw new ValidationError(`${name} must be greater than 0, got ${amount}`, {
      amount: amount.toString(),
    });
  }
}

/**
 * Validate that a bigint amount is non-negative (>= 0n).
 *
 * @param amount - The amount to validate.
 * @param name - Human-readable parameter name for the error message.
 * @throws {ValidationError} If the amount is negative.
 */
export function validateNonNegativeAmount(amount: bigint, name: string): void {
  if (amount < 0n) {
    throw new ValidationError(`${name} must be non-negative, got ${amount}`, {
      amount: amount.toString(),
    });
  }
}

/**
 * Validate that slippage tolerance is within a safe range [0, 5000] bps.
 *
 * @param bps - Slippage in basis points.
 * @throws {ValidationError} If bps is outside the allowed range.
 */
export function validateSlippage(bps: number): void {
  if (bps < 0 || bps > 5000) {
    throw new ValidationError(
      `Slippage must be between 0 and 5000 bps, got ${bps}`,
      { slippageBps: bps },
    );
  }
}

/**
 * Validate that two token addresses are not identical.
 *
 * @param tokenIn - First token address.
 * @param tokenOut - Second token address.
 * @throws {ValidationError} If the addresses are the same.
 */
export function validateDistinctTokens(tokenIn: string, tokenOut: string): void {
  if (tokenIn === tokenOut) {
    throw new ValidationError(
      'tokenIn and tokenOut must be different addresses',
      { tokenIn, tokenOut },
    );
  }
}

/**
 * Check whether a swap path is structurally valid.
 *
 * A valid path:
 * - contains at least two token identifiers
 * - has no identical adjacent tokens (no-op hops)
 */
export function isValidPath(path: readonly string[]): boolean {
  if (!Array.isArray(path) || path.length < 2) {
    return false;
  }

  for (let i = 0; i < path.length - 1; i++) {
    if (path[i] === path[i + 1]) {
      return false;
    }
  }

  return true;
}
