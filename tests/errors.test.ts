import {
  CoralSwapSDKError,
  NetworkError,
  RpcError,
  SimulationError,
  TransactionError,
  SlippageError,
  DeadlineError,
  PairNotFoundError,
  InsufficientLiquidityError,
  CircuitBreakerError,
  ValidationError,
  FlashLoanError,
  SignerError,
  mapError,
} from "../src/errors";

describe("Error Hierarchy", () => {
  it("CoralSwapSDKError is instanceof Error", () => {
    const err = new CoralSwapSDKError("TEST", "test message");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CoralSwapSDKError);
    expect(err.code).toBe("TEST");
  });

  it("NetworkError carries code", () => {
    const err = new NetworkError("connection lost");
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.name).toBe("NetworkError");
  });

  it("SlippageError includes amounts", () => {
    const err = new SlippageError(100n, 90n, 50);
    expect(err.code).toBe("SLIPPAGE_EXCEEDED");
    expect(err.details?.toleranceBps).toBe(50);
  });

  it("DeadlineError includes timestamp", () => {
    const err = new DeadlineError(1234567890);
    expect(err.code).toBe("DEADLINE_EXCEEDED");
    expect(err.details?.deadline).toBe(1234567890);
  });

  it("PairNotFoundError includes tokens", () => {
    const err = new PairNotFoundError("TOKEN_A", "TOKEN_B");
    expect(err.code).toBe("PAIR_NOT_FOUND");
    expect(err.details?.tokenA).toBe("TOKEN_A");
  });

  describe("mapError", () => {
    it("passes through SDK errors", () => {
      const original = new NetworkError("test");
      expect(mapError(original)).toBe(original);
    });

    describe("Deadline errors", () => {
      it("maps deadline strings with extracted value", () => {
        const err = mapError(new Error("Transaction deadline: 1234567890"));
        expect(err.code).toBe("DEADLINE_EXCEEDED");
        expect(err).toBeInstanceOf(DeadlineError);
        expect(err.details?.deadline).toBe(1234567890);
      });

      it("maps EXPIRED without deadline value", () => {
        const err = mapError(new Error("Transaction EXPIRED"));
        expect(err.code).toBe("DEADLINE_EXCEEDED");
        expect(err.details?.deadline).toBe(0);
      });

      it("extracts deadline from various formats", () => {
        const err = mapError(new Error("deadline exceeded: 9876543210"));
        expect(err.code).toBe("DEADLINE_EXCEEDED");
        expect(err.details?.deadline).toBe(9876543210);
      });
    });

    describe("Slippage errors", () => {
      it("maps slippage with extracted amounts", () => {
        const err = mapError(
          new Error("slippage exceeded: expected 1000, got 900, tolerance 50"),
        );
        expect(err.code).toBe("SLIPPAGE_EXCEEDED");
        expect(err).toBeInstanceOf(SlippageError);
        expect(err.details?.expected).toBe("1000");
        expect(err.details?.actual).toBe("900");
        expect(err.details?.toleranceBps).toBe(50);
      });

      it("maps INSUFFICIENT_OUTPUT", () => {
        const err = mapError(new Error("INSUFFICIENT_OUTPUT"));
        expect(err.code).toBe("SLIPPAGE_EXCEEDED");
      });

      it("handles slippage without extractable values", () => {
        const err = mapError(new Error("slippage exceeded"));
        expect(err.code).toBe("SLIPPAGE_EXCEEDED");
        expect(err.details?.expected).toBe("0");
        expect(err.details?.actual).toBe("0");
      });
    });

    describe("Liquidity errors", () => {
      it("maps liquidity errors with pair address", () => {
        const pairAddress =
          "CDUMMYPAIRADDRESSFORTEST1234567890ABCDEFGHIJKLMNOP";
        const err = mapError(
          new Error(`Insufficient liquidity in ${pairAddress}`),
        );
        expect(err.code).toBe("INSUFFICIENT_LIQUIDITY");
        expect(err).toBeInstanceOf(InsufficientLiquidityError);
        expect(err.details?.pairAddress).toBe(pairAddress);
      });

      it("maps liquidity errors without address", () => {
        const err = mapError(new Error("Insufficient liquidity"));
        expect(err.code).toBe("INSUFFICIENT_LIQUIDITY");
        expect(err.details?.pairAddress).toBe("unknown");
      });
    });

    describe("Circuit breaker errors", () => {
      it("maps circuit breaker with pair address", () => {
        const pairAddress =
          "CDUMMYPAIRADDRESSFORTEST1234567890ABCDEFGHIJKLMNOP";
        const err = mapError(new Error(`Circuit breaker on ${pairAddress}`));
        expect(err.code).toBe("CIRCUIT_BREAKER");
        expect(err).toBeInstanceOf(CircuitBreakerError);
        expect(err.details?.pairAddress).toBe(pairAddress);
      });

      it("maps paused pool", () => {
        const err = mapError(new Error("Pool is paused"));
        expect(err.code).toBe("CIRCUIT_BREAKER");
      });

      it("maps PAUSED status", () => {
        const err = mapError(new Error("PAUSED"));
        expect(err.code).toBe("CIRCUIT_BREAKER");
      });
    });

    describe("Network errors", () => {
      it("maps ECONNRESET", () => {
        const err = mapError(new Error("ECONNRESET"));
        expect(err.code).toBe("NETWORK_ERROR");
        expect(err).toBeInstanceOf(NetworkError);
      });

      it("maps ETIMEDOUT", () => {
        const err = mapError(new Error("ETIMEDOUT"));
        expect(err.code).toBe("NETWORK_ERROR");
      });

      it("maps ENOTFOUND", () => {
        const err = mapError(new Error("ENOTFOUND"));
        expect(err.code).toBe("NETWORK_ERROR");
      });

      it("maps ENETUNREACH", () => {
        const err = mapError(new Error("ENETUNREACH"));
        expect(err.code).toBe("NETWORK_ERROR");
      });
    });

    describe("RPC errors", () => {
      it("maps rate limit errors", () => {
        const err = mapError(new Error("rate limit exceeded"));
        expect(err.code).toBe("RPC_ERROR");
        expect(err).toBeInstanceOf(RpcError);
      });

      it("maps too many requests", () => {
        const err = mapError(new Error("too many requests"));
        expect(err.code).toBe("RPC_ERROR");
      });

      it("maps 429 status", () => {
        const err = mapError(new Error("HTTP 429"));
        expect(err.code).toBe("RPC_ERROR");
      });

      it("maps RPC errors", () => {
        const err = mapError(new Error("RPC endpoint unavailable"));
        expect(err.code).toBe("RPC_ERROR");
      });
    });

    describe("Signer errors", () => {
      it("maps signing errors", () => {
        const err = mapError(new Error("signing failed"));
        expect(err.code).toBe("NO_SIGNER");
        expect(err).toBeInstanceOf(SignerError);
      });

      it("maps signer not configured", () => {
        const err = mapError(new Error("No signer configured"));
        expect(err.code).toBe("NO_SIGNER");
      });

      it("maps NO_SIGNER code", () => {
        const err = mapError(new Error("NO_SIGNER"));
        expect(err.code).toBe("NO_SIGNER");
      });

      it("maps private key errors", () => {
        const err = mapError(new Error("Invalid private key"));
        expect(err.code).toBe("NO_SIGNER");
      });
    });

    describe("Flash loan errors", () => {
      it("maps flash loan errors", () => {
        const err = mapError(new Error("flash loan failed"));
        expect(err.code).toBe("FLASH_LOAN_ERROR");
        expect(err).toBeInstanceOf(FlashLoanError);
      });

      it("maps flash_loan with underscore", () => {
        const err = mapError(new Error("flash_loan callback failed"));
        expect(err.code).toBe("FLASH_LOAN_ERROR");
      });

      it("maps reentrancy errors", () => {
        const err = mapError(new Error("reentrancy detected"));
        expect(err.code).toBe("FLASH_LOAN_ERROR");
      });

      it("maps callback errors", () => {
        const err = mapError(new Error("callback execution failed"));
        expect(err.code).toBe("FLASH_LOAN_ERROR");
      });
    });

    describe("Validation errors", () => {
      it("maps invalid input", () => {
        const err = mapError(new Error("invalid amount"));
        expect(err.code).toBe("VALIDATION_ERROR");
        expect(err).toBeInstanceOf(ValidationError);
      });

      it("maps validation failures", () => {
        const err = mapError(new Error("validation failed"));
        expect(err.code).toBe("VALIDATION_ERROR");
      });

      it("maps required field errors", () => {
        const err = mapError(new Error("field is required"));
        expect(err.code).toBe("VALIDATION_ERROR");
      });

      it("maps must be errors", () => {
        const err = mapError(new Error("amount must be positive"));
        expect(err.code).toBe("VALIDATION_ERROR");
      });
    });

    describe("Pair not found errors", () => {
      it("maps pair not found", () => {
        const err = mapError(new Error("pair not found"));
        expect(err.code).toBe("PAIR_NOT_FOUND");
        expect(err).toBeInstanceOf(PairNotFoundError);
      });

      it("maps no pair", () => {
        const err = mapError(new Error("no pair exists"));
        expect(err.code).toBe("PAIR_NOT_FOUND");
      });

      it("maps PAIR_NOT_FOUND code", () => {
        const err = mapError(new Error("PAIR_NOT_FOUND"));
        expect(err.code).toBe("PAIR_NOT_FOUND");
      });
    });

    describe("Simulation errors", () => {
      it("maps simulation failures", () => {
        const err = mapError(new Error("simulation failed"));
        expect(err.code).toBe("SIMULATION_ERROR");
        expect(err).toBeInstanceOf(SimulationError);
      });

      it("maps SIMULATION_FAILED code", () => {
        const err = mapError(new Error("SIMULATION_FAILED"));
        expect(err.code).toBe("SIMULATION_ERROR");
      });
    });

    describe("Transaction errors", () => {
      it("maps transaction failures", () => {
        const err = mapError(new Error("transaction failed"));
        expect(err.code).toBe("TRANSACTION_ERROR");
        expect(err).toBeInstanceOf(TransactionError);
      });

      it("maps TX_FAILED code", () => {
        const err = mapError(new Error("TX_FAILED"));
        expect(err.code).toBe("TRANSACTION_ERROR");
      });

      it("maps tx failed", () => {
        const err = mapError(new Error("tx failed on-chain"));
        expect(err.code).toBe("TRANSACTION_ERROR");
      });
    });

    describe("Soroban contract error codes", () => {
      describe("Core pair contract errors (100-113)", () => {
        it("maps error code 100 - Invalid token pair", () => {
          const err = mapError(new Error("Error(Contract, #100)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err).toBeInstanceOf(ValidationError);
          expect(err.details?.contractErrorCode).toBe(100);
        });

        it("maps error code 101 - Insufficient liquidity", () => {
          const err = mapError(new Error("Error(Contract, #101)"));
          expect(err.code).toBe("INSUFFICIENT_LIQUIDITY");
          expect(err).toBeInstanceOf(InsufficientLiquidityError);
          expect(err.details?.contractErrorCode).toBe(101);
        });

        it("maps error code 102 - Slippage exceeded", () => {
          const err = mapError(new Error("Error(Contract, #102)"));
          expect(err.code).toBe("SLIPPAGE_EXCEEDED");
          expect(err).toBeInstanceOf(SlippageError);
          expect(err.details?.contractErrorCode).toBe(102);
        });

        it("maps error code 103 - Deadline exceeded", () => {
          const err = mapError(new Error("Error(Contract, #103)"));
          expect(err.code).toBe("DEADLINE_EXCEEDED");
          expect(err).toBeInstanceOf(DeadlineError);
        });

        it("maps error code 104 - Invalid amount", () => {
          const err = mapError(new Error("Error(Contract, #104)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(104);
        });

        it("maps error code 105 - Insufficient input amount", () => {
          const err = mapError(new Error("Error(Contract, #105)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(105);
        });

        it("maps error code 106 - Reentrancy detected", () => {
          const err = mapError(new Error("Error(Contract, #106)"));
          expect(err.code).toBe("FLASH_LOAN_ERROR");
          expect(err).toBeInstanceOf(FlashLoanError);
          expect(err.message).toContain("Reentrancy detected");
          expect(err.details?.contractErrorCode).toBe(106);
        });

        it("maps error code 107 - Flash loan callback failed", () => {
          const err = mapError(new Error("Error(Contract, #107)"));
          expect(err.code).toBe("FLASH_LOAN_ERROR");
          expect(err.message).toContain("callback failed");
          expect(err.details?.contractErrorCode).toBe(107);
        });

        it("maps error code 108 - Flash loan repayment insufficient", () => {
          const err = mapError(new Error("Error(Contract, #108)"));
          expect(err.code).toBe("FLASH_LOAN_ERROR");
          expect(err.message).toContain("repayment insufficient");
          expect(err.details?.contractErrorCode).toBe(108);
        });

        it("maps error code 109 - Circuit breaker", () => {
          const err = mapError(new Error("Error(Contract, #109)"));
          expect(err.code).toBe("CIRCUIT_BREAKER");
          expect(err).toBeInstanceOf(CircuitBreakerError);
        });

        it("maps error code 110 - Unauthorized", () => {
          const err = mapError(new Error("Error(Contract, #110)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(110);
        });

        it("maps error code 111 - Invalid recipient", () => {
          const err = mapError(new Error("Error(Contract, #111)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(111);
        });

        it("maps error code 112 - Overflow", () => {
          const err = mapError(new Error("Error(Contract, #112)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(112);
        });

        it("maps error code 113 - K invariant violated", () => {
          const err = mapError(new Error("Error(Contract, #113)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(113);
        });
      });

      describe("Router contract errors (300-306)", () => {
        it("maps error code 300 - Pair not found", () => {
          const err = mapError(new Error("Error(Contract, #300)"));
          expect(err.code).toBe("PAIR_NOT_FOUND");
          expect(err).toBeInstanceOf(PairNotFoundError);
        });

        it("maps error code 301 - Invalid path", () => {
          const err = mapError(new Error("Error(Contract, #301)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(301);
        });

        it("maps error code 302 - Slippage exceeded", () => {
          const err = mapError(new Error("Error(Contract, #302)"));
          expect(err.code).toBe("SLIPPAGE_EXCEEDED");
          expect(err).toBeInstanceOf(SlippageError);
          expect(err.details?.contractErrorCode).toBe(302);
        });

        it("maps error code 303 - Deadline exceeded", () => {
          const err = mapError(new Error("Error(Contract, #303)"));
          expect(err.code).toBe("DEADLINE_EXCEEDED");
          expect(err).toBeInstanceOf(DeadlineError);
        });

        it("maps error code 304 - Insufficient liquidity", () => {
          const err = mapError(new Error("Error(Contract, #304)"));
          expect(err.code).toBe("INSUFFICIENT_LIQUIDITY");
          expect(err).toBeInstanceOf(InsufficientLiquidityError);
          expect(err.details?.contractErrorCode).toBe(304);
        });

        it("maps error code 305 - Excessive input amount", () => {
          const err = mapError(new Error("Error(Contract, #305)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(305);
        });

        it("maps error code 306 - Invalid token", () => {
          const err = mapError(new Error("Error(Contract, #306)"));
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.details?.contractErrorCode).toBe(306);
        });
      });

      it("handles contract errors without # prefix", () => {
        const err = mapError(new Error("Error(Contract, 106)"));
        expect(err.code).toBe("FLASH_LOAN_ERROR");
        expect(err.details?.contractErrorCode).toBe(106);
      });

      it("handles unknown contract error codes", () => {
        const err = mapError(new Error("Error(Contract, #999)"));
        expect(err.code).toBe("UNKNOWN_ERROR");
      });
    });

    describe("Unknown errors", () => {
      it("maps unknown string errors", () => {
        const err = mapError("some string error");
        expect(err.code).toBe("UNKNOWN_ERROR");
        expect(err.message).toBe("some string error");
      });

      it("preserves original error in details", () => {
        const original = new Error("custom error");
        const err = mapError(original);
        expect(err.details?.originalError).toBe(original);
      });

      it("handles non-Error objects", () => {
        const err = mapError({ custom: "error" });
        expect(err.code).toBe("UNKNOWN_ERROR");
      });
    });
  });
});
