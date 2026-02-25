/**
 * Typed error hierarchy for CoralSwap SDK.
 *
 * All errors extend CoralSwapSDKError and carry a machine-readable
 * error code for programmatic handling plus human-readable messages.
 */

/**
 * Base error class for all SDK errors.
 */
export class CoralSwapSDKError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoralSwapSDKError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Network or RPC connection errors.
 */
export class NetworkError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NETWORK_ERROR", message, details);
    this.name = "NetworkError";
  }
}

/**
 * RPC endpoint errors (timeouts, rate limits).
 */
export class RpcError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("RPC_ERROR", message, details);
    this.name = "RpcError";
  }
}

/**
 * Transaction simulation failures.
 */
export class SimulationError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("SIMULATION_ERROR", message, details);
    this.name = "SimulationError";
  }
}

/**
 * Transaction submission or execution errors.
 */
export class TransactionError extends CoralSwapSDKError {
  readonly txHash?: string;

  constructor(
    message: string,
    txHash?: string,
    details?: Record<string, unknown>,
  ) {
    super("TRANSACTION_ERROR", message, details);
    this.name = "TransactionError";
    this.txHash = txHash;
  }
}

/**
 * Transaction deadline exceeded.
 */
export class DeadlineError extends CoralSwapSDKError {
  constructor(deadline: number) {
    super("DEADLINE_EXCEEDED", `Transaction deadline exceeded (deadline: ${deadline})`, {
      deadline,
    });
    this.name = "DeadlineError";
  }
}

/**
 * Slippage tolerance exceeded.
 */
export class SlippageError extends CoralSwapSDKError {
  constructor(
    expected: bigint,
    actual: bigint,
    toleranceBps: number,
    additionalDetails?: Record<string, unknown>,
  ) {
    super(
      "SLIPPAGE_EXCEEDED",
      `Slippage tolerance exceeded. Expected ${expected}, got ${actual} (tolerance: ${toleranceBps} bps)`,
      {
        expected: expected.toString(),
        actual: actual.toString(),
        toleranceBps,
        ...additionalDetails,
      },
    );
    this.name = "SlippageError";
  }
}

/**
 * Insufficient liquidity in a pool.
 */
export class InsufficientLiquidityError extends CoralSwapSDKError {
  constructor(pairAddress: string, details?: Record<string, unknown>) {
    super(
      "INSUFFICIENT_LIQUIDITY",
      `Insufficient liquidity for pair ${pairAddress}`,
      { pairAddress, ...details },
    );
    this.name = "InsufficientLiquidityError";
  }
}

/**
 * Pool not found for a token pair.
 */
export class PairNotFoundError extends CoralSwapSDKError {
  constructor(tokenA: string, tokenB: string) {
    super("PAIR_NOT_FOUND", `Pair not found for tokens ${tokenA} / ${tokenB}`, {
      tokenA,
      tokenB,
    });
    this.name = "PairNotFoundError";
  }
}

/**
 * Invalid input parameters.
 */
export class ValidationError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

/**
 * Flash loan specific errors.
 */
export class FlashLoanError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("FLASH_LOAN_ERROR", message, details);
    this.name = "FlashLoanError";
  }
}

/**
 * Circuit breaker triggered (pool is paused).
 */
export class CircuitBreakerError extends CoralSwapSDKError {
  constructor(pairAddress: string) {
    super("CIRCUIT_BREAKER", `Pool is paused for pair ${pairAddress}`, {
      pairAddress,
    });
    this.name = "CircuitBreakerError";
  }
}

/**
 * No signing key configured.
 */
export class SignerError extends CoralSwapSDKError {
  constructor() {
    super(
      "NO_SIGNER",
      "No signing key configured. Provide secretKey in config or use external signing.",
    );
    this.name = "SignerError";
  }
}

/**
 * Extract pair address from error details or message.
 */
function extractPairAddress(err: unknown): string {
  if (err && typeof err === "object") {
    const details = (err as { details?: { pairAddress?: string; pair?: string } })
      .details;
    if (details?.pairAddress) return details.pairAddress;
    if (details?.pair) return details.pair;
  }

  const message = err instanceof Error ? err.message : String(err);
  // Try to extract Stellar address pattern (C or G followed by 47-55 alphanumeric chars)
  // Real Stellar addresses are 56 chars, but we're flexible for test addresses
  const addressMatch = message.match(/[CG][A-Z0-9]{47,55}/i);
  if (addressMatch) return addressMatch[0];

  return "unknown";
}

/**
 * Map Soroban contract error codes to SDK errors.
 *
 * Contract error codes are returned in the format: Error(Contract, #XXX)
 * where XXX is the error code defined in the contract.
 */
