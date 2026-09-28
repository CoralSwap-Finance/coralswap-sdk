# Changelog

## [Unreleased]

### Added
- `GovernanceModule.cancelProposal()` and `executeProposal()`, and `decodeProposal` now returns the proposal's `actions` instead of an empty array (#655)
- Test matrices for governance (propose, decode actions, cancel, execute) and staking cooldown boundaries (#655), an events-timeline continuity suite over multi-page ledgers (#657), and a tax-reporting regression suite for non-zero gains, BigInt-safe cost basis and exports past 200 events (#659)
- `NotConfiguredError` (`NOT_CONFIGURED`, fail-fast) for a required network deployment or SDK provider that has not been configured (#638, #642)
- `decodeI128Strict` (shared i128 ScVal decoder used by events, staking and limit orders), the `SCALE` constants bundle (`TOKEN_DECIMALS`, `PRICE_SCALE`, `BPS_DENOMINATOR`, `CONVERSION_SCALE`), and a `taskTimeoutMs` option on `batchRequest` that rejects tasks exceeding the per-task timeout
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
- Governance module validates `createProposal` and `castVote` inputs with zod schemas (`CreateProposalInputSchema`, `CastVoteInputSchema`), replacing the hand-written guards while keeping `ValidationError` as the thrown type (#488)
- `MonitoringModule.getSystemMetrics(period)` validates `period` through the shared `MonitoringPeriodSchema` (zod) via `validateWithSchema`, replacing the hand-written check; the error is still a `ValidationError` (#493)
- `EventCursor` continues a multi-page scan from the previous page's cursor (paging token) instead of `lastLedger + 1`, so events beyond the page limit inside a single ledger are no longer skipped; continuation requests carry the cursor and no ledger range, as Soroban RPC requires (#657)
- `Network.STAGING` now targets Stellar Futurenet (`rpc-futurenet.stellar.org`, futurenet passphrase) with empty factory and router addresses instead of aliasing Testnet; `client.factory` / `client.router` throw `NotConfiguredError` on STAGING and MAINNET until deployment addresses are configured (#638)
- `getVotingPower` / `getVotingPowerAtLedger` throw `NotConfiguredError` when no voting-power provider is set, instead of returning a silent zero-power account (#642)
- `verifyRedStonePayload` fails closed: a missing or non-positive feed price throws `MissingPriceFeedError` and non-positive amounts throw `ValidationError`, where the guard used to be skipped (#656)
- Bundle-size budget re-baselined from 200 KiB to 225 KiB: the original cap was measured before the check merged, and `main` was already 213.9 KiB when it landed, so the CI job failed on every commit. The current public surface measures 215.1 KiB (220,313 bytes) at `0d73bc2`; the cap keeps the intended ~4.5% headroom (#810)
- Liquidity module validates add/remove-liquidity and add-liquidity-quote inputs with Zod schemas via `validateWithSchema`, replacing the hand-written guards while preserving every existing rule and error message

### Fixed
- `verifyRedStonePayload` returns a `PriceGuardResult` instead of `void`, so a caller can tell whether the guard actually ran. Degenerate amounts (zero or negative) now return `{ guardSkipped: true }` explicitly rather than failing the swap with a `ValidationError` that read as a bad request instead of a skipped guard, and a completed guard returns `{ guardSkipped: false, deviationBps }`. Feed availability is checked before the amount check, so a payload missing a required symbol still throws `MissingPriceFeedError` instead of being masked by a skip. `swapWithPriceGuard` surfaces the outcome as `SwapResult.priceGuard` (#640)
- `FeeModule.getFeeRevenue()` no longer corrupts revenue figures: fee amounts are computed and accumulated in stroop-level BigInt (no `Number()` precision loss above 2^53), display conversions use each input token's own `decimals()` read from its contract instead of a hard-coded 10^7, and swap events are fetched through the shared `TypedEventCursor` with full cursor pagination so windows with more than 200 events are fully retrievable. Returns exact `totalFeeStroops`/`feeStroops` totals plus a per-token breakdown (`totalFeeByToken`), with input validation for the ledger window and page limit (#632)
- `FeeModule.getLPYield()` uses the same BigInt-safe share math (no `Number(lpBalance)` precision loss) and converts both reserve sides with their own tokens' decimals instead of a hard-coded 1e7; it also exposes `totalFeeRevenueStroops` (#632)
- Tax reporting computes cost basis, disposals and gains in stroops with BigInt arithmetic instead of `parseFloat` rounding; partial lot consumption keeps the remaining lot's cost, and holding-period gains use real proceeds and cost instead of a zero placeholder (#659)
- `fromSorobanAmount(amount, 0)` returned `"123."` for zero-decimal tokens, which `parseTokenAmount` rejects; it now returns `"123"`. Caught by the new amounts fuzz suite
- `DecodeError` was exported but missing from `ERROR_TAXONOMY` and the error taxonomy docs; the new conformance suite caught it
- Threshold price alerts using the pair spot-price fallback now quote the watched token in its paired token at the USD canonical scale (10^8), oriented by which side of the pair the token is on, instead of always returning `reserve1 / reserve0` at 10^18. Direction, boundary and orientation semantics are pinned by a fixture suite (#678)
- `RateLimiter.destroy()` no longer "gifts" tokens to queued callers: destroying the limiter now rejects every queued `acquire()` with the new `RateLimiterDestroyedError` instead of resolving them, so a teardown path can no longer materialize an immediate unthrottled burst (#647). The error message is deliberately non-retryable-sounding so `isRetryable()` fails fast on a dead limiter
- Added burst/token-accuracy tests for `RateLimiter` refill boundaries: sub-interval credit accrual, floor rounding at the refill boundary, and refill capping at `maxBurst` without distorting the refill clock (#647)
- Restored source, config, and test files corrupted when #784, #785, #786, #789, #790, and #792 were merged (overwritten code, invalid `package.json` / `package-lock.json`), which left `main` unable to install, compile, or pass CI

### Removed
- Unused `GetOpenOrdersSchema` and `GetOrderSummarySchema` exports from the package entry (#664)

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