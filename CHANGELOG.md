# Changelog

## [Unreleased]

### Added
- Webhook endpoint verification for the SDK webhook module:
  - `verifyWebhook(webhookId)` posts a signed challenge payload and records the result — a `2xx` marks the endpoint `verified: true`, a failed handshake (non-`2xx`, network error or timeout) marks it `verified: false`
  - `updateWebhook(webhookId, updates)` changes a registered webhook's `url`, `events` and/or `secret` with the same validation as `registerWebhook()`; changing the url resets `verified` and clears the failure counter, re-enabling a webhook that was auto-disabled
  - `listWebhooks()` now returns `Webhook[]` views carrying `verified`, `failCount` and `lastDelivery` alongside the configuration, and `getWebhook()` returns the same view; `isWebhookVerified()` and `listWebhooksForEvent()` expose the verification state and event subscription directly
  - `sendWebhook(webhookId, payload, { event })` honours the webhook's event subscription: an event the endpoint did not subscribe to is skipped without an HTTP request (`filtered: true`)
- `Webhook` and `WebhookUpdate` types for the above
- CI check requiring a CHANGELOG entry under `[Unreleased]` for PRs that change `src/`
- Input validation guards on `PortfolioModule` methods: `owner` and every `pairAddresses` entry must be a valid Stellar address (`G…` or `C…`), `fromDate`/`toDate` must be real dates that are not in the future and must satisfy `fromDate < toDate`, and `limit` must be a positive integer no greater than 1000 — every failure throws a typed `ValidationError` whose message includes the invalid value
- `MonitoringModule.getSystemMetrics(period)`: TVL, swap volume, fee revenue, and unique-user change vs. the previous equal-length window, plus top growing/declining pools. Historical figures are read through the shared `TypedEventCursor` (#478)

### Changed
- Bundle-size budget re-baselined from 200 KiB to 225 KiB: the original cap was measured before the check merged, and `main` was already 213.9 KiB when it landed, so the CI job failed on every commit. The current public surface measures 215.1 KiB (220,313 bytes) at `0d73bc2`; the cap keeps the intended ~4.5% headroom (#810)
- Liquidity module validates add/remove-liquidity and add-liquidity-quote inputs with Zod schemas via `validateWithSchema`, replacing the hand-written guards while preserving every existing rule and error message

### Fixed
- `RateLimiter.destroy()` no longer "gifts" tokens to queued callers: destroying the limiter now rejects every queued `acquire()` with the new `RateLimiterDestroyedError` instead of resolving them, so a teardown path can no longer materialize an immediate unthrottled burst (#647). The error message is deliberately non-retryable-sounding so `isRetryable()` fails fast on a dead limiter
- Added burst/token-accuracy tests for `RateLimiter` refill boundaries: sub-interval credit accrual, floor rounding at the refill boundary, and refill capping at `maxBurst` without distorting the refill clock (#647)
- Restored source, config, and test files corrupted when #784, #785, #786, #789, #790, and #792 were merged (overwritten code, invalid `package.json` / `package-lock.json`), which left `main` unable to install, compile, or pass CI

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