function mapContractError(
  code: number,
  err: unknown,
): CoralSwapSDKError | null {
  // Core pair contract errors (100-113)
  switch (code) {
    case 100:
      return new ValidationError("Invalid token pair", {
        contractErrorCode: code,
      });
    case 101:
      return new InsufficientLiquidityError(extractPairAddress(err), {
        contractErrorCode: code,
      });
    case 102:
      return new SlippageError(0n, 0n, 0, { contractErrorCode: code });
    case 103:
      return new DeadlineError(0);
    case 104:
      return new ValidationError("Invalid amount", { contractErrorCode: code });
    case 105:
      return new ValidationError("Insufficient input amount", {
        contractErrorCode: code,
      });
    case 106:
      return new FlashLoanError("Reentrancy detected", {
        contractErrorCode: code,
      });
    case 107:
      return new FlashLoanError("Flash loan callback failed", {
        contractErrorCode: code,
      });
    case 108:
      return new FlashLoanError("Flash loan repayment insufficient", {
        contractErrorCode: code,
      });
    case 109:
      return new CircuitBreakerError(extractPairAddress(err));
    case 110:
      return new ValidationError("Unauthorized operation", { contractErrorCode: code });
    case 111:
      return new ValidationError("Invalid recipient", {
        contractErrorCode: code,
      });
    case 112:
      return new ValidationError("Arithmetic overflow", { contractErrorCode: code });
    case 113:
      return new ValidationError("K invariant violated", {
        contractErrorCode: code,
      });

    // Router contract errors (300-306)
    case 300:
      return new PairNotFoundError("unknown", "unknown");
    case 301:
      return new ValidationError("Invalid swap path", { contractErrorCode: code });
    case 302:
      return new SlippageError(0n, 0n, 0, { contractErrorCode: code });
    case 303:
      return new DeadlineError(0);
    case 304:
      return new InsufficientLiquidityError(extractPairAddress(err), {
        contractErrorCode: code,
      });
    case 305:
      return new ValidationError("Excessive input amount", {
        contractErrorCode: code,
      });
    case 306:
      return new ValidationError("Invalid token", { contractErrorCode: code });

    default:
      return null;
  }
}

/**
 * Map a raw error to the appropriate typed error class.
 *
 * This function provides intelligent error mapping with:
 * - Soroban contract error code detection
 * - Regex-based data extraction from error messages
 * - Context preservation from error details
 * - Fallback to generic error types
 */
export function mapError(err: unknown): CoralSwapSDKError {
  if (err instanceof CoralSwapSDKError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const normalizedMessage = message.toLowerCase();

  // Check for Soroban contract error codes: Error(Contract, #XXX)
  const contractErrorMatch = message.match(/Error\(Contract,\s*#?(\d+)\)/i);
  if (contractErrorMatch) {
    const errorCode = parseInt(contractErrorMatch[1], 10);
    const mappedError = mapContractError(errorCode, err);
    if (mappedError) return mappedError;
  }

  // Extract deadline value from message - improved regex
  const deadlineMatch = message.match(/deadline[:\s]*[a-z]*[:\s]*(\d+)/i);
  if (message.includes("EXPIRED") || normalizedMessage.includes("deadline")) {
    const deadline = deadlineMatch ? parseInt(deadlineMatch[1], 10) : 0;
    return new DeadlineError(deadline);
  }

  // Extract slippage amounts from message
  if (normalizedMessage.includes("slippage") || message.includes("INSUFFICIENT_OUTPUT")) {
    const expectedMatch = message.match(/expected[:\s]*(\d+)/i);
    const actualMatch = message.match(/(?:got|actual)[:\s]*(\d+)/i);
    const toleranceMatch = message.match(/tolerance[:\s]*(\d+)/i);

    const expected = expectedMatch ? BigInt(expectedMatch[1]) : 0n;
    const actual = actualMatch ? BigInt(actualMatch[1]) : 0n;
    const tolerance = toleranceMatch ? parseInt(toleranceMatch[1], 10) : 0;

    return new SlippageError(expected, actual, tolerance);
  }

  // Extract pair address for liquidity errors
  if (
    normalizedMessage.includes("liquidity") ||
    message.includes("INSUFFICIENT_LIQUIDITY")
  ) {
    return new InsufficientLiquidityError(extractPairAddress(err));
  }

  // Circuit breaker / paused pool - check before other patterns
  if (
    normalizedMessage.includes("circuit") ||
    normalizedMessage.includes("paused")
  ) {
    return new CircuitBreakerError(extractPairAddress(err));
  }

  // Network connectivity errors
  if (
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ENOTFOUND") ||
    message.includes("ENETUNREACH")
  ) {
    return new NetworkError(message);
  }

  // RPC-specific errors
  if (
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("too many requests") ||
    message.includes("RPC") ||
    message.includes("429")
  ) {
    return new RpcError(message);
  }

  // Signer errors
  if (
    normalizedMessage.includes("signing") ||
    normalizedMessage.includes("signer") ||
    message.includes("NO_SIGNER") ||
    normalizedMessage.includes("private key")
  ) {
    return new SignerError();
  }

  // Flash loan errors
  if (
    normalizedMessage.includes("flash loan") ||
    normalizedMessage.includes("flash_loan") ||
    normalizedMessage.includes("reentrancy") ||
    normalizedMessage.includes("callback")
  ) {
    return new FlashLoanError(message);
  }

  // Validation errors - be more specific to avoid false matches
  if (
    (normalizedMessage.includes("invalid") && !normalizedMessage.includes("active")) ||
    normalizedMessage.includes("validation") ||
    normalizedMessage.includes("required") ||
    normalizedMessage.includes("must be")
  ) {
    return new ValidationError(message);
  }

  // Pair not found
  if (
    normalizedMessage.includes("pair not found") ||
    normalizedMessage.includes("no pair") ||
    message.includes("PAIR_NOT_FOUND")
  ) {
    return new PairNotFoundError("unknown", "unknown");
  }

  // Simulation errors
  if (normalizedMessage.includes("simulation") || message.includes("SIMULATION_FAILED")) {
    return new SimulationError(message);
  }

  // Transaction errors
  if (
    normalizedMessage.includes("transaction") ||
    message.includes("TX_FAILED") ||
    normalizedMessage.includes("tx failed")
  ) {
    return new TransactionError(message);
  }

  return new CoralSwapSDKError("UNKNOWN_ERROR", message, {
    originalError: err,
  });
}
