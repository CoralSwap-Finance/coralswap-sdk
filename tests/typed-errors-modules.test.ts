import { SwapModule } from "../src/modules/swap";
import { LiquidityModule } from "../src/modules/liquidity";
import { FlashLoanModule } from "../src/modules/flash-loan";
import {
  ValidationError,
  InsufficientLiquidityError,
  PairNotFoundError,
  TransactionError,
  FlashLoanError,
  CoralSwapSDKError,
} from "../src/errors";

/**
 * Tests to verify that all modules use typed error classes
 * instead of generic Error objects.
 *
 * This ensures consumers can reliably catch specific error types
 * using instanceof checks.
 */
describe("Typed Errors in Modules", () => {
  describe("SwapModule", () => {
    let swap: SwapModule;

    beforeEach(() => {
      // Create with null client for pure math function testing
      swap = new SwapModule(null as any);
    });

    describe("getAmountOut", () => {
      it("throws ValidationError (not generic Error) for zero input", () => {
        let error: any;
        try {
          swap.getAmountOut(0n, 1000n, 1000n, 30);
        } catch (err) {
          error = err;
        }

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toBeInstanceOf(CoralSwapSDKError);
        expect(error.constructor.name).toBe("ValidationError");
      });

      it("throws ValidationError with context details", () => {
        try {
          swap.getAmountOut(0n, 1000n, 1000n, 30);
          fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("VALIDATION_ERROR");
          expect((err as ValidationError).details?.amountIn).toBe("0");
        }
      });

      it("throws InsufficientLiquidityError (not generic Error) for zero reserves", () => {
        let error: any;
        try {
          swap.getAmountOut(100n, 0n, 1000n, 30);
        } catch (err) {
          error = err;
        }

        expect(error).toBeInstanceOf(InsufficientLiquidityError);
        expect(error).toBeInstanceOf(CoralSwapSDKError);
        expect(error.constructor.name).toBe("InsufficientLiquidityError");
      });

      it("throws InsufficientLiquidityError with context details", () => {
        try {
          swap.getAmountOut(100n, 0n, 1000n, 30);
          fail("Should have thrown InsufficientLiquidityError");
        } catch (err) {
          expect(err).toBeInstanceOf(InsufficientLiquidityError);
          expect((err as InsufficientLiquidityError).code).toBe(
            "INSUFFICIENT_LIQUIDITY",
          );
          expect((err as InsufficientLiquidityError).details?.reserveIn).toBe(
            "0",
          );
          expect((err as InsufficientLiquidityError).details?.reserveOut).toBe(
            "1000",
          );
        }
      });

      it("all errors are instances of CoralSwapSDKError", () => {
        expect(() => {
          swap.getAmountOut(0n, 1000n, 1000n, 30);
        }).toThrow(CoralSwapSDKError);

        expect(() => {
          swap.getAmountOut(100n, 0n, 1000n, 30);
        }).toThrow(CoralSwapSDKError);
      });
    });

    describe("getAmountIn", () => {
      it("throws ValidationError (not generic Error) for zero output", () => {
        let error: any;
        try {
          swap.getAmountIn(0n, 1000n, 1000n, 30);
        } catch (err) {
          error = err;
        }

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toBeInstanceOf(CoralSwapSDKError);
        expect(error.constructor.name).toBe("ValidationError");
      });

      it("throws ValidationError with context details", () => {
        try {
          swap.getAmountIn(0n, 1000n, 1000n, 30);
          fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).details?.amountOut).toBe("0");
        }
      });

      it("throws InsufficientLiquidityError (not generic Error) for zero reserves", () => {
        let error: any;
        try {
          swap.getAmountIn(100n, 0n, 1000n, 30);
        } catch (err) {
          error = err;
        }

        expect(error).toBeInstanceOf(InsufficientLiquidityError);
        expect(error).toBeInstanceOf(CoralSwapSDKError);
        expect(error.constructor.name).toBe("InsufficientLiquidityError");
      });

      it("throws InsufficientLiquidityError with context details", () => {
        try {
          swap.getAmountIn(100n, 0n, 1000n, 30);
          fail("Should have thrown InsufficientLiquidityError");
        } catch (err) {
          expect(err).toBeInstanceOf(InsufficientLiquidityError);
          expect((err as InsufficientLiquidityError).details?.reserveIn).toBe(
            "0",
          );
          expect((err as InsufficientLiquidityError).details?.reserveOut).toBe(
            "1000",
          );
        }
      });

      it("throws InsufficientLiquidityError when output exceeds reserves", () => {
        try {
          swap.getAmountIn(2000n, 1000n, 1000n, 30);
          fail("Should have thrown InsufficientLiquidityError");
        } catch (err) {
          expect(err).toBeInstanceOf(InsufficientLiquidityError);
          expect((err as InsufficientLiquidityError).details?.reason).toContain(
            "exceeds",
          );
          expect((err as InsufficientLiquidityError).details?.amountOut).toBe(
            "2000",
          );
          expect((err as InsufficientLiquidityError).details?.reserveOut).toBe(
            "1000",
          );
        }
      });

      it("all errors are instances of CoralSwapSDKError", () => {
        expect(() => {
          swap.getAmountIn(0n, 1000n, 1000n, 30);
        }).toThrow(CoralSwapSDKError);

        expect(() => {
          swap.getAmountIn(100n, 0n, 1000n, 30);
        }).toThrow(CoralSwapSDKError);

        expect(() => {
          swap.getAmountIn(2000n, 1000n, 1000n, 30);
        }).toThrow(CoralSwapSDKError);
      });
    });

    describe("instanceof checks work correctly", () => {
      it("ValidationError can be caught with instanceof", () => {
        let caughtError: any = null;
        try {
          swap.getAmountOut(0n, 1000n, 1000n, 30);
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).not.toBeNull();
        expect(caughtError instanceof ValidationError).toBe(true);
        expect(caughtError instanceof InsufficientLiquidityError).toBe(false);
        expect(caughtError instanceof CoralSwapSDKError).toBe(true);
      });

      it("InsufficientLiquidityError can be caught with instanceof", () => {
        let caughtError: any = null;
        try {
          swap.getAmountOut(100n, 0n, 1000n, 30);
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).not.toBeNull();
        expect(caughtError instanceof InsufficientLiquidityError).toBe(true);
        expect(caughtError instanceof ValidationError).toBe(false);
        expect(caughtError instanceof CoralSwapSDKError).toBe(true);
      });
    });
  });

  describe("LiquidityModule", () => {
    let liquidity: LiquidityModule;

    beforeEach(() => {
      liquidity = new LiquidityModule(null as any);
    });

    describe("sqrt helper", () => {
      it("throws ValidationError (not generic Error) for negative input", () => {
        let error: any;
        try {
          (liquidity as any).sqrt(-1n);
        } catch (err) {
          error = err;
        }

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toBeInstanceOf(CoralSwapSDKError);
        expect(error.constructor.name).toBe("ValidationError");
      });

      it("throws ValidationError with proper error code", () => {
        try {
          (liquidity as any).sqrt(-1n);
          fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("VALIDATION_ERROR");
          expect((err as ValidationError).message).toContain("negative");
        }
      });

      it("error is instance of CoralSwapSDKError", () => {
        expect(() => {
          (liquidity as any).sqrt(-1n);
        }).toThrow(CoralSwapSDKError);
      });
    });
  });

  describe("Error type consistency across modules", () => {
    it("all modules use CoralSwapSDKError base class", () => {
      const swap = new SwapModule(null as any);

      // Test that all errors inherit from CoralSwapSDKError
      expect(() => swap.getAmountOut(0n, 1000n, 1000n, 30)).toThrow(
        CoralSwapSDKError,
      );
      expect(() => swap.getAmountOut(100n, 0n, 1000n, 30)).toThrow(
        CoralSwapSDKError,
      );
      expect(() => swap.getAmountIn(0n, 1000n, 1000n, 30)).toThrow(
        CoralSwapSDKError,
      );
      expect(() => swap.getAmountIn(100n, 0n, 1000n, 30)).toThrow(
        CoralSwapSDKError,
      );
    });

    it("error codes are consistent and machine-readable", () => {
      const swap = new SwapModule(null as any);

      try {
        swap.getAmountOut(0n, 1000n, 1000n, 30);
      } catch (err) {
        expect((err as CoralSwapSDKError).code).toBe("VALIDATION_ERROR");
      }

      try {
        swap.getAmountOut(100n, 0n, 1000n, 30);
      } catch (err) {
        expect((err as CoralSwapSDKError).code).toBe("INSUFFICIENT_LIQUIDITY");
      }
    });

    it("error details are preserved for debugging", () => {
      const swap = new SwapModule(null as any);

      try {
        swap.getAmountOut(0n, 1000n, 1000n, 30);
      } catch (err) {
        expect((err as CoralSwapSDKError).details).toBeDefined();
        expect((err as CoralSwapSDKError).details?.amountIn).toBe("0");
      }

      try {
        swap.getAmountOut(100n, 0n, 1000n, 30);
      } catch (err) {
        expect((err as CoralSwapSDKError).details).toBeDefined();
        expect((err as CoralSwapSDKError).details?.reserveIn).toBe("0");
      }
    });
  });

  describe("Error handling best practices", () => {
    it("consumers can catch specific error types", () => {
      const swap = new SwapModule(null as any);
      let validationErrorCaught = false;
      let liquidityErrorCaught = false;

      // Test ValidationError catch
      try {
        swap.getAmountOut(0n, 1000n, 1000n, 30);
      } catch (err) {
        if (err instanceof ValidationError) {
          validationErrorCaught = true;
        }
      }

      // Test InsufficientLiquidityError catch
      try {
        swap.getAmountOut(100n, 0n, 1000n, 30);
      } catch (err) {
        if (err instanceof InsufficientLiquidityError) {
          liquidityErrorCaught = true;
        }
      }

      expect(validationErrorCaught).toBe(true);
      expect(liquidityErrorCaught).toBe(true);
    });

    it("consumers can catch all SDK errors with base class", () => {
      const swap = new SwapModule(null as any);
      let sdkErrorCount = 0;

      const testCases = [
        () => swap.getAmountOut(0n, 1000n, 1000n, 30),
        () => swap.getAmountOut(100n, 0n, 1000n, 30),
        () => swap.getAmountIn(0n, 1000n, 1000n, 30),
        () => swap.getAmountIn(100n, 0n, 1000n, 30),
      ];

      for (const testCase of testCases) {
        try {
          testCase();
        } catch (err) {
          if (err instanceof CoralSwapSDKError) {
            sdkErrorCount++;
          }
        }
      }

      expect(sdkErrorCount).toBe(4);
    });
  });
});
