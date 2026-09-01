# Changelog

## [1.1.0] - 2026-02-17

### Added
- Pluggable `Signer` interface in `src/types/common.ts` for wallet adapter support
- `KeypairSigner` default implementation in `src/utils/signer.ts`
- `signer` option in `CoralSwapConfig` for external wallet integration (Freighter, Albedo)
- Core SDK client with direct Soroban RPC interaction
- Factory, Pair, Router, LP Token contract bindings
- Flash Receiver interface and helpers
- Swap module with dynamic fee-aware quoting
- Liquidity module with LP position management
- Flash Loan module with fee estimation
- Fee module for dynamic fee transparency
- TWAP Oracle module for manipulation-resistant price feeds
- Typed error hierarchy (12 error classes)
- Utility modules: amounts, addresses, simulation, retry
- Test scaffolding with Jest configuration
- Full README documentation with examples


### Changed
- `CoralSwapClient` now accepts both `secretKey` and `signer` config options
- `submitTransaction()` now awaits `signer.signTransaction()` 

### Backward Compatible
- Existing `secretKey` usage continues to work unchanged

## [2.0.0] - 2026-06-29

### Added
- Full [Migration Guide](./MIGRATION.md) from v1 to v2
- Treasury, Staking, Governance, Limit Orders, DCA, Stop Loss, Positions modules
- Alerts, Webhooks, Monitoring modules
- RouterModule with multi-hop swap support
- Enhanced `simulateTransaction()` with typed return values
- `estimateOnly` option on liquidity operations
- `Signer` interface for external wallet adapters (Freighter, Albedo)
- `mapError()` utility for automatic contract error mapping
- `CircuitBreakerError`, `PriceDeviationError`, `StaleOracleError`, `SignerError` error classes
- 18 new utility functions (validation, simulation, gas, events)

### Changed
- Improved error handling with `executeWithFallback` for multi-RPC resilience
- `CoralSwapClient` constructor now supports `rpcUrl` as string array for fallback URLs
- `SwapModule.getQuote()`/`execute()` now accept `path` for multi-hop routing
- `LiquidityModule.getAddLiquidityQuote()` signature simplified (removed `amountBDesired`)

### Deprecated
- Legacy `simulateTransaction(ops, source)` string form — prefer enhanced options object
- Manual `instanceof` error chain — prefer `mapError()`