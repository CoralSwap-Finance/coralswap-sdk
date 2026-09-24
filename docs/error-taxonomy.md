# Error Taxonomy

This document maps CoralSwap SDK error classes to their string codes and recommended retry policies.

> **Note**: This file is auto-generated from `src/errors.ts`. Do not edit directly.

| Error Class | Error Code | Retry Policy |
|-------------|------------|--------------|
| `NetworkError` | `NETWORK_ERROR` | `retry-with-backoff` |
| `RpcError` | `RPC_ERROR` | `retry-with-backoff` |
| `SimulationError` | `SIMULATION_ERROR` | `fail-fast` |
| `TransactionError` | `TRANSACTION_ERROR` | `fail-fast` |
| `DeadlineError` | `DEADLINE_EXCEEDED` | `fail-fast` |
| `SlippageError` | `SLIPPAGE_EXCEEDED` | `fail-fast` |
| `InsufficientLiquidityError` | `INSUFFICIENT_LIQUIDITY` | `fail-fast` |
| `PairNotFoundError` | `PAIR_NOT_FOUND` | `fail-fast` |
| `WebhookDeliveryError` | `WEBHOOK_DELIVERY_FAILED` | `retry-with-backoff` |
| `ValidationError` | `VALIDATION_ERROR` | `fail-fast` |
| `InvalidThresholdError` | `VALIDATION_ERROR` | `fail-fast` |
| `FlashLoanError` | `FLASH_LOAN_ERROR` | `fail-fast` |
| `FlashLoanFailedError` | `FLASH_LOAN_ERROR` | `fail-fast` |
| `CrossChainError` | `CROSS_CHAIN_ERROR` | `fail-fast` |
| `CircuitBreakerError` | `CIRCUIT_BREAKER` | `fail-fast` |
| `PriceDeviationError` | `PRICE_DEVIATION_TOO_HIGH` | `fail-fast` |
| `StaleOracleError` | `STALE_ORACLE_PAYLOAD` | `fail-fast` |
| `SignerError` | `NO_SIGNER` | `fail-fast` |
| `OrderNotFoundError` | `ORDER_NOT_FOUND` | `fail-fast` |
| `InvalidOperationError` | `INVALID_OPERATION` | `fail-fast` |
| `StakingError` | `STAKING_ERROR` | `fail-fast` |
| `CooldownError` | `COOLDOWN_ERROR` | `fail-fast` |
| `MissingPriceFeedError` | `MISSING_PRICE_FEED` | `fail-fast` |
| `WebhookError` | `WEBHOOK_ERROR` | `fail-fast` |
| `AddressNotFoundError` | `ADDRESS_NOT_FOUND` | `fail-fast` |
| `PortfolioCalculationError` | `PORTFOLIO_CALCULATION_ERROR` | `fail-fast` |
| `WebhookDisabledError` | `WEBHOOK_DISABLED` | `fail-fast` |
