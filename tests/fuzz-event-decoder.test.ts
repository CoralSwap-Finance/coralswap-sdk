/**
 * Fuzz / property-based tests for EventParser and event-decode helpers.
 *
 * These tests verify that the event-decoding path handles adversarially-shaped
 * on-chain data gracefully — failing closed (returning null / throwing a typed
 * error) rather than crashing the process or hanging.
 *
 * Three adversarial categories are tested:
 *
 *   A1 – Deeply nested / recursive structures (maps inside maps)
 *   A2 – Unexpectedly large arrays and oversized payloads
 *   A3 – Unexpected XDR type tags in fields expected to be a different type
 *
 * Run with: npm test -- --testPathPattern='fuzz-event'
 */

import * as fc from "fast-check";
import { xdr, Address, nativeToScVal } from "@stellar/stellar-sdk";
import { EventParser, EVENT_TOPICS, decodeEventsFromXdr } from "../src/utils/events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTRACT_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONTRACT_BUF = Address.fromString(CONTRACT_ADDR).toBuffer();

function symbolVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

function makeDiagnosticEvent(
  topic: string,
  data: xdr.ScVal,
  contractBuf: Buffer = CONTRACT_BUF,
): xdr.DiagnosticEvent {
  const topics = [symbolVal(topic)];
  const bodyV0 = new xdr.ContractEventV0({ topics, data });
  const body = xdr.ContractEventBody.v0(bodyV0) as xdr.ContractEventBody;

  const contractEvent = new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0() as xdr.ExtensionPoint,
    contractId: contractBuf,
    type: xdr.ContractEventType.contract,
    body,
  });

  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: contractEvent,
  });
}

// ---------------------------------------------------------------------------
// Adversarial arbitraries
// ---------------------------------------------------------------------------

/** Generate a deeply nested ScMap.
 *  Each level wraps a previous map as a value, producing depth up to 100.
 */
const nestedMap: fc.Arbitrary<xdr.ScVal> = fc.nat({ max: 100 }).chain((depth) => {
  let val: xdr.ScVal = xdr.ScVal.scvU32(42);
  for (let i = 0; i < depth; i++) {
    val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: symbolVal("nested"), val }),
    ]);
  }
  return fc.constant(val);
});

/** Generate a large ScVec with random numbers (up to 1000 elements). */
const largeVec: fc.Arbitrary<xdr.ScVal> = fc
  .array(fc.bigInt({ min: 0n, max: 2n ** 64n }), { minLength: 0, maxLength: 1000 })
  .map((items) => {
    const vals = items.map((n) => {
      const signed = n > 0x7fffffffffffffffn ? n - 2n ** 64n : n;
      return n % 2n === 0n ? xdr.ScVal.scvU64(n) : xdr.ScVal.scvI64(signed);
    });
    return xdr.ScVal.scvVec(vals);
  });

/** Generate a ScVal of an unexpected type for a given expected type.
 *  For example, where an i128 is expected, produce scvString, scvBool, scvMap, etc.
 */
const unexpectedType: fc.Arbitrary<xdr.ScVal> = fc.oneof(
  fc.constant(xdr.ScVal.scvBool(true)),
  fc.constant(xdr.ScVal.scvVoid()),
  fc.constant(xdr.ScVal.scvString("not_a_number")),
  fc.constant(xdr.ScVal.scvSymbol("also_not_a_number")),
  fc.constant(xdr.ScVal.scvBytes(Buffer.from("garbage"))),
  fc.constant(xdr.ScVal.scvMap([])),
  fc.constant(xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)])),
  fc.constant(xdr.ScVal.scvContractInstance()),
  fc.constant(xdr.ScVal.scvTimepoint(0n)),
  fc.constant(xdr.ScVal.scvDuration(0n)),
  fc.constant(
    (() => {
      try {
        return xdr.ScVal.scvError(xdr.ScpErrorCode.scpErrorConn());
      } catch {
        return xdr.ScVal.scvVoid();
      }
    })(),
  ),
);

/** Generate a map with random entries, some with unexpected key types. */
const adversarialMap: fc.Arbitrary<xdr.ScVal> = fc
  .array(
    fc.oneof(
      // Normal string keys with unexpected value types
      fc
        .tuple(
          fc.constant(symbolVal("sender")),
          unexpectedType,
        )
        .map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
      // Normal string keys with nested maps
      fc
        .tuple(
          fc.constant(symbolVal("sender")),
          nestedMap,
        )
        .map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
      // Non-string keys (number keys)
      fc
        .tuple(
          fc.oneof(
            fc.constant(xdr.ScVal.scvU32(0)),
            fc.constant(xdr.ScVal.scvU32(1)),
            fc.constant(xdr.ScVal.scvI32(-1)),
          ),
          fc.constant(xdr.ScVal.scvU32(42)),
        )
        .map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
      // String keys not in the expected schema
      fc
        .tuple(
          fc.constant(symbolVal("__unexpected_key_xyz")),
          fc.constant(xdr.ScVal.scvString("malicious")),
        )
        .map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
    ),
    { minLength: 0, maxLength: 50 },
  )
  .map((entries) => xdr.ScVal.scvMap(entries));

