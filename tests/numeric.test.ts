import { describe, it, expect, beforeEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { decodeI128 } from '@/utils/numeric';
import { ValidationError } from '@/errors';

describe('decodeI128', () => {
  it('decodes native bigint i128', () => {
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('12345') }));
    // Override the i128 to be a native bigint
    (val.i128 as any) = 12345n;

    const result = decodeI128(val);
    expect(result).toBe(12345n);
  });

  it('decodes two-part i128 (hi/lo)', () => {
    const hi = BigInt('0x0000000000000001');
    const lo = BigInt('0x0000000000000000');
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }));
    // Override to use two-part representation
    (val.i128 as any) = { hi, lo };

    const result = decodeI128(val);
    expect(result).toBe((hi << 64n) + lo);
  });

  it('decodes zero i128', () => {
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('0') }));
    (val.i128 as any) = 0n;

    const result = decodeI128(val);
    expect(result).toBe(0n);
  });

  it('throws ValidationError for non-i128 ScVal', () => {
    const val = xdr.ScVal.scvU32(42);

    expect(() => decodeI128(val)).toThrow(ValidationError);
    expect(() => decodeI128(val)).toThrow('Expected i128 ScVal, got scvU32');
  });

  it('throws ValidationError for scvString', () => {
    const val = xdr.ScVal.scvString('not an i128');

    expect(() => decodeI128(val)).toThrow(ValidationError);
    expect(() => decodeI128(val)).toThrow('Expected i128 ScVal, got scvString');
  });

  it('decodes maximum safe i128 value', () => {
    const maxValue = BigInt('9223372036854775807');
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(maxValue.toString()) }));
    (val.i128 as any) = maxValue;

    const result = decodeI128(val);
    expect(result).toBe(maxValue);
  });

  it('handles large hi and lo parts correctly', () => {
    const hi = BigInt('0xFFFFFFFFFFFFFFFF');
    const lo = BigInt('0xFFFFFFFFFFFFFFFF');
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }));
    (val.i128 as any) = { hi, lo };

    const result = decodeI128(val);
    expect(result).toBe((hi << 64n) + lo);
  });
});
