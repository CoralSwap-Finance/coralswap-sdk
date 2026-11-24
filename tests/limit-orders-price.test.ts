import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { decodeScaledPrice, parseOrderStatus } from '../src/modules/limit-orders';
import {
  PRICE_SCALE,
  encodeTargetPrice,
  formatPrice,
  parsePriceDecimal,
  priceToNumber,
} from '../src/utils/price';

function makeStatusMap(executionPrice: xdr.ScVal): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    state: xdr.ScVal.scvSymbol('filled'),
    fill_percent: xdr.ScVal.scvU32(100),
    execution_price: executionPrice,
    filled_at: xdr.ScVal.scvU64(xdr.Uint64(1_700_000_000)),
  };
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(([key, val]) =>
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
    ),
  );
}

describe('limit order fixed-point prices (#885)', () => {
  it('encodes 0.0000005 without exponent notation and decodes it exactly', () => {
    const scaled = encodeTargetPrice(500n); // 500 / 1e9 = 0.0000005
    expect(scaled).toBe(500n);
    expect(formatPrice(scaled)).toBe('0.0000005');
    expect(formatPrice(scaled)).not.toMatch(/e/i);

    const encoded = nativeToScVal(scaled, { type: 'i128' });
    expect(encoded.type).toBe('scvI128');
    expect(decodeScaledPrice(encoded)).toBe(500n);
    expect(decodeScaledPrice(xdr.ScVal.scvString(formatPrice(scaled)))).toBe(500n);
  });

  it('rounds legacy numbers explicitly and rejects exponent-form input', () => {
    expect(encodeTargetPrice(0.1 + 0.2)).toBe(300_000_000n);
    expect(() => encodeTargetPrice(0.0000005)).toThrow(/exponent notation/);
    expect(() => encodeTargetPrice(5e-7)).toThrow(/exponent notation/);
    expect(parsePriceDecimal('1.2345678904')).toBe(1_234_567_890n);
    expect(parsePriceDecimal('1.2345678905')).toBe(1_234_567_890n + 1n);
    expect(formatPrice(PRICE_SCALE)).toBe('1');
  });

  it('round-trips pseudo-random prices exactly at the documented scale', () => {
    let state = 0x2f6e2b1n;
    for (let i = 0; i < 200; i += 1) {
      state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & ((1n << 64n) - 1n);
      const scaled = (state % (1_000_000n * PRICE_SCALE)) + 1n;
      const encoded = nativeToScVal(scaled, { type: 'i128' });
      expect(decodeScaledPrice(encoded)).toBe(scaled);
      expect(decodeScaledPrice(xdr.ScVal.scvString(formatPrice(scaled)))).toBe(scaled);
      expect(parsePriceDecimal(formatPrice(scaled))).toBe(scaled);
    }
  });

  it('round-trips an execution price above 2^53 without loss', () => {
    const bigPrice = 9_007_199_254_740_993n * PRICE_SCALE;
    const status = parseOrderStatus(makeStatusMap(nativeToScVal(bigPrice, { type: 'i128' })));
    expect(status.executionPriceScaled).toBe(bigPrice);
    expect(typeof status.executionPrice).toBe('number');

    const legacyU64 = 9_007_199_254_740_993n;
    const legacyStatus = parseOrderStatus(
      makeStatusMap(xdr.ScVal.scvU64(xdr.Uint64(legacyU64))),
    );
    expect(legacyStatus.executionPriceScaled).toBe(legacyU64 * PRICE_SCALE);

    // Legacy whole-unit prices keep their old display value.
    expect(parseOrderStatus(makeStatusMap(xdr.ScVal.scvU32(150))).executionPrice).toBe(150);
    expect(priceToNumber(500n)).toBe(0.0000005);
  });
});
