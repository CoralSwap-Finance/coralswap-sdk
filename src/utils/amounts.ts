import { PRECISION } from "@/config";

/**
 * Amount utilities for Soroban i128 arithmetic.
 *
 * All amounts in CoralSwap use BigInt to match Soroban's i128 type.
 * These helpers provide safe conversions, formatting, and arithmetic operations
 * for working with token amounts on the Stellar/Soroban blockchain.
 *
 * @module utils/amounts
 */

/**
 * Core implementation for parsing a decimal string into a BigInt with the
 * given number of decimals. This is used by both `toSorobanAmount` and
 * `parseTokenAmount` to keep behavior consistent.
 *
 * @param amount - The decimal string to parse (e.g., "1.5", "-100.123")
 * @param decimals - The number of decimal places for the token
 * @returns The amount as a BigInt with the specified decimal precision
 * @throws {Error} If decimals is invalid, amount is empty, or format is invalid
 *
 * @example
 * // Parse positive decimal
 * parseDecimalString("1.5", 7) // => 15000000n
 *
 * @example
 * // Parse negative decimal
 * parseDecimalString("-1.5", 7) // => -15000000n
 *
 * @example
 * // Parse with explicit positive sign
 * parseDecimalString("+1.5", 7) // => 15000000n
 *
 * @remarks
 * - Validates decimal count is a non-negative integer
 * - Trims whitespace from input
 * - Supports negative and positive signs
 * - Validates numeric format with regex
 * - Truncates excess decimal places
 * - Pads insufficient decimal places with zeros
 */
function parseDecimalString(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Invalid decimals");
  }

  const trimmed = amount.trim();
  if (trimmed === "") {
    throw new Error("Amount is required");
  }

  const isNegative = trimmed.startsWith("-");
  const isPositive = trimmed.startsWith("+");
  const sign = isNegative ? -1n : 1n;
  const numeric = isNegative || isPositive ? trimmed.slice(1) : trimmed;

  if (!/^\d+(\.\d+)?$/.test(numeric)) {
    throw new Error("Invalid amount format");
  }

  const parts = numeric.split(".");
  const whole = parts[0] ?? "0";
  let frac = parts[1] ?? "";

  if (frac.length > decimals) {
    frac = frac.substring(0, decimals);
  } else {
    frac = frac.padEnd(decimals, "0");
  }

  const parsed = BigInt(whole + frac);
  return sign * parsed;
}

/**
 * Convert a human-readable decimal string to a Soroban i128 BigInt amount.
 *
 * This function takes a decimal string representation (e.g., "1.5") and converts
 * it to the integer representation used by Soroban smart contracts. The conversion
 * multiplies the decimal value by 10^decimals to preserve precision.
 *
 * @param amount - The decimal string to convert (e.g., "1.5", "100.123456")
 * @param decimals - The number of decimal places for the token (default: 7 for XLM)
 * @returns The amount as a BigInt suitable for Soroban contract calls
 *
 * @example
 * // Convert 1.5 XLM (7 decimals) to stroops
 * toSorobanAmount("1.5", 7) // => 15000000n
 *
 * @example
 * // Convert 100 USDC (6 decimals)
 * toSorobanAmount("100", 6) // => 100000000n
 *
 * @example
 * // Excess decimals are truncated
 * toSorobanAmount("1.123456789", 7) // => 11234567n
 *
 * @remarks
 * - If the input has more decimal places than specified, excess decimals are truncated
 * - If the input has fewer decimal places, zeros are padded to the right
 * - Whole numbers without decimals are supported (e.g., "100")
 * - Supports negative amounts with "-" prefix
 */
export function toSorobanAmount(amount: string, decimals: number = 7): bigint {
  return parseDecimalString(amount, decimals);
}

