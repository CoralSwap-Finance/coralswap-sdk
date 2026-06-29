# Error Handling Strategy

- **Date**: 2026-06-29
- **Status**: Accepted

## Context

The CoralSwap SDK interacts with Soroban RPC endpoints, submits transactions, and parses contract return values — each of which can fail in distinct ways. Without a consistent error strategy, callers would face a mix of raw `Error` instances, opaque RPC strings, and untyped contract error codes, making it impossible to handle failures programmatically.

Specific problems addressed:

- Soroban contracts return numerical error codes (`Error(Contract, #101)`) that are meaningless without context.
- RPC failures (timeouts, rate limits, connection resets) are structurally different from contract logic errors.
- Module-specific failures (e.g., staking cooldown not elapsed) need distinct types so callers can react appropriately.

## Decision

All SDK errors inherit from a base `CoralSwapSDKError` class that carries a machine-readable `code` string, a human-readable `message`, and optional structured `details` (`src/errors.ts:13-28`).

**Typed error hierarchy** — 19 error types each with a unique `code`:

| Error class              | Code                      | Usage                                                     |
|--------------------------|---------------------------|-----------------------------------------------------------|
| `CoralSwapSDKError`      | `UNKNOWN_ERROR`           | Catch-all fallback                                        |
| `NetworkError`           | `NETWORK_ERROR`           | Connection resets, DNS failures                           |
| `RpcError`               | `RPC_ERROR`               | Rate limits, 429 responses                                |
| `SimulationError`        | `SIMULATION_ERROR`        | Soroban simulation failures                               |
| `TransactionError`       | `TRANSACTION_ERROR`       | Failed tx submission (carries `txHash`)                   |
| `DeadlineError`          | `DEADLINE_EXCEEDED`       | Transaction deadline expired                              |
| `SlippageError`          | `SLIPPAGE_EXCEEDED`       | Price movement beyond tolerance                           |
| `InsufficientLiquidityError` | `INSUFFICIENT_LIQUIDITY` | Pool lacks liquidity                                  |
| `PairNotFoundError`      | `PAIR_NOT_FOUND`          | Token pair not registered                                 |
| `ValidationError`        | `VALIDATION_ERROR`        | Invalid inputs (empty strings, bad addresses, zero amounts) |
| `FlashLoanError`         | `FLASH_LOAN_ERROR`        | Flash loan general failure                                |
| `FlashLoanFailedError`   | — (extends `FlashLoanError`) | On-chain flash loan callback failure                  |
| `CircuitBreakerError`    | `CIRCUIT_BREAKER`         | Pool is paused                                            |
| `PriceDeviationError`    | `PRICE_DEVIATION_TOO_HIGH`| Oracle price deviation exceeds threshold                 |
| `StaleOracleError`       | `STALE_ORACLE_PAYLOAD`    | RedStone payload too old                                  |
| `SignerError`            | `NO_SIGNER`               | No signing key configured                                 |
| `OrderNotFoundError`     | `ORDER_NOT_FOUND`         | Order missing or cancelled                                |
| `InvalidOperationError`  | `INVALID_OPERATION`       | Illegal action on an order                                |
| `StakingError`           | `STAKING_ERROR`           | Staking-specific failures (no rewards, over-unstake)      |
| `CooldownError`          | `COOLDOWN_ERROR`          | Staking cooldown not yet elapsed                          |

**Error classification flow** (`mapError`, `src/errors.ts:419-563`):

1. If the error is already a `CoralSwapSDKError`, pass through.
2. Extract a Soroban contract error code via `ErrorParser.extractErrorCode` (`src/errors/parser.ts:76-87`), then map it via `mapContractError` to the appropriate SDK error type.
3. Fall back to regex-based detection on the error message string (e.g., `"deadline"` → `DeadlineError`, `"slippage"` → `SlippageError`).
4. If no pattern matches, wrap in `CoralSwapSDKError` with code `UNKNOWN_ERROR`.

Each module validates its own inputs and throws `ValidationError` with context. Transaction failures are uniformly wrapped in `TransactionError` with the transaction hash attached for debugging.

## Consequences

### Positive

- **Predictable error shapes** — every error has `.code`, `.message`, and `.details`, enabling structured logging and programmatic handling.
- **Easier debugging** — `TransactionError` carries `txHash`, `ValidationError` carries the offending field, and contract error codes are translated to human-readable messages via `ErrorParser`.
- **Safe error mapping** — `mapError` converts any thrown value into a typed error, so try/catch boundaries always receive a known type.
- **Module-specific errors** — `StakingError` / `CooldownError` let staking callers distinguish "no rewards" from "cooldown active" without parsing strings.

### Negative

- **Code duplication** — each module repeats the same input-validation → `TransactionError` pattern. A future refactor could extract a base module class.
- **String-based fallback** — the regex detection in `mapError` is fragile; a new RPC response format that changes wording could produce incorrect error mappings until the patterns are updated.
- **Error count grows linearly with features** — every new module that introduces a unique failure mode adds a new error class, increasing the surface area callers must handle.
