import { xdr } from "@stellar/stellar-sdk";
import { ValidationError } from "@/errors";

/**
 * Decode an ScVal i128 to a bigint.
 *
 * Handles both native bigint format (JavaScript native) and two-part
 * representation (hi/lo parts), as returned by different Soroban SDKs.
 *
 * @param val - The ScVal to decode.
 * @returns The decoded big integer.
 * @throws {ValidationError} If the value is not an scvI128.
 *
 * @example
 * ```ts
 * import { decodeI128 } from '@coralswap/sdk';
 * import { xdr } from '@stellar/stellar-sdk';
 *
 * const bigintValue = decodeI128(scVal);
 * ```
 */
export function decodeI128(val: xdr.ScVal): bigint {
  if (val.type !== "scvI128") {
    throw new ValidationError(`Expected i128 ScVal, got ${val.type}`);
  }
  const i128 = val.i128 as unknown;
  if (typeof i128 === "bigint") return i128;
  const parts = i128 as { hi: bigint; lo: bigint };
  return (parts.hi << 64n) + parts.lo;
}