/**
 * Parse a human-readable token amount into the smallest unit BigInt.
 *
 * This is a general-purpose helper for converting values like "1.5" with a
 * given token decimal count into the BigInt representation used for contract
 * interactions. Functionally equivalent to `toSorobanAmount` but with a more
 * generic name for non-Soroban contexts.
 *
 * @param amount - The decimal string to parse (e.g., "1.5", "100.123456")
 * @param decimals - The number of decimal places for the token
 * @returns The amount as a BigInt in the token's smallest unit
 *
 * @example
 * // Parse 1.5 tokens with 7 decimals
 * parseTokenAmount("1.5", 7) // => 15000000n
 *
 * @example
 * // Parse 100 USDC (6 decimals)
 * parseTokenAmount("100", 6) // => 100000000n
 *
 * @remarks
 * - Uses the same underlying implementation as `toSorobanAmount`
 * - Useful for generic token amount parsing
 * - Supports all the same features (truncation, padding, negative amounts)
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  return parseDecimalString(amount, decimals);
}

/**
 * Convert a Soroban i128 BigInt amount to a human-readable decimal string.
 *
 * This function takes an integer amount from a Soroban contract and converts it
 * to a decimal string representation by dividing by 10^decimals. The result
 * includes all decimal places with trailing zeros preserved.
 *
 * @param amount - The BigInt amount from a Soroban contract
 * @param decimals - The number of decimal places for the token (default: 7 for XLM)
 * @returns A decimal string representation with all decimal places
 *
 * @example
 * // Convert 15000000 stroops to XLM
 * fromSorobanAmount(15000000n, 7) // => "1.5000000"
 *
 * @example
 * // Handle zero amounts
 * fromSorobanAmount(0n, 7) // => "0.0000000"
 *
 * @example
 * // Handle negative amounts
 * fromSorobanAmount(-15000000n, 7) // => "-1.5000000"
 *
 * @remarks
 * - Negative amounts are supported and prefixed with a minus sign
 * - All decimal places are included in the output (no truncation)
 * - Leading zeros are added if the amount is less than 1
 */
export function fromSorobanAmount(
  amount: bigint,
  decimals: number = 7,
): string {
  const isNegative = amount < 0n;
  const abs = isNegative ? -amount : amount;
  const str = abs.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals);
  const frac = str.slice(str.length - decimals);

  const result = `${whole}.${frac}`;
  return isNegative ? `-${result}` : result;
}

/**
 * Format a Soroban amount for user display with configurable decimal precision.
 *
 * This function converts a BigInt amount to a human-readable string and truncates
 * the decimal places to a specified display precision. Useful for showing amounts
 * in UI without excessive trailing zeros or precision.
 *
 * @param amount - The BigInt amount from a Soroban contract
 * @param decimals - The number of decimal places the token uses (default: 7 for XLM)
 * @param displayDecimals - The number of decimal places to show in output (default: 4)
 * @returns A formatted decimal string truncated to displayDecimals places
 *
 * @example
 * // Format XLM amount for display with 2 decimal places
 * formatAmount(15000000n, 7, 2) // => "1.50"
 *
 * @example
 * // Use default 4 decimal places
 * formatAmount(15123456n, 7) // => "1.5123"
 *
 * @example
 * // Format USDC (6 decimals) for display
 * formatAmount(1234567n, 6, 2) // => "1.23"
 *
 * @remarks
 * - Decimal places are truncated, not rounded
 * - Useful for displaying amounts in UI where full precision isn't needed
 * - The whole number part is always included regardless of displayDecimals
 */
export function formatAmount(
  amount: bigint,
  decimals: number = 7,
  displayDecimals: number = 4,
): string {
  const raw = fromSorobanAmount(amount, decimals);
  const parts = raw.split(".");
  const frac = (parts[1] ?? "").substring(0, displayDecimals);
  return `${parts[0]}.${frac}`;
}

