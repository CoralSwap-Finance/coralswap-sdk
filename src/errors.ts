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

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CoralSwapSDKError';
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
    super('NETWORK_ERROR', message, details);
    this.name = 'NetworkError';
  }
}

/**
 * RPC endpoint errors (timeouts, rate limits).
 */
export class RpcError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('RPC_ERROR', message, details);
    this.name = 'RpcError';
  }
}

/**
 * Transaction simulation failures.
 */
export class SimulationError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SIMULATION_ERROR', message, details);
    this.name = 'SimulationError';
  }
}

/**
 * Transaction submission or execution errors.
 */
export class TransactionError extends CoralSwapSDKError {
  readonly txHash?: string;

  constructor(message: string, txHash?: string, details?: Record<string, unknown>) {
    super('TRANSACTION_ERROR', message, details);
    this.name = 'TransactionError';
    this.txHash = txHash;
  }
}

/**
 * Transaction deadline exceeded.
 */
export class DeadlineError extends CoralSwapSDKError {
  constructor(deadline: number) {
    super('DEADLINE_EXCEEDED', `Transaction deadline exceeded: ${deadline}`, {
      deadline,
    });
    this.name = 'DeadlineError';
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
  ) {
    super(
      'SLIPPAGE_EXCEEDED',
      `Slippage exceeded: expected ${expected}, got ${actual} (tolerance: ${toleranceBps}bps)`,
      { expected: expected.toString(), actual: actual.toString(), toleranceBps },
    );
    this.name = 'SlippageError';
  }
}

/**
 * Insufficient liquidity in a pool.
 */
export class InsufficientLiquidityError extends CoralSwapSDKError {
  constructor(pairAddress: string, details?: Record<string, unknown>) {
    super(
      'INSUFFICIENT_LIQUIDITY',
      `Insufficient liquidity in pair ${pairAddress}`,
      { pairAddress, ...details },
    );
    this.name = 'InsufficientLiquidityError';
  }
}

/**
 * Pool not found for a token pair.
 */
export class PairNotFoundError extends CoralSwapSDKError {
  constructor(tokenA: string, tokenB: string) {
    super('PAIR_NOT_FOUND', `No pair found for tokens ${tokenA} / ${tokenB}`, {
      tokenA,
      tokenB,
    });
    this.name = 'PairNotFoundError';
  }
}

/**
 * Invalid input parameters.
 */
export class ValidationError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

/**
 * Flash loan specific errors.
 */
export class FlashLoanError extends CoralSwapSDKError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('FLASH_LOAN_ERROR', message, details);
    this.name = 'FlashLoanError';
  }
}

/**
 * Circuit breaker triggered (pool is paused).
 */
export class CircuitBreakerError extends CoralSwapSDKError {
  constructor(pairAddress: string) {
    super(
      'CIRCUIT_BREAKER',
      `Circuit breaker active on pair ${pairAddress}`,
      { pairAddress },
    );
    this.name = 'CircuitBreakerError';
  }
}

/**
 * No signing key configured.
 */
export class SignerError extends CoralSwapSDKError {
  constructor() {
    super(
      'NO_SIGNER',
      'No signing key configured. Provide secretKey in config or use external signing.',
    );
    this.name = 'SignerError';
  }
}

/**
 * Map a raw error to the appropriate typed error class.
 */
export function mapError(err: unknown): CoralSwapSDKError {
  if (err instanceof CoralSwapSDKError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('EXPIRED') || message.includes('deadline')) {
    return new DeadlineError(0);
  }
  if (message.includes('slippage') || message.includes('INSUFFICIENT_OUTPUT')) {
    return new SlippageError(0n, 0n, 0);
  }
  if (message.includes('liquidity')) {
    return new InsufficientLiquidityError('unknown');
  }
  if (message.includes('circuit') || message.includes('paused')) {
    return new CircuitBreakerError('unknown');
  }
  if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT')) {
    return new NetworkError(message);
  }

  return new CoralSwapSDKError('UNKNOWN_ERROR', message, {
    originalError: err,
  });
}
