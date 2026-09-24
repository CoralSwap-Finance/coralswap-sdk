import { Address, xdr } from "@stellar/stellar-sdk";

type ScVal = xdr.ScVal;
type ScMapEntry = xdr.ScMapEntry;

/**
 * Decode an ScVal i128 to a bigint. Returns 0n for non-i128 values.
 */
export function decodeI128(val: ScVal): bigint {
  if (val.type !== "scvI128") return 0n;
  const i128 = val.i128 as unknown;
  if (typeof i128 === "bigint") return i128;
  const parts = i128 as { hi: bigint; lo: bigint };
  return (parts.hi << 64n) + parts.lo;
}

/**
 * Decode an ScVal u32 to a number. Returns 0 for non-u32 values.
 */
export function decodeU32(val: ScVal): number {
  return val.type === "scvU32" ? val.u32 : 0;
}

/**
 * Decode an ScVal u64 to a bigint. Returns 0n for non-u64 values.
 */
export function decodeU64(val: ScVal): bigint {
  return val.type === "scvU64" ? val.u64 : 0n;
}

/**
 * Decode an ScVal address to a string.
 */
export function decodeAddress(val: ScVal): string {
  return Address.fromScVal(val).toString();
}

/**
 * Decode an ScVal i32 to a number. Returns 0 for non-i32 values.
 */
export function decodeI32(val: ScVal): number {
  return val.type === "scvI32" ? val.i32 : 0;
}

/**
 * Decode an ScVal i64 to a bigint. Returns 0n for non-i64 values.
 */
export function decodeI64(val: ScVal): bigint {
  return val.type === "scvI64" ? val.i64 : 0n;
}

/**
 * Decode an ScVal symbol or string to a JS string.
 */
export function decodeString(val: ScVal): string {
  if (val.type === "scvSymbol") return val.sym.toString();
  if (val.type === "scvString") return val.str.toString();
  return val.value?.toString() ?? "";
}

/**
 * Decode an ScVal boolean. Returns undefined for non-bool values.
 */
export function decodeBool(val: ScVal): boolean | undefined {
  return val.type === "scvBool" ? val.b : undefined;
}

/**
 * Safely extract a value from an ScMap by key name.
 */
export function getMapValue(
  map: ScMapEntry[],
  key: string,
): ScVal | undefined {
  for (const entry of map) {
    const k = entry.key;
    let keyStr: string | undefined;
    if (k.type === "scvSymbol") keyStr = k.sym.toString();
    else if (k.type === "scvString") keyStr = k.str.toString();
    if (keyStr === key) return entry.val;
  }
  return undefined;
}

/**
 * Single-entry map helper: treat the given ScVal as an ScMap and look up `key`.
 */
export function mapValue(val: ScVal, key: string): ScVal | undefined {
  if (val.type !== "scvMap" || !val.map) return undefined;
  return getMapValue(val.map, key);
}