/**
 * Calculate basis points (bps) from a ratio of two amounts.
 *
 * Basis points are a unit of measure equal to 1/100th of a percent (0.01%).
 * This function calculates the ratio of numerator to denominator and expresses
 * it in basis points (multiplied by 10,000).
 *
 * @param numerator - The numerator of the ratio
 * @param denominator - The denominator of the ratio
 * @returns The ratio expressed in basis points (0-10000 for 0%-100%)
 *
 * @example
 * // Calculate 0.3% as basis points
 * toBps(30n, 10000n) // => 30 (30 bps = 0.3%)
 *
 * @example
 * // Calculate 50% as basis points
 * toBps(5000n, 10000n) // => 5000 (5000 bps = 50%)
 *
 * @example
 * // Handle zero denominator safely
 * toBps(30n, 0n) // => 0
 *
 * @remarks
 * - Returns 0 if denominator is zero (avoids division by zero)
 * - Result is rounded down to nearest integer
 * - 10,000 bps = 100%, 100 bps = 1%, 1 bps = 0.01%
 */
export function toBps(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  return Number((numerator * PRECISION.BPS_DENOMINATOR) / denominator);
}

/**
 * Apply a basis points percentage to an amount.
 *
 * This function calculates a percentage of an amount using basis points.
 * Useful for calculating fees, slippage, or any percentage-based adjustments.
 *
 * @param amount - The base amount to apply the percentage to
 * @param bps - The percentage in basis points (e.g., 30 for 0.3%, 5000 for 50%)
 * @returns The calculated percentage of the amount
 *
 * @example
 * // Calculate 0.3% fee on 10,000 tokens
 * applyBps(10000n, 30) // => 30n
 *
 * @example
 * // Calculate 50% of an amount
 * applyBps(10000n, 5000) // => 5000n
 *
 * @example
 * // Calculate 1% slippage
 * applyBps(1000000n, 100) // => 10000n
 *
 * @remarks
 * - Result is rounded down (integer division)
 * - Formula: (amount * bps) / 10000
 * - Commonly used for fee calculations and slippage protection
 */
export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / PRECISION.BPS_DENOMINATOR;
}

/**
 * Calculate slippage-adjusted amount using basis points.
 *
 * This function adjusts an amount by a slippage tolerance expressed in basis points.
 * For input amounts, it increases the amount (maximum willing to pay).
 * For output amounts, it decreases the amount (minimum willing to receive).
 *
 * @param amount - The base amount to adjust
 * @param slippageBips - The slippage tolerance in basis points (0-10000)
 * @param isInput - Whether this is an input amount (true) or output amount (false)
 * @returns The slippage-adjusted amount
 * @throws {Error} If slippageBips is not between 0 and 10000
 *
 * @example
 * // Calculate minimum output with 1% slippage (100 bps)
 * getSlippageTolerance(10000n, 100n, false) // => 9900n (99% of original)
 *
 * @example
 * // Calculate maximum input with 1% slippage (100 bps)
 * getSlippageTolerance(10000n, 100n, true) // => 10100n (101% of original)
 *
 * @example
 * // Zero slippage returns original amount
 * getSlippageTolerance(10000n, 0n, false) // => 10000n
 *
 * @remarks
 * - For output amounts (isInput = false): returns minimum acceptable output
 * - For input amounts (isInput = true): returns maximum acceptable input
 * - Validates slippage is within valid range (0-10000 bps)
 * - Formula: amount * (10000 ± slippageBips) / 10000
 */
export function getSlippageTolerance(
  amount: bigint,
  slippageBips: bigint,
  isInput: boolean,
): bigint {
  if (slippageBips < 0n || slippageBips > PRECISION.BPS_DENOMINATOR) {
    throw new Error("Slippage bips must be between 0 and 10000");
  }

  const bps = PRECISION.BPS_DENOMINATOR;
  const multiplier = isInput ? bps + slippageBips : bps - slippageBips;

  return (amount * multiplier) / bps;
}

/**
 * Calculate the percentage difference between two amounts.
 *
 * This function computes how much the first amount differs from the second
 * as a percentage. Positive values indicate an increase, negative values
 * indicate a decrease.
 *
 * @param a - The first amount (new value)
 * @param b - The second amount (reference value)
 * @returns The percentage difference as a decimal number (e.g., 15.5 for 15.5%)
 *
 * @example
 * // Calculate 50% increase
 * percentDiff(150n, 100n) // => 50.0
 *
 * @example
 * // Calculate 25% decrease
 * percentDiff(75n, 100n) // => -25.0
 *
 * @example
 * // Handle zero reference value
 * percentDiff(100n, 0n) // => 0
 *
 * @remarks
 * - Returns 0 if the reference value (b) is zero
 * - Formula: ((a - b) / b) * 100
 * - Result is a decimal number, not basis points
 * - Useful for calculating price impact or value changes
 */