/** Generate a map with duplicate keys (adversarial for parsers that don't deduplicate). */
const duplicateKeyMap: fc.Arbitrary<xdr.ScVal> = fc
  .array(
    fc.record({
      key: fc.oneof(fc.constant(symbolVal("sender")), fc.constant(symbolVal("amount_in"))),
      val: unexpectedType,
    }),
    { minLength: 0, maxLength: 30 },
  )
  .map((entries) =>
    xdr.ScVal.scvMap(entries.map((e) => new xdr.ScMapEntry({ key: e.key, val: e.val }))),
  );

/** Generate an adversarially-shaped diagnostic event topic.
 *  Topics can be any ScVal, not just symbols.
 */
const adversarialTopic: fc.Arbitrary<xdr.ScVal[]> = fc
  .array(
    fc.oneof(
      fc.constant(symbolVal("swap")),
      fc.constant(symbolVal("mint")),
      fc.constant(symbolVal("burn")),
      fc.constant(symbolVal("sync")),
      fc.constant(symbolVal("fee_update")),
      fc.constant(symbolVal("add_liquidity")),
      fc.constant(symbolVal("remove_liquidity")),
      fc.constant(symbolVal("flash_loan")),
      fc.constant(xdr.ScVal.scvVoid()),
      fc.constant(xdr.ScVal.scvBool(false)),
      fc.constant(xdr.ScVal.scvU32(9999)),
      fc.constant(xdr.ScVal.scvString("")),
      fc.constant(xdr.ScVal.scvString("a".repeat(10000))),
      largeVec,
      unexpectedType,
    ),
    { minLength: 1, maxLength: 10 },
  )
  .filter((topics) => topics.length > 0);

// ---------------------------------------------------------------------------
// Fuzz: A1 – Deeply nested / recursive structures
// ---------------------------------------------------------------------------

