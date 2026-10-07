import {
  CONTRACT_ERROR_RANGES,
  ErrorParser,
} from "../src/errors/parser";
import {
  mapError,
  InvalidOperationError,
  PairNotFoundError,
} from "../src/errors";

describe("Contract error code ranges", () => {
  it("declares exactly one range per contract", () => {
    expect(CONTRACT_ERROR_RANGES.map((range) => range.scope)).toEqual([
      "pair",
      "router",
      "factory",
    ]);
  });

  it("never lets two ranges overlap", () => {
    for (let i = 0; i < CONTRACT_ERROR_RANGES.length; i += 1) {
      for (let j = i + 1; j < CONTRACT_ERROR_RANGES.length; j += 1) {
        const a = CONTRACT_ERROR_RANGES[i];
        const b = CONTRACT_ERROR_RANGES[j];
        const overlaps = a.start < b.end && b.start < a.end;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("keeps every mapped code inside its own range", () => {
    for (const range of CONTRACT_ERROR_RANGES) {
      for (const key of Object.keys(range.map)) {
        const code = Number(key);
        expect(code).toBeGreaterThanOrEqual(range.start);
        expect(code).toBeLessThan(range.end);
        expect(ErrorParser.resolveScope(code)).toBe(range.scope);
      }
    }
  });

  describe("resolveScope boundaries", () => {
    it("resolves the pair range", () => {
      expect(ErrorParser.resolveScope(99)).toBeNull();
      expect(ErrorParser.resolveScope(100)).toBe("pair");
      expect(ErrorParser.resolveScope(119)).toBe("pair");
      expect(ErrorParser.resolveScope(120)).toBeNull();
    });

    it("resolves the router range", () => {
      expect(ErrorParser.resolveScope(199)).toBeNull();
      expect(ErrorParser.resolveScope(200)).toBe("router");
      expect(ErrorParser.resolveScope(219)).toBe("router");
      expect(ErrorParser.resolveScope(220)).toBeNull();
    });

    it("resolves the factory range", () => {
      expect(ErrorParser.resolveScope(299)).toBeNull();
      expect(ErrorParser.resolveScope(300)).toBe("factory");
      expect(ErrorParser.resolveScope(319)).toBe("factory");
      expect(ErrorParser.resolveScope(320)).toBeNull();
    });
  });

  describe("code 300 resolves consistently across both mappers", () => {
    it("belongs to the factory contract, not the router", () => {
      expect(ErrorParser.resolveScope(300)).toBe("factory");
      expect(ErrorParser.parseContractError(300)).toBe(
        "Factory already initialized",
      );
    });

    it("maps to a typed error that matches the parsed message", () => {
      const err = mapError(new Error("Error(Contract, #300)"));
      expect(err).toBeInstanceOf(InvalidOperationError);
      expect(err).not.toBeInstanceOf(PairNotFoundError);
      expect(err.message).toBe("Factory already initialized");
      expect(err.details?.contractErrorCode).toBe(300);
    });

    it("keeps pair-not-found on the router code that owns it", () => {
      expect(ErrorParser.parseContractError(206)).toBe("Pair not found");
      expect(mapError(new Error("Error(Contract, #206)"))).toBeInstanceOf(
        PairNotFoundError,
      );
    });
  });

  it("leaves in-range codes with no message unresolved", () => {
    expect(ErrorParser.resolveScope(305)).toBe("factory");
    expect(ErrorParser.parseContractError(305)).toBeNull();
    expect(mapError(new Error("Error(Contract, #305)")).code).toBe(
      "UNKNOWN_ERROR",
    );
  });
});