export function percentDiff(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number(((a - b) * 10000n) / b) / 100;
}

/**
 * Safely multiply two BigInt values with overflow detection.
 *
 * This function performs multiplication and verifies that no overflow occurred
 * by checking if the division of the result by one operand equals the other operand.
 * Throws an error if overflow is detected.
 *
 * @param a - The first multiplicand
 * @param b - The second multiplicand
 * @returns The product of a and b
 * @throws {Error} If multiplication overflow is detected
 *
 * @example
 * // Safe multiplication
 * safeMul(100n, 200n) // => 20000n
 *
 * @example
 * // Multiply large numbers safely
 * safeMul(1000000000n, 1000000000n) // => 1000000000000000000n
 *
 * @remarks
 * - Overflow detection works by verifying: (a * b) / a === b
 * - Throws "Multiplication overflow" error if overflow is detected
 * - Zero values are handled correctly (0 * anything = 0)
 * - Essential for preventing silent overflow bugs in financial calculations
 */
export function safeMul(a: bigint, b: bigint): bigint {
  const result = a * b;
  if (a !== 0n && result / a !== b) {
    throw new Error("Multiplication overflow");
  }
  return result;
}

/**
 * Safely divide two BigInt values with zero-check.
 *
 * This function performs integer division and throws an error if the divisor
 * is zero, preventing division by zero errors.
 *
 * @param a - The dividend (numerator)
 * @param b - The divisor (denominator)
 * @returns The quotient of a divided by b (rounded down)
 * @throws {Error} If divisor is zero
 *
 * @example
 * // Safe division
 * safeDiv(200n, 100n) // => 2n
 *
 * @example
 * // Integer division (rounds down)
 * safeDiv(250n, 100n) // => 2n
 *
 * @example
 * // Throws on division by zero
 * safeDiv(200n, 0n) // throws Error: "Division by zero"
 *
 * @remarks
 * - Throws "Division by zero" error if divisor is zero
 * - Result is always rounded down (floor division)
 * - Essential for preventing division by zero errors in calculations
 */
export function safeDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");
  return a / b;
}

/**
 * Get the minimum of two BigInt values.
 *
 * This function compares two BigInt values and returns the smaller one.
 * Useful for clamping values or finding the limiting factor in calculations.
 *
 * @param a - The first value to compare
 * @param b - The second value to compare
 * @returns The smaller of the two values
 *
 * @example
 * // Find minimum
 * minBigInt(100n, 200n) // => 100n
 *
 * @example
 * // Works with negative numbers
 * minBigInt(-50n, 50n) // => -50n
 *
 * @example
 * // Equal values return either one
 * minBigInt(100n, 100n) // => 100n
 *
 * @remarks
 * - Handles negative values correctly
 * - If values are equal, returns the first value
 * - Useful for calculating minimum amounts in liquidity operations
 */
export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Get the maximum of two BigInt values.
 *
 * This function compares two BigInt values and returns the larger one.
 * Useful for ensuring minimum thresholds or finding the maximum capacity.
 *
 * @param a - The first value to compare
 * @param b - The second value to compare
 * @returns The larger of the two values
 *
 * @example
 * // Find maximum
 * maxBigInt(100n, 200n) // => 200n
 *
 * @example
 * // Works with negative numbers
 * maxBigInt(-50n, 50n) // => 50n
 *
 * @example
 * // Equal values return either one
 * maxBigInt(100n, 100n) // => 100n
 *
 * @remarks
 * - Handles negative values correctly
 * - If values are equal, returns the first value
 * - Useful for calculating maximum amounts or ensuring thresholds
 */
export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
