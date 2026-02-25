import { PRECISION } from '../config';

/**
 * Amount utilities for Soroban i128 arithmetic.
 *
 * All amounts in CoralSwap use BigInt to match Soroban's i128.
 * These helpers provide safe conversions and formatting.
 */

/**
 * Core implementation for parsing a decimal string into a BigInt with the
 * given number of decimals. This is used by both `toSorobanAmount` and
 * `parseTokenAmount` to keep behavior consistent.
 */
function parseDecimalString(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Invalid decimals');
  }

  const trimmed = amount.trim();
  if (trimmed === '') {
    throw new Error('Amount is required');
  }

  const isNegative = trimmed.startsWith('-');
  const isPositive = trimmed.startsWith('+');
  const sign = isNegative ? -1n : 1n;
  const numeric = isNegative || isPositive ? trimmed.slice(1) : trimmed;

  if (!/^\d+(\.\d+)?$/.test(numeric)) {
    throw new Error('Invalid amount format');
  }

  const parts = numeric.split('.');
  const whole = parts[0] ?? '0';
  let frac = parts[1] ?? '';

  if (frac.length > decimals) {
    frac = frac.substring(0, decimals);
  } else {
    frac = frac.padEnd(decimals, '0');
  }

  const parsed = BigInt(whole + frac);
  return sign * parsed;
}

/**
 * Convert a human-readable decimal string to i128 BigInt.
 *
 * @example toSorobanAmount("1.5", 7) => 15000000n
 */
export function toSorobanAmount(amount: string, decimals: number = 7): bigint {
  return parseDecimalString(amount, decimals);
}

/**
 * Parse a human-readable token amount into the smallest unit BigInt.
 *
 * This is a general-purpose helper for converting values like "1.5" with a
 * given token decimal count into the BigInt representation used for contract
 * interactions.
 *
 * @example parseTokenAmount("1.5", 7) => 15000000n
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  return parseDecimalString(amount, decimals);
}

/**
 * Convert i128 BigInt to a human-readable decimal string.
 *
 * @example fromSorobanAmount(15000000n, 7) => "1.5000000"
 */
export function fromSorobanAmount(amount: bigint, decimals: number = 7): string {
  const isNegative = amount < 0n;
  const abs = isNegative ? -amount : amount;
  const str = abs.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, str.length - decimals);
  const frac = str.slice(str.length - decimals);

  const result = `${whole}.${frac}`;
  return isNegative ? `-${result}` : result;
}

/**
 * Format an amount for display with optional truncation.
 */
export function formatAmount(
  amount: bigint,
  decimals: number = 7,
  displayDecimals: number = 4,
): string {
  const raw = fromSorobanAmount(amount, decimals);
  const parts = raw.split('.');
  const frac = (parts[1] ?? '').substring(0, displayDecimals);
  return `${parts[0]}.${frac}`;
}

/**
 * Calculate basis points from two amounts (a / b * 10000).
 */
export function toBps(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  return Number((numerator * PRECISION.BPS_DENOMINATOR) / denominator);
}

/**
 * Apply basis points to an amount.
 */
export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / PRECISION.BPS_DENOMINATOR;
}

/**
 * Calculate percentage difference between two amounts.
 */
export function percentDiff(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number(((a - b) * 10000n) / b) / 100;
}

/**
 * Safe multiplication that checks for overflow patterns.
 */
export function safeMul(a: bigint, b: bigint): bigint {
  const result = a * b;
  if (a !== 0n && result / a !== b) {
    throw new Error('Multiplication overflow');
  }
  return result;
}

/**
 * Safe division with zero-check.
 */
export function safeDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('Division by zero');
  return a / b;
}

/**
 * Get the minimum of two BigInt values.
 */
export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Get the maximum of two BigInt values.
 */
export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