describe("A1 – Deeply nested structures", () => {
  const parser = new EventParser();

  it("nested maps do not crash EventParser.parse", () => {
    fc.assert(
      fc.property(nestedMap, (data) => {
        const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
        const result = parser.parse([diag]);
        // Must not crash or hang; may return empty or throw
        expect(Array.isArray(result)).toBe(true);
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("nested maps do not crash EventParser.parseStrict (may throw Error but not hang)", () => {
    fc.assert(
      fc.property(nestedMap, (data) => {
        const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
        // In strict mode, deeply nested maps may cause XDR parsing to throw
        // an Error — that's acceptable as long as the process doesn't crash.
        // The key invariant: any thrown value is an Error instance, not a crash.
        try {
          parser.parseStrict([diag]);
        } catch (err) {
          expect(err instanceof Error).toBe(true);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("nested maps do not crash decodeEventsFromXdr", () => {
    fc.assert(
      fc.property(nestedMap, (data) => {
        const diag = makeDiagnosticEvent(EVENT_TOPICS.MINT, data);
        const result = decodeEventsFromXdr([diag]);
        expect(Array.isArray(result)).toBe(true);
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Fuzz: A2 – Unexpectedly large arrays and oversized payloads
// ---------------------------------------------------------------------------

describe("A2 – Large arrays and oversized payloads", () => {
  const parser = new EventParser();

  it("large arrays in event data do not crash or hang", () => {
    fc.assert(
      fc.property(largeVec, (data) => {
        const diag = makeDiagnosticEvent(EVENT_TOPICS.SYNC, data);
        const result = parser.parse([diag]);
        expect(Array.isArray(result)).toBe(true);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("huge number of events does not crash parser", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            topic: fc.constantFrom(
              EVENT_TOPICS.SWAP,
              EVENT_TOPICS.MINT,
              EVENT_TOPICS.BURN,
              EVENT_TOPICS.SYNC,
            ),
            useMap: fc.boolean(),
          }),
          { minLength: 0, maxLength: 500 },
        ),
        (events) => {
          const diags = events.map((e) => {
            const data = e.useMap
              ? xdr.ScVal.scvMap([
                  new xdr.ScMapEntry({
                    key: symbolVal("reserve0"),
                    val: xdr.ScVal.scvI128(
                      new (xdr.Int128Parts as any)({ lo: 0, hi: 0 }),
                    ),
                  }),
                ])
              : xdr.ScVal.scvVoid();
            return makeDiagnosticEvent(e.topic, data);
          });
          const result = parser.parse(diags);
          expect(Array.isArray(result)).toBe(true);
          // Should not take an unreasonable amount of time (fuzzing guard)
          expect(result.length).toBeLessThanOrEqual(diags.length);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("extremely long strings in event data do not crash", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (longStr) => {
          const data = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: symbolVal("sender"),
              val: xdr.ScVal.scvString(longStr),
            }),
          ]);
          const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
          const result = parser.parse([diag]);
          expect(Array.isArray(result)).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Fuzz: A3 – Unexpected XDR type tags
// ---------------------------------------------------------------------------

describe("A3 – Unexpected XDR type tags", () => {
  const parser = new EventParser();

  it("adversarial maps with wrong types per field do not crash", () => {
    fc.assert(
      fc.property(adversarialMap, (data) => {
        const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
        const result = parser.parse([diag]);
        expect(Array.isArray(result)).toBe(true);
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it("void data for known topics returns empty without crashing", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          EVENT_TOPICS.SWAP,
          EVENT_TOPICS.MINT,
          EVENT_TOPICS.BURN,
          EVENT_TOPICS.SYNC,
          EVENT_TOPICS.FEE_UPDATE,
          EVENT_TOPICS.ADD_LIQUIDITY,
          EVENT_TOPICS.REMOVE_LIQUIDITY,
          EVENT_TOPICS.FLASH_LOAN,
        ),
        (topic) => {
          const diag = makeDiagnosticEvent(topic, xdr.ScVal.scvVoid());
          const result = parser.parse([diag]);
          expect(Array.isArray(result)).toBe(true);
          // In lenient mode, void data is silently skipped
          expect(result.length).toBe(0);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("adversarial topic values do not crash parser", () => {
    fc.assert(
      fc.property(adversarialTopic, (topics) => {
        const data = xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: symbolVal("sender"),
            val: xdr.ScVal.scvString("GABCDEF1234567890123456789012345678901234567890123"),
          }),
        ]);
        const bodyV0 = new xdr.ContractEventV0({ topics, data });
        const body = xdr.ContractEventBody.v0(bodyV0) as xdr.ContractEventBody;
        const contractEvent = new xdr.ContractEvent({
          ext: xdr.ExtensionPoint.v0() as xdr.ExtensionPoint,
          contractId: CONTRACT_BUF,
          type: xdr.ContractEventType.contract,
          body,
        });
        const diag = new xdr.DiagnosticEvent({
          inSuccessfulContractCall: true,
          event: contractEvent,
        });

        const result = parser.parse([diag]);
        expect(Array.isArray(result)).toBe(true);
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("duplicate key maps do not crash parser", () => {
    fc.assert(
      fc.property(duplicateKeyMap, (data) => {
        const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
        const result = parser.parse([diag]);
        expect(Array.isArray(result)).toBe(true);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("parseStrict always throws an Error (not a process crash) on adversarial data", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(xdr.ScVal.scvVoid()),
          fc.constant(xdr.ScVal.scvBool(true)),
          fc.constant(xdr.ScVal.scvU32(0)),
          adversarialMap,
        ),
        (data) => {
          const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
          // In strict mode, we expect an Error to be thrown (not a string/undefined/number).
          // The error type may be CoralSwapSDKError, ValidationError, or any other Error
          // subclass propagated from the underlying XDR library — as long as it is an Error
          // instance, the parser fails closed rather than crashing the process.
          let threw = false;
          try {
            parser.parseStrict([diag]);
          } catch (err) {
            threw = true;
            expect(err instanceof Error).toBe(true);
          }
          // Must throw for adversarial data that cannot be decoded
          expect(threw).toBe(true);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-category: All decoders fail closed (no crash, no hang)
// ---------------------------------------------------------------------------

describe("All decoders fail closed under any adversarial input", () => {
  const parser = new EventParser();

  it("EventParser.parse never hangs on any ScVal", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          nestedMap,
          largeVec,
          adversarialMap,
          duplicateKeyMap,
          unexpectedType,
          fc.constant(xdr.ScVal.scvVoid()),
        ),
        (data) => {
          const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
          // Must return within reasonable time (not hang)
          const start = Date.now();
          const result = parser.parse([diag]);
          const elapsed = Date.now() - start;
          expect(elapsed).toBeLessThan(1000); // must not hang
          expect(Array.isArray(result)).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("decodeEventsFromXdr never hangs on any ScVal", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          nestedMap,
          largeVec,
          adversarialMap,
          duplicateKeyMap,
          unexpectedType,
          fc.constant(xdr.ScVal.scvVoid()),
        ),
        (data) => {
          const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, data);
          const start = Date.now();
          const result = decodeEventsFromXdr([diag]);
          const elapsed = Date.now() - start;
          expect(elapsed).toBeLessThan(1000);
          expect(Array.isArray(result)).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("empty events array returns empty without crashing", () => {
    expect(parser.parse([])).toEqual([]);
    expect(parser.parseStrict([])).toEqual([]);
    expect(decodeEventsFromXdr([])).toEqual([]);
  });
});
