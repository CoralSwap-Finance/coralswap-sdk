import { PRECISION } from "../config";
import { InsufficientLiquidityError, ValidationError } from "../errors";

/**
 * Integer square root (Babylonian method).
 */
export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new ValidationError("Square root of negative number");
  if (value === 0n) return 0n;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Compute LP tokens minted for a deposit into an existing pool.
 *
 * Mirrors Uniswap V2: min(amountA * totalSupply / reserveA, amountB * totalSupply / reserveB).
 * For the initial deposit: sqrt(amountA * amountB) - MIN_LIQUIDITY.
 */
export function computeMint(
  amountA: bigint,
  amountB: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalSupply: bigint,
): bigint {
  if (totalSupply === 0n) {
    const liquidity = sqrt(amountA * amountB) - PRECISION.MIN_LIQUIDITY;
    if (liquidity <= 0n) throw new InsufficientLiquidityError("pair", { reason: "initial mint too small" });
    return liquidity;
  }
  const liqA = (amountA * totalSupply) / reserveA;
  const liqB = (amountB * totalSupply) / reserveB;
  return liqA < liqB ? liqA : liqB;
}

/**
 * Compute token amounts returned when burning LP tokens.
 *
 * Mirrors Uniswap V2: amount = liquidity * reserve / totalSupply.
 */
export function computeBurn(
  liquidity: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalSupply: bigint,
): { amountA: bigint; amountB: bigint } {
  return {
    amountA: (liquidity * reserveA) / totalSupply,
    amountB: (liquidity * reserveB) / totalSupply,
  };
}

/**
 * Compute output amount for an exact-in swap (Uniswap V2 formula with dynamic fee).
 *
 * amountOut = (amountIn * (10000 - feeBps) * reserveOut)
 *           / (reserveIn * 10000 + amountIn * (10000 - feeBps))
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n) throw new ValidationError("Insufficient input amount");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new InsufficientLiquidityError("pair");
  const feeFactor = BigInt(10000 - feeBps);
  const amountInWithFee = amountIn * feeFactor;
  return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
}

/**
 * Compute input amount required for an exact-out swap.
 */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountOut <= 0n) throw new ValidationError("Insufficient output amount");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new InsufficientLiquidityError("pair");
  if (amountOut >= reserveOut) throw new InsufficientLiquidityError("pair", { reason: "output exceeds reserves" });
  const feeFactor = BigInt(10000 - feeBps);
  return (reserveIn * amountOut * 10000n) / ((reserveOut - amountOut) * feeFactor) + 1n;
}
